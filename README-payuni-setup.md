# PAYUNi 串接設定說明

## 現在的狀態

已經對照 PAYUNi 官方文件（`docs.payuni.com.tw` 的「整合式支付頁 UNiPaypage」「資料加解密」章節）核對過，加解密邏輯也用官方給的測試向量實際驗證，結果逐字元一致：

- ✅ `functions/_utils/payuni-crypto.js`：AES-256-GCM 加解密 + SHA256 驗證碼，**已用官方測試向量驗證正確**
- ✅ `functions/api/create-order.js`：建立訂單、產生付款請求（欄位名稱、API 網址已對照文件確認）
- ✅ `functions/api/payuni-notify.js`：接收 PAYUNi 背景付款通知（含 HashInfo 驗證，防偽造）
- ✅ `functions/api/payuni-return.js`：接收顧客付款後導回的資料（解密後轉址到 thankyou.html）
- ✅ `thankyou.html`：依付款狀態（成功／處理中／審查中／失敗）顯示對應訊息
- ✅ 訂單記錄方式：已決定寫回 Google 試算表（見下方設定步驟）
- ⬜ 購物車「線上刷卡付款」按鈕：**還沒加到首頁**，等你確認金鑰跟試算表寫入測試沒問題再加上去

## 審核通過後，你要做的事

### 1. 到 PAYUNi 後台拿三組資料
登入 PAYUNi 後台 →「會員」→「商店清單」→ 選擇你的商店 →「串接設定」，複製：
- 商店代號（MerID）
- Hash Key
- Hash IV

### 2. 把這三組資料設定到 Cloudflare Pages（不是寫進程式碼！）

1. 登入 Cloudflare Dashboard → 選你的 `metalego` 專案
2. 左側選單找「Settings」→「Environment variables」
3. 新增這幾個環境變數：

   | 變數名稱 | 值 |
   |---|---|
   | `PAYUNI_MERID` | 你的商店代號 |
   | `PAYUNI_HASHKEY` | 你的 Hash Key |
   | `PAYUNI_HASHIV` | 你的 Hash IV |
   | `PAYUNI_SANDBOX` | 先設 `true`（測試區），正式上線前刪掉這個變數或改成 `false` |

4. Production 環境要設定，如果你有另外開 Preview 環境測試，也要設定一次
5. 存檔後，用 GitHub Desktop 隨便 commit 一次、push 上去讓 Cloudflare 重新部署套用

**為什麼不能寫進程式碼？** 因為程式碼會進到 GitHub 倉庫，任何人都看得到。用 Cloudflare 的環境變數，金鑰只存在 Cloudflare 伺服器端，不會出現在 GitHub 倉庫或瀏覽器裡。

### 3. 用測試區資料試跑一次

文件裡有提供測試卡號可以直接用（不會真的刷卡）：
- 一次付清：`4147631000000001`（卡片到期日、背面末三碼可任意填）
- 分期付款：`4147632000000001`

`PAYUNI_SANDBOX=true` 的狀態下，`create-order.js` 會自動打測試區網址（`sandbox-api.payuni.com.tw`），不會誤觸正式扣款。

### 4. 設定寫回 Google 試算表（訂單記錄方式：已選用試算表）

已改成用一份**全新、獨立的「訂單」試算表**專門記訂單（跟商品資料的試算表分開），裡面是空的，沒有其他 Apps Script，設定起來更單純：

**(1) 建立 Apps Script**
1. 打開「訂單」試算表：`https://docs.google.com/spreadsheets/d/1SxF9em8tcpua_LjhAnRwji211-nuNUHaj_tkYnReYHk/edit`
2. 上方選單「擴充功能」→「Apps Script」
3. 把預設程式碼刪掉，貼上 `google-apps-script-payuni-orders.gs` 這個檔案的內容
4. 把程式碼裡的 `SHARED_SECRET` 改成你自己設的一串密碼（隨便打，越亂越好），記下來，等下要用

**(2) 部署成網頁應用程式**
1. 右上角「部署」→「新增部署作業」
2. 類型選「網頁應用程式」
3. 執行身分：「我」
4. 誰可以存取：「所有人」（不用登入也能呼叫，靠密碼字串驗證，不是公開任何人都能看到你的試算表內容）
5. 部署後會給你一個網址（結尾 `/exec`），複製起來

**(3) 把兩組資料設定到 Cloudflare Pages 環境變數**

   | 變數名稱 | 值 |
   |---|---|
   | `GAS_WEBHOOK_URL` | 剛剛部署拿到的網址（結尾 /exec） |
   | `GAS_WEBHOOK_SECRET` | 你在 Apps Script 裡設定的那組密碼字串 |

設定方式跟 PAYUNi 金鑰一樣，Cloudflare Dashboard → 你的專案 → Settings → Environment variables，存檔後 commit push 一次讓它生效。

**(4) 效果**：之後每筆訂單付款通知進來，都會自動在試算表新增一列：時間、訂單編號、狀態、金額、付款方式、商品內容。

**之後如果要修改 Apps Script 程式碼**：改完不能只存檔，要「管理部署作業」→ 點鉛筆圖示編輯現有部署 → 版本選「新版本」→ 部署，網址才會套用最新程式碼（網址本身不會變）。

### 5. 開啟購物車的「線上刷卡付款」按鈕

前面幾步都測試沒問題後，跟我說一聲，我把按鈕加到購物車彈窗裡（跟現在的「LINE 預約時間取貨」並列），串上 `create-order.js`。

## 技術細節（給你參考，不用自己看懂也沒關係）

- 加密方式：**AES-256-GCM**（不是常見教學文章寫的 CBC，這點很多網路資源會搞錯）
- API 網址：
  - 測試區：`https://sandbox-api.payuni.com.tw/api/upp`
  - 正式區：`https://api.payuni.com.tw/api/upp`
- 送出方式：瀏覽器端用 HTML `<form>` POST（不是 fetch API 直接呼叫）
- 訂單編號規則：英數字加底線/減號、限制 25 字元內、10 分鐘內不可重複（`generateOrderNo()` 已符合）
- 金額一律由後端（`create-order.js`）重新計算，不相信前端傳來的金額，防止被竄改
- 付款結果驗證：`payuni-notify.js` 收到通知後會重新計算 HashInfo 比對，確認不是偽造請求才處理
