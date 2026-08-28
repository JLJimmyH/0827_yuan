// geometry.js 測試：以手寫的 Run 物件（ExecutedBlock/Action 依 ns.js 型別）驗證；
// 整合測試在 NC.tokenize / NC.interpret 存在時才用四支真實程式跑契約 §3 的驗收數字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNC, fixture, goldenSkip, FIX_A, FIX_B, FIX_C, FIX_D } from './load.mjs';

const NC = loadNC();
const G = NC.geometry;

// ---------------------------------------------------------------------------
// 小工具：手工組 Run
// ---------------------------------------------------------------------------
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const approx = (a, b, eps = 1e-6, msg = '') => assert.ok(near(a, b, eps), `${msg} 期望 ${b} 得到 ${a}`);
const approx3 = (p, q, eps = 1e-6, msg = '') => { approx(p.x, q.x, eps, msg + '.x'); approx(p.y, q.y, eps, msg + '.y'); approx(p.z, q.z, eps, msg + '.z'); };
const V = (x, y, z) => ({ x, y, z });

function state(over) {
  return Object.assign({
    motion: null, distance: 'G90', plane: 'G17', units: 'G21', feedMode: 'G94', wcs: 'G54', comp: 'G40', d: 0,
    lengthComp: 'G43', h: 11, cycle: null, retractMode: 'G98', feed: 150, spindle: { dir: 'M3', rpm: 1800 }, coolant: true,
    toolInSpindle: 11, toolStaged: null, aicc: false, rigidTap: false, rigidTapS: null, pos: V(0, 0, 0), lengthCompActive: true,
  }, over || {});
}

/**
 * 依序把「移動描述」組成 Run。每個 move：
 *  {line, kind:'rapid'|'linear'|'arc'|'hole'|'refReturn'|'none', to, r?, center?, cw?, corner?, comp?('G40'|'G41'|'G42'), d?, feed?, ...}
 *  from 自動接上一個 to；comp 變化時自動加 compStart/compEnd。
 */
function mkRun(moves, opts = {}) {
  let pos = opts.start || V(0, 0, 10);
  let comp = 'G40';
  let d = 0;
  let feed = 150;
  let line = 1;
  const executed = [];
  for (const m of moves) {
    line = m.line || line + 1;
    const before = state({ comp, d, feed, pos, toolInSpindle: opts.tool == null ? 11 : opts.tool });
    const nextComp = m.comp || comp;
    if (m.d != null) d = m.d;
    if (m.feed != null) feed = m.feed;
    const actions = [];
    let after;
    if (m.kind === 'none') {
      after = state({ comp: nextComp, d, feed, pos, toolInSpindle: before.toolInSpindle });
      if (m.actions) actions.push(...m.actions);
    } else if (m.kind === 'hole') {
      const a = Object.assign({ kind: 'hole', from: pos, initialZ: pos.z, retract: 'G98', cycle: 'G81' }, m.hole);
      actions.push(a);
      pos = V(a.x, a.y, a.retract === 'G98' ? a.initialZ : a.r);
      after = state({ comp: nextComp, d, feed, pos, toolInSpindle: before.toolInSpindle });
    } else if (m.kind === 'refReturn') {
      actions.push({ kind: 'refReturn', from: pos, via: m.via, to: m.to, axes: m.axes || ['Z'] });
      pos = m.to;
      after = state({ comp: nextComp, d, feed, pos, toolInSpindle: before.toolInSpindle });
    } else {
      const a = { kind: m.kind, from: pos, to: m.to };
      if (m.kind !== 'rapid') a.feed = feed;
      if (m.kind === 'arc') { a.cw = !!m.cw; if (m.r != null) a.r = m.r; if (m.center) a.center = m.center; }
      if (m.corner) a.corner = m.corner;
      if (m.nonLinear) a.nonLinear = true;
      if (nextComp !== comp) { if (nextComp === 'G40') a.compEnd = true; else a.compStart = true; }
      if (m.extra) Object.assign(a, m.extra);
      actions.push(a);
      pos = m.to;
      after = state({ comp: nextComp, d, feed, pos, toolInSpindle: before.toolInSpindle });
    }
    comp = nextComp;
    executed.push({ line, skipped: !!m.skipped, ignored: false, before, after, actions: m.skipped ? [] : actions, opIndex: 0 });
  }
  const ops = [{ index: 0, tool: opts.tool == null ? 11 : opts.tool, toolComment: '12MM', h: 11, dList: [11], lineStart: 1, lineEnd: line, zMin: null, feeds: [], rpms: [], gCodes: [], kindGuess: 'contour' }];
  return { scenario: 'off', executed, ops, diagnostics: [], finalState: executed.length ? executed[executed.length - 1].after : state() };
}

const TABLE = { programKey: 'test', tools: [{ t: 11, label: '12MM', type: 'endmill', diameter: 12, angle: null, fluteLen: 36, stickout: null, pitch: null, resident: false, probe: false, source: {} }, { t: 5, label: '10MM', type: 'endmill', diameter: 10, source: {} }], offsets: [], updatedAt: '' };
const build = (moves, opts = {}, table = TABLE, settings = {}) => NC.buildSegments(mkRun(moves, opts), table, Object.assign(NC.util.defaultSettings(), settings));
const comp = (res) => res.segments.filter((s) => s.path === 'compensated');
const prog = (res) => res.segments.filter((s) => s.path === 'programmed');
const byLine = (segs, line) => segs.filter((s) => s.line === line);
const diagsOf = (res, id) => res.diagnostics.filter((d) => d.ruleId === id);

// ---------------------------------------------------------------------------
// 基本段
// ---------------------------------------------------------------------------
test('rapid / linear / arc 各產生一段，id 連號，欄位齊全', () => {
  const res = build([
    { line: 10, kind: 'rapid', to: V(10, 0, 10), nonLinear: true },
    { line: 11, kind: 'linear', to: V(10, 20, 10) },
    { line: 12, kind: 'arc', to: V(20, 30, 10), r: 10, cw: false },
  ]);
  assert.equal(res.segments.length, 3);
  assert.deepEqual(res.segments.map((s) => s.kind), ['rapid', 'feed', 'arc']);
  assert.deepEqual(res.segments.map((s) => s.id), [0, 1, 2]);
  assert.equal(res.segments[0].nonLinear, true);
  assert.equal(res.segments[0].feed, null);
  assert.equal(res.segments[1].feed, 150);
  assert.equal(res.segments[1].line, 11);
  assert.equal(res.segments[1].tool, 11);
  assert.equal(res.segments[1].opIndex, 0);
  assert.equal(res.segments[2].path, 'programmed');
  assert.ok(res.segments.every((s) => s.path === 'programmed'));
});

test('跳過的節不產生段', () => {
  const res = build([
    { line: 10, kind: 'rapid', to: V(10, 0, 10) },
    { line: 11, kind: 'linear', to: V(10, 20, 10), skipped: true },
    { line: 12, kind: 'linear', to: V(10, 30, 10) },
  ]);
  assert.equal(res.segments.length, 2);
  assert.deepEqual(res.segments.map((s) => s.line), [10, 12]);
});

