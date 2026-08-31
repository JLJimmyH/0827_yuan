// 第四軸（A）測試 — CONTRACT §13「層次一：認得 A、不騙人」
//
// 本版**不做**工件旋轉的座標轉換，所以這裡驗的是三件事：
//   1. A 有被讀進來（狀態、動作、段、摘要），不會被靜靜吃掉
//   2. 因為 A 被忽略而產生的連鎖誤報（同 XY 不同角度的孔）不再發生
//   3. 不依賴旋轉轉換也能確定的危險（轉動時的刀尖高度、補正、收尾角度）有被抓到
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNC } from './load.mjs';

const NC = loadNC();
const S = () => NC.util.defaultSettings();

/** 跑 interpret（自動包 %/O/M30，行號因此 +2） */
function prog(src, opts = {}) {
  const text = opts.raw ? src : `%\nO1\n${src}\nM30\n%`;
  const tok = NC.tokenize(text);
  const r = NC.interpret(tok.blocks, Object.assign(S(), opts.settings || {}), 'off');
  return { tok, run: r, at: (line) => r.executed[line - 1 + (opts.raw ? 0 : 2)] };
}
/** 跑完整 analyzeSync（要看 rules 的診斷時用） */
function full(src, req = {}) {
  return NC.analyzeSync(Object.assign({ text: `%\nO1\n${src}\nM30\n%` }, req));
}
const byRule = (diags, id, sev) => diags.filter((d) => d.ruleId === id && (!sev || d.severity === sev));
const acts = (eb, kind) => (eb.actions || []).filter((a) => a.kind === kind);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

// ---------------------------------------------------------------------------
// 讀取與狀態
// ---------------------------------------------------------------------------
test('三軸程式：rotary.used = false，A 恆為 0', () => {
  const { run: r } = prog('G0G90G54X10.Y10.\nG1Z-5.F100.');
  assert.equal(r.rotary.used, false);
  assert.equal(r.rotary.mode, 'none');
  assert.equal(r.finalState.a, 0);
});

test('寫了 A0. 但從頭到尾沒轉：used = true 但 rotateLines 是空的', () => {
  // Yuan 說的「三軸 XYZ 的角度就是 0」——這種程式路徑完全正確，不該有任何 A 軸提醒
  const { run: r } = prog('G0G90G54X10.Y10.A0.\nG1Z-5.F100.');
  assert.equal(r.rotary.used, true);
  assert.deepEqual(r.rotary.rotateLines, []);
  const res = full('G0G90G54X10.Y10.A0.\nG1Z-5.F100.');
  assert.equal(byRule(res.diagnostics, 'R37').length, 0);
});

test('G90 絕對角度：A 進到狀態與動作', () => {
  const p = prog('G0G90G54X0.Y0.A0.Z50.\nG0A90.');
  assert.equal(p.at(2).after.a, 90);
  const rot = acts(p.at(2), 'rotate');
  assert.equal(rot.length, 1);
  assert.equal(rot[0].aFrom, 0);
  assert.equal(rot[0].a, 90);
  assert.equal(rot[0].axis, 'A');
  // 純轉動節的 XYZ 不動
  assert.deepEqual(rot[0].from, rot[0].to);
});

test('G91 增量角度：A 是累加的', () => {
  const p = prog('G0G90G54X0.Y0.A0.Z50.\nG91A90.\nA90.\nA90.');
  assert.equal(p.at(2).after.a, 90);
  assert.equal(p.at(3).after.a, 180);
  assert.equal(p.at(4).after.a, 270);
});

test('重複寫同一個角度不算轉動', () => {
  const p = prog('G0G90G54X0.Y0.A90.Z50.\nG0A90.');
  assert.equal(acts(p.at(2), 'rotate').length, 0);
  assert.deepEqual(p.run.rotary.rotateLines, [3]); // 只有第一節（0 → 90）算
});

test('XYZ 與 A 同一節：動作帶 a 與 aFrom，G0 標成 nonLinear', () => {
  const p = prog('G0G90G54X0.Y0.A0.Z50.\nG0X10.A90.');
  const rapid = acts(p.at(2), 'rapid')[0];
  assert.equal(rapid.aFrom, 0);
  assert.equal(rapid.a, 90);
  assert.equal(rapid.nonLinear, true);
});

test('G28 A0.：第四軸回參考點視為 A0', () => {
  const p = prog('G0G90G54X0.Y0.A270.Z50.\nG91G28A0.');
  const rr = acts(p.at(2), 'refReturn')[0];
  assert.ok(rr, '應該產生 refReturn 動作');
  assert.equal(rr.aFrom, 270);
  assert.equal(rr.a, 0);
  assert.ok(rr.axes.includes('A'));
  assert.equal(p.run.finalState.a, 0);
});

test('B／C 軸只警告不模擬，整支只報一次', () => {
  const p = prog('G0G90G54X0.Y0.B45.Z50.\nG0B90.\nG0C10.');
  const d = p.run.diagnostics.filter((x) => x.ruleId === 'R02' && /只認得第四軸 A/.test(x.message));
  assert.equal(d.length, 1);
});

