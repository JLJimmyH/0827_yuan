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
