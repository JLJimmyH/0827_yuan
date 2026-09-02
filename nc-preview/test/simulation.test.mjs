// simulation.js 測試：手寫 Segment 陣列驗證足跡、碰撞、snapshot、時間；若上游模組存在則用 樣本 C 做契約驗收。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNC, fixture, goldenSkip, FIX_C } from './load.mjs';

const NC = loadNC();
const S = NC.sim;

// ---------------------------------------------------------------------------
// 測試用小工具
// ---------------------------------------------------------------------------
const V = (x, y, z) => ({ x, y, z });
let nextId = 1;
/** 建一個 Segment（預設 feed 段、T1、第 1 行、op 0） */
function seg(o) {
  return Object.assign({ id: nextId++, line: 1, opIndex: 0, tool: 1, kind: 'feed', feed: 200, path: 'programmed' }, o);
}
function tool(t, type, diameter, extra) {
  return Object.assign({ t, label: `T${t}`, type, diameter, angle: null, fluteLen: null, stickout: null, pitch: null, resident: false, probe: false, source: {} }, extra || {});
}
function table(tools) {
  return { programKey: 'test', tools, offsets: [], updatedAt: new Date().toISOString() };
}
function stock(w, d, h, fixtures) {
  return { min: V(-w / 2, -d / 2, -h), max: V(w / 2, d / 2, 0), source: 'user', fixtures: fixtures || [] };
}
function op(index, t, lineStart, lineEnd) {
  return { index, tool: t, toolComment: null, h: t, dList: [], lineStart, lineEnd, zMin: null, feeds: [], rpms: [], gCodes: [], kindGuess: 'unknown' };
}
function scenario(segments, ops, executed) {
  return {
    run: { scenario: 'off', executed: executed || [], ops: ops || [op(0, 1, 1, 99)], diagnostics: [], finalState: null },
    geometry: { segments, diagnostics: [], bounds: null },
    sim: null,
  };
}
const settings = () => NC.util.defaultSettings();
const TT = table([
  tool(1, 'endmill', 10),
  tool(2, 'drill', 10, { angle: 118 }),
  tool(3, 'chamfer', 8, { angle: 90 }),
  tool(4, 'tap', 6, { pitch: 1 }),
  tool(5, 'facemill', 50),
  tool(6, 'ballmill', 10),
]);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} 期望 ${b}±${tol}，實際 ${a}`);

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
test('create：格數、原點、初始高度、floorZ', () => {
  const sim = S.create(stock(130, 60, 15), 0.25);
  assert.equal(sim.nx, 521);
  assert.equal(sim.ny, 241);
  assert.deepEqual(sim.origin, { x: -65, y: -30 });
  assert.equal(sim.floorZ, -15);
  assert.equal(sim.height.length, 521 * 241);
  assert.ok(sim.height.every((h) => h === 0));
  assert.equal(S.heightAt(sim, 0, 0), 0);
  assert.equal(S.heightAt(sim, 999, 0), null);
});

test('create：治具寫進 height 並記錄 mask', () => {
  const st = stock(100, 100, 20, [{ min: V(30, -10, -20), max: V(50, 10, 8), name: '壓板' }]);
  const sim = S.create(st, 0.5);
  assert.equal(S.heightAt(sim, 40, 0), 8);
  assert.equal(sim.mask[S.cellIndex(sim, 40, 0)], 1);
  assert.equal(S.heightAt(sim, 0, 0), 0);
  assert.equal(sim.mask[S.cellIndex(sim, 0, 0)], 0);
  assert.equal(sim.topZ, 8);
});

// ---------------------------------------------------------------------------
// 足跡
// ---------------------------------------------------------------------------
test('Ø10 平銑刀沿 X 切一刀：槽內 -3、槽外 0、端頭圓弧', async () => {
  const sim = S.create(stock(100, 40, 10), 0.25);
  const segs = [seg({ from: V(-20, 0, -3), to: V(20, 0, -3), line: 5 })];
  const res = await S.run(sim, scenario(segs), TT, settings());
  near(S.heightAt(res, 0, 0), -3, 1e-6, '槽中心');
  near(S.heightAt(res, 15, 4.5), -3, 1e-6, '槽內 y=4.5');
  near(S.heightAt(res, -19, -4.75), -3, 1e-6, '槽內 y=-4.75');
  assert.equal(S.heightAt(res, 0, 5.25), 0, '槽外 y=5.25');
  assert.equal(S.heightAt(res, 0, -6), 0, '槽外 y=-6');
  near(S.heightAt(res, 24, 0), -3, 1e-6, '端頭圓弧內 (24,0)');
  assert.equal(S.heightAt(res, 24, 4), 0, '端頭圓弧外 (24,4)：距 (20,0) 5.66 > 5');
  assert.equal(S.heightAt(res, 26, 0), 0, '端頭外');
  assert.equal(res.events.length, 0);
  // 移除體積 ≈ 槽 40×10×3 + 兩個半圓 π·25·3
  near(res.removedVolume, 40 * 10 * 3 + Math.PI * 25 * 3, 40, '移除體積');
});

test('Ø10 平銑刀斜下（ramp）：膠囊公式沿線取最低 Z', async () => {
  const sim = S.create(stock(100, 40, 10), 0.25);
  const segs = [seg({ from: V(-20, 0, 0), to: V(20, 0, -4), line: 5 })];
  const res = await S.run(sim, scenario(segs), TT, settings());
  near(S.heightAt(res, 20, 0), -4, 1e-6, '終點');
  // x=0 的格子被圓盤蓋到的最後位置是刀心在 x=5 → z = -4·(25/40) = -2.5
  near(S.heightAt(res, 0, 0), -2.5, 1e-6, '中段');
  // x=-20 起點：刀心到 x=-15 時仍蓋到 → z = -4·(5/40) = -0.5
  near(S.heightAt(res, -20, 0), -0.5, 1e-6, '起點');
});

test('鑽頭 Ø10 118°：孔底錐形', async () => {
  const sim = S.create(stock(60, 60, 20), 0.25);
  const segs = [seg({ tool: 2, kind: 'drill', from: V(0, 0, 2), to: V(0, 0, -8), line: 7, feed: 100 })];
  const res = await S.run(sim, scenario(segs), TT, settings());
  const tanHalf = Math.tan(59 * Math.PI / 180);
  near(S.heightAt(res, 0, 0), -8, 1e-5, '孔心');
  near(S.heightAt(res, 2.5, 0), -8 + 2.5 / tanHalf, 1e-4, 'd=2.5');
  near(S.heightAt(res, 0, -4), -8 + 4 / tanHalf, 1e-4, 'd=4');
  assert.equal(S.heightAt(res, 5.25, 0), 0, '孔外');
  assert.equal(S.heightAt(res, 8, 8), 0, '遠處');
});

test('倒角刀 Ø8 90°：倒錐足跡，尖端在下', async () => {
  const sim = S.create(stock(60, 60, 20), 0.25);
  const segs = [seg({ tool: 3, kind: 'drill', from: V(0, 0, 2), to: V(0, 0, -2), line: 7, feed: 80 })];
  const res = await S.run(sim, scenario(segs), TT, settings());
  near(S.heightAt(res, 0, 0), -2, 1e-5, '尖端');
  near(S.heightAt(res, 1, 0), -1, 1e-4, 'd=1 → -1');
  near(S.heightAt(res, 0, 1.5), -0.5, 1e-4, 'd=1.5 → -0.5');
  assert.equal(S.heightAt(res, 3, 0), 0, 'd=3 → 錐面高於頂面');
});

test('倒角刀沿直線走：錐形足跡沿路徑（固定 Z 的解析解）', async () => {
  const sim = S.create(stock(100, 40, 10), 0.25);
  const segs = [seg({ tool: 3, from: V(-10, 0, -2), to: V(10, 0, -2), line: 9 })];
  const res = await S.run(sim, scenario(segs), TT, settings());
  near(S.heightAt(res, 0, 0), -2, 1e-5, '中心線');
  near(S.heightAt(res, 3, 1), -1, 1e-4, '偏 1 → -1');
  near(S.heightAt(res, 11, 0), -1, 1e-4, '端頭外 1 → -1');
});

test('球刀 Ø10：球面足跡', async () => {
  const sim = S.create(stock(60, 60, 20), 0.25);
  const segs = [seg({ tool: 6, kind: 'drill', from: V(0, 0, 2), to: V(0, 0, -5), line: 3, feed: 100 })];
  const res = await S.run(sim, scenario(segs), TT, settings());
  near(S.heightAt(res, 0, 0), -5, 1e-5);
  near(S.heightAt(res, 3, 0), -5 + (5 - 4), 1e-4, 'd=3 → 球面高 1');
});

test('tap 不改材料，但時間照算', async () => {
  const sim = S.create(stock(60, 60, 20), 0.25);
  const segs = [
    seg({ tool: 4, kind: 'drill', from: V(0, 0, 2), to: V(0, 0, -10), line: 3, feed: 600 }),
    seg({ tool: 4, kind: 'drill', from: V(0, 0, -10), to: V(0, 0, 2), line: 3, feed: 600, sub: 'tapUp' }),
  ];
  const res = await S.run(sim, scenario(segs), TT, settings());
  assert.equal(S.heightAt(res, 0, 0), 0);
  assert.ok(res.height.every((h) => h === 0));
  near(res.time.total, 24 / 600 * 60, 1e-9, '時間');
});

test('圓弧：Ø10 平銑刀走 R20 半圓（G3）', async () => {
  const sim = S.create(stock(100, 100, 10), 0.25);
  const segs = [seg({ kind: 'arc', from: V(20, 0, -2), to: V(-20, 0, -2), arc: { center: { x: 0, y: 0 }, cw: false, r: 20 }, line: 4 })];
  const res = await S.run(sim, scenario(segs), TT, settings());
  near(S.heightAt(res, 0, 20), -2, 1e-6, '弧頂 (0,20)');
  near(S.heightAt(res, 0, 16), -2, 1e-6, '弧內側 16');
  near(S.heightAt(res, 0, 24), -2, 1e-6, '弧外側 24');
  assert.equal(S.heightAt(res, 0, 14), 0, '弧內 14 未切');
  assert.equal(S.heightAt(res, 0, 26), 0, '弧外 26 未切');
  assert.equal(S.heightAt(res, 0, -20), 0, '下半圓未走');
  near(S.heightAt(res, 24, 0), -2, 1e-6, '端頭 (24,0)');
  near(S.heightAt(res, -20, 0), -2, 1e-6, '終點');
  near(S.heightAt(res, -24, 0), -2, 1e-6, '終點端頭');
  near(res.time.total, Math.PI * 20 / 200 * 60, 1e-6, '弧長時間');
});

test('整圓與順時針弧', async () => {
  const sim = S.create(stock(100, 100, 10), 0.25);
  const segs = [
    seg({ kind: 'arc', from: V(10, 0, -1), to: V(10, 0, -1), arc: { center: { x: 0, y: 0 }, cw: true, r: 10 }, line: 4 }),
    seg({ kind: 'arc', from: V(40, 0, -1), to: V(0, 40, -1), arc: { center: { x: 40, y: 40 }, cw: true, r: 40 }, line: 5 }),
  ];
  const res = await S.run(sim, scenario(segs), TT, settings());
  for (const ang of [0, 90, 180, 270, 45]) {
    const a = ang * Math.PI / 180;
    near(S.heightAt(res, 10 * Math.cos(a), 10 * Math.sin(a)), -1, 1e-6, `整圓 ${ang}°`);
  }
  assert.equal(S.heightAt(res, 0, 0), 0, '整圓中心');
  // 順時針從 (40,0) 到 (0,40)，圓心 (40,40)：經過 (40-40cos45, 40-40sin45) ≈ (11.7,11.7)
  near(S.heightAt(res, 40 - 40 * Math.SQRT1_2, 40 - 40 * Math.SQRT1_2), -1, 1e-6, 'CW 弧中點');
});

test('螺旋下刀：Z 沿弧變化', async () => {
  const sim = S.create(stock(60, 60, 20), 0.25);
  const segs = [seg({ kind: 'arc', from: V(5, 0, 0), to: V(5, 0, -4), arc: { center: { x: 0, y: 0 }, cw: false, r: 5 }, line: 4 })];
  const res = await S.run(sim, scenario(segs), TT, settings());
  near(S.heightAt(res, 5, 0), -4, 0.13, '終點附近最低');
  // (0,-0.5) 在刀心轉到約 357° 前都還在足跡內 → 接近最低；(0,0.5) 最後被蓋到約 177° → 約 -2
  assert.ok(S.heightAt(res, 0, -0.5) <= -3.9, '(0,-0.5) 接近最低');
  near(S.heightAt(res, 0, 0.5), -2, 0.15, '(0,0.5) 半圈處');
  assert.equal(S.heightAt(res, 0, 0), 0, '圓心離刀心恰 5 = r：相切不切');
});

// ---------------------------------------------------------------------------
// 碰撞 R27
// ---------------------------------------------------------------------------
test('rapid 撞料 → R27 error（附 line、pos、scenario）', async () => {
  const sim = S.create(stock(100, 40, 10), 0.25);
  const segs = [
    seg({ kind: 'rapid', feed: null, from: V(-70, 0, 5), to: V(-70, 0, -2), line: 10 }), // 工件外下刀：不撞
    seg({ kind: 'rapid', feed: null, from: V(-70, 0, -2), to: V(70, 0, -2), line: 11 }), // 橫穿工件：撞
    seg({ kind: 'rapid', feed: null, from: V(70, 0, -2), to: V(70, 0, 30), line: 12 }), // 上升：不撞
    seg({ kind: 'rapid', feed: null, from: V(70, 0, 30), to: V(0, 0, 30), line: 13 }), // 高處：不撞
    seg({ kind: 'rapid', feed: null, from: V(0, 0, 30), to: V(0, 0, -1), line: 14 }), // 直接下刀進材料：撞
  ];
  const res = await S.run(sim, scenario(segs), TT, settings());
  const r27 = res.events.filter((e) => e.ruleId === 'R27');
  assert.equal(r27.length, 2);
  assert.deepEqual(r27.map((e) => e.line), [11, 14]);
  for (const e of r27) {
    assert.equal(e.severity, 'error');
    assert.equal(e.scenario, 'off');
    assert.ok(e.pos && typeof e.pos.x === 'number' && typeof e.pos.z === 'number');
    assert.ok(e.message.includes('G0'));
    assert.ok(e.detail && e.detail.length > 0);
  }
  assert.ok(r27[1].message.includes('下刀'), '下刀終點在材料內');
  near(r27[1].pos.z, 0, 1e-6, '干涉位置的材料高度');
  assert.ok(res.height.every((h) => h === 0), 'rapid 不改材料');
});

test('rapid 在已切區域內移動、或與素材邊相切 → 不報 R27', async () => {
  const sim = S.create(stock(100, 40, 10), 0.25);
  const segs = [
    seg({ from: V(-20, 0, -3), to: V(20, 0, -3), line: 5 }),
    seg({ kind: 'rapid', feed: null, from: V(20, 0, -3), to: V(-20, 0, -3), line: 6 }), // 在剛切的槽內
    seg({ kind: 'rapid', feed: null, from: V(-20, 0, -3), to: V(-20, 0, 20), line: 7 }),
    seg({ kind: 'rapid', feed: null, from: V(-55, 30, 20), to: V(-55, 30, -5), line: 8 }), // 距素材邊 (x=-50) 剛好 5 = r：相切
    seg({ kind: 'rapid', feed: null, from: V(-55, 30, -5), to: V(-55, -30, -5), line: 9 }),
  ];
  const res = await S.run(sim, scenario(segs), TT, settings());
  assert.deepEqual(res.events, []);
});

test('rapid 撞治具 → R27（訊息含治具名）；進給切到治具也報 R27', async () => {
  const st = stock(100, 100, 20, [{ min: V(30, -10, -20), max: V(50, 10, 8), name: '壓板' }]);
  const sim = S.create(st, 0.5);
  const segs = [
    seg({ kind: 'rapid', feed: null, from: V(-40, 0, 5), to: V(60, 0, 5), line: 3 }),
    seg({ from: V(0, 0, -2), to: V(45, 0, -2), line: 4 }),
  ];
  const res = await S.run(sim, scenario(segs), TT, settings());
  const r27 = res.events.filter((e) => e.ruleId === 'R27');
  assert.equal(r27.length, 2);
  assert.ok(r27[0].message.includes('壓板') && r27[0].line === 3);
  assert.ok(r27[1].message.includes('治具') && r27[1].line === 4);
  assert.equal(S.heightAt(res, 40, 0), 8, '治具不被切');
  near(S.heightAt(res, 20, 0), -2, 1e-6, '治具外照切');
});

test('refReturn 段與鑽頭錐形孔內的 rapid 不誤報', async () => {
  const sim = S.create(stock(60, 60, 20), 0.25);
  const segs = [
    seg({ tool: 2, kind: 'drill', from: V(0, 0, 2), to: V(0, 0, -8), line: 7, feed: 100, sub: 'peck' }),
    seg({ tool: 2, kind: 'rapid', feed: null, from: V(0, 0, -8), to: V(0, 0, 2), line: 7, sub: 'retract' }),
    seg({ tool: 2, kind: 'rapid', feed: null, from: V(0, 0, 2), to: V(0, 0, -7.5), line: 7 }), // 回到上次深度上方 0.5
    seg({ tool: 2, kind: 'drill', from: V(0, 0, -7.5), to: V(0, 0, -12), line: 7, feed: 100, sub: 'peck' }),
    seg({ tool: 2, kind: 'rapid', feed: null, from: V(0, 0, -12), to: V(0, 0, -12), line: 8, refReturn: true }),
    seg({ tool: 2, kind: 'rapid', feed: null, from: V(0, 0, -12), to: V(0, 0, 150), line: 8, refReturn: true }),
  ];
  const res = await S.run(sim, scenario(segs), TT, settings());
  assert.deepEqual(res.events, []);
  near(S.heightAt(res, 0, 0), -12, 1e-5);
});

// ---------------------------------------------------------------------------
// R28
// ---------------------------------------------------------------------------
test('重切削與高速下刀 → R28 warning', async () => {
  const sim = S.create(stock(100, 60, 30), 0.25);
  const segs = [
    seg({ from: V(-30, 0, -20), to: V(30, 0, -20), line: 5 }), // 全刃寬 20 深 > 1.5×10 → 重切削
    seg({ from: V(-30, 10, 2), to: V(-30, 10, -5), line: 6, feed: 500 }), // 材料內垂直下刀 F500 > 300
    seg({ from: V(-30, 20, 2), to: V(-30, 20, -5), line: 7, feed: 200 }), // F200 不報
    seg({ from: V(0, 0, 2), to: V(0, 0, -5), line: 8, feed: 800 }), // 已切的槽內（無材料）不報
    seg({ from: V(-30, -20, -2), to: V(30, -20, -2), line: 9 }), // 全刃寬 2 深：不報
  ];
  const res = await S.run(sim, scenario(segs), TT, settings());
  const r28 = res.events.filter((e) => e.ruleId === 'R28');
  assert.deepEqual(r28.map((e) => e.line), [5, 6]);
  assert.ok(r28[0].message.includes('重切削'));
  assert.ok(r28[1].message.includes('下刀'));
  assert.ok(r28.every((e) => e.severity === 'warning' && e.pos));
});

// ---------------------------------------------------------------------------
// compensated 優先
// ---------------------------------------------------------------------------
test('同一行有 compensated 段時只用 compensated', async () => {
  const sim = S.create(stock(100, 60, 10), 0.25);
  const segs = [
    seg({ from: V(-20, 0, -2), to: V(20, 0, -2), line: 5, path: 'programmed' }),
    seg({ from: V(-20, 5, -2), to: V(20, 5, -2), line: 5, path: 'compensated' }),
    seg({ from: V(20, 5, -2), to: V(20, 20, -2), line: 6, path: 'programmed' }),
  ];
  const res = await S.run(sim, scenario(segs), TT, settings());
  near(S.heightAt(res, 0, 5), -2, 1e-6, 'compensated 路徑');
  near(S.heightAt(res, 0, 9), -2, 1e-6);
  assert.equal(S.heightAt(res, 0, -3), 0, 'programmed 路徑（y=-3 只在 programmed 足跡內）未切');
  near(S.heightAt(res, 20, 15), -2, 1e-6, '沒有 compensated 的行照用 programmed');
});

// ---------------------------------------------------------------------------
// snapshot / fromOpIndex
// ---------------------------------------------------------------------------
test('每個 op 存 snapshot；fromOpIndex 從 snapshot 還原', async () => {
  const sim = S.create(stock(100, 60, 10), 0.25);
  const ops = [op(0, 1, 1, 10), op(1, 2, 11, 20), op(2, 1, 21, 30)];
  const segsA = [
    seg({ opIndex: 0, from: V(-20, 0, -2), to: V(20, 0, -2), line: 5 }),
    seg({ opIndex: 1, tool: 2, kind: 'drill', from: V(0, 20, 2), to: V(0, 20, -6), line: 15, feed: 100 }),
    seg({ opIndex: 2, from: V(-20, -20, -1), to: V(20, -20, -1), line: 25 }),
  ];
  const full = await S.run(sim, scenario(segsA, ops), TT, settings());
  assert.equal(full.snapshots.length, 3);
  assert.deepEqual(full.snapshots.map((s) => s.afterOpIndex), [0, 1, 2]);
  assert.deepEqual(full.snapshots.map((s) => s.tool), [1, 2, 1]);
  const snap0 = { height: full.snapshots[0].height, nx: full.nx, ny: full.ny, origin: full.origin, cell: full.cell };
  near(S.heightAt(snap0, 0, 0), -2, 1e-6, 'snapshot0 有第一刀');
  assert.equal(S.heightAt(snap0, 0, 20), 0, 'snapshot0 還沒鑽孔');
  const snap1 = Object.assign({}, snap0, { height: full.snapshots[1].height });
  near(S.heightAt(snap1, 0, 20), -6, 1e-5, 'snapshot1 有鑽孔');
  assert.equal(S.heightAt(snap1, 0, -20), 0, 'snapshot1 還沒第三刀');
  assert.equal(full.time.perOp.length, 3);

  // 改 op 1 的段（改鑽別的位置），從 op 1 重跑：op 0 的結果保留、舊 op 1 的孔不存在
  const segsB = [
    segsA[0],
    seg({ opIndex: 1, tool: 2, kind: 'drill', from: V(10, 20, 2), to: V(10, 20, -6), line: 15, feed: 100 }),
    segsA[2],
  ];
  const partial = await S.run(sim, scenario(segsB, ops), TT, settings(), { fromOpIndex: 1 });
  near(S.heightAt(partial, 0, 0), -2, 1e-6, 'op 0 保留');
  assert.equal(S.heightAt(partial, 0, 20), 0, '舊孔不存在');
  near(S.heightAt(partial, 10, 20), -6, 1e-5, '新孔');
  near(S.heightAt(partial, 0, -20), -1, 1e-6, 'op 2 重跑');
  assert.equal(partial.snapshots.length, 3);
  near(partial.time.total, full.time.total, 1e-9, '時間相同');
  // 沒有對應 snapshot 時（fromOpIndex 超過範圍或沒跑過）→ 從頭跑
  const fresh = S.create(stock(100, 60, 10), 0.25);
  const r3 = await S.run(fresh, scenario(segsB, ops), TT, settings(), { fromOpIndex: 2 });
  near(S.heightAt(r3, 0, 0), -2, 1e-6);
  near(S.heightAt(r3, 10, 20), -6, 1e-5);
});

test('超過 25 個 op 時 snapshot 稀疏化但保留最後一個', async () => {
  const sim = S.create(stock(100, 60, 10), 1);
  const n = 60;
  const ops = [];
  const segs = [];
  for (let i = 0; i < n; i++) {
    ops.push(op(i, 1, i * 2 + 1, i * 2 + 2));
    segs.push(seg({ opIndex: i, from: V(-40, -25 + i * 0.8, -1), to: V(40, -25 + i * 0.8, -1), line: i * 2 + 1 }));
  }
  const res = await S.run(sim, scenario(segs, ops), TT, settings());
  assert.ok(res.snapshots.length <= 25 && res.snapshots.length >= 20, `snapshots=${res.snapshots.length}`);
  assert.equal(res.snapshots[res.snapshots.length - 1].afterOpIndex, n - 1);
  const partial = await S.run(sim, scenario(segs, ops), TT, settings(), { fromOpIndex: 40 });
  assert.ok(partial.height.every((h, i) => h === res.height[i]), '從稀疏 snapshot 重跑結果一致');
});

// ---------------------------------------------------------------------------
// 時間估算
// ---------------------------------------------------------------------------
test('時間估算：feed、rapid（含多軸）、dwell、perOp', async () => {
  const sim = S.create(stock(100, 60, 10), 0.5);
  const ops = [op(0, 1, 1, 10), op(1, 1, 11, 20)];
  const segs = [
    seg({ opIndex: 0, from: V(-50, 0, 5), to: V(50, 0, 5), line: 5, feed: 200 }), // 100 mm / 200 → 30 s（在空中，沒切到）
    seg({ opIndex: 0, kind: 'rapid', feed: null, from: V(50, 0, 5), to: V(50, 0, 105), line: 6 }), // 100 / 20000 → 0.3 s
    seg({ opIndex: 1, kind: 'rapid', feed: null, nonLinear: true, from: V(50, 0, 105), to: V(-50, 0, 155), line: 15 }), // 最長軸 100 → 0.3 s
  ];
  const executed = [
    { line: 7, opIndex: 0, skipped: false, ignored: false, actions: [{ kind: 'dwell', seconds: 2 }] },
    { line: 16, opIndex: 1, skipped: false, ignored: false, actions: [{ kind: 'dwell', seconds: 1.5 }] },
    { line: 17, opIndex: 1, skipped: true, ignored: false, actions: [{ kind: 'dwell', seconds: 99 }] },
  ];
  const res = await S.run(sim, scenario(segs, ops, executed), TT, settings());
  near(res.time.perOp[0], 30 + 0.3 + 2, 1e-9, 'op0');
  near(res.time.perOp[1], 0.3 + 1.5, 1e-9, 'op1');
  near(res.time.total, 34.1, 1e-9, 'total');
});

// ---------------------------------------------------------------------------
// onProgress / yield
// ---------------------------------------------------------------------------
test('onProgress 遞增到 1，分批讓出事件迴圈', async () => {
  const sim = S.create(stock(100, 60, 10), 0.25);
  const segs = [];
  for (let i = 0; i < 40; i++) segs.push(seg({ from: V(-40, -25 + (i % 50), -1), to: V(40, -25 + (i % 50), -1), line: i + 1 }));
  const progress = [];
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const res = await S.run(sim, scenario(segs), TT, settings(), { onProgress: (p) => progress.push(p), yieldEveryMs: 0 });
  clearInterval(timer);
  assert.equal(progress[progress.length - 1], 1);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1]);
  assert.ok(progress.length >= 2, '至少讓出一次');
  assert.ok(ticks > 0, '事件迴圈有機會執行');
  assert.ok(res.height.some((h) => h === -1));
});

// ---------------------------------------------------------------------------
// 效能
// ---------------------------------------------------------------------------
test('效能：約 5,000 段、0.25 mm 格、140×100 素材 < 3 s', async () => {
  const sim = S.create({ min: V(-70, -50, -20), max: V(70, 50, 0), source: 'user', fixtures: [] }, 0.25);
  const tt = table([tool(1, 'endmill', 12), tool(2, 'drill', 6, { angle: 118 }), tool(3, 'facemill', 63), tool(4, 'chamfer', 8, { angle: 90 })]);
  const segs = [];
  let line = 1;
  // 面銑 6 刀
  for (let i = 0; i < 6; i++) {
    segs.push(seg({ opIndex: 0, tool: 3, from: V(-110, -40 + i * 16, -0.5), to: V(110, -40 + i * 16, -0.5), line: line++ }));
    segs.push(seg({ opIndex: 0, tool: 3, kind: 'rapid', feed: null, from: V(110, -40 + i * 16, -0.5), to: V(110, -40 + i * 16, 20), line: line++ }));
    segs.push(seg({ opIndex: 0, tool: 3, kind: 'rapid', feed: null, from: V(110, -40 + i * 16, 20), to: V(-110, -24 + i * 16, 20), line: line++ }));
  }
  // 口袋分層：每層 Z 往返 + 圓弧 + 短 rapid，湊到 ~4,000 段
  let z = -0.5;
  for (let layer = 0; layer < 20; layer++) {
    z -= 0.9;
    for (let row = 0; row < 60; row++) {
      const y = -45 + row * 1.5;
      const dir = row % 2 ? -1 : 1;
      segs.push(seg({ opIndex: 1, tool: 1, from: V(-60 * dir, y, z), to: V(60 * dir, y, z), line: line++ }));
      segs.push(seg({ opIndex: 1, tool: 1, kind: 'arc', from: V(60 * dir, y, z), to: V(60 * dir, y + 1.5, z), arc: { center: { x: 60 * dir, y: y + 0.75 }, cw: dir > 0, r: 0.75 }, line: line++ }));
      segs.push(seg({ opIndex: 1, tool: 1, kind: 'rapid', feed: null, from: V(60 * dir, y + 1.5, z), to: V(60 * dir, y + 1.5, z), line: line++ }));
      segs.push(seg({ opIndex: 1, tool: 1, from: V(60 * dir, y + 1.5, z), to: V(60 * dir, y + 1.5, z - 0.01), line: line++, feed: 100 }));
    }
    segs.push(seg({ opIndex: 1, tool: 1, kind: 'rapid', feed: null, from: V(-60, 43, z), to: V(-60, 43, 30), line: line++ }));
    segs.push(seg({ opIndex: 1, tool: 1, kind: 'rapid', feed: null, from: V(-60, 43, 30), to: V(-60, -45, 30), line: line++ }));
  }
  // 鑽 120 孔（G83 展開：rapid 下、peck、retract）
  for (let i = 0; i < 120; i++) {
    const x = -60 + (i % 20) * 6.3, y = -40 + Math.floor(i / 20) * 15;
    segs.push(seg({ opIndex: 2, tool: 2, kind: 'rapid', feed: null, from: V(x, y, 20), to: V(x, y, 2), line: line++ }));
    segs.push(seg({ opIndex: 2, tool: 2, kind: 'drill', from: V(x, y, 2), to: V(x, y, -25), line: line, feed: 120, sub: 'peck' }));
    segs.push(seg({ opIndex: 2, tool: 2, kind: 'rapid', feed: null, from: V(x, y, -25), to: V(x, y, 20), line: line++, sub: 'retract' }));
  }
  // 倒角一圈
  for (let i = 0; i < 100; i++) {
    const a0 = i / 100 * Math.PI * 2, a1 = (i + 1) / 100 * Math.PI * 2;
    segs.push(seg({ opIndex: 3, tool: 4, from: V(45 * Math.cos(a0), 45 * Math.sin(a0), -1), to: V(45 * Math.cos(a1), 45 * Math.sin(a1), -1), line: line++ }));
  }
  const ops = [op(0, 3, 1, 20), op(1, 1, 21, 2000), op(2, 2, 2001, 2400), op(3, 4, 2401, 2600)];
  assert.ok(segs.length >= 4500, `segs=${segs.length}`);
  const t0 = performance.now();
  const res = await S.run(sim, scenario(segs, ops), tt, settings());
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `耗時 ${ms.toFixed(0)} ms`);
  console.log(`  # 效能：${segs.length} 段、${sim.nx}×${sim.ny} 格，耗時 ${ms.toFixed(0)} ms`);
  near(S.heightAt(res, 0, 0), z, 1e-5, '口袋底');
  assert.equal(res.snapshots.length, 4);
});

