// tools.js 測試：parseComment 各型、inferTools（含 probe 與交叉驗證）、補正、素材推估、儲存、JSON/CSV。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadNC, fixture, FIXTURES, ROOT, goldenSkip, FIX_A, FIX_B, FIX_C, FIX_D } from './load.mjs';

const NC = loadNC();
const T = NC.tools;
const hasTokenizer = typeof NC.tokenize === 'function';
const hasPipeline = hasTokenizer && typeof NC.interpret === 'function';

// ---------------------------------------------------------------------------
// 測試用小工具：沒有 tokenizer 時用的極簡切詞（只給 tools.js 的 tok 退路用）
// ---------------------------------------------------------------------------
function miniTokenize(text) {
  const lines = text.split(/\r\n|\n/);
  const blocks = lines.map((raw, i) => {
    const comments = [];
    let body = raw.replace(/\(([^)]*)\)/g, (_, c) => { comments.push(c.trim()); return ' '; });
    const sm = /^(\/+)/.exec(body.trim());
    body = body.trim().replace(/^\/+\d?/, '');
    const words = [];
    const re = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;
    let m;
    while ((m = re.exec(body))) words.push({ addr: m[1].toUpperCase(), value: parseFloat(m[2]), raw: m[0], col: m.index, hasDecimal: m[2].includes('.'), comma: false });
    const isPercent = body.trim() === '%';
    return { line: i + 1, raw, text: body.trim(), comment: comments.length ? comments.join(' ') : null, slashes: sm ? sm[1].length : 0,
      skipLevel: sm ? 1 : null, words, isPercent, isEmpty: words.length === 0, tailIgnored: null };
  });
  const o = blocks.find((b) => b.words.some((w) => w.addr === 'O'));
  return { blocks, lineEnding: '\n', programNumber: o ? o.words.find((w) => w.addr === 'O').value : null, programName: o ? o.comment : null, diagnostics: [] };
}

/** 依 fixture 產生 (tok, run)：有正式 tokenizer/interpreter 就用，否則用極簡切詞、run = null 走 tok 退路 */
function pipeline(name) {
  const text = fixture(name);
  const tok = hasTokenizer ? NC.tokenize(text) : miniTokenize(text);
  const run = hasPipeline ? NC.interpret(tok.blocks, NC.util.defaultSettings(), 'off') : null;
  return { tok, run };
}

// ---------------------------------------------------------------------------
// 手寫 Run 產生器
// ---------------------------------------------------------------------------
const P = (x, y, z) => ({ x, y, z });
function makeRun(opsSpec) {
  // opsSpec: [{tool, comment, blocks:[ {actions:[...], comp?:'G41'} ], gCodes?, dList?}]
  const executed = [];
  const ops = [];
  let line = 2;
  opsSpec.forEach((spec, index) => {
    const lineStart = line;
    executed.push({ line: line++, skipped: false, ignored: false, opIndex: index, actions: [{ kind: 'toolchange', tool: spec.tool }], before: {}, after: { comp: 'G40' } });
    for (const b of (spec.blocks || [])) {
      executed.push({ line: line++, skipped: !!b.skipped, ignored: false, opIndex: index, actions: b.actions || [], before: {}, after: { comp: b.comp || 'G40' } });
    }
    let zMin = null;
    for (const eb of executed) if (eb.opIndex === index) for (const a of eb.actions) {
      const z = a.kind === 'hole' ? a.z : ((a.kind === 'linear' || a.kind === 'arc') ? a.to.z : null);
      if (z != null && (zMin == null || z < zMin)) zMin = z;
    }
    ops.push({ index, tool: spec.tool, toolComment: spec.comment == null ? null : spec.comment, h: spec.tool, dList: spec.dList || [],
      lineStart, lineEnd: line - 1, zMin, feeds: [], rpms: [], gCodes: spec.gCodes || [], kindGuess: 'unknown' });
  });
  return { scenario: 'off', executed, ops, diagnostics: [], finalState: {} };
}
const lin = (a, b, feed = 100) => ({ kind: 'linear', from: a, to: b, feed });
const hole = (x, y, z, cycle, extra) => Object.assign({ kind: 'hole', x, y, z, r: 2, initialZ: 10, cycle, retract: 'G98' }, extra || {});

