import { loadNC, fixture } from '../test/load.mjs';
const NC = loadNC();
for (const f of ['樣本 A','樣本 D']) {
  const res = await NC.analyze({ text: fixture(f), settings: NC.util.defaultSettings(), toolTable: null, stock: null, scenarios: ['off','on'], sim: { enabled: true, cell: 0.5 } });
  const errs = res.diagnostics.filter(d => d.severity === 'error');
  console.log(`\n=== ${f}  stock=${JSON.stringify(res.stock.min)}..${JSON.stringify(res.stock.max)} (${res.stock.source})`);
  console.log(`   error ${errs.length} 筆，分 ${new Set(errs.map(d=>d.groupKey)).size} 組`);
  for (const d of errs.filter(d=>d.groupFirst)) {
    console.log(`  [${d.ruleId}] L${d.line} ×${d.groupCount} mag=${d.magnitude?.toFixed?.(2)} 情境=${d.scenario||'全部'} pos=${d.pos?`(${d.pos.x.toFixed(1)},${d.pos.y.toFixed(1)},${d.pos.z.toFixed(2)})`:'-'}`);
    console.log(`      ${d.message.slice(0,100)}`);
  }
}
