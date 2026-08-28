// 驗收用暫時腳本：對 test/fixtures/樣本 C 跑真實 NC.analyze，把 SimResult + 路徑 + 素材
// 匯出成 test/fixture-sim.js（window.__SIM = {...}），讓 file:// 下的 demo 頁可以直接 <script> 載入。
// 用法：node tools/make-fixture-sim.mjs [cell]
import fs from 'node:fs';
import path from 'node:path';
import { loadNC, ROOT, fixture } from '../test/load.mjs';

const NC = loadNC();
const CELL = Number(process.argv[2] || 0.25);
const NAME = '樣本 C';
const text = fixture(NAME);
const settings = NC.util.defaultSettings();
// 素材 130×60×15（與 test/simulation.test.mjs 的契約驗收同一組）：
// 程式的孔在 Y48.4、輪廓在 Y-8..40，所以 Y 取 -10..50，不是「頂面正中心」。
const stock = {
  min: { x: -65, y: -10, z: -15 }, max: { x: 65, y: 50, z: 0 },
  source: 'user', fixtures: [],
};

const t0 = Date.now();
const res = await NC.analyze({
  text, settings, toolTable: null, stock,
  scenarios: ['off'], sim: { enabled: true, cell: CELL },
});
const ms = Date.now() - t0;

const sc = res.scenarios.off;
const sim = sc.sim;
if (!sim) throw new Error('沒有跑出 SimResult');

const f32 = (a) => Array.from(a, (v) => Math.round(v * 1000) / 1000);
const out = {
  name: NAME,
  cell: sim.cell, nx: sim.nx, ny: sim.ny,
  origin: sim.origin, floorZ: sim.floorZ,
  scenario: sim.scenario,
  height: f32(sim.height),
  snapshots: sim.snapshots.map((s) => ({ afterOpIndex: s.afterOpIndex, tool: s.tool, height: f32(s.height) })),
  time: sim.time,
  stock,
  segments: sc.geometry.segments.map((s) => ({
    id: s.id, line: s.line, opIndex: s.opIndex, tool: s.tool, kind: s.kind,
    from: s.from, to: s.to, arc: s.arc || undefined, feed: s.feed, path: s.path,
    refReturn: s.refReturn || undefined, inserted: s.inserted || undefined, sub: s.sub || undefined,
  })),
  toolTable: {
    programKey: res.toolTable.programKey,
    tools: res.toolTable.tools.map((t) => ({ t: t.t, label: t.label, type: t.type, diameter: t.diameter })),
    offsets: res.toolTable.offsets, updatedAt: res.toolTable.updatedAt,
  },
  ops: sc.run.ops.map((o) => ({ index: o.index, tool: o.tool, toolComment: o.toolComment, kindGuess: o.kindGuess, zMin: o.zMin })),
  meta: {
    analyzeMs: ms, cells: sim.nx * sim.ny, segments: sc.geometry.segments.length,
    diagnostics: res.diagnostics.length, ops: sc.run.ops.length, snapshots: sim.snapshots.length,
  },
};

const jsonPath = path.join(ROOT, 'test', 'fixture-sim.json');
const jsPath = path.join(ROOT, 'test', 'fixture-sim.js');
const json = JSON.stringify(out);
fs.writeFileSync(jsonPath, json);
fs.writeFileSync(jsPath, '// 由 tools/make-fixture-sim.mjs 產生：' + NAME + ' 的真實分析結果（file:// 下 fetch 會被擋，所以寫成 .js）\nwindow.__SIM = ' + json + ';\n');

// 抽樣檢查（契約 §5 驗收）
const at = (x, y) => {
  const ix = Math.round((x - sim.origin.x) / sim.cell), iy = Math.round((y - sim.origin.y) / sim.cell);
  return sim.height[iy * sim.nx + ix];
};
console.log('分析 %d ms · 格 %d×%d = %d · 段 %d · op %d · snapshot %d',
  ms, sim.nx, sim.ny, sim.nx * sim.ny, out.segments.length, out.ops.length, sim.snapshots.length);
console.log('抽樣高度：X=-62.5 → %s（契約：≈ -10）；X=0 → %s（契約：0）', at(-62.5, 0).toFixed(3), at(0, 0).toFixed(3));
let zmin = Infinity, zmax = -Infinity;
for (const v of sim.height) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
console.log('高度範圍 %s ~ %s · floorZ %s', zmin.toFixed(3), zmax.toFixed(3), sim.floorZ);
console.log('輸出 %s（%s MB）', jsPath, (fs.statSync(jsPath).size / 1048576).toFixed(2));