// ---------------------------------------------------------------------------
// parseComment
// ---------------------------------------------------------------------------
test('parseComment：契約驗收各型', () => {
  assert.deepEqual(T.parseComment('SG-12.'), { type: 'drill', diameter: 12, angle: 118, source: 'comment' });
  assert.deepEqual(T.parseComment('M4*P0.7'), { type: 'tap', diameter: 4, pitch: 0.7, source: 'comment' });
  assert.deepEqual(T.parseComment('6+0.014'), { type: 'reamer', diameter: 6.014, source: 'comment' });
  assert.deepEqual(T.parseComment('10V'), { type: 'chamfer', diameter: 10, angle: 90, source: 'comment' });
  assert.deepEqual(T.parseComment('100MM'), { type: 'facemill', diameter: 100, source: 'comment' });
});
test('parseComment：銑刀寫法與邊界', () => {
  assert.equal(T.parseComment('12MM').type, 'endmill');
  assert.equal(T.parseComment('12MM').diameter, 12);
  assert.equal(T.parseComment('10M/M').diameter, 10);
  assert.equal(T.parseComment('5.9M/M').diameter, 5.9);
  assert.equal(T.parseComment('50MM').type, 'facemill');
  assert.equal(T.parseComment('39.9MM').type, 'endmill');
  assert.equal(T.parseComment('SG-6.5').diameter, 6.5);
  assert.equal(T.parseComment('SG-4.5').diameter, 4.5);
  assert.equal(T.parseComment('8V').diameter, 8);
  assert.equal(T.parseComment('m4*p0.7').type, 'tap');
  assert.equal(T.parseComment('M8X1.25').pitch, 1.25);
  assert.equal(T.parseComment(' 12 mm ').diameter, 12);
});
test('parseComment：空值與看不懂 → unknown', () => {
  for (const v of ['', null, undefined, 'ABC', '哈囉']) {
    const r = T.parseComment(v);
    assert.equal(r.type, 'unknown', String(v));
    assert.equal(r.diameter, null);
    assert.equal(r.source, 'default');
  }
});

// ---------------------------------------------------------------------------
// inferTools（手寫 Run）
// ---------------------------------------------------------------------------
function sampleRun() {
  return makeRun([
    { tool: 20, comment: '100MM', blocks: [{ actions: [lin(P(115, -58, 0), P(-115, -58, 0), 200)] }] },
    { tool: 11, comment: '12MM', dList: [11], gCodes: ['G0', 'G1', 'G41', 'G40'], blocks: [
      { actions: [lin(P(0, 0, 3), P(0, 0, -30))] },
      { actions: [lin(P(0, 0, -30), P(58, 0, -30))], comp: 'G41' },
      { actions: [lin(P(58, 0, -30), P(58, -80, -30))], comp: 'G41' },
    ] },
    { tool: 9, comment: 'SG-12.', blocks: [{ actions: [hole(10, 10, -40, 'G81'), hole(20, 10, -40, 'G81')] }] },
    { tool: 10, comment: 'M4*P0.7', blocks: [{ actions: [hole(-53, -5, -11, 'G84', { rigid: true })] }] },
    { tool: 13, comment: '6+0.014', blocks: [{ actions: [hole(-42, -67.5, -26.5, 'G85')] }] },
    { tool: 3, comment: '10V', dList: [21], gCodes: ['G41'], blocks: [{ actions: [lin(P(0, 0, -31), P(50, 0, -31))], comp: 'G41' }] },
    { tool: 11, comment: '12MM', dList: [11], blocks: [{ actions: [lin(P(0, 0, -36), P(10, 0, -36))] }] }, // 同刀第二次
    { tool: 7, comment: null, dList: [7], gCodes: ['G41'], blocks: [{ actions: [lin(P(0, 0, -5), P(30, 0, -5))], comp: 'G41' }] }, // 無註解但有輪廓
    { tool: 8, comment: null, blocks: [{ actions: [hole(0, 0, -20, 'G83', { q: 1 })] }] }, // 無註解只有鑽孔
    { tool: 15, comment: null, blocks: [{ actions: [{ kind: 'rapid', from: P(0, 0, 150), to: P(0, 0, 150) }] }] }, // probe
  ]);
}