// ---------------------------------------------------------------------------
// 契約驗收：樣本 C
// ---------------------------------------------------------------------------
const upstreamReady = typeof NC.tokenize === 'function' && typeof NC.interpret === 'function' && typeof NC.buildSegments === 'function';
test('契約驗收 樣本 C：側面銑掉、四孔 ≤ -7、中央不動、無 R27', { skip: goldenSkip.skip || (!upstreamReady && '上游模組（tokenize/interpret/buildSegments）尚未就緒') }, async () => {
  const text = fixture(FIX_C);
  const st = settings();
  const tok = NC.tokenize(text);
  const run = NC.interpret(tok.blocks, st, 'off');
  // 刀具表：優先用 tools.js 推測，否則手寫
  let tt;
  if (NC.tools && typeof NC.tools.inferTools === 'function') {
    const tools = NC.tools.inferTools(tok, run);
    tt = { programKey: 'O1003', tools, offsets: [], updatedAt: new Date().toISOString() };
    if (NC.tools.defaultOffsets) tt.offsets = NC.tools.defaultOffsets(tools, [1, 2]);
  } else {
    tt = table([tool(3, 'chamfer', 8, { angle: 90 }), tool(7, 'drill', 4.5, { angle: 118 }), tool(1, 'endmill', 10), tool(2, 'endmill', 10), tool(15, 'unknown', 10, { probe: true })]);
  }
  const geometry = NC.buildSegments(run, tt, st);
  // 素材 130×60×15：程式的孔在 Y48.4、輪廓在 Y-8..40，故 Y 範圍取 -10..50（契約寫「頂面中心原點」，Y 向對不上，見回報）
  const stockDef = { min: V(-65, -10, -15), max: V(65, 50, 0), source: 'user', fixtures: [] };
  const sim = S.create(stockDef, 0.25);
  const res = await S.run(sim, { run, geometry, sim: null }, tt, st);
  near(S.heightAt(res, -62.5, 0), -10, 0.05, 'X=-62.5 側面');
  near(S.heightAt(res, 62.5, 20), -10, 0.05, 'X=+62.5 側面');
  assert.equal(S.heightAt(res, 0, 0), 0, 'X=0');
  for (const x of [-45, -15, 15, 45]) assert.ok(S.heightAt(res, x, 48.4) <= -7, `孔 X${x} 高度 ${S.heightAt(res, x, 48.4)}`);
  const r27 = res.events.filter((e) => e.ruleId === 'R27');
  assert.deepEqual(r27, [], `不應有 R27：${r27.map((e) => `L${e.line} ${e.message}`).join('；')}`);
  assert.equal(res.snapshots.length, run.ops.length);
  assert.ok(res.time.total > 0);
});


