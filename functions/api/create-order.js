// ============================================================
// POST /api/create-order
// 顧客按「線上刷卡付款」時，前端會把購物車內容 POST 到這支 Function。
// 這支 Function 在伺服器端把訂單加密、組成 PAYUNi 整合式支付頁(UPP)要的
// 付款請求，回傳前端需要的資料，讓前端自動組一個表單 POST 到 PAYUNi。
//
// 已對照官方文件 https://docs.payuni.com.tw/web/#/7/34 （整合式支付頁 UPP）
// 與 https://docs.payuni.com.tw/web/#/7/56 （資料加密陣列）撰寫，
// 加密邏輯已用官方測試向量驗證正確（見 payuni-crypto.js 開頭說明）。
//
// ✅ 安全性：金額不再信任前端傳來的數字，一律用 getCachedProducts()
//    向 Google 試算表撈「當下真實的價格與庫存」重新計算，並拒絕庫存不足的訂單。
//    （原本這裡是 TODO，用前端傳來的 price 暫代，已修正。）
//
// ✅ 效能：商品資料透過 Cloudflare KV 快取（90秒），大量結帳時不會每筆
//    都直接打 Google Sheets API，只有快取過期後的第一筆才會真的查詢。
//    這代表庫存數字最多可能有 90 秒的些微延遲（例如快取期間內，理論上
//    有極小機率讓兩筆訂單都通過「庫存夠不夠」的檢查，等實際扣庫存時
//    才會發現不夠），對這個規模的小型賣場來說完全可以接受。
//    沒有設定 PRODUCTS_KV 的話會自動退回「每次都直接查」，正確性不受影響。
//
// ⚠️ 還剩一個地方要等你確認：
//   - 目前預設會顯示所有已在 PAYUNi 後台開通的支付方式（不指定 Credit/LinePay 等參數）。
//     如果你只想開放信用卡+LINE Pay，之後可以加 Credit=1&LinePay=1 這類參數，
//     跟我說要開哪些支付方式即可調整。
//
// 環境變數 SHEETS_API_KEY 是選填的：沒設定的話會用跟前端網頁同一把 API 金鑰
// （因為那把本來就是公開的唯讀金鑰）。如果之後重新申請了新的金鑰，
// 在 Cloudflare 設定 SHEETS_API_KEY 這個環境變數就會改用新的，不用改程式碼。
// ============================================================

import { payuniEncrypt, payuniSha256, generateOrderNo } from "../utils/payuni-crypto.js";
import { getCachedProducts } from "../utils/products.js";