// ---------------------------------------------------------------------------
// 固定循環的分度
// ---------------------------------------------------------------------------
test('循環中只寫 A：照樣鑽一個孔（不寫的話孔數會少報）', () => {
  const p = prog([
    'G0G90G54X10.Y0.A0.Z50.',
    'G99G81Z-5.R2.F100.',
    'A90.',
    'A180.',
    'A270.',
    'G80',
  ].join('\n'));
  const holes = [2, 3, 4, 5].map((n) => acts(p.at(n), 'hole'));
  assert.deepEqual(holes.map((h) => h.length), [1, 1, 1, 1]);
  assert.deepEqual(holes.map((h) => h[0].a), [0, 90, 180, 270]);
  // 轉動只記在該節第一個孔上
  assert.equal(holes[1][0].aFrom, 0);
  assert.equal(holes[2][0].aFrom, 90);
});

test('同一個 XY 在不同角度不是重複孔（R19 不再誤報）', () => {
  const res = full([
    'M6T1(6MM)',
    'G0G90G54X10.Y0.A0.G43H1Z50.M3S1000',
    'G99G81Z-5.R2.F100.',
    'A90.',
    'A180.',
    'A270.',
    'G80',
  ].join('\n'));
  assert.equal(byRule(res.diagnostics, 'R19', 'warning').length, 0);
  // 但真正的重複（同角度同 XY）還是要抓到
  const dup = full([
    'M6T1(6MM)',
    'G0G90G54X10.Y0.A0.G43H1Z50.M3S1000',
    'G99G81Z-5.R2.F100.',
    'A90.',
    'X10.Y0.',
    'G80',
  ].join('\n'));
  assert.equal(byRule(dup.diagnostics, 'R19', 'warning').length, 1);
});

// ---------------------------------------------------------------------------
// 分度 vs 連續四軸
// ---------------------------------------------------------------------------
test('分度：mode = index，角度由小到大', () => {
  const { run: r } = prog('G0G90G54X10.Y0.A0.Z50.\nG0A270.\nG0A90.');
  assert.equal(r.rotary.mode, 'index');
  assert.deepEqual(r.rotary.angles, [0, 90, 270]);
  assert.deepEqual(r.rotary.simLines, []);
});

test('A 與 XYZ 同時進給：mode = simultaneous', () => {
  const { run: r } = prog('G0G90G54X0.Y0.A0.Z-2.\nG1X50.A360.F200.');
  assert.equal(r.rotary.mode, 'simultaneous');
  assert.deepEqual(r.rotary.simLines, [4]);
});

test('G1 模態下單獨轉 A 仍算分度，不是四軸插補', () => {
  // 旋轉進給（G1A90.F500.）路徑上還是分度；危不危險由刀尖高度那條判
  const { run: r } = prog('G0G90G54X0.Y0.A0.Z50.\nG1A90.F500.');
  assert.equal(r.rotary.mode, 'index');
});

// ---------------------------------------------------------------------------
// R04：A 沒有小數點
// ---------------------------------------------------------------------------
test('A90 沒有小數點 → R04（讀成 0.09 度）', () => {
  const p = prog('G0G90G54X0.Y0.A0.Z50.\nG0A90');
  const d = byRule(p.run.diagnostics, 'R04', 'warning').filter((x) => /度/.test(x.message));
  assert.equal(d.length, 1);
  assert.match(d[0].message, /0\.09 度/);
});

test('dpi = true 時不報 A 的小數點', () => {
  const p = prog('G0G90G54X0.Y0.A0.Z50.\nG0A90', { settings: { dpi: true } });
  assert.equal(byRule(p.run.diagnostics, 'R04').length, 0);
});

// ---------------------------------------------------------------------------
// R37
// ---------------------------------------------------------------------------
test('R37：分度程式一定有一則總體標示，並指向展開圖', () => {
  const res = full('G0G90G54X10.Y0.A0.Z50.\nG0A90.');
  const d = byRule(res.diagnostics, 'R37', 'warning').filter((x) => /展開圖/.test(x.message));
  assert.equal(d.length, 1);
  assert.match(d[0].message, /2 個角度/);
});

test('R37：連續四軸標成「畫不出來」', () => {
  const res = full('G0G90G54X0.Y0.A0.Z-2.\nG1X50.A360.F200.');
  const d = byRule(res.diagnostics, 'R37').filter((x) => /畫不出來/.test(x.message));
  assert.equal(d.length, 1);
});

test('R37：轉動時刀尖在工件零點以下 → error', () => {
  const res = full('M6T1(6MM)\nG0G90G54X0.Y0.A0.G43H1Z50.M3S1000\nG1Z-5.F200.\nG0A90.');
  const d = byRule(res.diagnostics, 'R37', 'error').filter((x) => /轉到 A90/.test(x.message));
  assert.equal(d.length, 1);
  assert.match(d[0].message, /Z-5/);
});

test('R37：轉動時刀尖已經拉高 → 不報', () => {
  const res = full('M6T1(6MM)\nG0G90G54X0.Y0.A0.G43H1Z50.M3S1000\nG1Z-5.F200.\nG0Z50.\nG0A90.');
  assert.equal(byRule(res.diagnostics, 'R37', 'error').length, 0);
});

test('R37：G99 分度（退到 R 點就轉）也要抓', () => {
  // R 點在 Z-1（還埋在料裡）就分度，是固定循環最容易漏掉的撞機寫法
  const res = full([
    'M6T1(6MM)',
    'G0G90G54X10.Y0.A0.G43H1Z50.M3S1000',
    'G99G81Z-5.R-1.F100.',
    'A90.',
    'G80',
  ].join('\n'));
  const d = byRule(res.diagnostics, 'R37', 'error');
  assert.ok(d.length >= 1, '應該報轉動時刀尖太低');
  assert.match(d[0].detail, /G99/);
});