test('inferTools：去重、順序、型式與直徑', () => {
  const tools = T.inferTools(null, sampleRun());
  assert.deepEqual(tools.map((t) => t.t), [20, 11, 9, 10, 13, 3, 7, 8, 15]);
  const by = Object.fromEntries(tools.map((t) => [t.t, t]));
  assert.equal(by[20].type, 'facemill'); assert.equal(by[20].diameter, 100); assert.equal(by[20].resident, true);
  assert.equal(by[11].type, 'endmill'); assert.equal(by[11].diameter, 12); assert.equal(by[11].label, '12MM'); assert.equal(by[11].resident, false);
  assert.equal(by[9].type, 'drill'); assert.equal(by[9].angle, 118);
  assert.equal(by[10].type, 'tap'); assert.equal(by[10].pitch, 0.7); assert.equal(by[10].diameter, 4);
  assert.equal(by[13].type, 'reamer'); assert.equal(by[13].diameter, 6.014);
  assert.equal(by[3].type, 'chamfer'); assert.equal(by[3].angle, 90);
  assert.equal(by[11].source.type, 'comment'); assert.equal(by[11].source.diameter, 'comment');
  assert.equal(by[11].fluteLen, 36); assert.equal(by[11].source.fluteLen, 'default');
  assert.equal(by[11].stickout, null);
});
test('inferTools：無註解 → 由動作推測、source.type=motion', () => {
  const by = Object.fromEntries(T.inferTools(null, sampleRun()).map((t) => [t.t, t]));
  assert.equal(by[7].type, 'endmill'); assert.equal(by[7].source.type, 'motion'); assert.equal(by[7].diameter, 10); assert.equal(by[7].source.diameter, 'default');
  assert.equal(by[7].label, 'T7'); assert.equal(by[7].probe, false);
  assert.equal(by[8].type, 'drill'); assert.equal(by[8].source.type, 'motion'); assert.equal(by[8].probe, false);
});
test('inferTools：無註解且無切削 → probe', () => {
  const by = Object.fromEntries(T.inferTools(null, sampleRun()).map((t) => [t.t, t]));
  assert.equal(by[15].probe, true);
  assert.equal(by[15].type, 'unknown');
  assert.equal(by[15].diameter, 10);
  assert.equal(by[15].label, 'T15');
});
test('inferTools：註解與動作矛盾 → 保留註解型式、inferDetails.conflict=true', () => {
  const run = makeRun([
    { tool: 9, comment: 'SG-12.', dList: [9], gCodes: ['G41'], blocks: [{ actions: [lin(P(0, 0, -5), P(50, 0, -5))], comp: 'G41' }] }, // 鑽頭做輪廓
    { tool: 10, comment: 'M4*P0.7', blocks: [{ actions: [hole(0, 0, -10, 'G81')] }] },                                             // 絲攻做 G81
    { tool: 3, comment: '8V', blocks: [{ actions: [hole(0, 0, -1.2, 'G81')] }] },                                                   // 倒角刀 G81 倒孔口：相容
    { tool: 12, comment: '12MM', blocks: [{ actions: [hole(0, 0, -3, 'G82')] }] },                                                 // 銑刀 G82：相容
  ]);
  const tools = T.inferTools(null, run);
  const det = T.inferDetails(null, run);
  const d = Object.fromEntries(det.map((x) => [x.t, x]));
  assert.equal(tools[0].type, 'drill'); assert.equal(tools[0].source.type, 'comment');
  assert.equal(d[9].conflict, true); assert.equal(d[9].motionType, 'endmill'); assert.equal(d[9].commentType, 'drill');
  assert.equal(tools[1].type, 'tap'); assert.equal(d[10].conflict, true); assert.equal(d[10].motionType, 'drill');
  assert.equal(d[3].conflict, false);
  assert.equal(d[12].conflict, false);
});
test('inferTools：無註解、淺層長行程 → facemill、resident', () => {
  const run = makeRun([{ tool: 5, comment: null, blocks: [{ actions: [lin(P(115, -58, 0), P(-115, -58, 0), 200)] }] }]);
  const [t] = T.inferTools(null, run);
  assert.equal(t.type, 'facemill'); assert.equal(t.source.type, 'motion'); assert.equal(t.resident, true);
});
test('inferTools：只有 tok（無 run）也能走退路', goldenSkip, () => {
  const tok = miniTokenize(fixture(FIX_C));
  const tools = T.inferTools(tok, null);
  assert.deepEqual(tools.map((t) => t.t), [3, 7, 1, 2, 15]);
  const by = Object.fromEntries(tools.map((t) => [t.t, t]));
  assert.equal(by[15].probe, true);
  assert.equal(by[3].type, 'chamfer');
  assert.equal(by[7].type, 'drill');
  assert.equal(by[1].type, 'endmill');
});
test('inferTools：空輸入不會炸', () => {
  assert.deepEqual(T.inferTools(null, null), []);
  assert.deepEqual(T.inferTools({ blocks: [] }, { executed: [], ops: [] }), []);
});