test('無 run / 空 run 不會爆', () => {
  const r0 = NC.buildSegments({ scenario: 'off', executed: [], ops: [], diagnostics: [] }, null);
  assert.deepEqual(r0.segments, []);
  assert.deepEqual(r0.bounds, { min: V(0, 0, 0), max: V(0, 0, 0) });
});

// ---------------------------------------------------------------------------
// 圓弧
// ---------------------------------------------------------------------------
test('arcFromR：R 指定的順時針圓弧，圓心落在弦的哪一側', () => {
  const c = G.arcFromR(V(58, -74.5, -2), V(52, -80.5, -2), 6, true).center;
  approx(c.x, 52); approx(c.y, -74.5);
  // 逆時針同弦 → 圓心在另一側
  const c2 = G.arcFromR(V(58, -74.5, -2), V(52, -80.5, -2), 6, false).center;
  approx(c2.x, 58); approx(c2.y, -80.5);
});

test('arcFromR：半圓（弦長 = 2R）、大弧（R<0）、弦長 > 2R → null', () => {
  const half = G.arcFromR(V(35, -32.75, 0), V(35, -10.75, 0), 11, false).center;
  approx(half.x, 35); approx(half.y, -21.75);
  const small = G.arcFromR(V(0, 0, 0), V(10, 0, 0), 10, true).center;
  const big = G.arcFromR(V(0, 0, 0), V(10, 0, 0), -10, true).center;
  approx(small.x, 5); approx(small.y, -8.660254);
  approx(big.x, 5); approx(big.y, 8.660254);
  assert.equal(G.arcFromR(V(0, 0, 0), V(30, 0, 0), 10, true), null);
});

test('arc 動作：有 center（IJK）直接用；只有 r 時自己算圓心；半徑寫入 seg.arc.r', () => {
  const res = build([
    { line: 10, kind: 'rapid', to: V(58, -74.5, -2) },
    { line: 11, kind: 'arc', to: V(52, -80.5, -2), r: 6, cw: true },
    { line: 12, kind: 'arc', to: V(58, -74.5, -2), center: { x: 58, y: -80.5 }, cw: true },
  ]);
  const a1 = res.segments[1], a2 = res.segments[2];
  approx(a1.arc.center.x, 52); approx(a1.arc.center.y, -74.5); assert.equal(a1.arc.cw, true); approx(a1.arc.r, 6);
  approx(a2.arc.center.x, 58); approx(a2.arc.center.y, -80.5); approx(a2.arc.r, 6);
  approx(G.segmentLength(a1), Math.PI * 6 / 2, 1e-6, '四分之一圓弧長');
});

test('半圓（G91 Y22 R11）與大弧（R-6）的掃角與長度', () => {
  const res = build([
    { line: 10, kind: 'rapid', to: V(35, -32.75, -2.5) },
    { line: 11, kind: 'arc', to: V(35, -10.75, -2.5), r: 11, cw: false },
    { line: 12, kind: 'arc', to: V(35, -32.75, -2.5), r: -11, cw: false }, // 大弧其實也是半圓（弦 = 2R）
    { line: 13, kind: 'rapid', to: V(0, 0, 0) },
    { line: 14, kind: 'arc', to: V(6, 6, 0), r: -6, cw: true }, // 大弧 270°
  ]);
  const half = res.segments[1];
  approx(half.arc.center.x, 35); approx(half.arc.center.y, -21.75);
  approx(G.arcSweep(half.arc.center, half.from, half.to, half.arc.cw), Math.PI);
  approx(G.segmentLength(half), Math.PI * 11);
  const big = res.segments[4];
  approx(G.arcSweep(big.arc.center, big.from, big.to, big.arc.cw), Math.PI * 1.5);
  approx(big.arc.center.x, 0); approx(big.arc.center.y, 6);
  approx(G.segmentLength(big), Math.PI * 1.5 * 6);
});

test('sampleSegment：直線兩點；弧依弦差細分、點都在圓上、端點精確', () => {
  const line = { from: V(0, 0, 0), to: V(3, 4, 0), kind: 'feed' };
  assert.equal(G.sampleSegment(line).length, 2);
  approx(G.segmentLength(line), 5);
  const arc = { from: V(10, 0, 0), to: V(0, 10, 5), kind: 'arc', arc: { center: { x: 0, y: 0 }, cw: false, r: 10 } };
  const pts = G.sampleSegment(arc, 0.05);
  assert.ok(pts.length > 5, `取樣點數 ${pts.length}`);
  approx3(pts[0], arc.from); approx3(pts[pts.length - 1], arc.to);
  for (const p of pts) approx(Math.hypot(p.x, p.y), 10, 1e-9, '半徑');
  // 弦差 < tol
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i - 1].x + pts[i].x) / 2, my = (pts[i - 1].y + pts[i].y) / 2;
    assert.ok(10 - Math.hypot(mx, my) <= 0.05 + 1e-9);
  }
  // Z 線性遞增
  assert.ok(pts.every((p, i) => i === 0 || p.z >= pts[i - 1].z));
  // 整圓
  const full = { from: V(10, 0, 0), to: V(10, 0, 0), kind: 'arc', arc: { center: { x: 0, y: 0 }, cw: true, r: 10 } };
  approx(G.segmentLength(full), Math.PI * 20);
  assert.ok(G.sampleSegment(full, 0.05).length > 10);
});

// ---------------------------------------------------------------------------
// hole 展開
// ---------------------------------------------------------------------------
test('expandHole G81 G98：定位、到 R、進給到孔底、快速回 R、回初始面', () => {
  const segs = G.expandHole({ kind: 'hole', x: 10, y: 0, r: 2, z: -5, cycle: 'G81', retract: 'G98', initialZ: 25 }, { pos: V(0, 0, 25), feed: 50 });
  assert.deepEqual(segs.map((s) => s.kind), ['rapid', 'rapid', 'drill', 'rapid', 'rapid']);
  approx3(segs[0].to, V(10, 0, 25));
  approx3(segs[1].to, V(10, 0, 2));
  approx3(segs[2].to, V(10, 0, -5)); assert.equal(segs[2].sub, 'plunge'); assert.equal(segs[2].feed, 50);
  approx3(segs[3].to, V(10, 0, 2));
  approx3(segs[4].to, V(10, 0, 25));
  assert.equal(segs[3].feed, null);
});

test('expandHole G99 停在 R 點；下一孔以 R 高度定位', () => {
  const s1 = G.expandHole({ kind: 'hole', x: 10, y: 0, r: 2, z: -5, cycle: 'G81', retract: 'G99', initialZ: 25 }, { pos: V(0, 0, 25), feed: 50 });
  approx3(s1[s1.length - 1].to, V(10, 0, 2));
  const s2 = G.expandHole({ kind: 'hole', x: 20, y: 0, r: 2, z: -5, cycle: 'G81', retract: 'G99', initialZ: 25 }, { pos: s1[s1.length - 1].to, feed: 50 });
  assert.equal(s2[0].kind, 'rapid'); approx3(s2[0].to, V(20, 0, 2));
  assert.equal(s2[1].kind, 'drill'); // 已在 R 點 → 不再插入到 R 的段
});

