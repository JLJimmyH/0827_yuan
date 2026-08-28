/*
 * 檢查 samples/ 裡的示範程式：跑一遍完整分析，列出各嚴重度的診斷數與 error/warning 明細。
 * 用法（在 nc-preview 目錄下）：node tools/check-samples.mjs
 * 示範程式不該有 error；warning 是刻意保留的教學點，改動範例後用這支確認。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadNC, ROOT } from '../test/load.mjs';

const NC = loadNC();
const dir = path.join(ROOT, 'samples');
let errors = 0;

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.nc')).sort()) {
  const text = fs.readFileSync(path.join(dir, f), 'latin1');
  const settings = NC.util.defaultSettings();
  const tok = NC.tokenize(text);
  const off = NC.interpret(tok.blocks, settings, 'off');
  const on = NC.interpret(tok.blocks, settings, 'on');
  const toolTable = NC.tools.buildTable(tok, off, null);
  const gOff = NC.buildSegments(off, toolTable, settings);
  const gOn = NC.buildSegments(on, toolTable, settings);
  const stock = NC.tools.estimateStock(off, gOff, toolTable);
  const ctx = {
    tok,
    scenarios: { off: { run: off, geometry: gOff, sim: null }, on: { run: on, geometry: gOn, sim: null } },
    toolTable, stock, settings,
  };
  const all = [...(tok.diagnostics || []), ...(off.diagnostics || []), ...(gOff.diagnostics || []), ...NC.rules.run(ctx)];
  const by = {};
  for (const d of all) by[d.severity] = (by[d.severity] || 0) + 1;

  console.log(`\n=== ${f} ===  ${tok.blocks.length} 行 / ${off.ops.length} 作業 / O${tok.programNumber} ${JSON.stringify(by)}`);
  for (const d of all.filter((x) => x.severity === 'error')) { errors++; console.log(`  ERROR L${d.line} ${d.ruleId}: ${d.message}`); }
  for (const d of all.filter((x) => x.severity === 'warning')) console.log(`  warn  L${d.line} ${d.ruleId}: ${d.message}`);
}

console.log(errors ? `\n有 ${errors} 筆 error，範例程式應該要是乾淨的` : '\n沒有 error');
process.exit(errors ? 1 : 0);