// ---------------------------------------------------------------------------
// 審查修正：碰撞門檻分級、錐形刀訊息、快照記憶體預算
// ---------------------------------------------------------------------------
test('R27 門檻：0.05–0.1 mm 的干涉不報（粗/精分刀一定會踩到）', async () => {
  const sim = S.create(stock(100, 40, 10), 0.25);
  // 先用進給把中間銑到 -5.1，再讓 G0 掃過 -5.2（差 0.1 mm）
  const segs = [
    seg({ kind: 'feed', from: V(-40, 0, -5.1), to: V(40, 0, -5.1), line: 5 }),
    seg({ kind: 'rapid', feed: null, from: V(40, 0, -5.2), to: V(-40, 0, -5.2), line: 6 }),
  ];
  const res = await S.run(sim, scenario(segs), TT, settings());
  assert.equal(res.events.filter((e) => e.ruleId === 'R27').length, 0);
});

test('R27 嚴重度：路徑掃過 0.2–2 mm → warning，超過 → error', async () => {
  const mk = async (z) => {
    const sim = S.create(stock(100, 40, 10), 0.25);
    const segs = [
      seg({ kind: 'feed', from: V(-40, 0, -5), to: V(40, 0, -5), line: 5 }),
      seg({ kind: 'rapid', feed: null, from: V(40, 0, z), to: V(-40, 0, z), line: 6 }),
    ];
    const res = await S.run(sim, scenario(segs), TT, settings());
    return res.events.filter((e) => e.ruleId === 'R27');
  };
  const mild = await mk(-6);      // 干涉 1 mm
  assert.equal(mild.length, 1);
  assert.equal(mild[0].severity, 'warning');
  assert.ok(mild[0].magnitude > 0.9 && mild[0].magnitude < 1.1);
  const bad = await mk(-8);       // 干涉 3 mm
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, 'error');
});

