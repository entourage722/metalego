// ============================================================
// 伺服器端商品資料查詢（防止結帳金額被竄改用）
// ============================================================
// 顧客送出訂單時，價格絕對不能相信瀏覽器端傳來的數字（打開開發者工具就能改），
// 這支工具負責在 Cloudflare Function 這端，直接向 Google 試算表撈「當下真實的
// 價格與庫存」，用來核對／覆蓋顧客端送來的金額。
//
// 跟 index.html 裡讀商品資料用的是同一份試算表、同一套欄位判斷邏輯，
// 只是換成在伺服器端執行一次，顧客端無法竄改。
// ============================================================

const SPREADSHEET_ID = "1C5-V2M1dn8ljDhwGvNA5wD0kNCu_HOdEHnRsgZ9TlBs";
const GID = "1498552544";

const HEADER_ALIASES = {
  sku:   ["sku", "商品編號", "編號"],
  name:  ["name", "商品名稱", "名稱"],
  price: ["price", "特價", "售價"],
  orig:  ["orig", "original", "原價"],
  stock: ["stock", "庫存", "庫存量", "數量"],
};

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase();
}

/**
 * 從 Google 試算表撈出目前所有商品的「真實價格 / 庫存」，用 sku 當 key。
 * 跟前端 index.html 的 fetchProductsFromSheet() 用同一套兩步驟邏輯：
 * 先用 GID 查出目前的分頁名稱（分頁改名也不會失效），再撈該分頁的資料。
 * @param {string} apiKey - Google Sheets API 金鑰（跟前端讀商品清單用同一把）
 * @returns {Promise<Map<string,{price:number, stock:number, name:string}>>}
 */
export async function fetchAuthoritativeProducts(apiKey) {
  if (!apiKey) throw new Error("缺少 Google Sheets API 金鑰");

  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?key=${apiKey}&fields=sheets.properties`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) throw new Error(`讀取試算表結構失敗：${metaRes.status}`);
  const meta = await metaRes.json();
  const sheetProps = (meta.sheets || [])
    .map((s) => s.properties)
    .find((p) => String(p.sheetId) === String(GID));
  if (!sheetProps) throw new Error("找不到對應 gid 的分頁");

  const range = encodeURIComponent(`${sheetProps.title}!A1:Z1000`);
  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?key=${apiKey}`;
  const res = await fetch(valuesUrl);
  if (!res.ok) throw new Error(`Google Sheets API 回應 ${res.status}`);
  const data = await res.json();
  const rows = data.values;
  if (!rows || rows.length < 2) throw new Error("試算表沒有資料");

  const headers = rows[0].map(normalizeHeader);
  const colIndex = {};
  Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
    const idx = headers.findIndex((h) => aliases.map(normalizeHeader).includes(h));
    if (idx !== -1) colIndex[field] = idx;
  });
  if (colIndex.sku === undefined || colIndex.price === undefined) {
    throw new Error("試算表欄位格式異常，找不到商品編號或價格欄位");
  }

  const map = new Map();
  rows.slice(1).forEach((r) => {
    const sku = String(r[colIndex.sku] || "").trim();
    if (!sku) return;
    const orig = colIndex.orig !== undefined
      ? Number(String(r[colIndex.orig] || "").replace(/[^0-9.]/g, "")) || 0
      : 0;
    const rawPrice = Number(String(r[colIndex.price] || "").replace(/[^0-9.]/g, "")) || 0;
    const price = rawPrice > 0 ? rawPrice : orig; // 特價/售價沒填時，先用原價頂著，避免結帳金額算成 NT$0
    const stock = colIndex.stock !== undefined
      ? Number(String(r[colIndex.stock] || "").replace(/[^0-9.\-]/g, "")) || 0
      : 3;
    const name = colIndex.name !== undefined ? String(r[colIndex.name] || "").trim() : "";
    map.set(sku, { price, stock, name });
  });

  return map;
}

// ============================================================
// KV 快取層
// ============================================================
// 結帳這種高頻率操作，如果每次都直接打 Google Sheets API，量大時容易撞到
// Google 的配額限制，也讓每筆結帳多花不必要的時間。改成：
//   - KV 裡有「還沒過期」的快取 → 直接回傳快取，完全不打 Sheets API
//   - KV 沒有快取，或快取「過期」了 → 才真的打一次 Sheets API，
//     並把結果連同「現在的時間」一起存回 KV，供接下來 CACHE_TTL_MS
//     毫秒內的所有請求共用
//
// 效果：不管同一時間有幾筆訂單進來，每 CACHE_TTL_MS 毫秒最多只打 1 次
// Google Sheets API，其餘全部吃快取，大幅降低 API 呼叫次數。
//
// 需要在 Cloudflare Pages 設定一個 KV 命名空間並綁定變數名稱 PRODUCTS_KV，
// 步驟見 README-payuni-setup.md。如果沒有綁定 KV，會自動退回「每次都直接查」
// 的舊行為，不影響正確性，只是少了省 API 呼叫次數的效果。
// ============================================================

const CACHE_KEY = "products-cache-v1";
const CACHE_TTL_MS = 90 * 1000; // 90 秒，你可以依需求調整成 60~120 秒之間

/**
 * 取得商品資料，優先吃 KV 快取，快取過期或不存在才真的去查 Google Sheets。
 * @param {string} apiKey - Google Sheets API 金鑰
 * @param {KVNamespace} [kv] - Cloudflare KV 綁定（沒傳的話等同直接呼叫 fetchAuthoritativeProducts）
 * @returns {Promise<Map<string,{price:number, stock:number, name:string}>>}
 */
export async function getCachedProducts(apiKey, kv) {
  if (!kv) {
    // 沒有綁定 KV，直接查，正確性不受影響，只是沒有省到 API 呼叫次數
    return fetchAuthoritativeProducts(apiKey);
  }

  const cachedRaw = await kv.get(CACHE_KEY);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);
      const age = Date.now() - cached.timestamp;
      if (age < CACHE_TTL_MS) {
        return new Map(cached.entries); // 快取還新鮮，直接用，不打 Sheets API
      }
    } catch (e) {
      // 快取內容壞掉，當作沒有快取，往下走重新查
    }
  }

  // 快取不存在或已過期，真的去查一次 Google Sheets
  const map = await fetchAuthoritativeProducts(apiKey);

  // 存回 KV 給接下來的請求共用；這步失敗不影響這次結帳（只是這次沒省到而已）
  try {
    await kv.put(
      CACHE_KEY,
      JSON.stringify({ timestamp: Date.now(), entries: [...map.entries()] }),
      { expirationTtl: 300 } // KV 自己保留 5 分鐘，比 CACHE_TTL_MS 長一點，避免邊界情況查無資料
    );
  } catch (e) {
    console.warn("寫入 KV 快取失敗（不影響這次結帳）：", e.message);
  }

  return map;
}
