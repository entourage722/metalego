// ============================================================
// POST /api/payuni-return
// 顧客付款完成後，瀏覽器會被 PAYUNi「Form Post」導回這支網址
// （這是 create-order.js 裡設定的 ReturnURL）。
//
// 跟 payuni-notify.js 收到的資料格式完全一樣（MerID/Version/EncryptInfo/HashInfo），
// 差別只在於：這支是「顧客瀏覽器」導回看到的，notify.js 是「PAYUNi 伺服器」背景通知的。
// 正式標記訂單付款狀態要以 notify.js 收到的為準（比較不會被中途攔截竄改），
// 這支主要負責「解密後，把結果轉成網址參數，導向靜態的 thankyou.html 頁面顯示給顧客看」。
// ============================================================

import { payuniDecrypt, payuniSha256 } from "../_utils/payuni-crypto.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = new URL(request.url).origin;

  const HASH_KEY = env.PAYUNI_HASHKEY;
  const HASH_IV = env.PAYUNI_HASHIV;

  if (!HASH_KEY || !HASH_IV) {
    return Response.redirect(`${origin}/thankyou.html?status=error`, 302);
  }

  try {
    const form = await request.formData();
    const encryptInfo = form.get("EncryptInfo");
    const hashInfo = form.get("HashInfo");

    if (!encryptInfo || !hashInfo) {
      return Response.redirect(`${origin}/thankyou.html?status=error`, 302);
    }

    const expectedHash = await payuniSha256(encryptInfo, HASH_KEY, HASH_IV);
    if (expectedHash !== hashInfo) {
      return Response.redirect(`${origin}/thankyou.html?status=error`, 302);
    }

    const decrypted = await payuniDecrypt(encryptInfo, HASH_KEY, HASH_IV);
    const result = Object.fromEntries(new URLSearchParams(decrypted));

    const params = new URLSearchParams({
      orderNo: result.MerTradeNo || "",
      status: result.Status || "UNKNOWN",
      amount: result.TradeAmt || "",
    });

    return Response.redirect(`${origin}/thankyou.html?${params.toString()}`, 302);
  } catch (e) {
    return Response.redirect(`${origin}/thankyou.html?status=error`, 302);
  }
}