test('expandHole G83 啄鑽：每次進 Q、快速回 R、再快速到上次深度 + 0.5', () => {
  const segs = G.expandHole({ kind: 'hole', x: 0, y: 0, r: 2, z: -7, q: 1, cycle: 'G83', retract: 'G98', initialZ: 25 }, { pos: V(0, 0, 25), feed: 50 });
  const drills = segs.filter((s) => s.kind === 'drill');
  assert.equal(drills.length, 9, '2 → -7 每 1 mm 共 9 次');
  assert.ok(drills.every((s) => s.sub === 'peck'));
  approx(drills[0].from.z, 2); approx(drills[0].to.z, 1);
  approx(drills[1].from.z, 1.5, 1e-9, '第二次從上次深度 + 0.5 開始'); approx(drills[1].to.z, 0);
  approx(drills[8].to.z, -7);
  // 每次啄完都快速回 R
  const i0 = segs.indexOf(drills[0]);
  assert.equal(segs[i0 + 1].kind, 'rapid'); approx(segs[i0 + 1].to.z, 2);
  assert.equal(segs[i0 + 2].kind, 'rapid'); approx(segs[i0 + 2].to.z, 1.5);
  approx3(segs[segs.length - 1].to, V(0, 0, 25));
  // Q 不整除
  const s2 = G.expandHole({ kind: 'hole', x: 0, y: 0, r: 2, z: -7, q: 4, cycle: 'G83', retract: 'G99', initialZ: 25 }, { pos: V(0, 0, 25), feed: 50 });
  const d2 = s2.filter((s) => s.kind === 'drill');
  assert.equal(d2.length, 3); approx(d2[2].from.z, -5.5); approx(d2[2].to.z, -7);
  approx(s2[s2.length - 1].to.z, 2, 1e-9, 'G99 停在 R');
});

test('expandHole G84 攻牙：進給到底、進給回 R（sub tapUp）；G85 鉸孔：進給回 R（sub retract）', () => {
  const tap = G.expandHole({ kind: 'hole', x: 0, y: 0, r: 3, z: -10, cycle: 'G84', retract: 'G99', initialZ: 20, rigid: true }, { pos: V(0, 0, 20), feed: 700 });
  const td = tap.filter((s) => s.kind === 'drill');
  assert.equal(td.length, 2);
  assert.equal(td[0].sub, 'plunge'); approx(td[0].to.z, -10);
  assert.equal(td[1].sub, 'tapUp'); approx(td[1].to.z, 3); assert.equal(td[1].feed, 700);
  assert.ok(!tap.some((s) => s.kind === 'rapid' && s.from.z < 3), '攻牙沒有快速上升段');
  const ream = G.expandHole({ kind: 'hole', x: 0, y: 0, r: 3, z: -10, cycle: 'G85', retract: 'G98', initialZ: 20 }, { pos: V(0, 0, 20), feed: 100 });
  const rd = ream.filter((s) => s.kind === 'drill');
  assert.equal(rd.length, 2); assert.equal(rd[1].sub, 'retract'); approx(rd[1].to.z, 3);
  approx(ream[ream.length - 1].to.z, 20);
  assert.equal(ream[ream.length - 1].kind, 'rapid');
});

test('expandHole 缺 R/Z 只做 XY 定位；cycle 給 CycleState 物件也能用', () => {
  const s = G.expandHole({ kind: 'hole', x: 5, y: 5, cycle: 'G81', retract: 'G98' }, { pos: V(0, 0, 10) });
  assert.equal(s.length, 1); approx3(s[0].to, V(5, 5, 10));
  const s2 = G.expandHole({ kind: 'hole', x: 5, y: 5, cycle: { code: 'G81', r: 2, z: -3, q: null, p: null, retract: 'G99', initialZ: 10 } }, { pos: V(0, 0, 10) });
  assert.equal(s2.filter((x) => x.kind === 'drill').length, 1);
});

test('buildSegments 內 hole 展開：4 孔 G81 → 4 個 drill 段、行號與刀具正確', () => {
  const hole = (line, x) => ({ line, kind: 'hole', hole: { x, y: 30, r: 2, z: -2.5, cycle: 'G81', retract: 'G98', initialZ: 25 } });
  const res = build([{ line: 5, kind: 'rapid', to: V(-50, 30, 25) }, hole(6, -50), hole(7, -20), hole(8, 20), hole(9, 50)], { tool: 3 });
  const drills = res.segments.filter((s) => s.kind === 'drill');
  assert.equal(drills.length, 4);
  assert.deepEqual(drills.map((s) => s.line), [6, 7, 8, 9]);
  assert.ok(drills.every((s) => s.tool === 3 && s.opIndex === 0 && s.feed === 150));
  approx3(drills[3].to, V(50, 30, -2.5));
  // 孔與孔之間只在初始面移動
  const l7 = byLine(res.segments, 7);
  assert.equal(l7[0].kind, 'rapid'); approx3(l7[0].from, V(-50, 30, 25)); approx3(l7[0].to, V(-20, 30, 25));
});

// ---------------------------------------------------------------------------
// refReturn
// ---------------------------------------------------------------------------
test('refReturn → 兩段 rapid（到 via、到 ref），refReturn:true', () => {
  const res = build([
    { line: 10, kind: 'rapid', to: V(10, 20, 5) },
    { line: 11, kind: 'refReturn', via: V(10, 20, 5), to: V(10, 20, 150), axes: ['Z'] },
  ]);
  const rr = byLine(res.segments, 11);
  assert.equal(rr.length, 2);
  assert.ok(rr.every((s) => s.kind === 'rapid' && s.refReturn === true && s.feed === null));
  approx3(rr[0].from, V(10, 20, 5)); approx3(rr[0].to, V(10, 20, 5));
  approx3(rr[1].from, V(10, 20, 5)); approx3(rr[1].to, V(10, 20, 150));
});

// ---------------------------------------------------------------------------
// ,C / ,R
// ---------------------------------------------------------------------------
test(',C0.3：插入長 0.3√2 的倒角段，本節縮短、下一節起點後移', () => {
  const res = build([
    { line: 15, kind: 'linear', to: V(57.6, 0, -2.5) },
    { line: 16, kind: 'linear', to: V(58, 0, -2.5), corner: { c: 0.3 } },
    { line: 17, kind: 'linear', to: V(58, -41, -2.5), corner: { c: 0.3 } },
    { line: 18, kind: 'linear', to: V(-58, -41, -2.5) },
  ], { start: V(57.6, 10, -2.5) });
  assert.equal(diagsOf(res, 'R22').length, 0);
  const l16 = byLine(res.segments, 16);
  assert.equal(l16.length, 2);
  const [a, ch] = l16;
  assert.equal(a.inserted, undefined);
  assert.equal(ch.inserted, true);
  assert.equal(ch.kind, 'feed');
  approx(G.segmentLength(ch), 0.3 * Math.SQRT2, 1e-9, '倒角長');
  approx3(a.to, V(57.7, 0, -2.5));
  approx3(ch.from, V(57.7, 0, -2.5)); approx3(ch.to, V(58, -0.3, -2.5));
  const l17 = byLine(res.segments, 17);
  approx3(l17[0].from, V(58, -0.3, -2.5));
  approx3(l17[0].to, V(58, -40.7, -2.5), 1e-9, '第二個倒角也縮短本節');
  approx3(l17[1].to, V(57.7, -41, -2.5));
  approx3(byLine(res.segments, 18)[0].from, V(57.7, -41, -2.5));
  assert.equal(ch.feed, 150);
});

