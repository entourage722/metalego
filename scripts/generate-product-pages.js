#!/usr/bin/env node
/**
 * 產生每個商品的靜態 HTML 頁面（SEO 用）
 * ============================================================
 * 用途：讀取商品 Google 試算表，幫每一筆商品產生一個真正的靜態 HTML 檔案，
 *      放在 products/{sku}/index.html，讓 Google 能個別收錄每個商品頁面，
 *      而不是只有一頁 SPA（單頁式網站，Google 比較難收錄裡面個別商品）。
 *
 * 執行方式：
 *   SHEETS_API_KEY=xxx node scripts/generate-product-pages.js
 * 由 .github/workflows/generate-product-pages.yml 排程執行，
 * 執行完會把新增/更新的 products/ 資料夾 commit 回倉庫，
 * Cloudflare Pages 偵測到 GitHub 有新的 commit 就會自動重新部署。
 *
 * 跟現有的價格監控 GitHub Actions 用的是同一套邏輯：讀 Sheet → 產生檔案 → commit。
 * ============================================================
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SITE_URL = "https://metatoylego.com"; // 正式網域，SEO標籤要用完整網址
const SPREADSHEET_ID = "1C5-V2M1dn8ljDhwGvNA5wD0kNCu_HOdEHnRsgZ9TlBs";
const GID = "1498552544";
const SHEETS_API_KEY = process.env.SHEETS_API_KEY;

if (!SHEETS_API_KEY) {
  console.error("錯誤：缺少環境變數 SHEETS_API_KEY，無法讀取商品試算表");
  process.exit(1);
}

// ============================================================
// 商品分類判斷邏輯（跟 index.html 裡的判斷邏輯保持一致）
// ============================================================

function loadJson(relPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf-8"));
  } catch (e) {
    console.warn(`讀取 ${relPath} 失敗，使用空資料代替：${e.message}`);
    return fallback;
  }
}

const LEGO_SETS = loadJson("lego-data/sets-lookup.json", {});
const LEGO_MINIFIGS = loadJson("lego-data/minifigs-lookup.json", {});
const LEGO_ELEMENTS = loadJson("lego-data/elements-lookup.json", {});
const LEGO_PARTS = loadJson("lego-data/parts-lookup.json", {});
const LEGO_PART_CATS = loadJson("lego-data/part-categories.json", {});

const MINIFIG_PART_CAT_IDS = new Set(["13", "27", "59", "60", "61", "65", "70", "71", "72", "73"]);

const THEME_TRANSLATE = {
  "Star Wars": "星際大戰", "City": "城市 City", "Technic": "科技 Technic", "Friends": "好朋友",
  "Ninjago": "忍者 NINJAGO", "Icons": "Icons", "LEGO Ideas and CUUSOO": "IDEAS", "Architecture": "建築",
  "LEGO Art": "Art", "Harry Potter": "哈利波特", "Super Heroes Marvel": "漫威英雄", "Super Heroes DC": "DC 系列",
  "Minecraft": "Minecraft", "Duplo": "得寶 DUPLO", "Disney": "迪士尼", "Speed Champions": "極速賽車",
  "Creator": "三合一創意", "Jurassic World": "侏儸紀", "One Piece": "航海王", "Super Mario": "瑪利歐",
  "Sonic The Hedgehog": "音速小子", "Animal Crossing": "動物森友會", "Gabby's Dollhouse": "蓋比娃娃屋",
  "Classic": "經典 Classic", "Collectible Minifigures": "人偶收藏", "Botanicals": "植物典藏",
  "KPop Demon Hunters": "Kpop 獵魔女團", "Seasonal": "節慶系列", "Brickheadz": "BrickHeadz",
};
function translateTheme(name) { return THEME_TRANSLATE[name] || name; }

function categorizeElement(elementId) {
  const el = LEGO_ELEMENTS[elementId];
  if (!el) return null;
  const [partNum] = el;
  return categorizePartNum(partNum);
}
function categorizePartNum(partNum) {
  const part = LEGO_PARTS[partNum];
  if (!part) return null;
  const [, catId] = part;
  if (MINIFIG_PART_CAT_IDS.has(String(catId))) return "人偶 Minifigures";
  return "零件・" + (LEGO_PART_CATS[catId] || "其他零件");
}
function looksLikeBricklinkFig(sku) { return /^[a-z]{2,6}\d{1,5}[a-z]?$/i.test(sku); }
function looksLikeCollectibleFig(sku) { return /^col\d{1,3}-\d{1,3}$/i.test(sku); }

function lookupCategory(sku) {
  const key = String(sku).trim();
  if (LEGO_SETS[key]) return translateTheme(LEGO_SETS[key].t);
  if (LEGO_MINIFIGS[key] || /^fig-/i.test(key)) return "人偶 Minifigures";
  const elCat = categorizeElement(key);
  if (elCat) return elCat;
  const partCat = categorizePartNum(key);
  if (partCat) return partCat;
  if (looksLikeCollectibleFig(key)) return "人偶收藏";
  if (looksLikeBricklinkFig(key)) return "人偶 Minifigures";
  return "其他";
}
function lookupFallbackName(sku) {
  const key = String(sku).trim();
  if (LEGO_SETS[key]) return LEGO_SETS[key].n;
  if (LEGO_MINIFIGS[key]) return LEGO_MINIFIGS[key].n;
  return "";
}
function lookupYear(sku) {
  const set = LEGO_SETS[String(sku).trim()];
  return set && set.y ? String(set.y) : "";
}

// 主題圖示對照表（跟 index.html 的 themeIconMap 保持一致）
const THEME_ICON_MAP = {
  "蓋比娃娃屋":"🏠","Icons":"🏛️","建築":"🏙️","IDEAS":"💡","Minecraft":"⛏️",
  "Art":"🎨","Iconic":"🎃","科技 Technic":"⚙️","好朋友":"💛","Editions":"💿",
  "瑪利歐":"🍄","Kpop 獵魔女團":"🎤","星際大戰":"🚀","航海王":"🏴‍☠️",
  "超級英雄":"🦸","動物森友會":"🍃","音速小子":"💨","極速賽車":"🏎️","侏儸紀":"🦖",
  "城市 City":"🏙️","忍者 NINJAGO":"🥷","經典 Classic":"🧩","哈利波特":"🪄",
  "漫威英雄":"🦸","DC 系列":"🦇","當個創世神":"⛏️","得寶 DUPLO":"🧸",
  "迪士尼":"🐭","三合一創意":"🧑‍🎨","人偶收藏":"🧍","人偶 Minifigures":"🧍",
  "BrickHeadz":"🧠","植物典藏":"🌿","節慶系列":"🎄","其他":"🧱",
};
function themeIcon(cat) { return THEME_ICON_MAP[cat] || "🧱"; }

// ============================================================
// 讀取商品試算表
// ============================================================

const HEADER_ALIASES = {
  sku: ["sku", "商品編號", "編號"],
  name: ["name", "商品名稱", "名稱"],
  price: ["price", "特價", "售價"],
  orig: ["orig", "original", "原價"],
  stock: ["stock", "庫存", "庫存量", "數量"],
};
function normalizeHeader(h) { return String(h || "").trim().toLowerCase(); }

async function fetchSheetRows() {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?key=${SHEETS_API_KEY}&fields=sheets.properties`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) throw new Error(`讀取試算表結構失敗：${metaRes.status} ${await metaRes.text()}`);
  const meta = await metaRes.json();
  const sheetProps = (meta.sheets || []).map((s) => s.properties).find((p) => String(p.sheetId) === String(GID));
  if (!sheetProps) throw new Error("找不到對應 gid 的分頁");

  const range = encodeURIComponent(`${sheetProps.title}!A1:Z1000`);
  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?key=${SHEETS_API_KEY}`;
  const res = await fetch(valuesUrl);
  if (!res.ok) throw new Error(`讀取商品資料失敗：${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.values;
}

function mapRowsToProducts(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  const colIndex = {};
  Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
    const idx = headers.findIndex((h) => aliases.map(normalizeHeader).includes(h));
    if (idx !== -1) colIndex[field] = idx;
  });
  if (colIndex.sku === undefined || colIndex.name === undefined) return [];

  return rows
    .slice(1)
    .filter((r) => r[colIndex.sku])
    .map((r) => {
      const sku = String(r[colIndex.sku]).trim();
      const rawName = String(r[colIndex.name] || "").trim();
      const stock = colIndex.stock !== undefined ? Number(String(r[colIndex.stock]).replace(/[^0-9.\-]/g, "")) || 0 : 3;
      const orig = colIndex.orig !== undefined ? Number(String(r[colIndex.orig]).replace(/[^0-9.]/g, "")) || 0 : 0;
      const rawPrice = colIndex.price !== undefined ? Number(String(r[colIndex.price]).replace(/[^0-9.]/g, "")) || 0 : 0;
      return {
        sku,
        name: rawName || lookupFallbackName(sku) || sku,
        cat: lookupCategory(sku),
        year: lookupYear(sku),
        price: rawPrice > 0 ? rawPrice : orig, // 特價/售價沒填時，先用原價頂著，避免顯示 NT$0
        orig,
        stock,
        soldOut: stock <= 0,
      };
    });
}

// ============================================================
// 圖片檢查（跟網站前台的命名慣例一致：sku.jpg / sku.png / sku-1.jpg / sku-1.png，
// 額外照片 sku-2 ~ sku-4）
// ============================================================

function findImages(sku) {
  const imagesDir = path.join(ROOT, "images");
  const candidates = [`${sku}.jpg`, `${sku}.png`, `${sku}-1.jpg`, `${sku}-1.png`];
  let main = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(imagesDir, c))) { main = c; break; }
  }
  const gallery = [];
  if (main) gallery.push(main);
  for (let i = 2; i <= 4; i++) {
    for (const ext of ["jpg", "png"]) {
      const file = `${sku}-${i}.${ext}`;
      if (fs.existsSync(path.join(imagesDir, file))) { gallery.push(file); break; }
    }
  }
  return { main, gallery };
}

// ============================================================
// 產生單一商品頁面的 HTML
// ============================================================

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderProductPage(p, images) {
  const url = `${SITE_URL}/products/${p.sku}/`;
  const title = `${p.name}（${p.sku}）｜你想像的樂高倉庫`;
  const priceText = `NT$${p.price.toLocaleString()}`;
  const descParts = [p.name, p.cat, p.year ? `${p.year}年` : "", p.soldOut ? "目前無庫存" : `現貨 ${priceText}`, "原封整套／拆售單顆／缺件補件"];
  const description = descParts.filter(Boolean).join("・");
  const mainImageUrl = images.main ? `${SITE_URL}/images/${images.main}` : `${SITE_URL}/images/og-default.jpg`;
  const stockLabel = p.soldOut ? "無庫存" : (p.stock <= 2 ? `庫存量小 ${p.stock} 件` : "現貨供應");

  const galleryHtml = images.gallery.length > 1
    ? images.gallery.map((f, i) => `<img src="../../images/${f}" alt="${escapeHtml(p.name)} 照片${i + 1}" loading="lazy" class="thumb${i === 0 ? " active" : ""}" data-idx="${i}">`).join("\n        ")
    : "";

  const jsonLd = {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": p.name,
    "sku": p.sku,
    "category": p.cat,
    "image": mainImageUrl,
    "description": description,
    "offers": {
      "@type": "Offer",
      "url": url,
      "priceCurrency": "TWD",
      "price": p.price,
      "availability": p.soldOut ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
    },
  };

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="product">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${mainImageUrl}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='14' y='6' width='14' height='12' rx='2' fill='%23d2001f' stroke='%231a1a2e' stroke-width='3'/%3E%3Crect x='36' y='6' width='14' height='12' rx='2' fill='%23d2001f' stroke='%231a1a2e' stroke-width='3'/%3E%3Crect x='6' y='16' width='52' height='40' rx='7' fill='%23d2001f' stroke='%231a1a2e' stroke-width='3.5'/%3E%3C/svg%3E">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;700;900&family=Baloo+2:wght@700;800&display=swap" rel="stylesheet">
<style>
  :root{ --ink:#1a1a2e; --red:#d2001f; --red-dark:#a5001a; --yellow:#ffcd00; --cream:#fff6e6; --card:#fff; --shadow:4px 4px 0 rgba(26,26,46,0.9); }
  *{box-sizing:border-box;}
  body{margin:0; background:var(--cream); font-family:'Noto Sans TC',sans-serif; color:var(--ink); line-height:1.6;}
  .site-header{background:var(--yellow); border-bottom:4px solid var(--ink); padding:14px 20px;}
  .header-inner{max-width:1180px; margin:0 auto; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;}
  .logo-block{display:flex; align-items:center; gap:12px; text-decoration:none; color:var(--ink);}
  .logo-brick{width:44px; height:44px; flex-shrink:0;}
  .logo-text .title{font-family:'Baloo 2',sans-serif; font-weight:800; font-size:19px; line-height:1.2;}
  .logo-text .subtitle{font-size:11.5px; color:var(--red-dark); font-weight:700; margin-top:2px;}
  .header-contact{display:flex; align-items:center; gap:10px; flex-wrap:wrap;}
  .btn-line-header{display:inline-flex; align-items:center; gap:6px; background:#06c755; color:#fff; font-weight:900; text-decoration:none; padding:9px 16px; border-radius:10px; border:3px solid var(--ink); box-shadow:var(--shadow); font-size:13.5px; white-space:nowrap;}
  .cart-badge{display:inline-flex; align-items:center; gap:4px; background:var(--ink); color:#fff; font-weight:700; text-decoration:none; padding:9px 14px; border-radius:10px; border:3px solid #fff; box-shadow:var(--shadow); font-size:13px; white-space:nowrap; cursor:pointer; font-family:'Noto Sans TC', sans-serif;}
  main{max-width:760px; margin:0 auto; padding:20px 16px 60px;}
  .breadcrumb{font-size:13px; color:#777; margin-bottom:14px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;}
  .breadcrumb a{color:var(--red-dark); text-decoration:none;}
  .cat-btn{display:inline-flex; align-items:center; gap:5px; background:#fff; color:var(--red-dark); text-decoration:none; font-weight:700; font-size:12.5px; padding:5px 11px; border:2px solid var(--ink); border-radius:20px; box-shadow:2px 2px 0 rgba(26,26,46,0.9);}
  .home-icon{width:14px; height:14px; flex-shrink:0;}
  .cat-btn:hover{background:var(--yellow);}
  .card{background:var(--card); border:3px solid var(--ink); border-radius:14px; box-shadow:var(--shadow); overflow:hidden;}
  .thumb-main{width:100%; aspect-ratio:1/1; background:var(--red); display:flex; align-items:center; justify-content:center; border-bottom:3px solid var(--ink);}
  .thumb-main img{width:100%; height:100%; object-fit:contain; background:#fff;}
  .thumb-main .fallback{font-size:64px;}
  .gallery{display:flex; gap:8px; padding:10px 14px; overflow-x:auto;}
  .gallery img{width:60px; height:60px; object-fit:cover; border:2px solid var(--ink); border-radius:6px; cursor:pointer; flex:none;}
  .gallery img.active{border-color:var(--red);}
  .body{padding:16px 20px 24px;}
  .cat{color:var(--red-dark); font-weight:700; font-size:13px;}
  .name{font-size:20px; font-weight:900; margin:6px 0 10px; line-height:1.3;}
  .sku{color:#888; font-size:12.5px; margin-bottom:14px;}
  .price-row{display:flex; align-items:baseline; gap:10px; margin-bottom:6px;}
  .price{font-family:'Baloo 2',sans-serif; font-weight:800; color:var(--red-dark); font-size:28px;}
  .orig{color:#999; text-decoration:line-through; font-size:15px;}
  .stock{font-size:13px; color:${p.soldOut ? "#999" : (p.stock <= 2 ? "#d9822b" : "#2a8f4f")}; font-weight:700; margin-bottom:18px;}
  .btn-line{display:inline-flex; align-items:center; gap:8px; line-height:1; background:#06c755; color:#fff; font-weight:900; text-decoration:none; padding:13px 20px; border-radius:10px; border:3px solid var(--ink); box-shadow:var(--shadow); font-size:15px;}
  .action-row{display:flex; gap:10px; flex-wrap:wrap; align-items:center;}
  .btn-add-cart{display:inline-flex; align-items:center; justify-content:center; line-height:1; background:var(--ink); color:#fff; border:3px solid var(--ink); box-shadow:var(--shadow); border-radius:10px; padding:13px 20px; font-size:15px; font-weight:900; cursor:pointer; font-family:'Noto Sans TC', sans-serif;}
  .btn-add-cart:hover{background:var(--red);}
  .btn-add-cart:disabled{background:#ccc; cursor:not-allowed;}
  .btn-back{display:inline-block; margin-top:18px; color:var(--red-dark); font-weight:700; text-decoration:none; font-size:14px;}
  .note{margin-top:22px; font-size:13px; color:#777; border-top:1px dashed #ddd; padding-top:14px;}

  /* ---------- 購物車彈窗（跟首頁樣式一致） ---------- */
  .cart-modal-overlay{display:none; position:fixed; inset:0; background:rgba(26,26,46,0.55); z-index:1000; align-items:center; justify-content:center; padding:16px;}
  .cart-modal-overlay.open{display:flex;}
  .cart-modal{background:var(--cream); border:3px solid var(--ink); border-radius:12px; box-shadow:var(--shadow); width:100%; max-width:480px; max-height:80vh; display:flex; flex-direction:column; overflow:hidden;}
  .cart-modal-head{background:var(--red); color:#fff; font-weight:900; font-size:16px; padding:14px 18px; display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid var(--ink);}
  .cart-close-btn{background:none; border:none; color:#fff; font-size:18px; cursor:pointer; line-height:1;}
  .cart-modal-body{padding:12px 18px; overflow-y:auto; flex:1;}
  .cart-empty{text-align:center; color:#999; padding:30px 0; font-size:13.5px;}
  .cart-item{display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px dashed #ddd;}
  .cart-item-info{flex:1; min-width:0;}
  .cart-item-name{font-size:13px; font-weight:700; margin-bottom:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
  .cart-item-price{font-size:12px; color:var(--red-dark); font-weight:700;}
  .cart-item-qty{display:flex; align-items:center; gap:6px; flex:none;}
  .cart-item-qty button{width:24px; height:24px; border:2px solid var(--ink); background:#eee; border-radius:6px; cursor:pointer; font-weight:900; font-size:13px; line-height:1;}
  .cart-item-qty button:hover{background:var(--yellow);}
  .cart-item-qty button:disabled{background:#eee; color:#bbb; cursor:not-allowed;}
  .cart-item-qty button:disabled:hover{background:#eee;}
  .cart-item-maxnote{color:var(--red-dark); font-weight:700; margin-left:4px;}
  .cart-item-qty span{min-width:18px; text-align:center; font-weight:700; font-size:13px;}
  .cart-item-remove{flex:none; background:none; border:none; color:#bbb; cursor:pointer; font-size:15px; padding:4px;}
  .cart-item-remove:hover{color:var(--red);}
  .cart-modal-foot{padding:14px 18px; border-top:3px solid var(--ink); background:#fff;}
  .cart-modal-total{font-weight:900; font-size:16px; margin-bottom:10px; text-align:right; color:var(--red-dark);}
  .cart-modal-btns{display:flex; gap:8px;}
  .cart-modal-btns .btn{flex:1; display:inline-flex; align-items:center; justify-content:center; gap:6px; text-decoration:none; font-weight:900; padding:11px; border-radius:8px; border:3px solid var(--ink); font-size:13.5px; cursor:pointer; font-family:'Noto Sans TC', sans-serif;}
  .btn-tel{background:#fff; color:var(--ink);}
  .cart-modal-btns .btn-line{background:#06c755; color:#fff; box-shadow:none; padding:11px;}
</style>
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a class="logo-block" href="../../index.html" title="回到首頁">
        <svg class="logo-brick" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <rect x="14" y="6" width="14" height="12" rx="2" fill="#d2001f" stroke="#1a1a2e" stroke-width="3"/>
          <rect x="36" y="6" width="14" height="12" rx="2" fill="#d2001f" stroke="#1a1a2e" stroke-width="3"/>
          <rect x="6" y="16" width="52" height="40" rx="7" fill="#d2001f" stroke="#1a1a2e" stroke-width="3.5"/>
        </svg>
        <div class="logo-text">
          <div class="title">你想像的樂高倉庫</div>
          <div class="subtitle">原封整套・拆售單顆・缺件補件・開倉出清！</div>
        </div>
      </a>
      <div class="header-contact">
        <a class="btn-line-header" href="https://line.me/ti/p/7hy1HnSChM">💬 LINE 詢問</a>
        <button type="button" class="cart-badge" id="cart-badge-btn">
          🛒 購物車　<span id="cart-count">0</span> 件｜NT$<span id="cart-total">0</span>
        </button>
      </div>
    </div>
  </header>
  <main>
    <div class="breadcrumb">
      <a class="cat-btn" href="../../index.html" title="回首頁">
        <svg class="home-icon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <rect x="14" y="6" width="14" height="12" rx="2" fill="#d2001f" stroke="#1a1a2e" stroke-width="3"/>
          <rect x="36" y="6" width="14" height="12" rx="2" fill="#d2001f" stroke="#1a1a2e" stroke-width="3"/>
          <rect x="6" y="16" width="52" height="40" rx="7" fill="#d2001f" stroke="#1a1a2e" stroke-width="3.5"/>
        </svg>
        首頁
      </a> ／
      <a class="cat-btn" href="../../index.html?theme=${encodeURIComponent(p.cat)}" title="回首頁看更多「${escapeHtml(p.cat)}」商品">${themeIcon(p.cat)} ${escapeHtml(p.cat)}</a>
      ／ ${escapeHtml(p.sku)}
    </div>
    <div class="card">
      <div class="thumb-main">
        ${images.main ? `<img src="../../images/${images.main}" alt="${escapeHtml(p.name)}">` : `<div class="fallback">🧱</div>`}
      </div>
      ${images.gallery.length > 1 ? `<div class="gallery">\n        ${galleryHtml}\n      </div>` : ""}
      <div class="body">
        <div class="cat">${escapeHtml(p.cat)}${p.year ? `・${p.year}年` : ""}</div>
        <h1 class="name">${escapeHtml(p.name)}</h1>
        <div class="sku">商品編號：${escapeHtml(p.sku)}</div>
        <div class="price-row">
          ${p.orig > p.price ? `<span class="orig">NT$${p.orig.toLocaleString()}</span>` : ""}
          <span class="price">NT$${p.price.toLocaleString()}</span>
        </div>
        <div class="stock">${stockLabel}</div>
        <div class="action-row">
          <a class="btn-line" href="https://line.me/ti/p/7hy1HnSChM">💬 LINE 詢問這件商品</a>
          <button type="button" class="btn-add-cart" id="add-cart-btn"
            data-sku="${escapeHtml(p.sku)}" data-name="${escapeHtml(p.name)}"
            data-price="${p.price}" data-stock="${p.stock}"
            ${p.soldOut ? "disabled" : ""}>
            ${p.soldOut ? "無庫存" : "🛒 加入購物車"}
          </button>
        </div>
        <div>
          <a class="btn-back" href="../../index.html">← 回商店繼續逛逛</a>
        </div>
        <div class="note">原封整套・拆售單顆・缺件補件・開倉出清！歡迎來訊詢問缺件。</div>
      </div>
    </div>
  </main>

  <!-- 購物車彈窗 -->
  <div id="cart-modal-overlay" class="cart-modal-overlay">
    <div class="cart-modal">
      <div class="cart-modal-head">
        <span>🛒 購物車</span>
        <button type="button" id="cart-close-btn" class="cart-close-btn">✕</button>
      </div>
      <div id="cart-modal-body" class="cart-modal-body">
        <!-- 購物車內容由 JS 產生 -->
      </div>
      <div class="cart-modal-foot">
        <div class="cart-modal-total">總計：NT$<span id="cart-modal-total">0</span></div>
        <div class="cart-modal-btns">
          <button type="button" id="cart-copy-btn" class="btn btn-tel">📋 複製清單</button>
          <a id="cart-checkout-btn" class="btn btn-line" href="https://line.me/ti/p/7hy1HnSChM">💬 LINE 預約時間取貨</a>
        </div>
      </div>
    </div>
  </div>
  <script>
    document.querySelectorAll('.gallery img').forEach(img => {
      img.addEventListener('click', () => {
        document.querySelector('.thumb-main img').src = img.src;
        document.querySelectorAll('.gallery img').forEach(i => i.classList.remove('active'));
        img.classList.add('active');
      });
    });
    // 跟首頁共用同一把 localStorage 鑰匙，讓購物車資料在商品頁跟首頁之間同步
    const CART_KEY = 'brickWarehouseCart';
    function loadCart() {
      try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; }
      catch (e) { return {}; }
    }
    function saveCart(cart) {
      try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {}
    }
    function getCartItems() { return Object.values(loadCart()); }
    function getCartTotal() { return getCartItems().reduce((sum, i) => sum + i.qty * i.price, 0); }
    function refreshCartBadge() {
      const items = getCartItems();
      const count = items.reduce((sum, i) => sum + i.qty, 0);
      document.getElementById('cart-count').textContent = count;
      document.getElementById('cart-total').textContent = getCartTotal().toLocaleString();
    }
    refreshCartBadge();

    // 加入購物車按鈕：邏輯跟首頁一致（庫存上限檢查、達上限時顯示提示文字後還原）
    const addBtn = document.getElementById('add-cart-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const sku = addBtn.dataset.sku;
        const name = addBtn.dataset.name;
        const price = Number(addBtn.dataset.price);
        const stock = Number(addBtn.dataset.stock);
        const cart = loadCart();
        const currentQty = cart[sku] ? cart[sku].qty : 0;
        const original = '🛒 加入購物車';

        if (currentQty >= stock) {
          addBtn.textContent = '已達庫存上限';
          setTimeout(() => { addBtn.textContent = original; }, 1000);
          return;
        }
        if (cart[sku]) { cart[sku].qty += 1; }
        else { cart[sku] = { sku, name, price, qty: 1, stock }; }
        saveCart(cart);
        refreshCartBadge();
        addBtn.textContent = '✓ 已加入';
        setTimeout(() => { addBtn.textContent = original; }, 1000);
      });
    }

    // ---- 購物車彈窗：直接在這頁顯示，不用跳回首頁 ----
    function renderCartModal() {
      const body = document.getElementById('cart-modal-body');
      const items = getCartItems();
      if (items.length === 0) {
        body.innerHTML = '<p class="cart-empty">購物車還是空的，去挑幾件喜歡的積木吧！</p>';
      } else {
        body.innerHTML = items.map(i => {
          // 這頁沒有完整商品清單可查即時庫存，用加入購物車當下記錄的庫存數字判斷上限
          const maxStock = (typeof i.stock === 'number') ? i.stock : Infinity;
          const atMax = i.qty >= maxStock;
          const maxNote = atMax ? ('<span class="cart-item-maxnote">（庫存僅剩 ' + maxStock + ' 件）</span>') : '';
          return '' +
            '<div class="cart-item">' +
              '<div class="cart-item-info">' +
                '<div class="cart-item-name">' + i.name + '</div>' +
                '<div class="cart-item-price">NT$' + i.price.toLocaleString() + ' ／ 件' + maxNote + '</div>' +
              '</div>' +
              '<div class="cart-item-qty">' +
                '<button type="button" data-action="dec" data-sku="' + i.sku + '">−</button>' +
                '<span>' + i.qty + '</span>' +
                '<button type="button" data-action="inc" data-sku="' + i.sku + '"' + (atMax ? ' disabled' : '') + '>＋</button>' +
              '</div>' +
              '<button type="button" class="cart-item-remove" data-action="remove" data-sku="' + i.sku + '">✕</button>' +
            '</div>';
        }).join('');
      }
      document.getElementById('cart-modal-total').textContent = getCartTotal().toLocaleString();
    }
    function openCart() {
      renderCartModal();
      document.getElementById('cart-modal-overlay').classList.add('open');
    }
    function closeCart() {
      document.getElementById('cart-modal-overlay').classList.remove('open');
    }
    document.getElementById('cart-badge-btn').addEventListener('click', openCart);
    document.getElementById('cart-close-btn').addEventListener('click', closeCart);
    document.getElementById('cart-modal-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'cart-modal-overlay') closeCart();
    });
    document.getElementById('cart-modal-body').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const sku = btn.dataset.sku;
      const cart = loadCart();
      if (!cart[sku]) return;
      if (btn.dataset.action === 'inc') {
        const maxStock = (typeof cart[sku].stock === 'number') ? cart[sku].stock : Infinity;
        if (cart[sku].qty >= maxStock) return;
        cart[sku].qty += 1;
      } else if (btn.dataset.action === 'dec') {
        cart[sku].qty -= 1;
        if (cart[sku].qty <= 0) delete cart[sku];
      } else if (btn.dataset.action === 'remove') {
        delete cart[sku];
      }
      saveCart(cart);
      refreshCartBadge();
      renderCartModal();
    });
    function buildCartSummaryText() {
      const items = getCartItems();
      if (items.length === 0) return '';
      const lines = items.map(i => '・' + i.name + '（' + i.sku + '）x' + i.qty + '　NT$' + (i.price * i.qty).toLocaleString());
      lines.push('—— 總計 NT$' + getCartTotal().toLocaleString() + ' ——');
      return '我想預約取貨，商品如下：\\n' + lines.join('\\n');
    }
    document.getElementById('cart-copy-btn').addEventListener('click', async () => {
      const text = buildCartSummaryText();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const btn = document.getElementById('cart-copy-btn');
        const original = btn.textContent;
        btn.textContent = '✓ 已複製';
        setTimeout(() => { btn.textContent = original; }, 1200);
      } catch (err) {}
    });
    document.getElementById('cart-checkout-btn').addEventListener('click', () => {
      const text = buildCartSummaryText();
      if (text) navigator.clipboard.writeText(text).catch(() => {});
    });
  </script>
</body>
</html>
`;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log("讀取商品試算表...");
  const rows = await fetchSheetRows();
  const products = mapRowsToProducts(rows);
  console.log(`共 ${products.length} 筆商品`);

  const productsDir = path.join(ROOT, "products");
  fs.mkdirSync(productsDir, { recursive: true });

  const existingDirs = new Set(fs.existsSync(productsDir) ? fs.readdirSync(productsDir) : []);
  const currentSkus = new Set();
  let created = 0, updated = 0;
  const sitemapUrls = [];

  for (const p of products) {
    currentSkus.add(p.sku);
    const dir = path.join(productsDir, p.sku);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "index.html");
    const images = findImages(p.sku);
    const html = renderProductPage(p, images);

    const isNewFile = !fs.existsSync(filePath);
    const prevContent = isNewFile ? null : fs.readFileSync(filePath, "utf-8");
    if (prevContent !== html) {
      fs.writeFileSync(filePath, html, "utf-8");
      if (isNewFile) created++; else updated++;
    }
    sitemapUrls.push(`${SITE_URL}/products/${p.sku}/`);
  }

  // 清掉試算表裡已經不存在的商品頁面（避免累積孤兒頁面被 Google 索引到下架商品）
  let removed = 0;
  for (const dirName of existingDirs) {
    if (!currentSkus.has(dirName)) {
      fs.rmSync(path.join(productsDir, dirName), { recursive: true, force: true });
      removed++;
    }
  }

  // 產生 sitemap.xml，方便 Google 一次發現所有商品頁面
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc></url>
${sitemapUrls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>
`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap, "utf-8");

  console.log(`完成：新增 ${created} 筆、更新 ${updated} 筆、移除 ${removed} 筆（已下架商品）`);
}

main().catch((err) => {
  console.error("執行失敗：", err);
  process.exit(1);
});