test('R37：刀徑補正生效中轉 A → error', () => {
  const res = full([
    'M6T1(6MM)',
    'G0G90G54X0.Y0.A0.G43H1Z50.M3S1000',
    'G1Z10.F200.',
    'G41D1X10.',
    'G0A90.',
    'G40',
  ].join('\n'));
  const d = byRule(res.diagnostics, 'R37', 'error').filter((x) => /補正/.test(x.message));
  assert.equal(d.length, 1);
});

test('R37：程式結束時 A 沒回 0 → warning', () => {
  const res = full('G0G90G54X10.Y0.A0.Z50.\nG0A270.');
  const d = byRule(res.diagnostics, 'R37', 'warning').filter((x) => /沒有轉回 A0/.test(x.message));
  assert.equal(d.length, 1);
  assert.match(d[0].message, /A270/);
});

test('R37：有 G28 A0. 收尾就不報', () => {
  const res = full('G0G90G54X10.Y0.A0.Z50.\nG0A270.\nG91G28A0.');
  assert.equal(byRule(res.diagnostics, 'R37', 'warning').filter((x) => /沒有轉回/.test(x.message)).length, 0);
});

test('R37：分度順序 info 列出每一段的行號', () => {
  const res = full('G0G90G54X10.Y0.A0.Z50.\nG0A90.\nG0A180.');
  const d = byRule(res.diagnostics, 'R37', 'info');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /A0（第 3 行）/);
  assert.match(d[0].message, /A90（第 4 行）/);
  assert.match(d[0].message, /A180（第 5 行）/);   // 分段只到最後一個移動節，M30 不帶角度
});

// ---------------------------------------------------------------------------
// geometry：段上的角度標記
// ---------------------------------------------------------------------------
test('Segment 帶 a／aFrom，但 XYZ 不做旋轉轉換', () => {
  const res = full('G0G90G54X10.Y0.A0.Z50.\nG0X20.A90.');
  const segs = res.scenarios.off.geometry.segments;
  const s = segs.find((x) => x.line === 4);
  assert.ok(s, '第 4 行應該有段');
  assert.equal(s.a, 90);
  assert.equal(s.aFrom, 0);
  // 座標就是程式座標，沒有被轉過
  near(s.to.x, 20);
  near(s.to.y, 0);
});

test('固定循環展開的每一段都帶該孔的角度', () => {
  const res = full([
    'G0G90G54X10.Y0.A0.Z50.',
    'G99G81Z-5.R2.F100.',
    'A90.',
    'G80',
  ].join('\n'));
  const segs = res.scenarios.off.geometry.segments.filter((x) => x.line === 5);
  assert.ok(segs.length > 0);
  for (const s of segs) assert.equal(s.a, 90);
});

// ---------------------------------------------------------------------------
// 座標轉換與展開圖（geometry.rotary）
// ---------------------------------------------------------------------------
const R = NC.geometry.rotary;

test('rotaryPoint：刀在正上方，工件轉 90 度就打到工件的 +Y 側', () => {
  const p = R.point({ x: 5, y: 0, z: 20 }, 90);
  near(p.x, 5); near(p.y, 20); near(p.z, 0);
});

test('rotaryPoint：A0 是恆等變換', () => {
  const p = R.point({ x: 1, y: 2, z: 3 }, 0);
  near(p.x, 1); near(p.y, 2); near(p.z, 3);
});

test('rotaryPoint：迴轉中心不在原點時繞著中心轉', () => {
  // 中心在 (y=0, z=10)，刀在 (0, 0, 20) → 離中心 10；轉 90 度後應該在 (0, 10, 10)
  const p = R.point({ x: 0, y: 0, z: 20 }, 90, { y: 0, z: 10 });
  near(p.y, 10); near(p.z, 10);
});

test('unrollPoint：刀在正上方時 theta 就是程式的 A 值', () => {
  for (const a of [0, 90, 180]) {
    const u = R.unrollPoint(R.point({ x: 0, y: 0, z: 20 }, a));
    near(u.theta, a);
    near(u.r, 20);
  }
});

test('unrollPoint：r 是離迴轉中心的距離，切得越深越小', () => {
  near(R.unrollPoint({ x: 0, y: 0, z: 20 }).r, 20);
  near(R.unrollPoint({ x: 0, y: 0, z: 8 }).r, 8);
});

test('展開圖：分度鑽孔的四個孔落在正確的角度上', () => {
  const res = full([
    'M6T1(SG-8.5)',
    'G0G90G54X20.Y0.A0.G43H1Z50.M3S900',
    'G98G81Z10.R25.F70M8',
    'A90.',
    'A180.',
    'A270.',
    'G80',
  ].join('\n'));
  const { polylines } = R.unrollSegments(res.scenarios.off.geometry.segments);
  const holes = polylines.filter((p) => p.kind === 'drill' && p.sub === 'plunge');
  assert.equal(holes.length, 4);
  assert.deepEqual(holes.map((h) => Math.round(h.pts[0].theta)), [0, 90, 180, 270]);
  // 四個孔的軸向位置一樣
  for (const h of holes) near(h.pts[0].x, 20);
  // 下刀是從表面（R 點 Z25）往中心切到 Z10
  for (const h of holes) { near(h.pts[0].r, 25); near(h.pts[h.pts.length - 1].r, 10); }
});

test('展開圖：A270 畫在 270，不是 atan2 給的 −90', () => {
  const res = full('G0G90G54X10.Y0.A0.Z25.\nG0A270.\nG1Z20.F100.');
  const { polylines } = R.unrollSegments(res.scenarios.off.geometry.segments);
  const last = polylines[polylines.length - 1];
  near(last.pts[last.pts.length - 1].theta, 270);
});