test('R27 訊息：錐形刀要一起寫出刀尖 Z（否則使用者在程式裡找不到那個數字）', async () => {
  const sim = S.create(stock(100, 40, 10), 0.25);
  const segs = [seg({ kind: 'rapid', tool: 2, feed: null, from: V(0, 0, 20), to: V(0, 0, -3), line: 7 })];
  const res = await S.run(sim, scenario(segs), TT, settings());
  const e = res.events.find((x) => x.ruleId === 'R27');
  assert.ok(e);
  assert.match(e.message, /刀尖 Z-3/);
});

test('快照用位元組預算，不是固定份數（格數大時份數要自動變少）', async () => {
  const ops = [];
  const segs = [];
  for (let i = 0; i < 30; i++) {
    ops.push(op(i, 1, i * 10 + 1, i * 10 + 9));
    segs.push(seg({ kind: 'feed', opIndex: i, from: V(-40, i - 15, -1), to: V(40, i - 15, -1), line: i * 10 + 5 }));
  }
  const sim = S.create(stock(200, 200, 10), 0.5);
  const res = await S.run(sim, scenario(segs, ops), TT, Object.assign(settings(), { snapshotBudgetBytes: 4 * 160801 }));
  assert.ok(res.snapshots.length <= 4, '預算只夠 4 份，實得 ' + res.snapshots.length);
  assert.ok(res.snapshots.length >= 1);
  assert.equal(res.snapshots[res.snapshots.length - 1].afterOpIndex, 29, '最後一個作業一定要有快照');
});