// ---------------------------------------------------------------------------
// 四支真實程式
// ---------------------------------------------------------------------------
test(`真實程式：樣本 A inferTools 15 把（T1–T14 + T20，無 T15）${hasPipeline ? '' : '（tok 退路）'}`, goldenSkip, () => {
  const { tok, run } = pipeline(FIX_A);
  const tools = T.inferTools(tok, run);
  const ts = tools.map((t) => t.t).sort((a, b) => a - b);
  assert.deepEqual(ts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 20]);
  assert.equal(tools.length, 15);
  assert.ok(!ts.includes(15));
  const by = Object.fromEntries(tools.map((t) => [t.t, t]));
  assert.equal(by[20].type, 'facemill'); assert.equal(by[20].diameter, 100); assert.equal(by[20].resident, true);
  assert.equal(by[11].type, 'endmill'); assert.equal(by[11].diameter, 12);
  assert.equal(by[13].type, 'reamer'); assert.equal(by[13].diameter, 6.014);
  assert.equal(by[10].type, 'endmill'); assert.equal(by[10].diameter, 5.9);
  assert.equal(by[4].type, 'chamfer'); assert.equal(by[4].diameter, 5);
  assert.equal(by[9].type, 'drill'); assert.equal(by[9].diameter, 12);
  for (const t of tools) assert.equal(t.probe, false, `T${t.t}`);
  assert.equal(tools[0].t, 20, '依第一次出現排序');
});
test(`真實程式：樣本 C T15 → probe:true${hasPipeline ? '' : '（tok 退路）'}`, goldenSkip, () => {
  const { tok, run } = pipeline(FIX_C);
  const tools = T.inferTools(tok, run);
  assert.deepEqual(tools.map((t) => t.t), [3, 7, 1, 2, 15]);
  const t15 = tools.find((t) => t.t === 15);
  assert.equal(t15.probe, true); assert.equal(t15.type, 'unknown'); assert.equal(t15.label, 'T15'); assert.equal(t15.diameter, 10);
  const t3 = tools.find((t) => t.t === 3);
  assert.equal(t3.type, 'chamfer'); assert.equal(t3.diameter, 8);
  const d = T.inferDetails(tok, run).find((x) => x.t === 15);
  assert.equal(d.hasCut, false); assert.equal(d.comment, null);
});
test(`真實程式：樣本 B 第二次 M6T20 無註解仍併入 T20；預選 T15 不算刀${hasPipeline ? '' : '（tok 退路）'}`, goldenSkip, () => {
  const { tok, run } = pipeline(FIX_B);
  const tools = T.inferTools(tok, run);
  assert.deepEqual(tools.map((t) => t.t), [20, 11, 12]);
  const t20 = tools[0];
  assert.equal(t20.type, 'facemill'); assert.equal(t20.diameter, 50); assert.equal(t20.probe, false); assert.equal(t20.label, '50MM');
});
test(`真實程式：樣本 D T10 絲攻、T8 鑽頭${hasPipeline ? '' : '（tok 退路）'}`, goldenSkip, () => {
  const { tok, run } = pipeline(FIX_D);
  const by = Object.fromEntries(T.inferTools(tok, run).map((t) => [t.t, t]));
  assert.equal(by[10].type, 'tap'); assert.equal(by[10].pitch, 0.7);
  assert.equal(by[8].type, 'drill'); assert.equal(by[8].diameter, 3.5);
  assert.equal(by[6].type, 'endmill'); assert.equal(by[6].diameter, 16);
  const d = T.inferDetails(tok, run);
  for (const x of d) assert.equal(x.conflict, false, `T${x.t} ${x.commentType} vs ${x.motionType}`);
});
test('真實程式：四支都不會有註解／動作矛盾', goldenSkip, () => {
  for (const f of FIXTURES) {
    const { tok, run } = pipeline(f);
    for (const x of T.inferDetails(tok, run)) assert.equal(x.conflict, false, `${f} T${x.t} ${x.commentType} vs ${x.motionType}`);
  }
});
if (hasPipeline) {
  test('真實程式（正式 pipeline）：樣本 A T11 zMin=-36 從 inferDetails 可得', goldenSkip, () => {
    const { tok, run } = pipeline(FIX_A);
    const d = T.inferDetails(tok, run).find((x) => x.t === 11);
    assert.ok(d.zMin <= -30);
    assert.ok(d.dList.includes(11));
    assert.equal(d.hasComp, true);
  });
}

