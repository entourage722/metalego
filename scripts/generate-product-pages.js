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
      return {
        sku,
        name: rawName || lookupFallbackName(sku) || sku,
        cat: lookupCategory(sku),
        year: lookupYear(sku),
        price: colIndex.price !== undefined ? Number(String(r[colIndex.price]).replace(/[^0-9.]/g, "")) || 0 : 0,
        orig: colIndex.orig !== undefined ? Number(String(r[colIndex.orig]).replace(/[^0-9.]/g, "")) || 0 : 0,
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
  .cart-badge{display:inline-flex; align-items:center; gap:4px; background:var(--ink); color:#fff; font-weight:700; text-decoration:none; padding:9px 14px; border-radius:10px; border:3px solid #fff; box-shadow:var(--shadow); font-size:13px; white-space:nowrap;}
  main{max-width:760px; margin:0 auto; padding:20px 16px 60px;}
  .breadcrumb{font-size:13px; color:#777; margin-bottom:14px;}
  .breadcrumb a{color:var(--red-dark); text-decoration:none;}
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
  .btn-line{display:inline-flex; align-items:center; gap:8px; background:#06c755; color:#fff; font-weight:900; text-decoration:none; padding:13px 20px; border-radius:10px; border:3px solid var(--ink); box-shadow:var(--shadow); font-size:15px;}
  .btn-back{display:inline-block; margin-top:18px; color:var(--red-dark); font-weight:700; text-decoration:none; font-size:14px;}
  .note{margin-top:22px; font-size:13px; color:#777; border-top:1px dashed #ddd; padding-top:14px;}
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
        <a class="cart-badge" href="../../index.html" title="回首頁查看購物車">
          🛒 購物車　<span id="cart-count">0</span> 件｜NT$<span id="cart-total">0</span>
        </a>
      </div>
    </div>
  </header>
  <main>
    <div class="breadcrumb"><a href="../../index.html">首頁</a> ／ ${escapeHtml(p.cat)} ／ ${escapeHtml(p.sku)}</div>
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
          ${p.orig ? `<span class="orig">NT$${p.orig.toLocaleString()}</span>` : ""}
          <span class="price">NT$${p.price.toLocaleString()}</span>
        </div>
        <div class="stock">${stockLabel}</div>
        <a class="btn-line" href="https://line.me/ti/p/7hy1HnSChM">💬 LINE 詢問這件商品</a>
        <div>
          <a class="btn-back" href="../../index.html">← 回商店繼續逛逛</a>
        </div>
        <div class="note">原封整套・拆售單顆・缺件補件・開倉出清！歡迎來訊詢問缺件。</div>
      </div>
    </div>
  </main>
  <script>
    document.querySelectorAll('.gallery img').forEach(img => {
      img.addEventListener('click', () => {
        document.querySelector('.thumb-main img').src = img.src;
        document.querySelectorAll('.gallery img').forEach(i => i.classList.remove('active'));
        img.classList.add('active');
      });
    });
    // 讀取跟首頁同一把 localStorage 鑰匙，讓購物車徽章顯示目前真實的件數/金額
    (function () {
      try {
        const raw = localStorage.getItem('brickWarehouseCart');
        const cart = raw ? JSON.parse(raw) : {};
        const items = Object.values(cart);
        const count = items.reduce((sum, i) => sum + i.qty, 0);
        const total = items.reduce((sum, i) => sum + i.qty * i.price, 0);
        document.getElementById('cart-count').textContent = count;
        document.getElementById('cart-total').textContent = total.toLocaleString();
      } catch (e) { /* 讀不到就維持預設的 0 */ }
    })();
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