test('固定循環孔底的 P 停留要算進時間（G82/G89）', async () => {
  const segs = [seg({ kind: 'drill', sub: 'plunge', from: V(0, 0, 2), to: V(0, 0, -5), line: 5, feed: 100 })];
  const executed = [{
    line: 5, skipped: false, ignored: false, opIndex: 0,
    actions: [{ kind: 'hole', cycle: 'G82', p: 1500, x: 0, y: 0, z: -5, r: 2 }],
  }];
  const sim = S.create(stock(100, 40, 10), 0.5);
  const res = await S.run(sim, scenario(segs, null, executed), TT, settings());
  assert.ok(res.time.total >= 1.5, 'P1500 = 1.5 秒要算進去，實得 ' + res.time.total);
});

// ---------------------------------------------------------------------------
// 足跡剖面：型式 → 形狀（形狀表在 tools.js，這裡驗 simulation 有照著用）
// ---------------------------------------------------------------------------
test('profileFor：新增型式的足跡形狀與錐角', () => {
  const FLAT = 0, CONE = 1, SPHERE = 2;
  const prof = (type, extra) => S.profileFor(tool(1, type, 10, extra));
  // 圓盤
  for (const t of ['bullnose', 'radiusmill', 'slotmill', 'tapermill', 'dovetail', 'boring', 'counterbore', 'wooddrill']) {
    assert.equal(prof(t).kind, FLAT, t);
    assert.equal(prof(t).cuts, true, t);
  }
  // 球端
  assert.equal(prof('lollipop').kind, SPHERE);
  // 錐尖：沒填角度就用型式的預設
  assert.equal(prof('centerdrill').kind, CONE);
  assert.ok(Math.abs(prof('centerdrill').tanHalf - Math.tan(30 * Math.PI / 180)) < 1e-12, '中心鑽預設 60°');
  assert.ok(Math.abs(prof('engrave').tanHalf - Math.tan(15 * Math.PI / 180)) < 1e-12, '雕刻刀預設 30°');
  assert.ok(Math.abs(prof('countersink').tanHalf - Math.tan(45 * Math.PI / 180)) < 1e-12, '沉頭孔鑽預設 90°');
  // 有填角度就用填的
  assert.ok(Math.abs(prof('spot', { angle: 142 }).tanHalf - Math.tan(71 * Math.PI / 180)) < 1e-12);
  // 左牙刀比照絲攻：不移除材料
  assert.equal(prof('taplh').cuts, false);
  assert.equal(prof('tap').cuts, false);
  // 底切刀要標出來（高度圖做不出底切，只能用最大直徑近似）
  assert.deepEqual(['slotmill', 'dovetail', 'lollipop'].map((t) => prof(t).undercut), [true, true, true]);
  assert.equal(prof('endmill').undercut, false);
});

// ---------------------------------------------------------------------------
// 廢料判定（chunks）：用 create 建小格網、直接改 height 陣列，不必跑 run
// ---------------------------------------------------------------------------
/** 60×40×10、cell 1 → nx 61、ny 41、floorZ −10；原點 (0,0) 在格 (30, 20) */
const ringSim = (fixtures) => S.create(stock(60, 40, 10, fixtures), 1);
const idxOf = (sim, ix, iy) => iy * sim.nx + ix;
/** 把 ix∈[19,41]、iy∈[14,26] 的邊框那一圈（68 格）設成 z，圍出中間 21×11 格（含原點格）；skip = 留一格不切（留耳） */
function cutRing(sim, z, skip) {
  for (let iy = 14; iy <= 26; iy++) {
    for (let ix = 19; ix <= 41; ix++) {
      if (!(ix === 19 || ix === 41 || iy === 14 || iy === 26)) continue;
      if (skip && skip.ix === ix && skip.iy === iy) continue;
      sim.height[idxOf(sim, ix, iy)] = z;
    }
  }
}
const INNER = 21 * 11, RING = 68, TOTAL = 61 * 41;