// 測試區 / 正式區 API 網址（官方文件明確給的，正式上線前記得確認 IS_SANDBOX 設定）
const API_URL = {
  sandbox: "https://sandbox-api.payuni.com.tw/api/upp",
  production: "https://api.payuni.com.tw/api/upp",
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const MER_ID = env.PAYUNI_MERID;
  const HASH_KEY = env.PAYUNI_HASHKEY;
  const HASH_IV = env.PAYUNI_HASHIV;
  // 在 Cloudflare 環境變數設定 PAYUNI_SANDBOX=true 可以先用測試區測試，
  // 正式上線前把這個環境變數拿掉或設成 false，就會打正式區
  const useSandbox = (env.PAYUNI_SANDBOX || "").toLowerCase() === "true";

  if (!MER_ID || !HASH_KEY || !HASH_IV) {
    return json(
      { ok: false, error: "尚未設定 PAYUNi 金鑰，請依 README-payuni-setup.md 在 Cloudflare Pages 設定環境變數" },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "訂單資料格式錯誤" }, 400);
  }

  const { items } = body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return json({ ok: false, error: "購物車是空的" }, 400);
  }

  // 後端重新計算總金額，絕對不能相信前端傳來的金額（避免被竄改金額）——
  // 直接去 Google 試算表撈「當下真實的價格與庫存」核對，前端傳來的 price 只當參考，不採用。
  const SHEETS_API_KEY = env.SHEETS_API_KEY || "AIzaSyBAjH-Wpm06d-fWjNGfY56GuptBpcrQ-Po";
  let authoritativeProducts;
  try {
    authoritativeProducts = await getCachedProducts(SHEETS_API_KEY, env.PRODUCTS_KV);
  } catch (e) {
    return json({ ok: false, error: "商品資料讀取失敗，請稍後再試：" + e.message }, 502);
  }

  let totalAmount = 0;
  const verifiedItems = [];
  for (const item of items) {
    const sku = String(item.sku || "").trim();
    const qty = Math.max(0, Math.floor(Number(item.qty) || 0));
    if (!sku || qty <= 0) {
      return json({ ok: false, error: "訂單內容格式異常" }, 400);
    }
    const real = authoritativeProducts.get(sku);
    if (!real) {
      return json({ ok: false, error: `商品 ${sku} 已下架或不存在，請重新整理購物車` }, 400);
    }
    if (real.price <= 0) {
      return json({ ok: false, error: `「${real.name || sku}」尚未定價，無法結帳，請從購物車移除` }, 400);
    }
    if (qty > real.stock) {
      return json({ ok: false, error: `「${real.name || sku}」庫存只剩 ${real.stock} 件，請調整購買數量` }, 400);
    }
    totalAmount += real.price * qty;
    verifiedItems.push({ sku, name: real.name || sku, qty, price: real.price });
  }
  totalAmount = Math.round(totalAmount);

  if (totalAmount <= 0) {
    return json({ ok: false, error: "訂單金額異常" }, 400);
  }

  const merTradeNo = generateOrderNo(); // 限制長度25、格式[A-Za-z0-9_-]，10分鐘內不可重複
  const origin = new URL(request.url).origin;

  const prodDesc = verifiedItems
    .map((i) => i.name)
    .join(";")
    .slice(0, 550); // PAYUNi 規定長度限制 550，多個商品用半形分號分隔

  // 依官方文件「請求參數」表格組成的 EncryptInfo 內容
  const orderFields = {
    MerID: MER_ID,
    MerTradeNo: merTradeNo,
    TradeAmt: totalAmount,
    Timestamp: Math.floor(Date.now() / 1000),
    ProdDesc: prodDesc,
    ReturnURL: `${origin}/api/payuni-return`,
    NotifyURL: `${origin}/api/payuni-notify`,
  };

  // 官方範例是用 querystring.stringify()，等效於標準 URLSearchParams 組出 key=value&key2=value2
  const plainText = new URLSearchParams(
    Object.fromEntries(Object.entries(orderFields).map(([k, v]) => [k, String(v)]))
  ).toString();

  const encryptInfo = await payuniEncrypt(plainText, HASH_KEY, HASH_IV);
  const hashInfo = await payuniSha256(encryptInfo, HASH_KEY, HASH_IV);

  // 先把「這筆訂單買了哪些商品、各買幾件」記一筆「待付款」到訂單試算表，
  // 之後 PAYUNi 通知付款成功時，才有明細可以回頭查、拿去扣商品庫存。
  // 這步失敗不擋結帳（顧客還是能正常付款），只是之後會少了自動扣庫存的依據，
  // 錯誤只記錄不中斷流程。
  try {
    await recordPendingOrder(env, merTradeNo, totalAmount, prodDesc, verifiedItems);
  } catch (e) {
    console.error("記錄待付款訂單失敗（不影響結帳）：", e.message);
  }

  return json({
    ok: true,
    orderNo: merTradeNo,
    amount: totalAmount,
    // 前端會用這幾個欄位組一個 <form method="POST"> 自動送出到下面這個網址
    submitUrl: useSandbox ? API_URL.sandbox : API_URL.production,
    formFields: {
      MerID: MER_ID,
      Version: "2.0",
      EncryptInfo: encryptInfo,
      HashInfo: hashInfo,
    },
  });
}

/** 呼叫 Google Apps Script，記錄一筆「待付款」訂單，附上完整商品明細 */
async function recordPendingOrder(env, orderNo, amount, itemDesc, items) {
  const url = env.GAS_WEBHOOK_URL;
  const secret = env.GAS_WEBHOOK_SECRET;
  if (!url || !secret) {
    console.warn("尚未設定 GAS_WEBHOOK_URL / GAS_WEBHOOK_SECRET，略過記錄待付款訂單");
    return;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret,
      action: "create",
      orderNo,
      amount,
      itemDesc,
      items: items.map((i) => ({ sku: i.sku, qty: i.qty })), // 扣庫存只需要 sku 跟數量
    }),
  });

  if (!res.ok) {
    throw new Error(`Apps Script 回應 ${res.status}：${await res.text()}`);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