test(',R2.：90° 轉角插入半徑 2 的四分之一圓弧，切線長 = 2', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(-34, 0, -1), corner: { r: 2 } },
    { line: 11, kind: 'linear', to: V(-34, -55.5, -1) },
  ], { start: V(0, 0, -1) });
  const l10 = byLine(res.segments, 10);
  assert.equal(l10.length, 2);
  const arc = l10[1];
  assert.equal(arc.kind, 'arc'); assert.equal(arc.inserted, true);
  approx(arc.arc.r, 2);
  approx3(arc.from, V(-32, 0, -1)); approx3(arc.to, V(-34, -2, -1));
  approx(arc.arc.center.x, -32); approx(arc.arc.center.y, -2);
  assert.equal(arc.arc.cw, false, '往 -X 再轉 -Y 是左轉 → 逆時針');
  approx(G.segmentLength(arc), Math.PI, 1e-9);
  approx3(byLine(res.segments, 11)[0].from, V(-34, -2, -1));
  // 反向（右轉）→ 順時針
  const res2 = build([
    { line: 10, kind: 'linear', to: V(10, 0, 0), corner: { r: 3 } },
    { line: 11, kind: 'linear', to: V(10, -10, 0) },
  ], { start: V(0, 0, 0) });
  const arc2 = byLine(res2.segments, 10)[1];
  assert.equal(arc2.arc.cw, true);
  approx(arc2.arc.center.x, 7); approx(arc2.arc.center.y, -3);
  // 非 90°：120° 內角（轉 60°）切線長 = r·tan(30°)
  const res3 = build([
    { line: 10, kind: 'linear', to: V(10, 0, 0), corner: { r: 2 } },
    { line: 11, kind: 'linear', to: V(10 + 10 * Math.cos(Math.PI / 3), 10 * Math.sin(Math.PI / 3), 0) },
  ], { start: V(0, 0, 0) });
  const t = 2 * Math.tan(Math.PI / 6);
  approx3(byLine(res3.segments, 10)[0].to, V(10 - t, 0, 0), 1e-9);
});

test(',C 長度不足 → R22 error PS0055、不展開；剛好等於 → info 仍展開（Fanuc 不報警）', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(3, 0, 0), corner: { c: 5 } },
    { line: 11, kind: 'linear', to: V(3, 20, 0) },
  ], { start: V(0, 0, 0) });
  const errs = diagsOf(res, 'R22');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].severity, 'error'); assert.equal(errs[0].fanucAlarm, 'PS0055'); assert.equal(errs[0].line, 10);
  assert.equal(res.segments.length, 2);
  assert.ok(!res.segments.some((s) => s.inserted));
  // 下一節不足
  const res2 = build([
    { line: 10, kind: 'linear', to: V(20, 0, 0), corner: { c: 5 } },
    { line: 11, kind: 'linear', to: V(20, 4, 0) },
  ], { start: V(0, 0, 0) });
  assert.equal(diagsOf(res2, 'R22')[0].fanucAlarm, 'PS0055');
  // 剛好等於
  const res3 = build([
    { line: 10, kind: 'linear', to: V(5, 0, 0), corner: { c: 5 } },
    { line: 11, kind: 'linear', to: V(5, 20, 0) },
  ], { start: V(0, 0, 0) });
  const w = diagsOf(res3, 'R22');
  // Fanuc 只有在移動量「小於」倒角量時才發 PS0055；剛好等於是合法的 CAM 寫法 → info
  assert.equal(w.length, 1); assert.equal(w[0].severity, 'info');
  assert.ok(res3.segments.some((s) => s.inserted));
  // ,R 切線長不足
  const res4 = build([
    { line: 10, kind: 'linear', to: V(20, 0, 0), corner: { r: 5 } },
    { line: 11, kind: 'linear', to: V(20, 3, 0) },
  ], { start: V(0, 0, 0) });
  assert.equal(diagsOf(res4, 'R22')[0].fanucAlarm, 'PS0055');
});

test(',C 在補正啟動／取消節 → R22 error PS0039；相鄰圓弧 → warning 未展開；沒有下一節 → error', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(10, 0, 0), comp: 'G41', d: 11, corner: { c: 1 } },
    { line: 11, kind: 'linear', to: V(10, 20, 0) },
    { line: 12, kind: 'linear', to: V(0, 20, 0), comp: 'G40', corner: { c: 1 } },
    { line: 13, kind: 'linear', to: V(0, 0, 0) },
  ], { start: V(0, 0, 0) });
  const d = diagsOf(res, 'R22');
  assert.deepEqual(d.map((x) => x.fanucAlarm), ['PS0039', 'PS0039']);
  assert.ok(!prog(res).some((s) => s.inserted));
  const res2 = build([
    { line: 10, kind: 'linear', to: V(10, 0, 0), corner: { c: 1 } },
    { line: 11, kind: 'arc', to: V(20, 10, 0), r: 10, cw: false },
  ], { start: V(0, 0, 0) });
  assert.equal(diagsOf(res2, 'R22')[0].severity, 'warning');
  assert.equal(res2.segments.length, 2);
  const res3 = build([{ line: 10, kind: 'linear', to: V(10, 0, 0), corner: { c: 1 } }], { start: V(0, 0, 0) });
  assert.equal(diagsOf(res3, 'R22')[0].severity, 'error');
});

// ---------------------------------------------------------------------------
// 刀徑補正
// ---------------------------------------------------------------------------
// 樣本 A T11 第一層輪廓（右半邊），r = 6
const CONTOUR = [
  { line: 12, kind: 'rapid', to: V(65, 12, 10) },
  { line: 13, kind: 'rapid', to: V(65, 12, -2) },
  { line: 14, kind: 'linear', to: V(58, 12, -2), comp: 'G41', d: 11 },
  { line: 15, kind: 'linear', to: V(58, -74.5, -2) },
  { line: 16, kind: 'arc', to: V(52, -80.5, -2), r: 6, cw: true },
  { line: 17, kind: 'linear', to: V(51, -80.5, -2) },
  { line: 18, kind: 'linear', to: V(51, -90, -2), comp: 'G40' },
  { line: 19, kind: 'rapid', to: V(-51.5, -90, -2) },
];