test('chunks：整圈切穿 → 2 塊；auto 下原點那塊是工件、外圈是廢料', () => {
  const sim = ringSim();
  cutRing(sim, sim.floorZ);
  const r = S.chunks(sim);
  assert.equal(r.supported, true);
  assert.equal(r.chunks.length, 2);
  assert.equal(r.partCount, 1);
  assert.equal(r.scrapCount, 1);
  const inner = r.chunks.find((c) => c.part), outer = r.chunks.find((c) => !c.part);
  assert.equal(inner.cells, INNER);
  assert.equal(inner.why, 'origin');
  assert.equal(outer.cells, TOTAL - INNER - RING);
  assert.equal(outer.why, 'other');
  assert.equal(r.scrapAreaMm2, outer.areaMm2);
  assert.equal(outer.areaMm2, outer.cells);   // cell 1 → 面積 = 格數
  assert.equal(r.labels[idxOf(sim, 30, 20)], inner.label, '原點格屬於工件');
  assert.equal(r.labels[idxOf(sim, 0, 0)], outer.label);
  assert.equal(r.labels[idxOf(sim, 19, 20)], 0, '切穿的那圈 label 0');
  assert.deepEqual(inner.bbox, { x0: -10, y0: -5, x1: 10, y1: 5 });
  assert.equal(inner.zMin, 0);
  assert.equal(inner.zMax, 0);
  assert.equal(r.hasFixture, false);
  assert.equal(r.partTouchesFixture, null, '沒有夾具格 → null');
  r.chunks.forEach((c, i) => assert.equal(c.label, i + 1, 'label 連號且等於索引 + 1'));
});

test('chunks：留一格沒切（留耳）→ 1 塊、廢料 0', () => {
  const sim = ringSim();
  cutRing(sim, sim.floorZ, { ix: 19, iy: 20 });
  const r = S.chunks(sim);
  assert.equal(r.chunks.length, 1);
  assert.equal(r.scrapCount, 0);
  assert.equal(r.partCount, 1);
  assert.equal(r.chunks[0].cells, TOTAL - RING + 1);
});

test('chunks：底皮——剩 0.2 mm 在 skinMm 0 時算有料、skinMm 0.3 時算切斷', () => {
  const sim = ringSim();
  cutRing(sim, sim.floorZ + 0.2);
  assert.equal(S.chunks(sim, null, { skinMm: 0 }).chunks.length, 1);
  assert.equal(S.chunks(sim, null, { skinMm: 0.3 }).chunks.length, 2);
});

test('chunks：floorZ 不是 float32 能表示的數時，切穿的格仍要判成沒料', () => {
  // 高度圖是 Float32Array：夾在 floorZ 的格存的是 fround(floorZ)，直接跟 float64 相減會剩殘差
  const st = { min: V(-30, -20, -100.3), max: V(30, 20, 0), source: 'user', fixtures: [] };
  const sim = S.create(st, 1);
  cutRing(sim, sim.floorZ);
  assert.equal(S.chunks(sim).chunks.length, 2);
});

test('chunks：細橋——1 格寬的橋在 bridgeMm 0 時相連、bridgeMm 2·cell 時算斷，橋上的格仍被標號', () => {
  const sim = ringSim();
  // 在 ix = 45 切一整條鉛直槽，只留 (45, 20) 一格當橋；原點 (30, 20) 在左邊那塊
  for (let iy = 0; iy < sim.ny; iy++) if (iy !== 20) sim.height[idxOf(sim, 45, iy)] = sim.floorZ;
  const r0 = S.chunks(sim, null, { bridgeMm: 0 });
  assert.equal(r0.chunks.length, 1);
  assert.equal(r0.chunks[0].cells, TOTAL - 40);
  const r1 = S.chunks(sim, null, { bridgeMm: 2 });
  assert.equal(r1.chunks.length, 2);
  assert.equal(r1.partCount, 1);
  assert.equal(r1.scrapCount, 1);
  const left = r1.chunks.find((c) => c.part);
  assert.equal(r1.labels[idxOf(sim, 30, 20)], left.label, '原點所在的左塊是工件');
  assert.equal(left.why, 'origin');
  assert.ok(r1.labels[idxOf(sim, 45, 20)] > 0, '橋上的格長回來後要有標號');
  // 每一個有料的格都要有標號（侵蝕掉的外圈也要長回來）
  let solidUnlabeled = 0;
  for (let i = 0; i < sim.height.length; i++) if (sim.height[i] > sim.floorZ && !r1.labels[i]) solidUnlabeled++;
  assert.equal(solidUnlabeled, 0);
  assert.equal(r1.chunks[0].cells + r1.chunks[1].cells, TOTAL - 40);
});

test('chunks：細橋——核心被吃光、旁邊沒塊可長的孤立小塊仍要標號成一塊（不能維持 0 變成「沒判定」）', () => {
  const sim = ringSim();
  // 用切穿的溝圍出 ix 11..12 × iy 11..15 的 2×5 島（10 格 > 預設 minAreaMm2 2）：k = 1 就整個被吃光、旁邊也沒塊可長過來。
  // 島放在離素材邊夠遠的地方——貼邊的話溝與素材邊之間那條 2 格寬的走道也會被當成細橋（格網外算沒料）
  for (let iy = 10; iy <= 16; iy++) {
    for (let ix = 10; ix <= 13; ix++) {
      if (ix === 10 || ix === 13 || iy === 10 || iy === 16) sim.height[idxOf(sim, ix, iy)] = sim.floorZ;
    }
  }
  const r0 = S.chunks(sim, null, { bridgeMm: 0 });
  assert.equal(r0.chunks.length, 2);
  const r1 = S.chunks(sim, null, { bridgeMm: 2 });   // cell 1 → k = 1
  assert.equal(r1.chunks.length, 2, '島沒有核心也要是一塊');
  const island = r1.chunks.find((c) => c.label === r1.labels[idxOf(sim, 11, 13)]);
  assert.ok(island, '島上的格有標號');
  assert.equal(island.cells, 10);
  assert.equal(island.part, false);
  assert.equal(island.why, 'other');
  assert.equal(r1.partCount, 1);
  assert.equal(r1.scrapCount, 1);
  assert.equal(r1.chunks.find((c) => c.part).cells, TOTAL - 18 - 10);
  let solidUnlabeled = 0;
  for (let i = 0; i < sim.height.length; i++) if (sim.height[i] > sim.floorZ && !r1.labels[i]) solidUnlabeled++;
  assert.equal(solidUnlabeled, 0, '每個實料格都要有標號');
  // 重新標號的塊照常過 minAreaMm2：門檻 20 → 島被剔除、label 0
  const r2 = S.chunks(sim, null, { bridgeMm: 2, minAreaMm2: 20 });
  assert.equal(r2.chunks.length, 1);
  assert.equal(r2.labels[idxOf(sim, 11, 13)], 0);
});

test('chunks：bridgeMm 大到整張圖被吃光 → 夾到上限、侵蝕提前結束、不炸；剩下的實料由 4b 重新標號', () => {
  // 120×40、cell 0.25 → nx 481、ny 161（77k 格）；bridgeMm 1e9 夾成 50 → k = 100，素材只有 161 格高：約 80 輪就吃光
  const sim = S.create(stock(120, 40, 10), 0.25);
  for (let iy = 0; iy < sim.ny; iy++) sim.height[idxOf(sim, 300, iy)] = sim.floorZ;   // 一條鉛直槽切成兩半；原點格 (240, 80) 在左邊
  S.chunks(sim);   // 暖機
  const t0 = performance.now();
  const r = S.chunks(sim, null, { bridgeMm: 1e9 });
  const ms = performance.now() - t0;
  assert.ok(ms < 250, 'k=100 吃光後要提前結束 ' + ms.toFixed(1) + ' ms');
  assert.equal(r.supported, true);
  assert.equal(r.chunks.length, 2, '核心全沒了，兩塊都靠 4b 重新標號');
  assert.equal(r.partCount, 1);
  assert.equal(r.scrapCount, 1);
  assert.equal(r.chunks.find((c) => c.part).why, 'origin');
  let solidUnlabeled = 0;
  for (let i = 0; i < sim.height.length; i++) if (sim.height[i] > sim.floorZ && !r.labels[i]) solidUnlabeled++;
  assert.equal(solidUnlabeled, 0);
  // 跟 bridgeMm 0 的答案一致：吃光＝沒有任何橋被切，塊的切法不變
  const r0 = S.chunks(sim, null, { bridgeMm: 0 });
  assert.deepEqual(r.chunks.map((c) => [c.cells, c.part]), r0.chunks.map((c) => [c.cells, c.part]));
});

test('chunks：minAreaMm2——孤立 1 格不分類（label 0、清單不含）；門檻 0 才算一塊', () => {
  const sim = ringSim();
  // 把 (5,5) 的四鄰切掉，讓它孤立
  for (const [ix, iy] of [[4, 5], [6, 5], [5, 4], [5, 6]]) sim.height[idxOf(sim, ix, iy)] = sim.floorZ;
  const r = S.chunks(sim);   // 預設 minAreaMm2 2
  assert.equal(r.chunks.length, 1);
  assert.equal(r.labels[idxOf(sim, 5, 5)], 0);
  assert.equal(r.chunks[0].label, 1);
  assert.equal(r.labels[idxOf(sim, 30, 20)], 1, '剩下的塊重新編成 1');
  const r0 = S.chunks(sim, null, { minAreaMm2: 0 });
  assert.equal(r0.chunks.length, 2);
  assert.ok(r0.labels[idxOf(sim, 5, 5)] > 0);
});

