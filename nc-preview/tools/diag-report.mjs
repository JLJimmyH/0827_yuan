/*
 * 診斷總表（人工檢視用）：對 test/fixtures 的四支程式跑完整 NC.analyze，
 * 印出每支程式每條規則的命中次數，以及所有 error / needsInput 的行號與訊息。
 *
 * 用法（在 nc-preview 目錄下）：
 *   node tools/diag-report.mjs                 四支程式，含模擬（cell 0.5）
 *   node tools/diag-report.mjs --no-sim        不跑模擬（只有 tokenizer/interpreter/geometry/rules）
 *   node tools/diag-report.mjs --cell=0.25     指定模擬格距
 *   node tools/diag-report.mjs --all           連 warning / info 的行號訊息也印
 *   node tools/diag-report.mjs --detail        每則診斷加印 detail 說明
 *   node tools/diag-report.mjs 樣本 C            只看檔名含 "樣本 C" 的程式
 */
import { loadNC, fixture, FIXTURES } from '../test/load.mjs';

const NC = loadNC();

// --- 參數 -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const cellArg = argv.find((a) => a.startsWith('--cell='));
const filters = argv.filter((a) => !a.startsWith('--'));
const useSim = !flags.has('--no-sim');
const cell = cellArg ? Number(cellArg.slice(7)) : 0.5;
const showAll = flags.has('--all');
const showDetail = flags.has('--detail');
const LOUD = new Set(showAll ? ['error', 'warning', 'needsInput', 'info'] : ['error', 'needsInput']);
const targets = FIXTURES.filter((f) => !filters.length || filters.some((q) => f.includes(q)));

const SEV_LABEL = { error: '錯誤', warning: '警告', needsInput: '待填', info: '參考' };
const ruleTitle = (id) => {
  const reg = (NC.rules && NC.rules.registry) || [];
  const r = reg.find((x) => x && x.id === id);
  return r && r.title ? r.title : '';
};

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function ms(t0) { return Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 10) / 10; }

console.log(`NC 預演台 診斷總表　模擬：${useSim ? `開（cell ${cell} mm）` : '關'}　rules.js：${NC.rules ? '已載入' : '未載入'}`);

const grand = {};
for (const f of targets) {
  const t0 = process.hrtime.bigint();
  const result = await NC.analyze({
    text: fixture(f),
    settings: NC.util.defaultSettings(),
    toolTable: null,
    stock: null,
    scenarios: ['off', 'on'],
    sim: { enabled: useSim, cell },
  });
  const took = ms(t0);
  const off = result.scenarios.off;
  const stock = result.stock;
  const size = (a, b) => `${Math.round(b.x - a.x)}×${Math.round(b.y - a.y)}×${Math.round(b.z - a.z)}`;

  console.log('\n' + '='.repeat(78));
  const oNum = result.tok.programNumber == null ? '（無 O 號）' : 'O' + String(result.tok.programNumber).padStart(4, '0');
  console.log(`${f}　${oNum}${result.tok.programName ? '(' + result.tok.programName + ')' : ''}　${took} ms`);
  console.log(`  行 ${result.tok.blocks.length}｜作業 ${off.run.ops.length}｜段 ${off.geometry.segments.length}｜刀 ${result.toolTable.tools.length}` +
    `｜素材 ${size(stock.min, stock.max)} mm（${stock.source}）` +
    (off.sim ? `｜格 ${off.sim.nx}×${off.sim.ny}｜加工時間 ${Math.round(off.sim.time.total / 60)} 分` : ''));
  if (result.rulesError) console.log(`  ⚠ rules.run 出錯：${result.rulesError.map((e) => e.phase + ' ' + e.message).join('；')}`);

  // --- 每條規則命中次數 ---
  const byRule = new Map();
  for (const d of result.diagnostics) {
    let e = byRule.get(d.ruleId);
    if (!e) { e = { n: 0, sev: {}, lines: [] }; byRule.set(d.ruleId, e); }
    e.n++;
    e.sev[d.severity] = (e.sev[d.severity] || 0) + 1;
    if (e.lines.length < 12) e.lines.push(d.line);
    grand[d.ruleId] = (grand[d.ruleId] || 0) + 1;
  }
  const sevOrder = { error: 0, warning: 1, needsInput: 2, info: 3 };
  const worst = (e) => Math.min(...Object.keys(e.sev).map((s) => sevOrder[s]));
  const rules = [...byRule.entries()].sort((a, b) => worst(a[1]) - worst(b[1]) || b[1].n - a[1].n || a[0].localeCompare(b[0]));
  console.log(`  規則命中（共 ${result.diagnostics.length} 則）：`);
  if (!rules.length) console.log('    （沒有任何診斷）');
  for (const [id, e] of rules) {
    const sev = Object.keys(e.sev).sort((a, b) => sevOrder[a] - sevOrder[b]).map((s) => `${SEV_LABEL[s]}${e.sev[s]}`).join(' ');
    const lines = e.lines.join(',') + (e.n > e.lines.length ? '…' : '');
    console.log(`    ${pad(id, 5)}${pad(e.n, 5)}${pad(sev, 18)}行 ${lines}${ruleTitle(id) ? '　' + ruleTitle(id) : ''}`);
  }

  // --- 需要人看的診斷（預設 error + needsInput）---
  const loud = result.diagnostics.filter((d) => LOUD.has(d.severity));
  console.log(`  ${[...LOUD].map((s) => SEV_LABEL[s]).join(' / ')} 明細（${loud.length} 則）：`);
  if (!loud.length) console.log('    （無）');
  for (const d of loud) {
    const tag = d.scenario ? `[${d.scenario}]` : '';
    const alarm = d.fanucAlarm ? ` <${d.fanucAlarm}>` : '';
    console.log(`    ${pad(SEV_LABEL[d.severity], 3)} L${pad(d.line, 6)}${pad(d.ruleId, 5)}${tag}${alarm} ${d.message}`);
    if (showDetail && d.detail) console.log(`         ↳ ${d.detail}`);
  }
}

console.log('\n' + '='.repeat(78));
console.log('全部程式的規則命中合計：');
const total = Object.keys(grand).sort();
if (!total.length) console.log('  （沒有任何診斷）');
for (const id of total) console.log(`  ${pad(id, 5)}${pad(grand[id], 6)}${ruleTitle(id)}`);
