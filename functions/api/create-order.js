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
// ⚠️ 還剩一個地方要等你確認：
//   - 目前預設會顯示所有已在 PAYUNi 後台開通的支付方式（不指定 Credit/LinePay 等參數）。
//     如果你只想開放信用卡+LINE Pay，之後可以加 Credit=1&LinePay=1 這類參數，
//     跟我說要開哪些支付方式即可調整。
// ============================================================

import { payuniEncrypt, payuniSha256, generateOrderNo } from "../utils/payuni-crypto.js";

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

  // 後端重新計算總金額，絕對不能相信前端傳來的金額（避免被竄改金額）
  // TODO：正式上線前，這裡要接你的商品資料來源（Google 試算表 / lego-data）
  //       重新核對每個 sku 當下的真實價格，目前先用前端傳來的 price 暫代。
  const totalAmount = Math.round(
    items.reduce((sum, item) => {
      const qty = Number(item.qty) || 0;
      const price = Number(item.price) || 0;
      return sum + qty * price;
    }, 0)
  );

  if (totalAmount <= 0) {
    return json({ ok: false, error: "訂單金額異常" }, 400);
  }

  const merTradeNo = generateOrderNo(); // 限制長度25、格式[A-Za-z0-9_-]，10分鐘內不可重複
  const origin = new URL(request.url).origin;

  const prodDesc = items
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