test('chunks：記號優先——✕ 中間變廢料；anchor marks 只有 ✕ → 外圈變工件；同塊 ⊙ 與 ✕ → 工件', () => {
  const sim = ringSim();
  cutRing(sim, sim.floorZ);
  const at = (r, ix, iy) => r.chunks.find((c) => c.label === r.labels[idxOf(sim, ix, iy)]);
  // auto + ✕ 中間：中間廢料；原點那塊被 ✕ 了，下一個候選（最大塊）自動補上當工件
  const rA = S.chunks(sim, null, { marks: [{ x: 0, y: 0, kind: 'scrap' }] });
  assert.equal(at(rA, 30, 20).part, false);
  assert.equal(at(rA, 30, 20).why, 'scrapMark');
  assert.equal(at(rA, 0, 0).part, true);
  assert.equal(at(rA, 0, 0).why, 'largest');
  // marks + 只有 ✕：沒被標的都是工件
  const rB = S.chunks(sim, null, { anchor: 'marks', marks: [{ x: 0, y: 0, kind: 'scrap' }] });
  assert.equal(at(rB, 0, 0).part, true);
  assert.equal(at(rB, 0, 0).why, 'unmarked');
  assert.equal(rB.partCount, 1);
  assert.equal(rB.scrapCount, 1);
  // marks + 只有 ⊙ 在外圈：沒被標的都是廢料
  const rC = S.chunks(sim, null, { anchor: 'marks', marks: [{ x: -29, y: -19, kind: 'part' }] });
  assert.equal(at(rC, 0, 0).why, 'mark');
  assert.equal(at(rC, 30, 20).part, false);
  assert.equal(at(rC, 30, 20).why, 'unmarked');
  // 同一塊兩種都有 → ⊙ 贏
  const rD = S.chunks(sim, null, { anchor: 'largest', marks: [{ x: 1, y: 1, kind: 'scrap' }, { x: -1, y: -1, kind: 'part' }] });
  assert.equal(at(rD, 30, 20).part, true);
  assert.equal(at(rD, 30, 20).why, 'mark');
  assert.equal(at(rD, 0, 0).part, true, 'largest 下外圈本來就是工件，中間的記號不影響它');
  assert.equal(at(rD, 0, 0).why, 'largest');
  // 記號落在切穿的那圈（空氣）→ 沒有作用；anchor marks 沒有有效記號 → 退回 auto
  const rE = S.chunks(sim, null, { anchor: 'marks', marks: [{ x: -11, y: 0, kind: 'scrap' }] });
  assert.equal(rE.labels[idxOf(sim, 19, 20)], 0);
  assert.equal(at(rE, 30, 20).why, 'origin');
});

test('chunks：記號的邊界——格外無效、被剔除小塊上的無效、同塊 ⊙✕ 共存 ⊙ 贏、fixture 排除 ✕ 後退回 auto', () => {
  const sim = ringSim([{ min: V(-28, -18, -10), max: V(-24, -14, 5), name: '壓板' }]);   // 夾具格 ix 2..6、iy 2..6，貼在外圈
  cutRing(sim, sim.floorZ);
  const at = (r, ix, iy) => r.chunks.find((c) => c.label === r.labels[idxOf(sim, ix, iy)]);
  // 格外（素材範圍外）的記號無效：anchor marks 下等於沒有記號 → 退回 auto
  const rOut = S.chunks(sim, null, { anchor: 'marks', marks: [{ x: 999, y: 999, kind: 'part' }, { x: -31, y: 0, kind: 'scrap' }] });
  assert.equal(rOut.partCount, 1);
  assert.equal(at(rOut, 30, 20).why, 'origin');
  assert.equal(at(rOut, 0, 0).why, 'other');
  // 被 minAreaMm2 剔除的孤立 1 格（55, 5）＝工件座標 (25, −15)：⊙ 落在上面沒有作用
  for (const [ix, iy] of [[54, 5], [56, 5], [55, 4], [55, 6]]) sim.height[idxOf(sim, ix, iy)] = sim.floorZ;
  const rTiny = S.chunks(sim, null, { anchor: 'marks', marks: [{ x: 25, y: -15, kind: 'part' }] });
  assert.equal(rTiny.labels[idxOf(sim, 55, 5)], 0);
  assert.equal(at(rTiny, 30, 20).why, 'origin', '沒有有效記號 → 退回 auto');
  const rTiny0 = S.chunks(sim, null, { anchor: 'marks', minAreaMm2: 0, marks: [{ x: 25, y: -15, kind: 'part' }] });
  assert.equal(at(rTiny0, 55, 5).why, 'mark', '門檻 0 → 那一格是一塊，⊙ 就生效');
  assert.equal(at(rTiny0, 30, 20).part, false);
  assert.equal(at(rTiny0, 30, 20).why, 'unmarked');
  // 同一塊 ⊙ 與 ✕ 都有 → ⊙ 贏（anchor marks 下也一樣）；另一塊因為存在 ⊙ 而算廢料
  const rBoth = S.chunks(sim, null, { anchor: 'marks', marks: [{ x: 0, y: 0, kind: 'scrap' }, { x: 2, y: 2, kind: 'part' }] });
  assert.equal(at(rBoth, 30, 20).part, true);
  assert.equal(at(rBoth, 30, 20).why, 'mark');
  assert.equal(at(rBoth, 0, 0).part, false);
  assert.equal(at(rBoth, 0, 0).why, 'unmarked');
  // fixture：唯一碰到夾具的外圈被 ✕ → 沒有候選 → 退回 auto（原點塊是工件）；外圈維持 scrapMark
  const rFix = S.chunks(sim, null, { anchor: 'fixture', marks: [{ x: -29, y: -19, kind: 'scrap' }] });
  assert.equal(at(rFix, 1, 1).part, false);
  assert.equal(at(rFix, 1, 1).why, 'scrapMark');
  assert.equal(at(rFix, 30, 20).part, true);
  assert.equal(at(rFix, 30, 20).why, 'origin');
  assert.equal(rFix.partTouchesFixture, false, '工件（中間）沒碰到夾具');
});

test('chunks：每一塊都被 ✕ → partCount 0、partTouchesFixture null（沒有工件就沒有「會掉落」可講）', () => {
  const sim = ringSim([{ min: V(-28, -18, -10), max: V(-24, -14, 5), name: '壓板' }]);
  cutRing(sim, sim.floorZ);
  const r = S.chunks(sim, null, { marks: [{ x: 0, y: 0, kind: 'scrap' }, { x: 29, y: 19, kind: 'scrap' }] });
  assert.equal(r.partCount, 0);
  assert.equal(r.scrapCount, 2);
  assert.equal(r.hasFixture, true);
  assert.equal(r.partTouchesFixture, null);
  assert.ok(r.chunks.every((c) => c.why === 'scrapMark'));
});

test('chunks：anchor largest／origin', () => {
  const sim = ringSim();
  cutRing(sim, sim.floorZ);
  const rL = S.chunks(sim, null, { anchor: 'largest' });
  const outerL = rL.chunks.find((c) => c.label === rL.labels[idxOf(sim, 0, 0)]);
  assert.equal(outerL.part, true);
  assert.equal(outerL.why, 'largest');
  assert.equal(rL.scrapAreaMm2, INNER);
  const rO = S.chunks(sim, null, { anchor: 'origin' });
  assert.equal(rO.chunks.find((c) => c.part).why, 'origin');
  // 原點落在空氣上 → 退回最大塊
  sim.height[idxOf(sim, 30, 20)] = sim.floorZ;
  const rO2 = S.chunks(sim, null, { anchor: 'origin', minAreaMm2: 0 });
  assert.equal(rO2.chunks.find((c) => c.part).why, 'largest');
  assert.equal(rO2.chunks.find((c) => c.part).cells, TOTAL - INNER - RING);
});

