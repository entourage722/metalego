// ============================================================
// POST /api/payuni-notify
// 顧客付款完成後，PAYUNi 的伺服器會 Form Post 呼叫這支網址，通知付款結果。
//
// 已對照官方文件確認：
//   - https://docs.payuni.com.tw/web/#/7/80 （整合式支付 UNiPaypage Notify）
//   - 通知格式跟 ReturnURL 是同一套：Form Post，欄位為
//     MerID / Version / EncryptInfo / HashInfo（EncryptInfo 解密後可拿到
//     Status / MerTradeNo / TradeAmt / TradeStatus / PaymentType 等交易明細）
//   - 加解密邏輯已用官方測試向量驗證正確（見 payuni-crypto.js）
//
// 訂單記錄方式：收到付款通知後，呼叫 Google Apps Script Web App，
// 把訂單資料寫進獨立的「訂單」Google 試算表。
// Apps Script 程式碼跟部署步驟見 google-apps-script-payuni-orders.gs
// 與 README-payuni-setup.md。
// ============================================================

import { payuniDecrypt, payuniSha256 } from "../utils/payuni-crypto.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const HASH_KEY = env.PAYUNI_HASHKEY;
  const HASH_IV = env.PAYUNI_HASHIV;

  if (!HASH_KEY || !HASH_IV) {
    return new Response("金鑰未設定", { status: 500 });
  }

  const form = await request.formData();
  const merID = form.get("MerID");
  const encryptInfo = form.get("EncryptInfo");
  const hashInfo = form.get("HashInfo");

  if (!merID || !encryptInfo || !hashInfo) {
    return new Response("缺少必要欄位", { status: 400 });
  }

  // 驗證 HashInfo：自己重新算一次 SHA256，確認跟 PAYUNi 送來的一致，
  // 這一步是防止有人偽造付款成功通知的關鍵，絕對不能省略。
  const expectedHash = await payuniSha256(encryptInfo, HASH_KEY, HASH_IV);
  if (expectedHash !== hashInfo) {
    return new Response("HashInfo 驗證失敗，可能是偽造請求", { status: 400 });
  }

  let decrypted;
  try {
    decrypted = await payuniDecrypt(encryptInfo, HASH_KEY, HASH_IV);
  } catch (e) {
    return new Response("解密失敗", { status: 400 });
  }

  // decrypted 是 key1=val1&key2=val2 格式，解析成物件
  const result = Object.fromEntries(new URLSearchParams(decrypted));

  // 依官方文件「返回參數」：
  //   result.Status         SUCCESS=成功 / UNKNOWN=等待授權結果逾期 / UNAPPROVED=審查中
  //   result.MerTradeNo     商店訂單編號（就是 create-order.js 產生的 merTradeNo）
  //   result.TradeAmt       訂單金額
  //   result.TradeStatus    0=取號成功 1=已付款 2=付款失敗 3=付款取消 8=訂單待確認
  //   result.PaymentType    1=信用卡 2=ATM 3=超商代碼 9=LinePay ...(其餘見文件)

  const isPaid = result.Status === "SUCCESS" && result.TradeStatus === "1";

  console.log(`PAYUNi 付款通知：訂單 ${result.MerTradeNo}，狀態 ${result.Status}，是否已付款：${isPaid}`);

  // 寫回 Google 試算表；就算這步失敗也不能讓 PAYUNi 收到錯誤狀態（不然它會一直重試通知），
  // 所以這裡包 try/catch，失敗只記錄 log，不影響下面回傳 200。
  try {
    await writeToSheet(env, result, isPaid);
  } catch (e) {
    console.error("寫回試算表失敗：", e.message);
  }

  // PAYUNi 收到 200 OK 視為成功接收通知；若回傳非 200，PAYUNi 會依機制重試通知。
  return new Response("OK", { status: 200 });
}

const PAYMENT_TYPE_MAP = {
  "1": "信用卡", "2": "ATM轉帳", "3": "超商代碼",
  "5": "超商取貨付款", "6": "愛金卡", "7": "先享後付",
  "9": "LINE Pay", "10": "宅配到付", "11": "街口支付",
};

/**
 * 呼叫 Google Apps Script Web App，把訂單資料寫進試算表。
 * 需要在 Cloudflare 環境變數設定：
 *   GAS_WEBHOOK_URL    - Apps Script 部署後拿到的網址（結尾 /exec）
 *   GAS_WEBHOOK_SECRET - 跟 Apps Script 程式碼裡 SHARED_SECRET 要一致的密碼字串
 * 設定步驟見 README-payuni-setup.md
 */
async function writeToSheet(env, result, isPaid) {
  const url = env.GAS_WEBHOOK_URL;
  const secret = env.GAS_WEBHOOK_SECRET;

  if (!url || !secret) {
    console.warn("尚未設定 GAS_WEBHOOK_URL / GAS_WEBHOOK_SECRET，略過寫回試算表");
    return;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret,
      orderNo: result.MerTradeNo || "",
      status: isPaid ? "已付款" : result.Status || "",
      amount: result.TradeAmt || "",
      paymentType: PAYMENT_TYPE_MAP[result.PaymentType] || "",
      itemDesc: result.ProdDesc || "",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Apps Script 回應 ${res.status}：${errText}`);
  }
}
