#!/usr/bin/env node
/**
 * 自動壓縮商品照片
 * ============================================================
 * 用途：掃描 images/ 資料夾，把過大的商品照片縮小、重新壓縮，
 *      解決 PageSpeed Insights 抓到的「圖片傳送效能」問題
 *      （原本很多商品照片是 3500x3500 的原始尺寸，但網站上顯示
 *      最大只用到 640px，等於下載了完全用不到的解析度）。
 *
 * 執行方式：
 *   node scripts/compress-images.js
 * 由 .github/workflows/compress-images.yml 排程／偵測到 images/
 * 資料夾有變動時自動執行，執行完會把處理過的圖片 commit 回倉庫。
 *
 * 運作邏輯：
 *   - 網站上圖片最大只會顯示到 640px（放大檢視），所以把任何
 *     長邊超過 MAX_DIMENSION 的圖片等比例縮小，並用 85 的品質
 *     重新壓縮成 JPEG（品質 85 肉眼幾乎看不出差異，檔案卻小很多）。
 *   - 用一份「已處理清單」(manifest) 記錄每張圖片處理後的雜湊值，
 *     下次執行時如果雜湊值沒變，代表這張圖片已經處理過、沒有被
 *     重新上傳新照片，就跳過，不會每次都重新壓縮浪費時間。
 *   - 如果重新壓縮後檔案反而變大（極少數已經壓得很好的小圖），
 *     就保留原始檔案，不會讓圖片變差。
 * ============================================================
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const IMAGES_DIR = path.join(ROOT, "images");
const MANIFEST_PATH = path.join(IMAGES_DIR, ".compressed-manifest.json");
const MAX_DIMENSION = 800; // 網站商品縮圖只顯示到308px，放大檢視也只到640px，800px已經足夠清晰
const JPEG_QUALITY = 85;

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  } catch (e) {
    return {};
  }
}

function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 0), "utf-8");
}

function hashBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function processImage(filePath, manifest) {
  const filename = path.basename(filePath);
  const original = fs.readFileSync(filePath);
  const originalHash = hashBuffer(original);
  const record = manifest[filename];

  // 上次處理過、檔案內容沒變、而且用的壓縮門檻也一樣，才跳過不重複處理
  // (以後如果調整 MAX_DIMENSION，門檻對不上就會自動重新處理一次，不用手動清資料)
  if (record && record.hash === originalHash && record.maxDim === MAX_DIMENSION) {
    return { filename, status: "skip" };
  }

  const meta = await sharp(original).metadata();
  const needsResize = (meta.width || 0) > MAX_DIMENSION || (meta.height || 0) > MAX_DIMENSION;

  let output;
  if (meta.format === "png") {
    output = await sharp(original)
      .resize(needsResize ? { width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true } : undefined)
      .png({ compressionLevel: 9 })
      .toBuffer();
  } else {
    output = await sharp(original)
      .resize(needsResize ? { width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true } : undefined)
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  }

  // 極少數已經很小的圖片，重新編碼後可能反而變大，這種情況保留原檔
  if (output.length >= original.length) {
    manifest[filename] = { hash: originalHash, maxDim: MAX_DIMENSION }; // 標記為已檢查過，下次不用再比對
    return { filename, status: "kept-original", before: original.length, after: original.length };
  }

  fs.writeFileSync(filePath, output);
  const newHash = hashBuffer(output);
  manifest[filename] = { hash: newHash, maxDim: MAX_DIMENSION };
  return { filename, status: "compressed", before: original.length, after: output.length };
}

async function main() {
  if (!fs.existsSync(IMAGES_DIR)) {
    console.error("找不到 images/ 資料夾");
    process.exit(1);
  }

  const manifest = loadManifest();
  const files = fs.readdirSync(IMAGES_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f));
  console.log(`共 ${files.length} 張圖片`);

  let compressed = 0, skipped = 0, kept = 0;
  let totalBefore = 0, totalAfter = 0;

  for (const filename of files) {
    const filePath = path.join(IMAGES_DIR, filename);
    try {
      const result = await processImage(filePath, manifest);
      if (result.status === "skip") {
        skipped++;
      } else if (result.status === "kept-original") {
        kept++;
      } else {
        compressed++;
        totalBefore += result.before;
        totalAfter += result.after;
        const savedKb = ((result.before - result.after) / 1024).toFixed(0);
        console.log(`壓縮：${filename}　${(result.before / 1024).toFixed(0)}KB → ${(result.after / 1024).toFixed(0)}KB（省下 ${savedKb}KB）`);
      }
    } catch (e) {
      console.error(`處理 ${filename} 失敗：${e.message}`);
    }
  }

  saveManifest(manifest);

  console.log(`\n完成：壓縮 ${compressed} 張、跳過(已處理過) ${skipped} 張、保留原檔(已經夠小) ${kept} 張`);
  if (compressed > 0) {
    console.log(`總共省下：${((totalBefore - totalAfter) / 1024 / 1024).toFixed(2)} MB`);
  }
}

main().catch((err) => {
  console.error("執行失敗：", err);
  process.exit(1);
});