test('啟動節：終點 = 程式終點 + 下一節方向的法向偏移（L14 → x=64）', () => {
  const res = build(CONTOUR);
  assert.equal(res.diagnostics.length, 0, JSON.stringify(res.diagnostics));
  const c14 = byLine(comp(res), 14);
  assert.equal(c14.length, 1);
  approx3(c14[0].from, V(65, 12, -2));
  approx3(c14[0].to, V(64, 12, -2));
  assert.equal(c14[0].kind, 'feed'); assert.equal(c14[0].feed, 150);
  // programmed 仍在
  approx3(byLine(prog(res), 14)[0].to, V(58, 12, -2));
});

test('補正中：直線平移 r、外側圓弧 R6 → R12、相切接合不插段、取消節回到程式終點', () => {
  const res = build(CONTOUR);
  const cs = comp(res);
  const c15 = byLine(cs, 15)[0];
  approx3(c15.from, V(64, 12, -2)); approx3(c15.to, V(64, -74.5, -2));
  const c16 = byLine(cs, 16);
  assert.equal(c16.length, 1, '相切 → 不插入接合段');
  approx(c16[0].arc.r, 12); approx(c16[0].arc.center.x, 52); approx(c16[0].arc.center.y, -74.5); assert.equal(c16[0].arc.cw, true);
  approx3(c16[0].from, V(64, -74.5, -2)); approx3(c16[0].to, V(52, -86.5, -2));
  const c17 = byLine(cs, 17)[0];
  approx3(c17.from, V(52, -86.5, -2)); approx3(c17.to, V(51, -86.5, -2));
  const c18 = byLine(cs, 18)[0];
  approx3(c18.from, V(51, -86.5, -2)); approx3(c18.to, V(51, -90, -2));
  assert.equal(byLine(cs, 19).length, 0, '取消後不再產生 compensated');
  assert.equal(byLine(cs, 13).length, 0, '啟動前不產生 compensated');
  // 路徑連續
  for (let i = 1; i < cs.length; i++) approx3(cs[i].from, cs[i - 1].to, 1e-9, `連續性 ${cs[i].line}`);
});

test('外角（轉向與補正側相反）→ 插入以程式轉角為圓心、半徑 r 的弧', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G41', d: 5 },
    { line: 11, kind: 'linear', to: V(10, 0, 0) },
    { line: 12, kind: 'linear', to: V(10, -10, 0) }, // 右轉 = G41 外角
    { line: 13, kind: 'linear', to: V(20, -10, 0), comp: 'G40' },
  ], { tool: 5, start: V(-10, 0, 0) });
  assert.equal(res.diagnostics.length, 0, JSON.stringify(res.diagnostics));
  const cs = comp(res);
  const c11 = byLine(cs, 11);
  assert.equal(c11.length, 2);
  approx3(c11[0].from, V(0, 5, 0)); approx3(c11[0].to, V(10, 5, 0));
  const ins = c11[1];
  assert.equal(ins.inserted, true); assert.equal(ins.kind, 'arc');
  approx(ins.arc.center.x, 10); approx(ins.arc.center.y, 0); approx(ins.arc.r, 5); assert.equal(ins.arc.cw, true);
  approx3(ins.from, V(10, 5, 0)); approx3(ins.to, V(15, 0, 0));
  approx(G.segmentLength(ins), Math.PI * 5 / 2);
  approx3(byLine(cs, 12)[0].from, V(15, 0, 0)); approx3(byLine(cs, 12)[0].to, V(15, -10, 0));
  // G42 鏡像：左轉是外角，插入逆時針弧
  const res2 = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G42', d: 5 },
    { line: 11, kind: 'linear', to: V(10, 0, 0) },
    { line: 12, kind: 'linear', to: V(10, 10, 0) },
    { line: 13, kind: 'linear', to: V(20, 10, 0), comp: 'G40' },
  ], { tool: 5, start: V(-10, 0, 0) });
  const ins2 = byLine(comp(res2), 11)[1];
  assert.equal(ins2.arc.cw, false);
  approx3(byLine(comp(res2), 11)[0].to, V(10, -5, 0));
  approx3(ins2.to, V(15, 0, 0));
});

test('內角 → 兩偏移線交點截斷，不插段', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G41', d: 5 },
    { line: 11, kind: 'linear', to: V(10, 0, 0) },
    { line: 12, kind: 'linear', to: V(10, 10, 0) }, // 左轉 = G41 內角
    { line: 13, kind: 'linear', to: V(20, 10, 0), comp: 'G40' },
  ], { tool: 5, start: V(-10, 0, 0) });
  assert.equal(res.diagnostics.length, 0, JSON.stringify(res.diagnostics));
  const cs = comp(res);
  assert.equal(byLine(cs, 11).length, 1);
  approx3(byLine(cs, 11)[0].to, V(5, 5, 0));
  approx3(byLine(cs, 12)[0].from, V(5, 5, 0)); approx3(byLine(cs, 12)[0].to, V(5, 10, 0));
  assert.ok(!cs.some((s) => s.inserted));
});

test('內角 直線→內凹圓弧：交點在弧上；圓弧→直線亦然', () => {
  // G41、r=5：往 +X 到 (20,0)，接 G3 圓心 (20,10) R10 到 (30,10)（內凹，左側是圓心）→ 偏移半徑 5
  const res = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G41', d: 5 },
    { line: 11, kind: 'linear', to: V(20, 0, 0) },
    { line: 12, kind: 'arc', to: V(30, 10, 0), center: { x: 20, y: 10 }, cw: false },
    { line: 13, kind: 'linear', to: V(30, 30, 0) },
    { line: 14, kind: 'linear', to: V(40, 30, 0), comp: 'G40' },
  ], { tool: 5, start: V(-10, 0, 0) });
  assert.equal(res.diagnostics.length, 0, JSON.stringify(res.diagnostics));
  const cs = comp(res);
  const c12 = byLine(cs, 12)[0];
  approx(c12.arc.r, 5);
  approx3(c12.from, V(20, 5, 0)); approx3(c12.to, V(25, 10, 0));
  approx3(byLine(cs, 11)[0].to, V(20, 5, 0));
  approx3(byLine(cs, 13)[0].from, V(25, 10, 0));
  for (let i = 1; i < cs.length; i++) approx3(cs[i].from, cs[i - 1].to, 1e-9, `連續性 ${cs[i].line}`);
});

