/*
 * 把 js/core/ns.js 的 NC.VERSION 更新成今天的日期（YYYY.MM.DD）。
 *
 * 版本號用日期而不是 semver：這支工具是持續小修的現場工具，沒有「破壞相容性」
 * 的概念，現場回報「我用的是 2026.09.10」比「0.3.1」好對照——直接看得出多舊。
 *
 * 用法：
 *   node tools/bump-version.mjs          今天
 *   node tools/bump-version.mjs 2026.09.11   指定
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NS = path.join(ROOT, 'js', 'core', 'ns.js');

const arg = process.argv[2];
const today = (() => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())}`;
})();
const next = arg || today;
if (!/^\d{4}\.\d{2}\.\d{2}$/.test(next)) {
  console.error(`版本號格式要像 2026.09.10，收到的是「${next}」`);
  process.exit(1);
}

const src = fs.readFileSync(NS, 'utf8');
const re = /(NC\.VERSION = ')([^']+)(';)/;
const m = src.match(re);
if (!m) {
  console.error('在 js/core/ns.js 裡找不到 NC.VERSION');
  process.exit(1);
}
if (m[2] === next) {
  console.log(`版本號已經是 ${next}，沒有改動`);
  process.exit(0);
}
fs.writeFileSync(NS, src.replace(re, `$1${next}$3`));
console.log(`版本號 ${m[2]} → ${next}`);