test('展開圖：A 轉動的段會被細分成曲線，不是一條直線', () => {
  const res = full('G0G90G54X0.Y0.A0.Z25.\nG1X50.A90.F200.');
  const { polylines } = R.unrollSegments(res.scenarios.off.geometry.segments);
  const turning = polylines.find((p) => p.pts.length > 2 && p.pts[0].theta !== p.pts[p.pts.length - 1].theta);
  assert.ok(turning, '同動段應該被細分');
  assert.ok(turning.pts.length >= 30, `90 度每 ${R.STEP_DEG} 度一點，至少 30 點，實際 ${turning.pts.length}`);
});

test('展開圖 bounds 不含 G28 與 rapid（否則會被參考點 Z150 撐爆）', () => {
  const res = full([
    'G0G90G54X20.Y0.A0.Z50.',
    'G98G81Z10.R25.F70',
    'A90.',
    'G80',
    'G91G28Z0.',
    'G28A0.',
  ].join('\n'));
  const { bounds } = R.unrollSegments(res.scenarios.off.geometry.segments);
  assert.ok(bounds.maxR <= 25 + 1e-6, `maxR ${bounds.maxR} 應該不超過 R 點 25`);
  near(bounds.minX, 20);
  near(bounds.maxX, 20);
});

test('estimateRadius：取切削段離中心最遠的距離（R 點附近）', () => {
  const res = full('M6T1(6MM)\nG0G90G54X10.Y0.A0.G43H1Z50.M3S1000\nZ25.\nG1Z17.F200\nX60.F250');
  const est = R.estimateRadius(res.scenarios.off.geometry.segments);
  assert.equal(est.source, 'cut');
  near(est.radius, 25);
});

test('三軸程式也能算展開圖（不會炸），只是全部落在同一條角度線上', () => {
  const res = full('G0G90G54X0.Y10.Z5.\nG1X50.F200.');
  const { polylines } = R.unrollSegments(res.scenarios.off.geometry.segments);
  assert.ok(polylines.length > 0);
  for (const pl of polylines) for (const p of pl.pts) assert.ok(Number.isFinite(p.theta));
});

// ---------------------------------------------------------------------------
// 設定面板的第四軸欄位（panels.settings）
// ---------------------------------------------------------------------------
test('設定：第四軸區塊只在 rotaryUsed 時出現，改值會送出 settings.rotary', async () => {
  const { default: fsx } = await import('node:fs');
  const { default: pathx } = await import('node:path');
  const { default: vmx } = await import('node:vm');
  const { ROOT } = await import('./load.mjs');
  // panels.js 需要 document；沿用 panels.test.mjs 建好的假 DOM（先跑過就有）
  if (!globalThis.document) {
    const t = pathx.join(ROOT, 'test', 'panels.test.mjs');
    if (!fsx.existsSync(t)) return;
  }
  if (!NC.ui || !NC.ui.panels) {
    const p = pathx.join(ROOT, 'js', 'ui', 'panels.js');
    if (!globalThis.document) return;   // 沒有假 DOM 就跳過（panels 測試自己會測）
    vmx.runInThisContext(fsx.readFileSync(p, 'utf8'), { filename: p });
  }
  const P = NC.ui && NC.ui.panels;
  if (!P || !globalThis.document) return;
  const container = () => globalThis.document.createElement('div');
  const q = (el, sel) => (el.querySelector ? el.querySelector(sel) : null);

  const plain = container();
  P.settings(plain, { settings: NC.util.defaultSettings(), scenario: 'off', cell: 0.5 });
  assert.ok(!q(plain, 'input[data-field="rotaryCenterZ"]'), '三軸程式不該出現第四軸設定');

  const c = container();
  const changes = [];
  P.settings(c, {
    settings: NC.util.defaultSettings(), scenario: 'off', cell: 0.5, rotaryUsed: true,
    onChange: (o) => changes.push(o),
  });
  const cz = q(c, 'input[data-field="rotaryCenterZ"]');
  assert.ok(cz, '有第四軸時應該出現迴轉中心 Z');
  cz.value = '-25';
  cz.dispatchEvent({ type: 'change' });
  assert.equal(changes[0].settings.rotary.center.z, -25);

  const dia = q(c, 'input[data-field="rotaryDiameter"]');
  dia.value = '50';
  dia.dispatchEvent({ type: 'change' });
  assert.equal(changes[1].settings.rotary.radius, 25, '填直徑 50 → 半徑 25');
});

// ---------------------------------------------------------------------------
// 反推迴轉中心（geometry.rotary.estimateCenter）
//
// 幾何：分度孔在機台座標上是沿 Z 的垂直線，要在工件上是徑向孔，這些線就得通過
// 迴轉中心線 → 所有孔的 Y 必須相同。中心的 Z 不影響角度（推不出來，由現場填）。
// ---------------------------------------------------------------------------
const FOUR_HOLES = [
  'M6T1(SG-8.5)',
  'G0G90G54X20.Y0.A0.G43H1Z50.M3S900',
  'G98G81Z10.R25.F70M8',
  'A90.',
  'A180.',
  'A270.',
  'G80',
].join('\n');

