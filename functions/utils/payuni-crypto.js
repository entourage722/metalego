// ============================================================
// PAYUNi 加解密共用工具（已對照官方文件與 Node.js 範例驗證正確）
// ============================================================
// 資料來源：https://docs.payuni.com.tw/web/#/7/56 （資料加密陣列／Node.js範例）
// 已用官方文件給的測試向量實際跑過，加密、SHA256、解密三項結果
// 都跟官方範例的答案逐字元比對一致，可以放心使用。
//
// 加密規格：
//   1. 明文：key1=val1&key2=val2... 的 query string 格式（用標準 URL encode）
//   2. 用 AES-256-GCM 加密（不是 CBC！這點很多網路上的舊文章會寫錯）
//   3. 加密結果 = base64(密文) + ":::" + base64(authTag)，這個字串本身再轉成 hex
//      → 這就是送給 PAYUNi 的 EncryptInfo 欄位值
//   4. HashInfo = SHA256(HashKey + EncryptInfo + HashIV)，取大寫 hex
//      → key 跟 iv 是「原始字串」直接接在前後，不是先轉過格式的版本
// ============================================================

/** 把 ArrayBuffer 轉成 base64 字串 */
function bufToBase64(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 字串轉回 ArrayBuffer */
function base64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** 字串轉 hex */
function strToHex(str) {
  return [...new TextEncoder().encode(str)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** hex 轉回原始字串 */
function hexToStr(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * PAYUNi AES-256-GCM 加密
 * @param {string} plainText - 明文（query string 格式，例：MerID=ABC&TradeAmt=100）
 * @param {string} hashKey - PAYUNi 後台給的 Hash Key（32 bytes）
 * @param {string} hashIV - PAYUNi 後台給的 Hash IV（16 bytes）
 * @returns {Promise<string>} EncryptInfo 欄位值（hex 字串）
 */
export async function payuniEncrypt(plainText, hashKey, hashIV) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(hashKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  // Web Crypto 的 AES-GCM 輸出格式是「密文+authTag」黏在一起（tag 在最後 16 bytes），
  // 但 PAYUNi 官方 Node.js 範例是用 Node crypto 模組，密文跟 tag 是分開拿的，
  // 所以這裡要手動把兩者切開，才能組成 PAYUNi 期待的「base64密文:::base64tag」格式。
  const result = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: enc.encode(hashIV), tagLength: 128 },
    cryptoKey,
    enc.encode(plainText)
  );

  const resultBytes = new Uint8Array(result);
  const cipherBytes = resultBytes.slice(0, resultBytes.length - 16);
  const tagBytes = resultBytes.slice(resultBytes.length - 16);

  const combined = `${bufToBase64(cipherBytes)}:::${bufToBase64(tagBytes)}`;
  return strToHex(combined);
}

/**
 * PAYUNi AES-256-GCM 解密（用在解讀 PAYUNi 回傳的 EncryptInfo）
 * @param {string} hexCipherText - PAYUNi 回傳的 EncryptInfo（hex 字串）
 * @param {string} hashKey
 * @param {string} hashIV
 * @returns {Promise<string>} 解密後的明文（query string 格式）
 */
export async function payuniDecrypt(hexCipherText, hashKey, hashIV) {
  const combined = hexToStr(hexCipherText);
  const [b64Cipher, b64Tag] = combined.split(":::");

  const cipherBytes = new Uint8Array(base64ToBuf(b64Cipher));
  const tagBytes = new Uint8Array(base64ToBuf(b64Tag));
  const full = new Uint8Array(cipherBytes.length + tagBytes.length);
  full.set(cipherBytes, 0);
  full.set(tagBytes, cipherBytes.length);

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(hashKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const result = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: enc.encode(hashIV), tagLength: 128 },
    cryptoKey,
    full
  );

  return new TextDecoder().decode(result);
}

/**
 * PAYUNi HashInfo：SHA256(HashKey + EncryptInfo + HashIV)，大寫 hex
 * @param {string} encryptInfoHex - payuniEncrypt() 算出來的 EncryptInfo
 * @param {string} hashKey
 * @param {string} hashIV
 * @returns {Promise<string>} HashInfo 欄位值
 */
export async function payuniSha256(encryptInfoHex, hashKey, hashIV) {
  const enc = new TextEncoder();
  const data = enc.encode(`${hashKey}${encryptInfoHex}${hashIV}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** 產生訂單編號：限制長度 25、只能英數字與底線/減號，10 分鐘內不可重複（PAYUNi 規定） */
export function generateOrderNo(prefix = "META") {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  // 格式：META20260810153045AB3F -> 21 字元，在 25 字元限制內
  return `${prefix}${y}${m}${d}${hh}${mm}${ss}${rand}`;
}