test('內凹圓弧半徑 < r → R11 error（PS0041）；剛好等於 r（4MM 刀銑 R2）→ 縮成一點、不報錯', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G41', d: 5 },
    { line: 11, kind: 'linear', to: V(20, 0, 0) },
    { line: 12, kind: 'arc', to: V(24, 4, 0), center: { x: 20, y: 4 }, cw: false }, // R4 < 5
    { line: 13, kind: 'linear', to: V(24, 30, 0) },
    { line: 14, kind: 'linear', to: V(40, 30, 0), comp: 'G40' },
  ], { tool: 5, start: V(-10, 0, 0) });
  const r11 = diagsOf(res, 'R11');
  assert.ok(r11.length >= 1);
  assert.equal(r11[0].severity, 'error'); assert.equal(r11[0].line, 12); assert.equal(r11[0].fanucAlarm, 'PS0041');
  // 路徑仍連續（不會爆）
  const cs = comp(res);
  for (let i = 1; i < cs.length; i++) approx3(cs[i].from, cs[i - 1].to, 1e-9, `連續性 ${cs[i].line}`);
  // 樣本 A L1494–1500：T6(4MM) D6，,R2. 內角 → 補正圓弧半徑 0，刀心停在圓角圓心
  const res2 = build([
    { line: 1494, kind: 'linear', to: V(-35, -14.75, -35), comp: 'G41', d: 6 },
    { line: 1495, kind: 'linear', to: V(-42.5, -14.75, -35), corner: { r: 2 } },
    { line: 1496, kind: 'linear', to: V(-42.5, -28.75, -35), corner: { r: 2 } },
    { line: 1497, kind: 'linear', to: V(42.5, -28.75, -35), corner: { r: 2 } },
    { line: 1498, kind: 'linear', to: V(42.5, -14.75, -35), corner: { r: 2 } },
    { line: 1499, kind: 'linear', to: V(-38, -14.75, -35) },
    { line: 1500, kind: 'linear', to: V(-38, -21.75, -35), comp: 'G40' },
  ], { tool: 6, start: V(-35, -21.75, -35) }, { tools: [{ t: 6, diameter: 4 }], offsets: [] });
  assert.equal(res2.diagnostics.length, 0, JSON.stringify(res2.diagnostics));
  const cs2 = comp(res2);
  for (let i = 1; i < cs2.length; i++) approx3(cs2[i].from, cs2[i - 1].to, 1e-9, `連續性 ${cs2[i].line}`);
  const c1495 = byLine(cs2, 1495);
  approx3(c1495[0].to, V(-40.5, -16.75, -35));
  approx3(byLine(cs2, 1496)[0].from, V(-40.5, -16.75, -35));
  approx3(byLine(cs2, 1496)[0].to, V(-40.5, -26.75, -35));
});

test('溝槽比刀徑小（求不到交點）→ R11 error PS0041', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G41', d: 5 },
    { line: 11, kind: 'linear', to: V(20, 0, 0) },
    { line: 12, kind: 'linear', to: V(20, 4, 0) },   // 寬 4 的槽，刀徑 10
    { line: 13, kind: 'linear', to: V(0, 4, 0) },
    { line: 14, kind: 'linear', to: V(0, 20, 0), comp: 'G40' },
  ], { tool: 5, start: V(-10, 0, 0) });
  const r11 = diagsOf(res, 'R11');
  assert.ok(r11.length >= 1, JSON.stringify(res.diagnostics));
  assert.equal(r11[0].severity, 'error'); assert.equal(r11[0].fanucAlarm, 'PS0041');
  const cs = comp(res);
  for (let i = 1; i < cs.length; i++) approx3(cs[i].from, cs[i - 1].to, 1e-9, `連續性 ${cs[i].line}`);
});

test('無 D 值／無刀具資料 → R10 needsInput，補正以 0 計算（compensated = programmed）', () => {
  const res = build(CONTOUR, {}, null);
  const ni = res.diagnostics.filter((d) => d.severity === 'needsInput' && d.ruleId === 'R10');
  assert.equal(ni.length, 1);
  assert.equal(ni[0].line, 14);
  assert.match(ni[0].message, /D 值/);
  const cs = comp(res);
  assert.ok(cs.length >= 5);
  approx3(byLine(cs, 14)[0].to, V(58, 12, -2));
  approx(byLine(cs, 16)[0].arc.r, 6);
  // 刀具表有刀但無直徑、offsets 也沒有 → 同樣 needsInput；offsets 有值 → 用 offsets
  const res2 = build(CONTOUR, {}, { tools: [{ t: 11, diameter: 0 }], offsets: [] });
  assert.equal(res2.diagnostics.filter((d) => d.ruleId === 'R10').length, 1);
  const res3 = build(CONTOUR, {}, { tools: [{ t: 11, diameter: 12 }], offsets: [{ n: 11, lenGeom: 0, lenWear: 0, radGeom: 5.9, radWear: 0.1, source: 'user' }] });
  assert.equal(res3.diagnostics.length, 0);
  approx3(byLine(comp(res3), 14)[0].to, V(64, 12, -2));
  const res4 = build(CONTOUR, {}, { tools: [{ t: 11, diameter: 12 }], offsets: [{ n: 11, radGeom: 5, radWear: 0, source: 'user' }] });
  approx3(byLine(comp(res4), 14)[0].to, V(63, 12, -2));
});

test('啟動節長度 < r → R10 warning（訊息含程式長度與淨移動）', () => {
  const res = build([
    { line: 10, kind: 'rapid', to: V(-3, 0, 0) },
    { line: 11, kind: 'linear', to: V(0, 0, 0), comp: 'G41', d: 11 }, // 長 3 < r 6
    { line: 12, kind: 'linear', to: V(0, 20, 0) },
    { line: 13, kind: 'linear', to: V(-10, 20, 0), comp: 'G40' },
  ], { start: V(-3, 0, 5) });
  const w = diagsOf(res, 'R10');
  assert.equal(w.length, 1); assert.equal(w[0].severity, 'warning'); assert.equal(w[0].line, 11);
  assert.match(w[0].message, /3 mm/); assert.match(w[0].message, /6/);
  approx3(byLine(comp(res), 11)[0].to, V(-6, 0, 0));
});

test('補正中連續無平面移動節數 > lookahead-2 → R12 warning；Z 軸移動在轉角向量位置輸出', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G41', d: 5 },
    { line: 11, kind: 'linear', to: V(10, 0, 0) },
    { line: 12, kind: 'linear', to: V(10, 0, -2) },  // Z only
    { line: 13, kind: 'none' , actions: [{ kind: 'coolant', on: true }] }, // M8
    { line: 14, kind: 'linear', to: V(10, 10, -2) },  // 內角
    { line: 15, kind: 'linear', to: V(20, 10, -2), comp: 'G40' },
  ], { tool: 5, start: V(-10, 0, 0), });
  const w = diagsOf(res, 'R12');
  assert.equal(w.length, 1); assert.equal(w[0].severity, 'warning'); assert.equal(w[0].line, 13);
  const cs = comp(res);
  const c12 = byLine(cs, 12)[0];
  approx3(c12.from, V(5, 5, 0)); approx3(c12.to, V(5, 5, -2));
  approx3(byLine(cs, 11)[0].to, V(5, 5, 0));
  approx3(byLine(cs, 14)[0].from, V(5, 5, -2));
  for (let i = 1; i < cs.length; i++) approx3(cs[i].from, cs[i - 1].to, 1e-9, `連續性 ${cs[i].line}`);
  // 只有一節 Z 移動（≤ lookahead-2）→ 不警告
  const res2 = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G41', d: 5 },
    { line: 11, kind: 'linear', to: V(10, 0, 0) },
    { line: 12, kind: 'linear', to: V(10, 0, -2) },
    { line: 14, kind: 'linear', to: V(10, 10, -2) },
    { line: 15, kind: 'linear', to: V(20, 10, -2), comp: 'G40' },
  ], { tool: 5, start: V(-10, 0, 0) });
  assert.equal(diagsOf(res2, 'R12').length, 0);
  // lookahead 設大 → 不警告
  const res3 = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G41', d: 5 },
    { line: 11, kind: 'linear', to: V(10, 0, 0) },
    { line: 12, kind: 'linear', to: V(10, 0, -2) },
    { line: 13, kind: 'none', actions: [{ kind: 'coolant', on: true }] },
    { line: 14, kind: 'linear', to: V(10, 10, -2) },
    { line: 15, kind: 'linear', to: V(20, 10, -2), comp: 'G40' },
  ], { tool: 5, start: V(-10, 0, 0) }, TABLE, { lookahead: 6 });
  assert.equal(diagsOf(res3, 'R12').length, 0);
});

