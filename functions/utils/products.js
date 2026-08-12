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
    const price = Number(String(r[colIndex.price] || "").replace(/[^0-9.]/g, "")) || 0;
    const stock = colIndex.stock !== undefined
      ? Number(String(r[colIndex.stock] || "").replace(/[^0-9.\-]/g, "")) || 0
      : 3;
    const name = colIndex.name !== undefined ? String(r[colIndex.name] || "").trim() : "";
    map.set(sku, { price, stock, name });
  });

  return map;
}