test('反推中心：分度孔都在 Y0 → 推出 Y0 且一致', () => {
  const res = full(FOUR_HOLES);
  const est = R.estimateCenter(res.scenarios.off.geometry.segments);
  assert.equal(est.holes, 4);
  assert.equal(est.consistent, true);
  near(est.y, 0);
  near(est.spread, 0);
});

test('反推中心：孔在 Y8 的母線上 → 推出 Y8', () => {
  const res = full(FOUR_HOLES.replace(/Y0\./g, 'Y8.'));
  const est = R.estimateCenter(res.scenarios.off.geometry.segments);
  assert.equal(est.consistent, true);
  near(est.y, 8);
});

test('反推中心：孔的 Y 不一致 → consistent = false，spread 是實際差距', () => {
  const res = full([
    'M6T1(SG-8.5)',
    'G0G90G54X20.Y0.A0.G43H1Z50.M3S900',
    'G98G81Z10.R25.F70M8',
    'Y-10.A90.',
    'Y10.A180.',
    'G80',
  ].join('\n'));
  const est = R.estimateCenter(res.scenarios.off.geometry.segments);
  assert.equal(est.consistent, false);
  near(est.spread, 20);
});

test('R37：刀偏到工件側邊的孔 → warning，並點名是哪幾行', () => {
  const res = full([
    'M6T1(SG-8.5)',
    'G0G90G54X20.Y0.A0.G43H1Z50.M3S900',
    'G98G81Z10.R25.F70M8',
    'Y-10.A90.',
    'Y10.A180.',
    'G80',
  ].join('\n'));
  const d = byRule(res.diagnostics, 'R37', 'warning').filter((x) => /偏在工件側邊/.test(x.message));
  assert.equal(d.length, 1);
  assert.match(d[0].message, /第 6、7 行/);   // 兩個偏掉的孔（%/O 包裝後 +2 行）
  assert.match(d[0].message, /10 mm/);
  assert.match(d[0].detail, /空氣中鑽/);
});

test('R37：正常的分度孔不報「母線」那條', () => {
  const res = full(FOUR_HOLES);
  assert.equal(byRule(res.diagnostics, 'R37').filter((x) => /母線/.test(x.message)).length, 0);
});

test('R37：刀尖穿過迴轉中心 → info，填對中心 Z 之後就不報', () => {
  // Z0 對在圓棒頂端（中心其實在 Z-25），但設定還是預設 0 → 孔底 Z-5 穿過中心線
  const prog2 = [
    'M6T1(SG-8.5)',
    'G0G90G54X20.Y0.A0.G43H1Z50.M3S900',
    'G98G81Z-5.R2.F70M8',
    'A90.',
    'G80',
  ].join('\n');
  const before = full(prog2);
  const d = byRule(before.diagnostics, 'R37', 'info').filter((x) => /穿過/.test(x.message));
  assert.equal(d.length, 1);

  const after = full(prog2, {
    settings: Object.assign(NC.util.defaultSettings(), { rotary: { center: { y: 0, z: -25 }, radius: 25 } }),
  });
  assert.equal(byRule(after.diagnostics, 'R37').filter((x) => /穿過/.test(x.message)).length, 0);
});

test('反推中心：三軸程式（沒有鑽孔）回 null', () => {
  const res = full('G0G90G54X0.Y0.Z5.\nG1X50.F200.');
  assert.equal(R.estimateCenter(res.scenarios.off.geometry.segments), null);
});

// ---------------------------------------------------------------------------
// 圓柱素材：(X, 弧長) → 半徑 的高度圖
//
// 平面高度圖是 (X,Y)→Z；圓棒是 (X, 弧長)→半徑。展開之後兩者同構，
// 所以 simulation 的切削邏輯完全重用，只多「兩軸格距不同」與「周向循環」兩件事。
// ---------------------------------------------------------------------------
const CYL_PROG = [
  'M6T6(SG-8.5)',
  'G0G90G54X20.Y0.A0.G43H6Z50.M3S900',
  'G98G81Z10.R25.F70M8',
  'A90.',
  'A180.',
  'A270.',
  'G80',
  'M9',
  'G91G28Z0.',
].join('\n');

function cylSim(cell = 0.5, radius = 20) {
  return NC.sim.create({ kind: 'cylinder', radius, xMin: -5, xMax: 65, center: { y: 0, z: 0 } }, cell);
}

test('圓柱素材：格網是 X × 周向，周向格距是圓周的等分', () => {
  const sim = cylSim(0.5, 20);
  assert.equal(sim.cylinder, true);
  assert.equal(sim.wrapY, true);
  near(sim.circumference, 2 * Math.PI * 20, 1e-9);
  // 周向格距 × 格數 = 圓周（繞一圈剛好接回原點，沒有半格接縫）
  near(sim.cellY * sim.ny, sim.circumference, 1e-9);
  assert.equal(sim.cellX, 0.5);
  assert.equal(sim.floorZ, 0);      // 軸心
  assert.equal(sim.topZ, 20);       // 表面
  // 初始整根都是實心的
  for (let i = 0; i < sim.height.length; i++) assert.equal(sim.height[i], 20);
});

test('圓柱素材：四個分度孔各自挖到正確深度，中間沒被誤挖', async () => {
  const res = NC.analyzeSync({ text: `%\nO1\n${CYL_PROG}\nM30\n%` });
  const sim = cylSim(0.5, 20);
  const out = await NC.sim.run(sim, res.scenarios.off, res.toolTable, NC.util.defaultSettings(), {});
  const k = Math.PI / 180 * 20;   // 角度 → 弧長
  for (const a of [0, 90, 180, 270]) {
    near(NC.sim.heightAt(out, 20, a * k), 10, 0.5, `A${a} 應該鑽到剩半徑 10`);
  }
  // 沒加工的角度維持原半徑
  near(NC.sim.heightAt(out, 20, 45 * k), 20, 1e-6);
  // 沒加工的軸向位置也是
  near(NC.sim.heightAt(out, 0, 0), 20, 1e-6);
  assert.ok(out.removedVolume > 0);
});