// ---------------------------------------------------------------------------
// effectiveRadius / defaultOffsets
// ---------------------------------------------------------------------------
test('effectiveRadius：補正優先、否則直徑/2、皆無 → null', () => {
  const table = {
    programKey: 'O1001',
    tools: [{ t: 11, diameter: 12 }, { t: 3, diameter: 0 }],
    offsets: [{ n: 11, lenGeom: 0, lenWear: 0, radGeom: 4.01, radWear: 0, source: 'user' }, { n: 12, lenGeom: 0, lenWear: 0, radGeom: 0, radWear: 0, source: 'default' }],
  };
  assert.equal(T.effectiveRadius(table, 11, 11), 4.01);
  assert.equal(T.effectiveRadius(table, 11, 12), 6);   // D12 為 0 → 用直徑/2
  assert.equal(T.effectiveRadius(table, 11, 0), 6);
  assert.equal(T.effectiveRadius(table, 11, 99), 6);
  assert.equal(T.effectiveRadius(table, 3, 99), null);
  assert.equal(T.effectiveRadius(table, 77, 0), null);
  assert.equal(T.effectiveRadius(null, 77, 0), null);
  table.offsets[0].radWear = -0.02;
  assert.ok(Math.abs(T.effectiveRadius(table, 11, 11) - 3.99) < 1e-9);
});
test('defaultOffsets：number[]、{d,tool}[]、Run 三種輸入', () => {
  const tools = [{ t: 11, diameter: 12 }, { t: 3, diameter: 10 }, { t: 21, diameter: 4 }];
  let o = T.defaultOffsets(tools, [11, 21]);
  assert.deepEqual(o, [
    { n: 11, lenGeom: 0, lenWear: 0, radGeom: 6, radWear: 0, source: 'default' },
    { n: 21, lenGeom: 0, lenWear: 0, radGeom: 2, radWear: 0, source: 'default' },
  ]);
  o = T.defaultOffsets(tools, [{ d: 21, tool: 3 }, { d: 11, tool: 11 }, { d: 21, tool: 3 }]);
  assert.deepEqual(o.map((e) => [e.n, e.radGeom]), [[11, 6], [21, 5]]);
  const run = makeRun([{ tool: 3, dList: [21] }, { tool: 11, dList: [11, 13] }]);
  o = T.defaultOffsets(tools, run);
  assert.deepEqual(o.map((e) => [e.n, e.radGeom]), [[11, 6], [13, 6], [21, 5]]);
  assert.deepEqual(T.defaultOffsets(tools, []), []);
  assert.deepEqual(T.defaultOffsets(tools, null), []);
  assert.deepEqual(T.defaultOffsets(tools, [0, -1]), []);
});

// ---------------------------------------------------------------------------
// estimateStock
// ---------------------------------------------------------------------------
test('estimateStock：用 geometry 段 + 刀半徑外擴，Z 取整', () => {
  const tools = [{ t: 1, diameter: 10 }, { t: 7, diameter: 4.5 }];
  const geometry = { segments: [
    { id: 1, line: 5, opIndex: 0, tool: 1, kind: 'rapid', from: P(-70, -8, 25), to: P(-70, -8, 3), feed: null, path: 'programmed' },
    { id: 2, line: 6, opIndex: 0, tool: 1, kind: 'feed', from: P(-70, -8, 3), to: P(-70, -8, -10), feed: 150, path: 'programmed' },
    { id: 3, line: 7, opIndex: 0, tool: 1, kind: 'feed', from: P(-70, -8, -10), to: P(-60, -8, -10), feed: 150, path: 'programmed' },
    { id: 4, line: 8, opIndex: 0, tool: 1, kind: 'feed', from: P(-60, -8, -10), to: P(-60, 40, -10), feed: 150, path: 'programmed' },
    { id: 5, line: 9, opIndex: 0, tool: 1, kind: 'feed', from: P(-60, 40, -10), to: P(60, 40, -10), feed: 150, path: 'programmed' },
    { id: 6, line: 10, opIndex: 0, tool: 1, kind: 'feed', from: P(60, 40, -10), to: P(60, 40, 25), feed: 150, path: 'programmed' }, // 純上提不算
    { id: 7, line: 12, opIndex: 1, tool: 7, kind: 'drill', from: P(45, 48.4, 2), to: P(45, 48.4, -7), feed: 50, path: 'programmed' },
    { id: 8, line: 20, opIndex: 1, tool: 7, kind: 'rapid', from: P(0, 0, 25), to: P(0, 0, 150), feed: null, path: 'programmed', refReturn: true },
  ], diagnostics: [], bounds: { min: P(-70, -8, -10), max: P(60, 48.4, 25) } };
  const s = T.estimateStock(makeRun([]), geometry, tools);
  assert.equal(s.source, 'estimated');
  assert.deepEqual(s.fixtures, []);
  assert.deepEqual(s.min, { x: -75, y: -13, z: -15 });
  assert.deepEqual(s.max, { x: 65, y: 51, z: 0 });
});
test('estimateStock：沒有 geometry 時退回用 Run 動作；沒有任何切削 → 預設方塊', () => {
  const tools = [{ t: 1, diameter: 10 }];
  const run = makeRun([{ tool: 1, blocks: [
    { actions: [lin(P(-60, 0, 2), P(-60, 0, -3.3))] },
    { actions: [lin(P(-60, 0, -3.3), P(60, 0, -3.3))] },
    { actions: [{ kind: 'arc', from: P(60, 0, -3.3), to: P(60, 20, -3.3), center: { x: 60, y: 10 }, r: 10, cw: false, feed: 100 }] },
  ] }]);
  const s = T.estimateStock(run, null, { tools });
  assert.deepEqual(s.min, { x: -65, y: -5, z: -9 });   // 弧：圓心 (60,10) 半徑 10 + 刀半徑 5 → Y -5..25
  assert.deepEqual(s.max, { x: 75, y: 25, z: 0 });
  const empty = T.estimateStock(makeRun([{ tool: 1 }]), { segments: [] }, tools);
  assert.deepEqual(empty.min, { x: -50, y: -50, z: -20 });
  assert.deepEqual(empty.max, { x: 50, y: 50, z: 0 });
  assert.deepEqual(T.estimateStock(null, null, null).source, 'estimated');
});
test('estimateStock：Z max 至少 0，最高切削 Z 為正時取該值', () => {
  const geometry = { segments: [{ id: 1, tool: 1, kind: 'feed', from: P(0, 0, 5), to: P(10, 0, 5), path: 'programmed' }] };
  const s = T.estimateStock(null, geometry, [{ t: 1, diameter: 10 }]);
  assert.equal(s.max.z, 5); assert.equal(s.min.z, 0);
  const g2 = { segments: [{ id: 1, tool: 1, kind: 'feed', from: P(0, 0, -1), to: P(10, 0, -1), path: 'programmed' }] };
  assert.equal(T.estimateStock(null, g2, []).max.z, 0);
});

