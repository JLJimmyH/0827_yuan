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
const ORDER = ['demo-drill.nc', 'demo-tap.nc', 'demo-plate.nc', 'demo-pocket.nc', 'demo-4axis.nc', 'check-4axis.nc'];
const found = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.nc'));
const NAMES = ORDER.filter((n) => found.includes(n)).concat(found.filter((n) => !ORDER.includes(n)).sort());

/** 讀檔並正規化：一律 LF 結尾、去掉 UTF-8 BOM（程式本身是純 ASCII） */
function readProgram(name) {
  let text = fs.readFileSync(path.join(SAMPLE_DIR, name), 'latin1');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n');
}

const samples = NAMES.map((name) => ({ name: name.replace(/\.nc$/i, ''), text: readProgram(name) }));

const lines = [];
lines.push('/*');
lines.push(' * NC 預演台 — 內建範例程式（由 tools/make-samples.mjs 從 samples/ 產生，請勿手動編輯）。');
lines.push(' * 重新產生：在 nc-preview 目錄下執行 node tools/make-samples.mjs（輸出固定，內容變了才會有差異）。');
lines.push(' */');
lines.push('(function (NC) {');
lines.push("  'use strict';");
lines.push('  const ui = (NC.ui = NC.ui || {});');
lines.push('  /** @type {{name:string, text:string}[]} 內建範例，供「載入範例」選單使用 */');
lines.push('  ui.samples = [');
for (const s of samples) {
  const nLines = s.text.split('\n').length;
  lines.push(`    // ${s.name}：${nLines} 行、${s.text.length} 字元`);
  lines.push(`    { name: ${JSON.stringify(s.name)}, text: ${JSON.stringify(s.text)} },`);
}
lines.push('  ];');
lines.push('})(globalThis.NC = globalThis.NC || {});');

const out = lines.join('\n') + '\n';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');

console.log(`已產生 ${path.relative(ROOT, OUT)}（${out.length} 位元組）`);
for (const s of samples) console.log(`  ${s.name}：${s.text.split('\n').length} 行、${s.text.length} 字元`);