test('圓柱素材：周向循環——A0 與 A360 是同一格', () => {
  const sim = cylSim(0.5, 20);
  const k = Math.PI / 180 * 20;
  assert.equal(NC.sim.cellIndex(sim, 20, 0), NC.sim.cellIndex(sim, 20, 360 * k));
  assert.equal(NC.sim.cellIndex(sim, 20, -90 * k), NC.sim.cellIndex(sim, 20, 270 * k));
});

test('analyze：四軸程式自動改用圓柱素材，半徑推估', () => {
  const res = NC.analyzeSync({ text: `%\nO1\n${CYL_PROG}\nM30\n%` });
  assert.equal(res.stock.kind, 'cylinder');
  assert.equal(res.stock.source, 'estimated');
  near(res.stock.radius, 25, 1e-6);   // R 點在 Z25
  // 包絡盒仍然給得出來（下游的 bounds／面板要用）
  near(res.stock.min.z, -25, 1e-6);
  near(res.stock.max.z, 25, 1e-6);
});

test('analyze：填了直徑就用填的，不再推估', () => {
  const res = NC.analyzeSync({
    text: `%\nO1\n${CYL_PROG}\nM30\n%`,
    settings: Object.assign(NC.util.defaultSettings(), { rotary: { center: { y: 0, z: 0 }, radius: 20 } }),
  });
  assert.equal(res.stock.kind, 'cylinder');
  assert.equal(res.stock.source, 'user');
  near(res.stock.radius, 20, 1e-6);
});

test('analyze：三軸程式維持方塊素材', () => {
  const res = NC.analyzeSync({ text: '%\nO1\nG0G90G54X0.Y0.Z5.\nG1Z-2.F100.\nX50.\nM30\n%' });
  assert.notEqual(res.stock.kind, 'cylinder');
  assert.ok(res.stock.min && res.stock.max);
});

async function runCyl(src, radius) {
  const res = NC.analyzeSync({ text: `%
O1
${src}
M30
%` });
  const sim = cylSim(0.5, radius);
  return NC.sim.run(sim, res.scenarios.off, res.toolTable, NC.util.defaultSettings(), {});
}

test('圓柱素材：只越過軸心一點點 → 對面的材料不能動（洞在工件內部）', async () => {
  // 圓棒半徑 20，鑽到 Z-6：刀尖越過軸心 6mm，但離對面表面還有 14mm。
  // 對面那一段材料好好的——高度圖表達不了內部空洞，記成「表面挖低」會憑空削掉一大塊。
  const out = await runCyl([
    'M6T6(SG-8.5)',
    'G0G90G54X20.Y0.A0.G43H6Z50.M3S900',
    'G98G81Z-6.R25.F70M8',
    'G80',
  ].join('\n'), 20);
  const k = Math.PI / 180 * 20;
  near(NC.sim.heightAt(out, 20, 0), 0, 1e-6, 'A0 側鑽到軸心');
  near(NC.sim.heightAt(out, 20, 180 * k), 20, 1e-6, 'A180 側的材料應該完好');
  near(NC.sim.heightAt(out, 20, 90 * k), 20, 1e-6);
});

test('圓柱素材：真的鑽穿出對面表面 → 對面才有開口', async () => {
  const out = await runCyl([
    'M6T6(SG-8.5)',
    'G0G90G54X20.Y0.A0.G43H6Z50.M3S900',
    'G98G81Z-25.R25.F70M8',
    'G80',
  ].join('\n'), 20);
  const k = Math.PI / 180 * 20;
  near(NC.sim.heightAt(out, 20, 0), 0, 1e-6, 'A0 側');
  near(NC.sim.heightAt(out, 20, 180 * k), 0, 1e-6, 'A180 側被穿出開口');
  near(NC.sim.heightAt(out, 20, 90 * k), 20, 1e-6, '沒鑽到的角度不受影響');
});

test('圓柱素材：沒鑽到軸心就不會動到對面', async () => {
  const res = NC.analyzeSync({ text: `%\nO1\n${CYL_PROG}\nM30\n%` });
  const sim = cylSim(0.5, 20);
  const out = await NC.sim.run(sim, res.scenarios.off, res.toolTable, NC.util.defaultSettings(), {});
  const k = Math.PI / 180 * 20;
  // CYL_PROG 只鑽到剩半徑 10（沒過軸心），四個孔彼此不該互相挖穿
  for (const a of [0, 90, 180, 270]) near(NC.sim.heightAt(out, 20, a * k), 10, 0.5);
});
/** 某個 X 位置的橫截面：被挖到表面的格 → {角度（弧度，相對正上方）, 半徑, 機台 Z, 機台 Y} */
function crossSection(out, x) {
  const ix = Math.round((x - out.origin.x) / out.cellX);
  const cut = [];
  for (let iy = 0; iy < out.ny; iy++) {
    const r = out.height[iy * out.nx + ix];
    if (r >= out.radius - 1e-6) continue;
    let th = (out.origin.y + iy * out.cellY) / out.radius;
    if (th > Math.PI) th -= 2 * Math.PI;
    cut.push({ th, r, z: r * Math.cos(th), y: r * Math.sin(th) });
  }
  return cut.sort((a, b) => a.th - b.th);
}