test('G41 單獨一節（無移動）→ 下一個平面移動當啟動節；G40 單獨一節 → 下一個移動回到程式路徑', () => {
  const res = build([
    { line: 10, kind: 'none', comp: 'G41', d: 5 },
    { line: 11, kind: 'linear', to: V(0, 0, 0) },
    { line: 12, kind: 'linear', to: V(10, 0, 0) },
    { line: 13, kind: 'none', comp: 'G40' },
    { line: 14, kind: 'rapid', to: V(10, 0, 10) },
    { line: 15, kind: 'rapid', to: V(30, 0, 10) },
  ], { tool: 5, start: V(-10, 0, 0) });
  const cs = comp(res);
  approx3(byLine(cs, 11)[0].to, V(0, 5, 0));
  approx3(byLine(cs, 12)[0].to, V(10, 5, 0));
  const c14 = byLine(cs, 14);
  assert.equal(c14.length, 1);
  approx3(c14[0].from, V(10, 5, 0)); approx3(c14[0].to, V(10, 0, 10));
  assert.equal(byLine(cs, 15).length, 0);
});

test('補正中遇到 G28（refReturn）／換刀 → 補正結束，路徑收尾', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G41', d: 5 },
    { line: 11, kind: 'linear', to: V(10, 0, 0) },
    { line: 12, kind: 'refReturn', via: V(10, 0, 0), to: V(10, 0, 150) },
  ], { tool: 5, start: V(-10, 0, 0) });
  const cs = comp(res);
  assert.equal(byLine(cs, 11).length, 1);
  approx3(byLine(cs, 11)[0].to, V(10, 5, 0));
  assert.equal(byLine(cs, 12).length, 0);
  assert.equal(byLine(prog(res), 12).length, 2);
});

test(',C 與補正並用：倒角段也被補正，外角插弧', () => {
  const res = build([
    { line: 15, kind: 'linear', to: V(57.6, 0, -2.5), comp: 'G41', d: 6 },
    { line: 16, kind: 'linear', to: V(58, 0, -2.5), corner: { c: 0.3 } },
    { line: 17, kind: 'linear', to: V(58, -41, -2.5) },
    { line: 18, kind: 'linear', to: V(-58, -41, -2.5), comp: 'G40' },
  ], { tool: 5, start: V(57.6, 10, -2.5), });
  const cs = comp(res);
  const c16 = byLine(cs, 16);
  // 短直線、外角弧、倒角段、外角弧
  assert.ok(c16.length >= 3, `L16 compensated 段數 ${c16.length}`);
  const chamfer = c16.find((s) => s.inserted && !s.arc);
  assert.ok(chamfer, '有補正後的倒角段');
  approx(G.segmentLength(chamfer), 0.3 * Math.SQRT2, 1e-9);
  assert.ok(c16.filter((s) => s.arc && s.inserted).length >= 2, '兩個外角各插一段弧');
  for (let i = 1; i < cs.length; i++) approx3(cs[i].from, cs[i - 1].to, 1e-9, `連續性 ${cs[i].line}`);
});

test('G42 直線偏移到右側', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(0, 0, 0), comp: 'G42', d: 5 },
    { line: 11, kind: 'linear', to: V(10, 0, 0) },
    { line: 12, kind: 'linear', to: V(10, 10, 0), comp: 'G40' },
  ], { tool: 5, start: V(-10, 0, 0) });
  const cs = comp(res);
  approx3(byLine(cs, 10)[0].to, V(0, -5, 0));
  approx3(byLine(cs, 11)[0].to, V(10, -5, 0));
});

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------
test('bounds：不含 rapid，含弧的包絡', () => {
  const res = build([
    { line: 10, kind: 'rapid', to: V(100, 100, 50) },
    { line: 11, kind: 'rapid', to: V(10, 0, 0) },
    { line: 12, kind: 'arc', to: V(-10, 0, -3), center: { x: 0, y: 0 }, cw: false }, // 上半圓 → y max 10
    { line: 13, kind: 'linear', to: V(-10, -4, -3) },
  ]);
  approx(res.bounds.max.x, 10); approx(res.bounds.min.x, -10);
  approx(res.bounds.max.y, 10); approx(res.bounds.min.y, -4);
  approx(res.bounds.max.z, 0); approx(res.bounds.min.z, -3);
  // 四分之一圓不含 180° 那點
  const res2 = build([
    { line: 10, kind: 'rapid', to: V(10, 0, 0) },
    { line: 11, kind: 'arc', to: V(0, 10, 0), center: { x: 0, y: 0 }, cw: false },
  ]);
  approx(res2.bounds.min.x, 0); approx(res2.bounds.min.y, 0); approx(res2.bounds.max.x, 10); approx(res2.bounds.max.y, 10);
});

// ---------------------------------------------------------------------------
// 整合測試：tokenizer + interpreter 存在時才跑
// ---------------------------------------------------------------------------
const HAS_PIPELINE = typeof NC.tokenize === 'function' && typeof NC.interpret === 'function';

function pipeline(name, tableOverride) {
  const settings = NC.util.defaultSettings();
  const tok = NC.tokenize(fixture(name));
  const run = NC.interpret(tok.blocks, settings, 'off');
  // 手工刀具表：由 M6 註解取直徑（xxMM / xxM/M）
  const tools = [];
  for (const b of tok.blocks) {
    const m6 = b.words && b.words.some((w) => w.addr === 'M' && w.value === 6);
    if (!m6) continue;
    const tw = b.words.find((w) => w.addr === 'T');
    const m = b.comment && b.comment.match(/(\d+(?:\.\d+)?)\s*(?:MM|M\/M)/i);
    if (tw && m && !tools.some((t) => t.t === tw.value)) tools.push({ t: tw.value, label: b.comment, type: 'endmill', diameter: parseFloat(m[1]), source: {} });
  }
  const table = tableOverride || { programKey: name, tools, offsets: [], updatedAt: '' };
  const geo = NC.buildSegments(run, table, settings);
  return { tok, run, geo, table };
}