// ---------------------------------------------------------------------------
// mergeUserTable
// ---------------------------------------------------------------------------
test('mergeUserTable：只有 source=user 的欄位覆蓋推測；user 補正覆蓋同號', () => {
  const inferred = T.inferTools(null, sampleRun());
  const saved = {
    programKey: 'O1001',
    tools: [
      { t: 11, label: '12MM', type: 'endmill', diameter: 8, angle: null, fluteLen: 20, stickout: 35, pitch: null, resident: false, probe: false,
        source: { type: 'comment', diameter: 'user', fluteLen: 'user', stickout: 'user', angle: 'default' } },
      { t: 20, diameter: 80, resident: false, source: { diameter: 'comment', resident: 'user' } },
      { t: 99, diameter: 3, source: { diameter: 'user' } }, // 程式裡沒有的刀：忽略
    ],
    offsets: [
      { n: 11, lenGeom: 0, lenWear: 0, radGeom: 4.01, radWear: 0, source: 'user' },
      { n: 21, lenGeom: 0, lenWear: 0, radGeom: 9, radWear: 0, source: 'default' },
    ],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const table = T.mergeUserTable({ programKey: 'O1001', tools: inferred, offsets: T.defaultOffsets(inferred, [{ d: 11, tool: 11 }, { d: 21, tool: 3 }]) }, saved);
  assert.equal(table.programKey, 'O1001');
  assert.ok(typeof table.updatedAt === 'string' && !Number.isNaN(Date.parse(table.updatedAt)));
  const by = Object.fromEntries(table.tools.map((t) => [t.t, t]));
  assert.equal(by[11].diameter, 8); assert.equal(by[11].source.diameter, 'user');
  assert.equal(by[11].fluteLen, 20); assert.equal(by[11].stickout, 35);
  assert.equal(by[11].type, 'endmill'); assert.equal(by[11].source.type, 'comment');
  assert.equal(by[20].diameter, 100, '非 user 來源不覆蓋'); assert.equal(by[20].resident, false, 'resident 可由 user 覆蓋');
  assert.equal(by[99], undefined);
  // D21 屬 T3(10V) 倒角刀：補正量取決於切削深度，預設留 0 表示「需輸入」，不可用公稱直徑/2（整合決議）
  assert.deepEqual(table.offsets.map((o) => [o.n, o.radGeom, o.source]), [[11, 4.01, 'user'], [21, 0, 'default']]);
  // 推測值不被改動（純函式）
  assert.equal(inferred.find((t) => t.t === 11).diameter, 12);
  // saved 為 null → 等同推測
  const plain = T.mergeUserTable(inferred, null);
  assert.equal(plain.tools.length, inferred.length); assert.deepEqual(plain.offsets, []);
});
test('buildTable：一次做完推測 + 預設補正 + 合併', goldenSkip, () => {
  const { tok, run } = pipeline(FIX_C);
  const table = T.buildTable(tok, run, null);
  assert.equal(table.programKey, 'O' + String(tok.programNumber).padStart(4, '0'));
  assert.deepEqual(table.tools.map((t) => t.t), [3, 7, 1, 2, 15]);
  assert.deepEqual(table.offsets.map((o) => [o.n, o.radGeom]), [[1, 5], [2, 5]]);
});

// ---------------------------------------------------------------------------
// save / load / exportJSON / importJSON
// ---------------------------------------------------------------------------
test('save/load：Node 沒有 localStorage 時安全回傳 false/null', () => {
  T.setStorage(null);
  assert.equal(typeof globalThis.localStorage, 'undefined');
  assert.equal(T.save('O1001', { programKey: 'O1001', tools: [], offsets: [] }), false);
  assert.equal(T.load('O1001'), null);
  assert.deepEqual(T.listSaved(), []);
});
test('save/load：注入儲存體時可存讀；壞掉的儲存體不會丟例外', () => {
  const mem = new Map();
  T.setStorage({ getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k), keys: () => mem.keys() });
  const table = T.mergeUserTable(T.inferTools(null, sampleRun()), null);
  table.programKey = 'O1001';
  assert.equal(T.save('O1001', table), true);
  assert.ok(mem.has(T.STORAGE_PREFIX + 'O1001'));
  const back = T.load('O1001');
  assert.equal(back.programKey, 'O1001');
  assert.deepEqual(back.tools.map((t) => t.t), table.tools.map((t) => t.t));
  assert.equal(back.tools.find((t) => t.t === 15).probe, true);
  assert.deepEqual(T.listSaved(), ['O1001']);
  assert.equal(T.load('nope'), null);
  assert.equal(T.remove('O1001'), true);
  assert.equal(T.load('O1001'), null);
  T.setStorage({ getItem: () => { throw new Error('boom'); }, setItem: () => { throw new Error('boom'); }, removeItem: () => { throw new Error('boom'); } });
  assert.equal(T.save('x', table), false);
  assert.equal(T.load('x'), null);
  assert.equal(T.remove('x'), false);
  T.setStorage(null);
});
test('exportJSON/importJSON：往返一致；壞 JSON 丟出繁中錯誤', () => {
  const table = T.mergeUserTable(T.inferTools(null, sampleRun()), null);
  table.programKey = 'O1001';
  table.offsets = [{ n: 11, lenGeom: 0, lenWear: 0, radGeom: 4.01, radWear: 0, source: 'user' }];
  const str = T.exportJSON(table);
  assert.ok(str.startsWith('{'));
  const back = T.importJSON('﻿' + str);
  assert.equal(back.programKey, 'O1001');
  assert.deepEqual(back.tools, table.tools);
  assert.deepEqual(back.offsets, table.offsets);
  assert.throws(() => T.importJSON('{not json'), /匯入失敗/);
  assert.throws(() => T.importJSON('{"foo":1}'), /tools/);
  // 純陣列也接受；數字字串會被轉型、型式別名會正規化
  const arr = T.importJSON('[{"t":"5","type":"平銑刀","diameter":"4"}]');
  assert.equal(arr.tools[0].t, 5); assert.equal(arr.tools[0].type, 'endmill'); assert.equal(arr.tools[0].diameter, 4); assert.equal(arr.tools[0].label, 'T5');
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
test('toCSV：欄位與 CSV_HEADER 相同、含 BOM、CRLF', goldenSkip, () => {
  const { tok, run } = pipeline(FIX_C);
  const table = T.buildTable(tok, run, null, FIX_C);
  const csv = T.toCSV(table, { tok, run });
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  assert.equal(lines[0], T.CSV_HEADER.join(','));
  assert.equal(lines.length, 1 + 5);
  const rows = lines.slice(1).map((l) => l.split(','));
  const t3 = rows.find((r) => r[1] === 'T3');
  assert.equal(t3[0], FIX_C); assert.equal(t3[2], '8V'); assert.equal(t3[3], 'V型倒角刀'); assert.equal(t3[4], '8');
  const t1 = rows.find((r) => r[1] === 'T1');
  assert.equal(t1[5], 'G41'); assert.equal(t1[12], 'D1');
  const t15 = rows.find((r) => r[1] === 'T15');
  assert.equal(t15[2], ''); assert.equal(t15[3], '?'); assert.ok(t15[14].includes('定位器'));
  if (hasPipeline) { assert.equal(t1[6], '-10.0'); assert.equal(t3[6], '-2.1'); }
});
test('toCSV：使用者欄位與補正值會寫進「請填_」欄；含逗號的欄位會加引號', () => {
  const table = {
    programKey: 'O1001',
    tools: [{ t: 12, label: '12MM', type: 'endmill', diameter: 8, angle: null, fluteLen: 20, stickout: null, pitch: null, resident: false, probe: false,
      source: { label: 'comment', type: 'comment', diameter: 'user', fluteLen: 'user' } }],
    offsets: [{ n: 12, lenGeom: 0, lenWear: 0, radGeom: 4.985, radWear: 0, source: 'user' }, { n: 13, lenGeom: 0, lenWear: 0, radGeom: 4, radWear: 0, source: 'default' }],
  };
  const details = [{ t: 12, comment: '12MM', hasComp: true, zMin: -30.2, dList: [12, 13] }];
  const csv = T.toCSV(table, { details, notes: { 12: '備註,含逗號' } });
  const row = csv.replace(/^﻿/, '').split('\r\n')[1];
  assert.ok(row.includes('"D12,D13"'));
  assert.ok(row.includes('D12=4.985'));
  assert.ok(row.includes('"備註,含逗號"'));
  const parsed = T.fromCSV(csv);
  assert.equal(parsed.programKey, 'O1001');
  assert.equal(parsed.tools[0].diameter, 8); assert.equal(parsed.tools[0].source.diameter, 'user');
  assert.equal(parsed.tools[0].fluteLen, 20); assert.equal(parsed.tools[0].source.fluteLen, 'user');
  assert.deepEqual(parsed.offsets.map((o) => [o.n, o.radGeom, o.source]), [[12, 4.985, 'user'], [13, 4, 'default']]);
});
test('fromCSV：多程式的 CSV（BOM、引號、同 T 出現在不同程式、填不出數字的格子）', () => {
  const csv = '﻿' + [
    T.CSV_HEADER.join(','),
    'O1001,T2,10MM,平銑刀,10,G41,-12.0,,8?,,,,D2,D2=4.9850/0,"備註,含逗號"',
    'O1001,T3,10V,V型倒角刀,10,G41,-1.0,,,,,,D3,,',
    'O1002,T2,10MM,平銑刀,10,G41,-7.5,,,,,,D2,D2=5.0/0,',
    'O1002,T4,6MM,平銑刀,6,面銑/一般切削,-3.0,,,,,,,,',
  ].join('\r\n');

  // 不指定程式：同一個 T 只留第一次出現的那一列
  const all = T.fromCSV(csv);
  assert.equal(all.programKey, 'O1001');
  assert.deepEqual(all.tools.map((t) => t.t), [2, 3, 4]);

  // 指定程式：只吃那支程式的列
  const p1 = T.fromCSV(csv, 'O1001');
  assert.equal(p1.programKey, 'O1001');
  assert.deepEqual(p1.tools.map((t) => t.t), [2, 3]);
  const by = Object.fromEntries(p1.tools.map((t) => [t.t, t]));
  assert.equal(by[2].diameter, 10, '「8?」不是數字，不能當成使用者輸入');
  assert.equal(by[2].source.diameter, 'comment');
  assert.equal(by[3].type, 'chamfer');
  const d2 = p1.offsets.find((o) => o.n === 2);
  assert.equal(d2.radGeom, 4.985); assert.equal(d2.source, 'user');

  const p2 = T.fromCSV(csv, 'O1002');
  assert.deepEqual(p2.tools.map((t) => t.t), [2, 4]);
  assert.equal(p2.offsets.find((o) => o.n === 2).radGeom, 5);
});
test('fromCSV：使用者填的型式／直徑／角度／刃長／伸出長 → source=user；空字串 → 空表', () => {
  const csv = T.CSV_HEADER.join(',') + '\n' +
    'P1,T5,4MM,平銑刀,4,G41,-35.1,鑽頭,4.2,120,15,40,D5,D5=2.1/0.05,\n' +
    'P1,T6,,?, ,面銑/一般切削,,,,,,,,,';
  const t = T.fromCSV(csv, 'P1');
  assert.equal(t.tools.length, 2);
  const t5 = t.tools[0];
  assert.equal(t5.type, 'drill'); assert.equal(t5.source.type, 'user');
  assert.equal(t5.diameter, 4.2); assert.equal(t5.source.diameter, 'user');
  assert.equal(t5.angle, 120); assert.equal(t5.source.angle, 'user');
  assert.equal(t5.fluteLen, 15); assert.equal(t5.stickout, 40);
  assert.deepEqual(t.offsets, [{ n: 5, lenGeom: 0, lenWear: 0, radGeom: 2.1, radWear: 0.05, source: 'user' }]);
  assert.equal(t.tools[1].probe, true); assert.equal(t.tools[1].label, 'T6');
  assert.deepEqual(T.fromCSV('').tools, []);
  assert.deepEqual(T.fromCSV('﻿').tools, []);
});


test('estimateStock：固定循環的孔內上下移動不可以墊高素材頂面', () => {
  const NCg = NC;
  const runs = [];
  const geo = {
    segments: [
      // 面銑：真正的切削，頂面 0.05
      { kind: 'feed', tool: 1, sub: undefined, from: { x: -50, y: 0, z: 0.05 }, to: { x: 50, y: 0, z: 0.05 } },
      // 鑽孔展開出來的退刀段：刀具在自己鑽出的孔內上下移動，不是切削
      { kind: 'drill', tool: 2, sub: 'retract', from: { x: 0, y: 0, z: -10 }, to: { x: 0, y: 0, z: 3 } },
      { kind: 'drill', tool: 2, sub: 'plunge', from: { x: 0, y: 0, z: 3 }, to: { x: 0, y: 0, z: -10 } },
    ],
  };
  const st = NCg.tools.estimateStock(runs, [geo], [{ t: 1, diameter: 50 }, { t: 2, diameter: 10 }]);
  assert.equal(st.max.z, 0.05, '頂面應該由面銑那一刀決定，不是 tapUp/retract 的 Z3');
});