/** 直上直下的 Ø10 平銑刀，沿 X 在 Ø40 圓棒上銑一條刀底 Z14 的槽 */
function slotProgram() {
  return [
    'M6T1(10MM)',
    'G0G90G54X10.Y0.A0.G43H1Z50.M3S1200',
    'G1Z14.F100.',
    'X40.F300.',
    'G0Z50.',
  ].join('\n');
}

test('圓柱素材：直上直下的刀切出平底，不是同心圓弧', async () => {
  // 槽底應該是 Z14 那個**平面**，每一格的半徑要隨角度變大（14 / cos φ），不是整片等於 14
  const out = await runCyl(slotProgram(), 20);
  const cut = crossSection(out, 25);
  assert.ok(cut.length > 10, `槽的橫截面應該有一排格子，實際 ${cut.length}`);
  for (const c of cut) near(c.z, 14, 1e-6, `φ${(c.th * 180 / Math.PI).toFixed(1)}° 的刀底 Z`);
  // 兩側的半徑一定比正中間大（等半徑 = 舊的圓弧底）
  assert.ok(cut[cut.length - 1].r > 14.05, `槽緣的半徑應該大於 14，實際 ${cut[cut.length - 1].r}`);
  // 開口（原始表面那一圈）的寬度是刀徑的**弦長**，不是弧長；容差一格
  const open = 2 * out.radius * Math.sin(cut[cut.length - 1].th);
  assert.ok(Math.abs(open - 10) <= 2 * out.cellY, `開口寬度應該接近刀徑 10，實際 ${open}`);
});

test('圓柱素材：槽壁是鉛直的（y = ±刀半徑），不是指向軸心的放射線', async () => {
  // 這是整個徑向 dexel 的重點：一格記一串材料區間，
  // 槽緣外側那些射線會變成「表面有料 → 中間空 → 下面又有料」，空洞的外緣就落在槽壁上。
  const out = await runCyl(slotProgram(), 20);
  const ix = Math.round((25 - out.origin.x) / out.cellX);
  let n = 0;
  for (let iy = 0; iy < out.ny; iy++) {
    const sp = NC.sim.spansOf(out, iy * out.nx + ix);
    if (sp.length < 4) continue;                       // 沒有內部空洞的射線跳過
    const th = (out.origin.y + iy * out.cellY) / out.radius;
    const y = sp[2] * Math.sin(th);                    // 空洞外緣 = 槽壁上的點
    const z = sp[2] * Math.cos(th);
    assert.ok(z > 13.9, `槽壁上的點應該在槽底之上，實際 z=${z}`);
    near(Math.abs(y), 5, 1e-3, `槽壁應該貼在 |y| = 5（刀半徑），實際 ${y}`);
    n++;
  }
  assert.ok(n >= 4, `槽緣兩側應該有一排帶空洞的射線，實際 ${n}`);
});

test('圓柱素材：貫穿孔有孔道，不再只是兩個開口', async () => {
  // 舊模型一格只記一個半徑，孔道（工件內部的空洞）根本存不下來。
  const out = await runCyl([
    'M6T6(SG-8.5)',
    'G0G90G54X20.Y0.A0.G43H6Z50.M3S900',
    'G98G81Z-25.R25.F70M8',
    'G80',
  ].join('\n'), 20);
  const k = Math.PI / 180 * 20;
  const idx = (deg) => NC.sim.cellIndex(out, 20, deg * k);
  assert.deepEqual(NC.sim.spansOf(out, idx(0)), [], 'A0 側整條射線都被鑽穿');
  assert.deepEqual(NC.sim.spansOf(out, idx(180)), [], 'A180 側也被穿出開口');
  // 側邊 90°：孔道把離軸心 4.25（刀半徑）以內的材料挖掉了，表面完好
  const side = NC.sim.spansOf(out, idx(90));
  assert.equal(side.length, 2, `側邊應該是一段材料（內部有孔道），實際 ${JSON.stringify(side)}`);
  near(side[0], 4.25, 0.3, '孔道的半徑就是刀半徑');
  near(side[1], 20, 1e-6, '側邊表面完好');
});

test('圓柱素材：只越過軸心一點點 → 對面是內部空洞，表面不動', async () => {
  const out = await runCyl([
    'M6T6(SG-8.5)',
    'G0G90G54X20.Y0.A0.G43H6Z50.M3S900',
    'G98G81Z-6.R25.F70M8',
    'G80',
  ].join('\n'), 20);
  const k = Math.PI / 180 * 20;
  const back = NC.sim.spansOf(out, NC.sim.cellIndex(out, 20, 180 * k));
  assert.equal(back.length, 2);
  near(back[0], 6, 0.1, '孔底越過軸心 6 mm');
  near(back[1], 20, 1e-6, '對面的表面完好');
});

test('圓柱素材：分度鑽孔的孔心仍然剛好等於孔底', async () => {
  const out = await runCyl([
    'M6T6(SG-8.5)',
    'G0G90G54X20.Y0.A0.G43H6Z50.M3S900',
    'G98G81Z10.R25.F70M8',
    'A90.',
    'G80',
  ].join('\n'), 20);
  const k = Math.PI / 180 * 20;
  near(NC.sim.heightAt(out, 20, 0), 10, 1e-6);
  near(NC.sim.heightAt(out, 20, 90 * k), 10, 1e-6);
});

