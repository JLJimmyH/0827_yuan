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
test('R37：分度程式一定有一則「路徑照工件不轉畫」的總體標示', () => {
  const res = full('G0G90G54X10.Y0.A0.Z50.\nG0A90.');
  const d = byRule(res.diagnostics, 'R37', 'warning').filter((x) => /工件不轉/.test(x.message));
  assert.equal(d.length, 1);
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