test('整合：R 圓弧的圓心、補正啟動節的終點、外角補正後半徑加上 r', { skip: goldenSkip.skip || (!HAS_PIPELINE && '需要 tokenizer/interpreter') }, () => {
  const { geo } = pipeline(FIX_A);
  const l16 = byLine(prog(geo.segments.length ? geo : { segments: [] }), 16)[0] || byLine(geo.segments, 16)[0];
  assert.ok(l16 && l16.arc, 'L16 是圓弧');
  approx(l16.arc.center.x, 52, 1e-6); approx(l16.arc.center.y, -74.5, 1e-6);
  const c14 = byLine(comp(geo), 14);
  assert.equal(c14.length, 1);
  approx(c14[0].to.x, 64, 1e-6); approx(c14[0].to.y, 12, 1e-6);
  const c16 = byLine(comp(geo), 16).find((s) => s.arc);
  assert.ok(c16, 'L16 有補正弧');
  approx(c16.arc.r, 12, 1e-6);
  approx(c16.arc.center.x, 52, 1e-6); approx(c16.arc.center.y, -74.5, 1e-6);
  // 補正路徑在每段 G41…G40 內連續（G40 取消 → 下一次 G41 啟動之間本來就會跳）
  const { run } = pipeline(FIX_A);
  const cs = comp(geo);
  const breaks = [];
  for (let i = 1; i < cs.length; i++) {
    const prevBlk = run.executed[cs[i - 1].line - 1];
    if (prevBlk && prevBlk.after.comp === 'G40') continue;
    if (NC.util.dist3(cs[i].from, cs[i - 1].to) > 1e-6) breaks.push(`L${cs[i - 1].line}->L${cs[i].line}`);
  }
  assert.deepEqual(breaks, [], `補正路徑不連續處 ${breaks.join(', ')}`);
  // 4MM 刀銑 R2 內角（L1495–1498）不應報 R11
  assert.equal(geo.diagnostics.filter((d) => d.ruleId === 'R11').length, 0, JSON.stringify(geo.diagnostics.filter((d) => d.ruleId === 'R11')));
});

test('整合：,C 倒角的插入段長度正確；G91 的 G3 半圓圓心正確', { skip: goldenSkip.skip || (!HAS_PIPELINE && '需要 tokenizer/interpreter') }, () => {
  const { geo } = pipeline(FIX_D);
  const l16 = byLine(prog(geo), 16);
  const ch = l16.find((s) => s.inserted);
  assert.ok(ch, 'L16 有插入段');
  approx(G.segmentLength(ch), 0.3 * Math.SQRT2, 1e-6);
  const l301 = byLine(prog(geo), 301).find((s) => s.arc);
  assert.ok(l301, 'L301 是圓弧');
  approx(l301.to.y - l301.from.y, 22, 1e-6);
  approx(l301.from.x, l301.to.x, 1e-6);
  approx(l301.arc.center.x, l301.from.x, 1e-6);
  approx(l301.arc.center.y, (l301.from.y + l301.to.y) / 2, 1e-6);
  approx(l301.arc.r, 11, 1e-6);
  approx(G.arcSweep(l301.arc.center, l301.from, l301.to, l301.arc.cw), Math.PI, 1e-6);
  assert.equal(l301.arc.cw, false);
});

test('整合：樣本 C T3 第一個 op 展開後有 4 個 drill 段', { skip: goldenSkip.skip || (!HAS_PIPELINE && '需要 tokenizer/interpreter') }, () => {
  const { geo, run } = pipeline(FIX_C);
  const op0 = run.ops[0];
  assert.equal(op0.tool, 3);
  const drills = geo.segments.filter((s) => s.opIndex === op0.index && s.kind === 'drill');
  assert.equal(drills.length, 4);
  assert.ok(drills.every((s) => Math.abs(s.to.z - (-1.2)) < 1e-6));
});

test('整合：四支程式 buildSegments 不丟例外、bounds 合理、效能', { skip: goldenSkip.skip || (!HAS_PIPELINE && '需要 tokenizer/interpreter') }, () => {
  for (const name of [FIX_A, FIX_B, FIX_C, FIX_D]) {
    const t0 = performance.now();
    const { geo } = pipeline(name);
    const dt = performance.now() - t0;
    assert.ok(geo.segments.length > 0, name);
    assert.ok(Number.isFinite(geo.bounds.min.x) && Number.isFinite(geo.bounds.max.x), name);
    assert.ok(geo.segments.every((s) => Number.isFinite(s.from.x) && Number.isFinite(s.to.x) && Number.isFinite(s.to.z)), `${name} 座標皆有限`);
    assert.ok(dt < 1000, `${name} tokenize+interpret+geometry ${dt.toFixed(0)} ms`);
  }
});


// ---------------------------------------------------------------------------
// 審查修正：G87 方向、G83 浮點夾點、PS0051、零長度補正段
// ---------------------------------------------------------------------------
test('G87 背搪孔：快速下到孔底、進給往上搪（方向不可以和 G81 一樣）', () => {
  const segs = NC.geometry.expandHole({
    kind: 'hole', x: 0, y: 0, z: -20, r: 2, initialZ: 10, cycle: 'G87', retract: 'G98', feed: 100,
  }, { pos: { x: 0, y: 0, z: 10 } });
  const cut = segs.filter((s) => s.kind === 'drill');
  assert.equal(cut.length, 1, 'G87 只有一段進給');
  assert.equal(cut[0].sub, 'boreUp');
  assert.ok(cut[0].to.z > cut[0].from.z, '搪孔是往上進給');
  assert.equal(cut[0].from.z, -20);
  // 下到孔底那一段是快速
  const down = segs.find((s) => s.kind === 'rapid' && s.to.z === -20);
  assert.ok(down, '應該有一段快速下到孔底');
});

test('G83 啄鑽：最後一啄要剛好到孔底（浮點累積不可以差 4e-14）', () => {
  const segs = NC.geometry.expandHole({
    kind: 'hole', x: 0, y: 0, z: -40, r: -28, q: 0.4, initialZ: 10, cycle: 'G83', retract: 'G98', feed: 30,
  }, { pos: { x: 0, y: 0, z: 10 } });
  const deepest = Math.min.apply(null, segs.map((s) => Math.min(s.from.z, s.to.z)));
  assert.equal(deepest, -40, '最深點要剛好等於孔底');
});

test(',C 後面完全沒有移動節 → PS0051（不是 PS0052）', () => {
  const res = build([
    { line: 10, kind: 'linear', to: V(10, 0, 0), corner: { c: 1 } },
  ], { start: V(0, 0, 0) });
  const d = diagsOf(res, 'R22')[0];
  assert.equal(d.severity, 'error');
  assert.equal(d.fanucAlarm, 'PS0051');
});

test('四支程式：補正段裡不留零長度的段（view2d 才不會多出點不到的段）', { skip: goldenSkip.skip || (!HAS_PIPELINE) }, () => {
  for (const name of [FIX_A, FIX_B, FIX_C, FIX_D]) {
    const g = pipeline(name).geo;
    const bad = g.segments.filter((s) => s.path === 'compensated' && !s.arc
      && Math.abs(s.to.x - s.from.x) < 1e-9 && Math.abs(s.to.y - s.from.y) < 1e-9 && Math.abs(s.to.z - s.from.z) < 1e-9);
    assert.equal(bad.length, 0, name + ' 有 ' + bad.length + ' 段零長度的 compensated 段');
  }
});