test('cylSection：槽壁在輪廓上是一條鉛直線', async () => {
  const out = await runCyl(slotProgram(), 20);
  const sec = NC.sim.cylSection(out, 25);
  assert.ok(sec && sec.loops.length >= 1, '至少要有一圈輪廓');
  // 槽底 Z14、外圓 R20：這個帶狀範圍裡只會有槽壁的點（外圓在這個 z 要 |y| > 8.7）
  const wall = sec.loops.reduce((a, l) => a.concat(l), [])
    .filter((p) => p.z > 14.2 && p.z < 18 && Math.abs(p.y) > 2 && Math.abs(p.y) < 8);
  assert.ok(wall.length >= 4, `槽壁上應該有一排輪廓點，實際 ${wall.length}`);
  for (const p of wall) near(Math.abs(p.y), 5, 0.15, '槽壁應該貼在 |y| = 5（刀半徑）');
});

test('鑽到迴轉中心：θ 在軸心沒有意義，不能讓刀軸「掃過去一大段」', async () => {
  // unrollPath 踩過的坑：刀尖剛好落在軸心時 atan2(0,0) 回 0，
  // 展開座標上會從原本的角度瞬間跳到 0，模擬就沿路挖掉一整片扇形。
  const out = await runCyl([
    'M6T1(6MM)',
    'G0G90G54X20.Y0.A0.G43H1Z50.M3S1200',
    'G98G81Z0.R30.F80.',    // 鑽到 Z0 = 迴轉中心
    'G80',
  ].join('\n'), 30);
  const ix = Math.round((20 - out.origin.x) / out.cellX);
  let opened = 0;
  for (let iy = 0; iy < out.ny; iy++) if (out.height[iy * out.nx + ix] < 30 - 1e-6) opened++;
  // Ø6 的孔在 R30 的表面只開一條 6 mm 的口（約 12 格），不是半圈
  assert.ok(opened < 20, `表面只該開一條孔口，實際開了 ${opened} 格（共 ${out.ny} 格）`);
  // 側邊 45°：孔道把離軸心 3/sin45 以內挖掉了，表面完好
  const k = Math.PI / 180 * 30;
  const side = NC.sim.spansOf(out, NC.sim.cellIndex(out, 20, 45 * k));
  assert.equal(side.length, 2, `側邊應該是一段材料（內部有孔道），實際 ${JSON.stringify(side)}`);
  near(side[0], 3 / Math.sin(Math.PI / 4), 0.2, '孔道邊界');
  near(side[1], 30, 1e-6, '表面完好');
});

test('cylSection：鑽孔的截面是一條直上直下的槽，不是橫貫整根棒子的假面', async () => {
  // 配對規則踩過的坑：相鄰射線的材料要用**段的重疊關係**配。
  // 拿邊界由內往外配的話，孔正上方（軸心是空的）那些射線會把軸心接到外表面，
  // 剖面上就多出一條橫貫整根棒子的假面。
  const out = await runCyl([
    'M6T1(SG-6.)',
    'G0G90G54X20.Y0.A0.G43H1Z50.M3S900',
    'G98G81Z0.R30.F80.',
    'G80',
  ].join('\n'), 30);
  const sec = NC.sim.cylSection(out, 20);
  assert.ok(sec && sec.loops.length === 1, `孔通到軸心 → 只有一圈輪廓，實際 ${sec ? sec.loops.length : 0}`);
  const wall = sec.loops[0].filter((p) => p.z > 5 && p.z < 25 && Math.abs(p.y) < 10);
  assert.ok(wall.length > 20, `孔壁上應該有一整排點，實際 ${wall.length}`);
  for (const p of wall) near(Math.abs(p.y), 3, 1e-3, '孔壁應該貼在 |y| = 3（刀半徑）');
});

test('圓柱素材：沒切過的圓棒不佔 extra，height 自己就講完了', async () => {
  const out = await runCyl('M6T1(10MM)\nG0G90G54X10.Y0.A0.G43H1Z50.M3S1200\nG0A90.', 20);
  assert.equal(out.extra.size, 0);
  assert.deepEqual(NC.sim.spansOf(out, 0), [0, 20]);
});

test('estimateRadius：優先用真正垂直鑽的孔，不被偏在側邊的刀撐大', () => {
  // 兩刀垂直鑽（Y0，R 點 Z25）＋ 兩刀偏在側邊 21.474（起點離軸心 √(25²+21.474²) ≈ 33）
  const res = full([
    'M6T1(SG-8.5)',
    'G0G90G54X-21.474Y0.A0.G43H1Z50.M3S900',
    'G98G81Z-1.R25.F70M8',
    'X0.Y-21.474A90.',
    'X21.474Y0.A180.',
    'X0.Y21.474A270.',
    'G80',
  ].join('\n'));
  const est = R.estimateRadius(res.scenarios.off.geometry.segments);
  assert.equal(est.source, 'radial');
  near(est.radius, 25, 1e-6, '應該用 Y0 那兩刀的 R 點，不是側邊刀的斜距 33');
});

test('estimateRadius：沒有垂直鑽的孔時退回原本的推估', () => {
  const res = full('M6T1(6MM)\nG0G90G54X10.Y0.A0.G43H1Z50.M3S1000\nZ25.\nG1Z17.F200\nX60.F250\nG0A90.');
  const est = R.estimateRadius(res.scenarios.off.geometry.segments);
  assert.equal(est.source, 'cut');
  assert.ok(est.radius > 0);
});
