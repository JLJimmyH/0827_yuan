/*
 * 產生 js/ui/samples.js：把 samples/ 的示範程式內嵌成 NC.ui.samples。
 * 用法（在 nc-preview 目錄下）：node tools/make-samples.mjs
 * 產出的檔案是一般腳本（不是 module），由 index.html 以 <script src> 載入。
 * 改過 samples/ 之後記得跑 node tools/check-samples.mjs 確認範例仍然是乾淨的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SAMPLE_DIR = path.join(ROOT, 'samples');
const OUT = path.join(ROOT, 'js', 'ui', 'samples.js');

// 選單顯示順序：先簡單的、再有陷阱的
const ORDER = ['demo-drill.nc', 'demo-tap.nc', 'demo-plate.nc', 'demo-pocket.nc', 'demo-cutout.nc', 'demo-4axis.nc', 'check-4axis.nc'];
const found = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.nc'));
const NAMES = ORDER.filter((n) => found.includes(n)).concat(found.filter((n) => !ORDER.includes(n)).sort());

/** 讀檔並正規化：一律 LF 結尾、去掉 UTF-8 BOM（程式本身是純 ASCII） */
function readProgram(name) {
  const buf = fs.readFileSync(path.join(SAMPLE_DIR, name));
  // NC 程式一律當純 ASCII 讀（Fanuc 控制器也不吃非 ASCII 的註解）。
  // 用 UTF-8 寫中文註解的話，這裡會照 latin1 逐位元組讀成一堆亂碼，
  // 而且畫面上看起來「只是字很怪」，不會有任何錯誤——所以在這裡擋下來。
  const bad = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7e && buf[i] !== 0x0d && buf[i] !== 0x0a) { bad.push(i); if (bad.length > 4) break; }
  }
  if (bad.length) {
    const at = bad.slice(0, 4).map((i) => '0x' + buf[i].toString(16)).join(' ');
    throw new Error(`${name} 含非 ASCII 位元組（${at}…）。範例程式的註解請用英數字，`
      + '中文寫進去傳到機台會變亂碼，畫面上也只會看到一堆怪字而不報錯。');
  }
  let text = buf.toString('latin1');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n');
}

/**
 * 可選的素材側車檔 samples/<name>.stock.json：{ spec, fixtures? }（spec 就是 analyze.stockFromSpec 吃的 StockSpec）。
 * 為什麼要有：推估素材的底面故意比最深切削低 5 mm（tools.STOCK_Z_MARGIN），所以推估素材下永遠不會「切穿」；
 * 像 demo-cutout 這種要示範「切穿 → 外框變廢料」的範例，非得知道板厚不可，素材就跟著範例走。
 * app 載入範例時：使用者存過的素材優先，沒存過才用這份（不寫進 localStorage，沒動過的範例不留痕跡）。
 * 這裡只做最基本的形狀檢查（shape、size 三軸為正數），真正的正規化交給 analyze.stockFromSpec。
 */
function readStock(name) {
  const p = path.join(SAMPLE_DIR, name.replace(/\.nc$/i, '') + '.stock.json');
  if (!fs.existsSync(p)) return null;
  // 側車檔壞掉（少個逗號、多個尾逗號）時 JSON.parse 的原始訊息沒有檔名，光看 stack 不知道是哪一份——
  // 這裡接住、帶檔名印出來再結束，不要噴一整頁 stack
  let o;
  try {
    o = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`${path.basename(p)}：不是合法的 JSON（${e && e.message ? e.message : e}）。`
      + '側車檔長相：{ "spec": { "shape": "box", "size": {...}, "anchor": {...}, "pos": {...} }, "fixtures": [...] }');
    process.exit(1);
  }
  const sp = o && o.spec;
  if (!sp || !['box', 'cylZ', 'cylX'].includes(sp.shape) || !sp.size || !['x', 'y', 'z'].every((a) => Number(sp.size[a]) > 0)) {
    throw new Error(`${path.basename(p)}：spec 要有 shape（box|cylZ|cylX）與 size.x/y/z（正數）`);
  }
  const out = { spec: sp };
  if (Array.isArray(o.fixtures) && o.fixtures.length) out.fixtures = o.fixtures;
  return out;
}

const samples = NAMES.map((name) => ({ name: name.replace(/\.nc$/i, ''), text: readProgram(name), stock: readStock(name) }));

const lines = [];
lines.push('/*');
lines.push(' * NC 預演台 — 內建範例程式（由 tools/make-samples.mjs 從 samples/ 產生，請勿手動編輯）。');
lines.push(' * 重新產生：在 nc-preview 目錄下執行 node tools/make-samples.mjs（輸出固定，內容變了才會有差異）。');
lines.push(' */');
lines.push('(function (NC) {');
lines.push("  'use strict';");
lines.push('  const ui = (NC.ui = NC.ui || {});');
lines.push('  /** @type {{name:string, text:string, stock?:{spec:Object, fixtures?:Object[]}}[]} 內建範例，供「載入範例」選單使用；stock 是範例附的素材（來自 samples/<name>.stock.json，沒有就沒這個欄位） */');
lines.push('  ui.samples = [');
for (const s of samples) {
  const nLines = s.text.split('\n').length;
  lines.push(`    // ${s.name}：${nLines} 行、${s.text.length} 字元${s.stock ? '、附素材' : ''}`);
  const stockField = s.stock ? `, stock: ${JSON.stringify(s.stock)}` : '';
  lines.push(`    { name: ${JSON.stringify(s.name)}, text: ${JSON.stringify(s.text)}${stockField} },`);
}
lines.push('  ];');
lines.push('})(globalThis.NC = globalThis.NC || {});');

const out = lines.join('\n') + '\n';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');

console.log(`已產生 ${path.relative(ROOT, OUT)}（${out.length} 位元組）`);
for (const s of samples) console.log(`  ${s.name}：${s.text.split('\n').length} 行、${s.text.length} 字元${s.stock ? '、附素材' : ''}`);