test('chunks：夾具——anchor fixture 時碰到夾具的外圈是工件；auto 下 partTouchesFixture false、hasFixture true', () => {
  // 夾具貼在外圈左下角：格 ix 2..6、iy 2..6
  const sim = ringSim([{ min: V(-28, -18, -10), max: V(-24, -14, 5), name: '壓板' }]);
  cutRing(sim, sim.floorZ);
  const rA = S.chunks(sim);
  assert.equal(rA.hasFixture, true);
  assert.equal(rA.partTouchesFixture, false, '工件（中間）沒碰到夾具');
  assert.equal(rA.labels[idxOf(sim, 4, 4)], 0, '夾具格不算料');
  const outerA = rA.chunks.find((c) => !c.part);
  assert.equal(outerA.touchesFixture, true);
  assert.equal(rA.chunks.find((c) => c.part).touchesFixture, false);
  const rF = S.chunks(sim, null, { anchor: 'fixture' });
  const outerF = rF.chunks.find((c) => c.label === rF.labels[idxOf(sim, 0, 0)]);
  assert.equal(outerF.part, true);
  assert.equal(outerF.why, 'fixture');
  assert.equal(rF.chunks.find((c) => c.label === rF.labels[idxOf(sim, 30, 20)]).part, false);
  assert.equal(rF.partTouchesFixture, true);
  // 沒有任何塊碰到夾具（這裡：根本沒夾具）→ 退回 auto
  const sim2 = ringSim();
  cutRing(sim2, sim2.floorZ);
  const rF2 = S.chunks(sim2, null, { anchor: 'fixture' });
  assert.equal(rF2.chunks.find((c) => c.part).why, 'origin');
});

test('chunks：四軸圓棒 → supported false、欄位齊全', () => {
  const sim = S.create({ kind: 'cylinder', radius: 10, xMin: 0, xMax: 50 }, 1);
  const r = S.chunks(sim);
  assert.deepEqual(r, { supported: false, labels: null, chunks: [], partCount: 0, scrapCount: 0, scrapAreaMm2: 0, partTouchesFixture: null, hasFixture: false });
  assert.equal(S.chunks(null).supported, false);
});

test('chunks：也吃 SimResult（跑真的切穿：整條槽把板切成兩半，原點在槽裡 → 最大塊）', async () => {
  const sim = S.create(stock(100, 40, 10), 0.5);
  const segs = [seg({ from: V(0, -30, -10), to: V(0, 30, -10), line: 5 })];   // Ø10 平刀，Z −10 = 素材底
  const res = await S.run(sim, scenario(segs), TT, settings());
  const r = S.chunks(res);
  assert.equal(r.supported, true);
  assert.equal(r.chunks.length, 2);
  assert.equal(r.partCount, 1);
  assert.equal(r.scrapCount, 1);
  assert.equal(r.labels[S.cellIndex(res, 0, 0)], 0, '槽裡沒料');
  assert.equal(r.chunks.find((c) => c.part).why, 'largest');
  // 傳快照的高度陣列也行（這裡只有一個作業，快照 = 最終）
  assert.equal(S.chunks(res, res.snapshots[0].height).chunks.length, 2);
});

test('chunkHeights：part 把廢料壓到底、scrap 只留廢料；labels null 時 part 照抄', () => {
  const sim = ringSim();
  cutRing(sim, sim.floorZ);
  const r = S.chunks(sim);
  const before = sim.height.slice();
  const part = S.chunkHeights(sim.height, r.labels, r.chunks, sim.floorZ, 'part');
  const scrap = S.chunkHeights(sim.height, r.labels, r.chunks, sim.floorZ, 'scrap');
  assert.deepEqual(sim.height, before, '不改原陣列');
  assert.ok(part instanceof Float32Array && part.length === sim.height.length);
  assert.equal(part[idxOf(sim, 30, 20)], 0, '工件照抄');
  assert.equal(part[idxOf(sim, 0, 0)], sim.floorZ, '廢料壓到底');
  assert.equal(part[idxOf(sim, 19, 20)], sim.floorZ, '切穿的格本來就在底');
  assert.equal(scrap[idxOf(sim, 0, 0)], 0, '廢料照抄');
  assert.equal(scrap[idxOf(sim, 30, 20)], sim.floorZ, '工件壓到底');
  assert.equal(scrap[idxOf(sim, 19, 20)], sim.floorZ);
  assert.deepEqual(S.chunkHeights(sim.height, null, [], sim.floorZ, 'part'), sim.height);
  assert.ok(S.chunkHeights(sim.height, null, [], sim.floorZ, 'scrap').every((v) => v === sim.floorZ));
});

test('normalizeScrap／defaultScrap：負值夾 0、anchor 亂填回 auto、marks 過濾 NaN 與壞 kind', () => {
  assert.deepEqual(S.defaultScrap(), { anchor: 'auto', marks: [], skinMm: 0, bridgeMm: 0, minAreaMm2: 2 });
  assert.deepEqual(S.normalizeScrap(null), S.defaultScrap());
  assert.deepEqual(S.normalizeScrap('x'), S.defaultScrap());
  const n = S.normalizeScrap({
    anchor: 'nope', skinMm: -1, bridgeMm: '3', minAreaMm2: null,
    marks: [{ x: 1, y: 2, kind: 'part' }, { x: NaN, y: 0, kind: 'scrap' }, { x: '4', y: '5', kind: 'scrap' }, { x: 1, y: 1, kind: 'huh' }, null, { x: Infinity, y: 0, kind: 'part' }, { x: null, y: 1, kind: 'part' }, { x: true, y: 1, kind: 'part' }],
  });
  assert.equal(n.anchor, 'auto');
  assert.equal(n.skinMm, 0);
  assert.equal(n.bridgeMm, 3);
  assert.equal(n.minAreaMm2, 2, 'null → 預設');
  assert.equal(S.normalizeScrap({ skinMm: true }).skinMm, 0, '布林不是數字 → 預設');
  assert.deepEqual(n.marks, [{ x: 1, y: 2, kind: 'part' }, { x: 4, y: 5, kind: 'scrap' }]);
  assert.equal(S.normalizeScrap({ anchor: 'fixture' }).anchor, 'fixture');
  assert.equal(S.normalizeScrap({ minAreaMm2: 0 }).minAreaMm2, 0, '0 是合法值，不是「沒填」');
  assert.deepEqual([...S.SCRAP_ANCHORS], ['auto', 'origin', 'largest', 'fixture', 'marks']);
  // 全空白字串＝沒填 → 預設（Number('   ') 是 0，不 trim 的話門檻會偷偷變 0）；有數字的字串照樣 trim 後吃
  assert.equal(S.normalizeScrap({ skinMm: '   ' }).skinMm, 0);
  assert.equal(S.normalizeScrap({ minAreaMm2: ' \t' }).minAreaMm2, 2);
  assert.equal(S.normalizeScrap({ bridgeMm: ' 3 ' }).bridgeMm, 3);
  assert.deepEqual(S.normalizeScrap({ marks: [{ x: '  ', y: 1, kind: 'part' }, { x: ' 2 ', y: ' 3', kind: 'scrap' }] }).marks, [{ x: 2, y: 3, kind: 'scrap' }]);
  // 上限：bridgeMm 50（侵蝕 O(k·n)，手滑的大數字不能凍住主執行緒）、skinMm 1000、minAreaMm2 1e6
  assert.deepEqual(S.SCRAP_MAX, { skinMm: 1000, bridgeMm: 50, minAreaMm2: 1e6 });
  assert.equal(S.normalizeScrap({ bridgeMm: 1e9 }).bridgeMm, 50);
  assert.equal(S.normalizeScrap({ bridgeMm: 50 }).bridgeMm, 50);
  assert.equal(S.normalizeScrap({ skinMm: 5000 }).skinMm, 1000);
  assert.equal(S.normalizeScrap({ minAreaMm2: 1e12 }).minAreaMm2, 1e6);
});

test('效能：chunks 在 0.17 M 格（含侵蝕 k=2）要夠快', () => {
  // 601×281 = 168,881 格；切一圈讓它真的有兩塊
  const sim = S.create({ min: V(-150, -70, -10), max: V(150, 70, 0), source: 'user', fixtures: [] }, 0.5);
  for (let iy = 40; iy <= 240; iy++) {
    for (let ix = 100; ix <= 500; ix++) {
      if (ix === 100 || ix === 500 || iy === 40 || iy === 240) sim.height[iy * sim.nx + ix] = sim.floorZ;
    }
  }
  S.chunks(sim);   // 暖機
  let t0 = performance.now();
  const r = S.chunks(sim);
  const plain = performance.now() - t0;
  t0 = performance.now();
  const rb = S.chunks(sim, null, { bridgeMm: 2 });
  const eroded = performance.now() - t0;
  assert.equal(r.chunks.length, 2);
  assert.equal(rb.chunks.length, 2);
  // 契約目標 30 ms；測試門檻放寬到 150 ms 以免慢機器誤紅
  assert.ok(plain < 150, '不侵蝕 ' + plain.toFixed(1) + ' ms');
  assert.ok(eroded < 150, '侵蝕 k=2 ' + eroded.toFixed(1) + ' ms');
});
