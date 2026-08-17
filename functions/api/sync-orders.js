// ============================================================
// GET/POST /api/sync-orders?secret=xxx
// ============================================================
// 背景排程用的端點，不是給顧客結帳時呼叫的。
//
// 由 .github/workflows/sync-orders.yml 這個排程（GitHub Actions cron，
// 每 5 分鐘一次，也可以在 GitHub Actions 頁面手動觸發 workflow_dispatch）
// 定期呼叫這支，把 create-order.js 寫進 Cloudflare KV 的「待同步訂單佇列」
// 一筆一筆循序 POST 給 Google Apps Script webhook，寫進真正的訂單試算表。
//
// 為什麼要多繞這一手，不讓結帳當下直接寫 Google 試算表？
//   實測過：結帳當下如果直接呼叫 Google Apps Script webhook，瞬間大量
//   結帳（例如 60 筆同時湧入）會因為 Google 那邊對「同時執行數」有限制，
//   導致大部分請求被擋掉、訂單記錄大量遺失，而且顧客端完全看不出來
//   （因為記錄失敗不會擋結帳，付款一樣會成功）。
//
//   改成這支背景排程「一筆一筆循序處理」之後，天然不會有多筆同時打
//   Google Apps Script 的情形，等於自動避開了 Google 的同時執行數限制；
//   卡在佇列裡還沒同步的訂單，下一次排程（最多等 5 分鐘）會自動重試，
//   不會漏單，只是入帳時間會晚個幾分鐘。
//
// 安全性：用 SYNC_SECRET 這把獨立的密碼保護，避免任何人隨便打這支 API
// 就能觸發同步（雖然頂多只是提早觸發同步，不會洩漏或竄改資料，但還是
// 建議設定好 SYNC_SECRET 這個環境變數）。
//
// 每次呼叫最多處理 15 筆，避免 Cloudflare Functions 免費方案「每次請求
// 最多 50 個對外連線（subrequest）」的限制（15 筆 × 最多 3 個對外連線
// + 1 次列出佇列 = 46，留一點安全空間）。佇列裡如果還有沒處理完的，
// 下一次排程會接著處理，不會漏。
// ============================================================

export async function onRequestGet(context) {
  return handle(context);
}
export async function onRequestPost(context) {
  return handle(context);
}

const BATCH_LIMIT = 15;

async function handle(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const providedSecret = url.searchParams.get("secret") || request.headers.get("x-sync-secret");
  if (!env.SYNC_SECRET || providedSecret !== env.SYNC_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const kv = env.PRODUCTS_KV;
  if (!kv) {
    return json({ ok: false, error: "尚未綁定 PRODUCTS_KV" }, 500);
  }
  const gasUrl = env.GAS_WEBHOOK_URL;
  const gasSecret = env.GAS_WEBHOOK_SECRET;
  if (!gasUrl || !gasSecret) {
    return json({ ok: false, error: "尚未設定 GAS_WEBHOOK_URL / GAS_WEBHOOK_SECRET" }, 500);
  }

  const list = await kv.list({ prefix: "pending-order:", limit: BATCH_LIMIT });

  let synced = 0;
  let failed = 0;
  const errors = [];

  // 刻意用 for...of + await（循序處理，不是 Promise.all 平行處理）——
  // 這是這整個機制能繞開 Google 同時執行數限制的關鍵，不要改成平行處理。
  for (const k of list.keys) {
    const raw = await kv.get(k.name);
    if (!raw) continue;

    let order;
    try {
      order = JSON.parse(raw);
    } catch (e) {
      // 佇列裡的資料本身壞掉，清掉避免卡住後面的處理
      await kv.delete(k.name);
      failed++;
      errors.push(`${k.name}: 資料格式壞掉，已捨棄`);
      continue;
    }

    try {
      const res = await fetch(gasUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: gasSecret,
          action: "create",
          orderNo: order.orderNo,
          amount: order.amount,
          itemDesc: order.itemDesc,
          items: order.items,
        }),
      });

      if (res.ok) {
        await kv.delete(k.name);
        synced++;
      } else {
        failed++;
        errors.push(`${order.orderNo}: Apps Script 回應 ${res.status}`);
      }
    } catch (e) {
      failed++;
      errors.push(`${order.orderNo}: ${e.message}`);
    }
  }

  return json({
    ok: true,
    synced,
    failed,
    remainingAtLeast: list.list_complete ? 0 : "more",
    errors: errors.slice(0, 5), // 避免回應太長，只回前 5 筆錯誤訊息
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
