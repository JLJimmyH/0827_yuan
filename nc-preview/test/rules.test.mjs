/*
 * test/rules.test.mjs — NC.rules（CONTRACT §6）
 *
 * 除了規則本身的行為，這支測試特別盯兩件事：
 *   1. 四支真實程式（test/fixtures）跑出來的 severity='error' 必須「每一筆都說得出為什麼」，
 *      在下面的「不誤報」段落裡逐筆列出理由。
 *   2. 沒有素材模擬資料時，任何需要知道「當下材料長什麼樣」的判斷都不准升到 error，
 *      只能是 warning 或 needsInput。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNC, fixture, FIXTURES, goldenSkip, FIX_A, FIX_B, FIX_C, FIX_D } from './load.mjs';

const NC = loadNC();

// ---------------------------------------------------------------------------
// 共用：把一段程式跑成 rules.run 需要的 ctx
// ---------------------------------------------------------------------------
function analyze(text, opts = {}) {
  const settings = Object.assign(NC.util.defaultSettings(), opts.settings || {});
  const tok = NC.tokenize(text);
  const off = NC.interpret(tok.blocks, settings, 'off');
  const on = NC.interpret(tok.blocks, settings, 'on');
  const toolTable = opts.toolTable || NC.tools.buildTable(tok, off, null);
  const gOff = NC.buildSegments(off, toolTable, settings);
  const gOn = NC.buildSegments(on, toolTable, settings);
  const stock = opts.stock || NC.tools.estimateStock(off, gOff, toolTable);
  return {
    tok,
    scenarios: {
      off: { run: off, geometry: gOff, sim: null },
      on: { run: on, geometry: gOn, sim: null },
    },
    toolTable, stock, settings,
  };
}

async function addSim(ctx, cell = 0.5) {
  for (const key of ['off', 'on']) {
    const sc = ctx.scenarios[key];
    const sim = NC.sim.create(ctx.stock, cell);
    sc.sim = await NC.sim.run(sim, sc, ctx.toolTable, ctx.settings, { yieldEveryMs: Infinity });
  }
  return ctx;
}

const plainCache = new Map();
function plain(name) {
  if (!plainCache.has(name)) plainCache.set(name, analyze(fixture(name)));
  return plainCache.get(name);
}
const simCache = new Map();
function simmed(name) {
  if (!simCache.has(name)) simCache.set(name, addSim(analyze(fixture(name)), 0.5));
  return simCache.get(name);
}

const diagCache = new WeakMap();
function diags(ctx) {
  let d = diagCache.get(ctx);
  if (!d) { d = NC.rules.run(ctx); diagCache.set(ctx, d); }
  return d;
}
const only = (ctx, ruleId) => diags(ctx).filter((d) => d.ruleId === ruleId);
const lines = (list) => list.map((d) => d.line).sort((a, b) => a - b);
const sevOf = (list, line) => (list.find((d) => d.line === line) || {}).severity;

// ---------------------------------------------------------------------------
// 0. 模組形狀
// ---------------------------------------------------------------------------
test('NC.rules 的形狀符合契約', () => {
  assert.ok(NC.rules, 'NC.rules 應該存在');
  assert.ok(Array.isArray(NC.rules.registry));
  assert.equal(typeof NC.rules.run, 'function');
  const ids = NC.rules.registry.map((r) => r.id);
  for (const want of ['R05', 'R06', 'R07', 'R14', 'R15', 'R19', 'R20', 'R24', 'R25', 'R26', 'R29', 'R30', 'R31', 'R33', 'R34', 'R35', 'R36']) {
    assert.ok(ids.includes(want), `registry 應該有 ${want}`);
  }
  assert.equal(new Set(ids).size, ids.length, 'rule id 不可重複');
  for (const r of NC.rules.registry) {
    assert.equal(typeof r.title, 'string');
    assert.ok(r.title.length > 0);
    assert.ok(['error', 'warning', 'info', 'needsInput'].includes(r.severity), `${r.id} severity`);
    assert.ok(['run', 'geometry', 'sim', 'cross'].includes(r.phase), `${r.id} phase`);
    assert.equal(typeof r.check, 'function');
  }
});

test('run() 對缺東缺西的 ctx 不會爆炸', goldenSkip, () => {
  assert.deepEqual(NC.rules.run(null), []);
  assert.deepEqual(NC.rules.run({}), []);
  assert.deepEqual(NC.rules.run({ scenarios: {} }), []);
  // 只有 off、沒有 toolTable／stock 也要能跑完
  const ctx = analyze(fixture(FIX_C));
  delete ctx.scenarios.on;
  delete ctx.toolTable;
  delete ctx.stock;
  const out = NC.rules.run(ctx);
  assert.ok(Array.isArray(out));
  assert.equal(out.filter((d) => d.ruleId === 'R06').length, 0, '沒有 on 情境時 R06 不該產生東西');
});

test('每一筆診斷都有必要欄位', goldenSkip, () => {
  const list = FIXTURES.reduce((acc, name) => acc.concat(diags(plain(name))), []);
  assert.ok(list.length > 0);
  for (const d of list) {
    assert.equal(typeof d.id, 'string');
    assert.ok(/^R\d\d$/.test(d.ruleId), `ruleId 格式：${d.ruleId}`);
    assert.equal(typeof d.line, 'number');
    assert.ok(d.line >= 0);
    assert.ok(['error', 'warning', 'info', 'needsInput'].includes(d.severity));
    assert.equal(typeof d.message, 'string');
    assert.ok(d.message.length > 0);
    assert.equal(typeof d.detail, 'string', `${d.ruleId} L${d.line} 應該要有 detail`);
    assert.ok(d.detail.length > 10);
    assert.ok(!/undefined|NaN|\[object/.test(d.message + d.detail), `訊息裡不該出現 undefined/NaN：${d.ruleId} L${d.line} ${d.message}`);
  }
});

test('settings.disabledRules 會過濾掉規則', goldenSkip, () => {
  const ctx = analyze(fixture(FIX_A), { settings: { disabledRules: ['R05', 'R06'] } });
  const out = NC.rules.run(ctx);
  assert.equal(out.filter((d) => d.ruleId === 'R05').length, 0);
  assert.equal(out.filter((d) => d.ruleId === 'R06').length, 0);
  assert.ok(out.length > 0, '其他規則還是要照跑');
});

test('opts.phases 可以只跑某些階段', goldenSkip, () => {
  const ctx = plain(FIX_A);
  const pre = NC.rules.run(ctx, { phases: NC.rules.PRE_SIM_PHASES });
  const post = NC.rules.run(ctx, { phases: NC.rules.SIM_PHASES });
  assert.ok(pre.some((d) => d.ruleId === 'R05'));
  assert.ok(!pre.some((d) => d.ruleId === 'R06'), 'R06 是 cross 階段');
  assert.ok(post.some((d) => d.ruleId === 'R06'));
  assert.ok(!post.some((d) => d.ruleId === 'R05'));
});

// ---------------------------------------------------------------------------
// R05 多斜線
// ---------------------------------------------------------------------------
test('R05：四支真實程式的命中行（契約驗收）', goldenSkip, () => {
  assert.deepEqual(lines(only(plain(FIX_A), 'R05')), [810, 1011, 1059, 1131, 1147, 1358, 1490]);
  assert.deepEqual(lines(only(plain(FIX_B), 'R05')), [254, 349, 375, 401]);
  assert.deepEqual(lines(only(plain(FIX_C), 'R05')), []);
  assert.deepEqual(lines(only(plain(FIX_D), 'R05')), [113, 437]);
});

test('R05：預設是 warning，訊息說得出斜線有幾個', goldenSkip, () => {
  const d = only(plain(FIX_A), 'R05').find((x) => x.line === 810);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /3 個斜線/);
  assert.match(d.detail, /只認節首的一個/);
});

test('R05：multiSlash=alarm 時升成 error 並帶 Fanuc 警報號', goldenSkip, () => {
  const ctx = analyze(fixture(FIX_D), { settings: { multiSlash: 'alarm' } });
  const list = only(ctx, 'R05');
  assert.deepEqual(lines(list), [113, 437]);
  assert.ok(list.every((d) => d.severity === 'error'));
  assert.equal(list[0].fanucAlarm, 'PS0010');
});

test('R05：一鍵改成單斜線的 fix，套用後原本的內容不變', goldenSkip, () => {
  const ctx = plain(FIX_A);
  const d = only(ctx, 'R05').find((x) => x.line === 1147);
  assert.ok(d.fix, '應該要有 fix');
  assert.equal(d.fix.edits.length, 1);
  assert.equal(d.fix.edits[0].line, 1147);
  const raw = ctx.tok.blocks[1146].raw;
  assert.equal(raw.trimEnd(), '////G0Z5.');
  assert.equal(d.fix.edits[0].text.trimEnd(), '/G0Z5.');
  // 把 fix 套回程式，R05 就沒了，而且該節還是同一個跳過節
  const text = fixture(FIX_A).split(/\r?\n/);
  for (const e of d.fix.edits) text[e.line - 1] = e.text;
  const after = analyze(text.join('\n'));
  assert.equal(only(after, 'R05').filter((x) => x.line === 1147).length, 0);
  assert.equal(after.tok.blocks[1146].slashes, 1);
  assert.equal(after.tok.blocks[1146].text, 'G0Z5.');
});

// ---------------------------------------------------------------------------
// R06 情境差異（最重要的一條）
// ---------------------------------------------------------------------------
test('R06：增量下刀節被跳過 → 深度變淺 → 至少 warning', goldenSkip, () => {
  const list = only(plain(FIX_D), 'R06');
  const d = list.find((x) => x.line === 325);
  assert.ok(d, 'L325 要有 R06');
  assert.ok(d.severity === 'warning' || d.severity === 'error');
  assert.equal(d.scenario, 'on');
  // 跳過後下一個動作（L326）會在 Z-5 而不是 Z-7.5
  assert.match(d.message, /第 326 行/);
  assert.match(d.message, /Z-5/);
  assert.match(d.detail, /若這行被跳過：刀具會從 \(35, -21\.75, -5\) 以 G1 F50 移到 \(-35, -21\.75, -5\)/);
  assert.match(d.detail, /開關關閉/);
  assert.match(d.detail, /-21\.75, -7\.5\) 以 G1 F50 移到/);
  // 同一段還有 3 行一模一樣的跳過節（353/381/409），累計會少切 10 mm
  assert.match(d.detail, /第 353 行、第 381 行、第 409 行/);
});

test('R06：多斜線的抬刀節被跳過 → 在實心材料裡 G1 斜切', goldenSkip, async () => {
  // 沒有素材模擬時只敢說 warning（不知道材料還在不在）
  const noSim = only(plain(FIX_A), 'R06').find((x) => x.line === 1147);
  assert.ok(noSim);
  assert.equal(noSim.severity, 'warning');
  assert.match(noSim.detail, /沒有素材模擬資料/);

  // 有素材模擬時升成 error：用「開關關」情境做完同一個作業之後的高度圖，
  // 那是當下材料的下界，還比刀尖高 → 一定會撞
  const ctx = await simmed(FIX_A);
  const d = only(ctx, 'R06').find((x) => x.line === 1147);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /切進實心材料/);
  assert.match(d.detail, /若這行被跳過：刀具會從 \(34, -21\.75, -36\) 以 G1 F120 移到 \(-27, -49, -36\)/);
  assert.match(d.detail, /材料最高到 Z-30/);
  assert.match(d.detail, /比刀尖高 6 mm/);
  // 推估素材時要把判定依據講清楚（整合者的 softenEstimatedStock 也是同一個立場）
  assert.equal(ctx.stock.source, 'estimated');
  assert.match(d.detail, /此判定依據推估素材/);
  assert.ok(d.pos && Math.abs(d.pos.z + 36) < 1e-6);
});

test('R06：跳過之後動作完全一樣的節不報', goldenSkip, () => {
  // 那幾節被跳過時刀具本來就已經停在同一點，跳不跳過結果一樣 → 不該有 R06
  const list = only(plain(FIX_B), 'R06');
  for (const l of [349, 375, 401]) {
    assert.equal(list.filter((d) => d.line === l).length, 0, `L${l} 不該有 R06`);
  }
  // 但 L254（跳過後換到完全不同的 XY 下刀）與 L443（跳過後從對面切過去）要報
  assert.ok(list.some((d) => d.line === 254));
  assert.ok(list.some((d) => d.line === 443));
});

test('R06：抬刀節被跳過時，訊息要講「快速定位變成進給切削」', goldenSkip, () => {
  const d = only(plain(FIX_A), 'R06').find((x) => x.line === 1023);
  assert.ok(d);
  assert.match(d.message, /快速定位會變成 G1 F150/);
  assert.match(d.message, /Z-7\.5/);
});

test('R06：作業層級會比較兩種情境的最深 Z', goldenSkip, () => {
  const list = only(plain(FIX_A), 'R06');
  // op#3（T11，L245–707）在開關打開時 11 層 /Z-… 全被跳過，只切到 Z-2.5
  const d = list.find((x) => x.line === 245);
  assert.ok(d, 'op 起點 L245 應該要有一筆作業層級的 R06');
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /最深只切到 Z-2\.5/);
  assert.match(d.message, /關閉時是 Z-30/);
});

test('R06：兩邊都有模擬時會回報成品差異格數', goldenSkip, async () => {
  const ctx = await simmed(FIX_B);
  const d = only(ctx, 'R06').find((x) => x.line === 0);
  assert.ok(d, '應該要有一筆程式層級的成品差異 info');
  assert.equal(d.severity, 'info');
  assert.match(d.message, /高度不同/);
  assert.match(d.message, /最大差 39\.5 mm/);
});

test('R06：所有診斷的 scenario 都標成 on（line 0 的總結除外）', goldenSkip, () => {
  for (const name of FIXTURES) {
    for (const d of only(plain(name), 'R06')) {
      if (d.line === 0) continue;
      assert.equal(d.scenario, 'on', `${name} R06 L${d.line}`);
    }
  }
});

test('R06：完全沒有跳過節的程式不會產生任何 R06', goldenSkip, () => {
  assert.deepEqual(only(plain(FIX_C), 'R06'), []);
});

// ---------------------------------------------------------------------------
// R07 被跳過節含模態字
// ---------------------------------------------------------------------------
test('R07：樣本 D L437 的 F50 被跳過 → 後面沿用 F150', goldenSkip, () => {
  const list = only(plain(FIX_D), 'R07');
  assert.deepEqual(lines(list), [437]);
  const d = list[0];
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /F 進給/);
  assert.match(d.detail, /150 → 50/);
  assert.match(d.detail, /跳過後會維持 150/);
});

test('R07：四支程式裡只有這一筆（G0/G1 的模態遺失交給 R06 講）', goldenSkip, () => {
  const total = FIXTURES.reduce((n, f) => n + only(plain(f), 'R07').length, 0);
  assert.equal(total, 1);
  // 分層程式常有一整排 /G0Z5. 會讓 motion 從 G1 變 G0，但那些由 R06 直接描述後果
  assert.deepEqual(only(plain(FIX_A), 'R07'), []);
});

test('R07：跳過節裡藏 G91 / D 號 → error', () => {
  const src = [
    '%', 'O9007', 'G40G49G80', 'M6T1(10MM)',
    'G0G90G54X0.Y0.G43H1Z10.M3S1000',
    'G1Z-1.F100M8',
    '/G91G1X10.',      // 跳過的話 G90/G91 就沒切換
    'X10.',
    'G90G0Z50.M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const list = only(analyze(src), 'R07');
  assert.equal(list.length, 1);
  assert.equal(list[0].line, 7);
  assert.equal(list[0].severity, 'error');
  assert.match(list[0].message, /G90\/G91/);
});

// ---------------------------------------------------------------------------
// R14 D／H 與刀號
// ---------------------------------------------------------------------------
test('R14：樣本 B 的 D30／D31 產生 info（契約驗收）', goldenSkip, () => {
  const list = only(plain(FIX_B), 'R14');
  assert.equal(list.length, 2);
  assert.ok(list.every((d) => d.severity === 'info'));
  const d30 = list.find((d) => /D30/.test(d.message));
  const d31 = list.find((d) => /D31/.test(d.message));
  assert.ok(d30 && d31);
  assert.equal(d30.line, 342, 'D30 第一次出現在 L342');
  assert.match(d30.message, /主軸上是 T11/);
  assert.equal(d31.line, 436);
  assert.match(d31.message, /主軸上是 T12/);
});

test('R14：其他程式的 D≠T 也只給 info，同一組 D/T 只報一次', goldenSkip, () => {
  const a = only(plain(FIX_A), 'R14');
  assert.deepEqual(lines(a), [1451, 1509, 1583]); // D13/T12、D21/T3、D14/T4
  assert.ok(a.every((d) => d.severity === 'info'));
  const b = only(plain(FIX_D), 'R14');
  assert.deepEqual(lines(b), [299, 502]);        // D16/T11、D21/T3
  assert.deepEqual(only(plain(FIX_C), 'R14'), []); // D1/T1、D2/T2 全對得上
});

test('R14：D0 與 H0 是 warning', () => {
  const src = [
    '%', 'O9014', 'G40G49G80', 'M6T1(10MM)',
    'G0G90G54X0.Y0.G43H0Z10.M3S1000',
    'G1Z-1.F100M8',
    'G1G41D0X10.',
    'Y10.',
    'G1G40X0.',
    'G0Z50.M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const list = only(analyze(src), 'R14');
  assert.equal(list.length, 2);
  assert.ok(list.every((d) => d.severity === 'warning'));
  assert.ok(list.some((d) => d.line === 5 && /H0/.test(d.message)));
  assert.ok(list.some((d) => d.line === 7 && /D0/.test(d.message)));
});

// ---------------------------------------------------------------------------
// R15 D 值與刀徑不符
// ---------------------------------------------------------------------------
const R15_SRC = [
  '%', 'O9015', 'G40G49G80',
  'M6T1(10MM)',
  'G0G90G54X-20.Y0.G43H1Z10.M3S1000',
  'G1Z-1.F100M8',
  'G1G41D1X-10.',
  'Y10.',
  'G1G40X-20.',
  'G0Z50.M9', 'M5', 'G91G28Z0.',
  'M6T2(10V)',
  'G0G90G54X-20.Y0.G43H2Z10.M3S1000',
  'G1Z-1.F100M8',
  'G1G41D2X-10.',
  'Y10.',
  'G1G40X-20.',
  'G0Z50.M9', 'M5', 'G91G28Z0.', 'M30', '%',
].join('\n');

function withOffsets(src, offsets) {
  const settings = NC.util.defaultSettings();
  const tok = NC.tokenize(src);
  const off = NC.interpret(tok.blocks, settings, 'off');
  const table = NC.tools.buildTable(tok, off, null);
  table.offsets = offsets.map((o) => Object.assign({ n: 0, lenGeom: 0, lenWear: 0, radGeom: 0, radWear: 0, source: 'user' }, o));
  return analyze(src, { toolTable: table });
}

test('R15：D 值和刀半徑差太多 → warning；倒角刀例外', () => {
  const ctx = withOffsets(R15_SRC, [{ n: 1, radGeom: 8 }, { n: 2, radGeom: 8 }]);
  const list = only(ctx, 'R15');
  assert.equal(list.length, 1, '只有 T1（Ø10 平銑刀）該被報，T2 是 10V 倒角刀要跳過');
  assert.equal(list[0].severity, 'warning');
  assert.match(list[0].message, /D1/);
  assert.match(list[0].message, /8/);
  assert.match(list[0].message, /5/);
});

test('R15：差在容許值內就不報；容許值可以調', () => {
  assert.deepEqual(only(withOffsets(R15_SRC, [{ n: 1, radGeom: 5.3 }]), 'R15'), []);
  const ctx = analyze(R15_SRC, {
    settings: { dToleranceMm: 0.1 },
    toolTable: (() => {
      const t = withOffsets(R15_SRC, [{ n: 1, radGeom: 5.3 }]).toolTable;
      return t;
    })(),
  });
  assert.equal(only(ctx, 'R15').length, 1);
});

test('R15：沒有輸入 D 值時不報（那是 geometry 的 R10 needsInput 在管）', goldenSkip, () => {
  for (const name of FIXTURES) assert.deepEqual(only(plain(name), 'R15'), [], name);
});

// ---------------------------------------------------------------------------
// R19 固定循環
// ---------------------------------------------------------------------------
test('R19：逐孔統計（每個循環群組一筆 info）', goldenSkip, () => {
  const a = only(plain(FIX_C), 'R19');
  assert.deepEqual(lines(a), [6, 14, 22]);
  assert.ok(a.every((d) => d.severity === 'info'));
  assert.match(a[0].message, /G81 固定循環從第 6 行到第 9 行，一共鑽 4 個孔/);
  assert.match(a[0].detail, /孔位：\(-45, 48\.4\)/);
  assert.match(a[0].detail, /孔底 Z：-1\.2/);
  assert.match(a[0].detail, /R 點 Z：2/);

  // G81 模態一路延續、中途換過 R/Z 的情形：那些孔全部會鑽
  const b = only(plain(FIX_A), 'R19').find((d) => d.line === 969);
  assert.match(b.message, /一共鑽 6 個孔/);
  assert.match(b.detail, /孔底 Z：-31 \/ -1/);
});

test('R19：同一個循環裡孔位重複 → warning', () => {
  const src = [
    '%', 'O9019', 'G40G49G80', 'M6T1(SG-6.)',
    'G0G90G54X0.Y0.G43H1Z10.M3S1000',
    'G98R2.G81Z-5.F50M8',
    'X10.',
    'X10.',
    'G80M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const list = only(analyze(src), 'R19');
  const dup = list.filter((d) => d.severity === 'warning' && /重複/.test(d.message));
  assert.equal(dup.length, 1);
  assert.equal(dup[0].line, 8);
  assert.match(dup[0].message, /第 7 行/);
});

test('R19：換刀前沒有 G80 → warning', () => {
  const src = [
    '%', 'O9019', 'G40G49G80', 'M6T1(SG-6.)',
    'G0G90G54X0.Y0.G43H1Z10.M3S1000',
    'G98R2.G81Z-5.F50M8',
    'X10.',
    'M9',
    'M6T2(SG-8.)',
    'G0G90G54X0.Y0.G43H2Z10.M3S1000',
    'G0Z50.M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const d = only(analyze(src), 'R19').find((x) => /沒有先用 G80/.test(x.message));
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.equal(d.line, 9);
});

test('R19：四支真實程式都有好好用 G80，不該報漏 G80', goldenSkip, () => {
  for (const name of FIXTURES) {
    const bad = only(plain(name), 'R19').filter((d) => d.severity !== 'info');
    assert.deepEqual(bad, [], `${name} 不該有非 info 的 R19`);
  }
});

// ---------------------------------------------------------------------------
// R20 R 點在材料裡
// ---------------------------------------------------------------------------
test('R20：沒有模擬時只給 needsInput，而且同一個作業的同一個 R 只問一次', goldenSkip, () => {
  const list = only(plain(FIX_A), 'R20');
  assert.deepEqual(lines(list), [969, 981, 1197, 1209]);
  assert.ok(list.every((d) => d.severity === 'needsInput'));
  assert.match(list[0].message, /R 點 Z-28/);
  assert.match(list[0].detail, /先用銑刀挖穴/);
  // R2./R3. 這種正常的安全高度不該被問
  assert.deepEqual(only(plain(FIX_C), 'R20'), []);
  assert.deepEqual(only(plain(FIX_B), 'R20'), []);
});

test('R20：有模擬時，確認前面真的挖開了就不再報', goldenSkip, async () => {
  for (const name of FIXTURES) {
    const ctx = await simmed(name);
    assert.deepEqual(only(ctx, 'R20'), [], `${name}：R-28 的孔位在前面的作業已經被銑到 Z-30，R 點是空的`);
  }
});

test('R20：R 點真的埋在實心材料裡 → warning', async () => {
  const src = [
    '%', 'O9020', 'G40G49G80', 'M6T20(50MM)',
    'G0G90G54X40.Y0.G43H20Z10.M3S800',
    'G1Z0.F150M8',
    'G1X-40.',
    'G0Z50.M9', 'M5', 'G91G28Z0.',
    'M6T1(SG-6.)',
    'G0G90G54X0.Y0.G43H1Z10.M3S1000',
    'G98R-5.G81Z-20.F50M8',   // R 點在頂面下 5 mm，但這裡從來沒被挖過
    'G80M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const stock = { min: { x: -50, y: -50, z: -30 }, max: { x: 50, y: 50, z: 0 }, source: 'user', fixtures: [] };
  const ctx = await addSim(analyze(src, { stock }), 0.5);
  const list = only(ctx, 'R20');
  assert.equal(list.length, 1);
  assert.equal(list[0].severity, 'warning');
  assert.match(list[0].message, /卡在材料裡面/);
  assert.match(list[0].detail, /快速下刀撞進實心材料/);
});

// ---------------------------------------------------------------------------
// R24 G91 區段
// ---------------------------------------------------------------------------
test('R24：G91 區段裡的跳過節 → warning', goldenSkip, () => {
  const list = only(plain(FIX_D), 'R24').filter((d) => d.severity === 'warning');
  assert.deepEqual(lines(list), [325, 353, 381, 409, 437]);
  assert.match(list[0].message, /G91 增量模式裡放了選擇性跳過節/);
  assert.match(list[0].detail, /平移 2\.5 mm/);
});

test('R24：程式結束時還停在 G91 → info（四支都是）', goldenSkip, () => {
  const want = { [FIX_A]: 1592, [FIX_B]: 456, [FIX_C]: 84, [FIX_D]: 561 };
  for (const [name, line] of Object.entries(want)) {
    const d = only(plain(name), 'R24').find((x) => x.severity === 'info');
    assert.ok(d, `${name} 應該要有一筆 M30 還在 G91 的 info`);
    assert.equal(d.line, line);
    assert.match(d.message, /程式結束時還停在 G91/);
  }
});

test('R24：換刀後第一個移動有寫 G90 就不報（四支程式的常見寫法）', goldenSkip, () => {
  for (const name of FIXTURES) {
    const bad = only(plain(name), 'R24').filter((d) => /換刀|暫停/.test(d.message));
    assert.deepEqual(bad, [], `${name}：G91G28Z0. 後面接 G0G90G54… 是安全的`);
  }
});

test('R24：換刀後第一個移動沒寫 G90 → warning', () => {
  const src = [
    '%', 'O9024', 'G40G49G80', 'M6T1(10MM)',
    'G0G90G54X0.Y0.G43H1Z10.M3S1000',
    'G1Z-1.F100M8',
    'G0Z50.M9', 'M5', 'G91G28Z0.',
    'M6T2(10MM)',
    'G0X10.Y10.',            // 還是 G91，而且沒補 G90
    'G43H2Z10.',
    'G0Z50.M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const d = only(analyze(src), 'R24').find((x) => /換刀/.test(x.message));
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.equal(d.line, 10);
});

// ---------------------------------------------------------------------------
// R25 主軸／冷卻
// ---------------------------------------------------------------------------
test('R25：四支真實程式都沒有「主軸沒轉就切」的 error', goldenSkip, () => {
  for (const name of FIXTURES) {
    const bad = only(plain(name), 'R25').filter((d) => d.severity === 'error');
    assert.deepEqual(bad, [], name);
  }
});

test('R25：換刀前主軸還在轉 → 預設 info（M6 會自己停主軸），設定打開後升 warning', goldenSkip, () => {
  const d = only(plain(FIX_C), 'R25')[0];
  assert.equal(d.severity, 'info');
  assert.match(d.message, /次換刀之前主軸還在轉/);
  assert.match(d.detail, /第 12 行/);
  const strict = analyze(fixture(FIX_C), { settings: { requireM5BeforeM6: true } });
  assert.equal(only(strict, 'R25')[0].severity, 'warning');
});

test('R25：M0 依設定會停主軸，所以 M0 → M6 不算沒停', goldenSkip, () => {
  // 樣本 A 大部分換刀前都是 M0，只有 4 次是真的還在轉
  const d = only(plain(FIX_A), 'R25')[0];
  assert.match(d.message, /有 4 次/);
  const noStop = analyze(fixture(FIX_A), { settings: { m0StopsSpindle: false } });
  assert.match(only(noStop, 'R25')[0].message, /有 16 次/);
});

test('R25：主軸沒轉就切削 → error', () => {
  const src = [
    '%', 'O9025', 'G40G49G80', 'M6T1(10MM)',
    'G0G90G54X0.Y0.G43H1Z10.',
    'G1Z-1.F100M8',   // 從頭到這裡都沒有 M3
    'G0Z50.M9', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const list = only(analyze(src), 'R25');
  assert.equal(list.length, 1);
  assert.equal(list[0].severity, 'error');
  assert.equal(list[0].line, 6);
  assert.match(list[0].message, /主軸沒有轉/);
});

test('R25：有 M3 但沒有 S → error', () => {
  const src = [
    '%', 'O9025', 'G40G49G80', 'M6T1(10MM)',
    'G0G90G54X0.Y0.G43H1Z10.M3',
    'G1Z-1.F100M8',
    'G0Z50.M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const list = only(analyze(src), 'R25').filter((d) => d.severity === 'error');
  assert.equal(list.length, 1);
  assert.match(list[0].message, /轉速 S 沒有指定/);
});

// ---------------------------------------------------------------------------
// R26 G05.1
// ---------------------------------------------------------------------------
test('R26：AI 輪廓控制還開著就 G28 → 聚合成一筆 info（手冊允許，只是提醒）', goldenSkip, () => {
  // Fanuc B-63944EN §19.1：AI 輪廓控制模式中 G28 是允許的，不能用的是 G62/G63/G41.1/G42.1/螺紋切削。
  // 四支真實程式一致寫成 G0Z50.M9 → G91G28Z0. → G05.1Q0 → M0 → M6，不能報成 warning。
  const d = only(plain(FIX_C), 'R26').find((x) => /G28/.test(x.message));
  assert.ok(d);
  assert.equal(d.severity, 'info');
  assert.equal(d.line, 63);
  assert.match(d.message, /共 2 處/);
  assert.match(d.detail, /B-63944EN/);
});

test('R26：AI 模式裡用固定循環 → info', goldenSkip, () => {
  const d = only(plain(FIX_A), 'R26').find((x) => /固定循環/.test(x.message));
  assert.ok(d);
  assert.equal(d.severity, 'info');
  assert.equal(d.line, 969);
});

test('R26：四支程式的 G05.1 都成對，也都沒有在 AI 模式裡換刀', goldenSkip, () => {
  for (const name of FIXTURES) {
    const list = only(plain(name), 'R26');
    assert.equal(list.filter((d) => /沒有 G05\.1 Q0 取消/.test(d.message)).length, 0, name);
    assert.equal(list.filter((d) => /就換刀/.test(d.message)).length, 0, name);
  }
});

test('R26：Q1 沒有對應的 Q0 → warning；G05.1 節混其他字 → error', () => {
  const src = [
    '%', 'O9026', 'G40G49G80', 'M6T1(10MM)',
    'G05.1Q1X10.',              // 不可以和其他字同節
    'G0G90G54X0.Y0.G43H1Z10.M3S1000',
    'G1Z-1.F100M8',
    'G0Z50.M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const list = only(analyze(src), 'R26');
  const bad = list.find((d) => d.severity === 'error');
  assert.ok(bad);
  assert.equal(bad.line, 5);
  assert.match(bad.message, /必須單獨成一節/);
  assert.equal(bad.fanucAlarm, 'PS5010');
  const open = list.find((d) => /沒有 G05\.1 Q0 取消/.test(d.message));
  assert.ok(open);
  assert.equal(open.severity, 'warning');
});

// ---------------------------------------------------------------------------
// R29 T 預選
// ---------------------------------------------------------------------------
test('R29：樣本 A L708 的 M6T11（T11 已在主軸）→ info（契約驗收）', goldenSkip, () => {
  const list = only(plain(FIX_A), 'R29');
  const d = list.find((x) => x.line === 708);
  assert.ok(d, 'L708 要有 R29');
  assert.equal(d.severity, 'info');
  assert.match(d.message, /T11 本來就在主軸上/);
  // L877 也是同樣情形
  assert.ok(list.some((x) => x.line === 877 && /本來就在主軸上/.test(x.message)));
});

test('R29：程式最後的預選刀 → info', goldenSkip, () => {
  const want = { [FIX_A]: [1581, 20], [FIX_B]: [455, 15], [FIX_C]: [83, 3] };
  for (const [name, [line, t]] of Object.entries(want)) {
    const d = only(plain(name), 'R29').find((x) => /程式最後預選/.test(x.message));
    assert.ok(d, name);
    assert.equal(d.severity, 'info');
    assert.equal(d.line, line);
    assert.match(d.message, new RegExp(`T${t}`));
  }
});

test('R29：四支程式的預選 T 都和下一次 M6 對得上（不該有 warning）', goldenSkip, () => {
  for (const name of FIXTURES) {
    assert.deepEqual(only(plain(name), 'R29').filter((d) => d.severity === 'warning'), [], name);
  }
});

test('R29：預選 T 和下一次 M6 的 T 不一樣 → warning', () => {
  const src = [
    '%', 'O9029', 'G40G49G80', 'M6T1(10MM)',
    'G0G90G54X0.Y0.G43H1Z10.M3S1000',
    'G1Z-1.F100M8T5',          // 預選 T5
    'G0Z50.M9', 'M5', 'G91G28Z0.',
    'M6T7(10MM)',              // 卻換 T7
    'G0G90G54X0.Y0.G43H7Z10.M3S1000',
    'G0Z50.M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const d = only(analyze(src), 'R29').find((x) => x.severity === 'warning');
  assert.ok(d);
  assert.equal(d.line, 10);
  assert.match(d.message, /預選的是 T5/);
  assert.match(d.message, /卻換 T7/);
});

// ---------------------------------------------------------------------------
// R30 刀庫
// ---------------------------------------------------------------------------
test('R30：沒有 settings.magazine 就完全不檢查', goldenSkip, () => {
  for (const name of FIXTURES) assert.deepEqual(only(plain(name), 'R30'), [], name);
});

test('R30：刀號超出刀庫容量 → error', goldenSkip, () => {
  const ctx = analyze(fixture(FIX_C), { settings: { magazine: { size: 10 } } });
  const list = only(ctx, 'R30');
  assert.ok(list.length > 0);
  assert.ok(list.every((d) => d.severity === 'error'));
  assert.ok(list.some((d) => /T15/.test(d.message)));
  assert.match(list[0].detail, /刀庫設定是 1～10 號/);
});

test('R30：刀位表缺刀 → warning；兩把刀同一個刀位 → error', goldenSkip, () => {
  const magazine = { size: 24, pots: { 1: 1, 2: 2, 3: 3, 7: 3 } }; // T15 沒登記、T7 和 T3 撞位
  const ctx = analyze(fixture(FIX_C), { settings: { magazine } });
  const list = only(ctx, 'R30');
  assert.ok(list.some((d) => d.severity === 'warning' && /T15/.test(d.message)));
  assert.ok(list.some((d) => d.severity === 'error' && /同一個刀位/.test(d.message)));
});

// ---------------------------------------------------------------------------
// R31 刀具推定
// ---------------------------------------------------------------------------
test('R31：樣本 C 的 T15 是 info，絕對不能是 warning／error（契約驗收）', goldenSkip, () => {
  const list = only(plain(FIX_C), 'R31');
  assert.equal(list.length, 1);
  const d = list[0];
  assert.equal(d.severity, 'info', 'T15 是刻意選一個沒用到的刀位裝定位器，不是問題');
  assert.equal(d.line, 82);
  assert.match(d.message, /T15/);
  assert.match(d.message, /空的刀位/);
  assert.match(d.detail, /定位器/);
  assert.match(d.detail, /這不是錯誤/);
});

test('R31：其他三支程式的刀具註解和動作都對得起來，不該有 warning', goldenSkip, () => {
  for (const name of [FIX_A, FIX_B, FIX_D]) {
    assert.deepEqual(only(plain(name), 'R31').filter((d) => d.severity !== 'info'), [], name);
  }
});

test('R31：註解型式和動作型式矛盾 → warning', () => {
  // 註解說是絲攻（M6*P1.0），實際卻用 G41 走輪廓
  const src = [
    '%', 'O9031', 'G40G49G80', 'M6T1(M6*P1.0)',
    'G0G90G54X-20.Y0.G43H1Z10.M3S1000',
    'G1Z-1.F100M8',
    'G1G41D1X-10.',
    'Y10.',
    'G1G40X-20.',
    'G0Z50.M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const list = only(analyze(src), 'R31');
  assert.equal(list.length, 1);
  assert.equal(list[0].severity, 'warning');
  assert.match(list[0].message, /T1/);
});

// ---------------------------------------------------------------------------
// R33 軟極限
// ---------------------------------------------------------------------------
test('R33：沒有 settings.softLimits 就不檢查', goldenSkip, () => {
  for (const name of FIXTURES) assert.deepEqual(only(plain(name), 'R33'), [], name);
});

test('R33：路徑超出軟極限 → error，每個方向只報最嚴重的一筆', goldenSkip, () => {
  const softLimits = { min: { x: -50, y: -50, z: -100 }, max: { x: 50, y: 50, z: 200 } };
  const ctx = analyze(fixture(FIX_C), { settings: { softLimits } });
  const list = only(ctx, 'R33');
  assert.ok(list.length > 0);
  assert.ok(list.every((d) => d.severity === 'error'));
  assert.ok(list.every((d) => d.fanucAlarm === 'OT0500'));
  // 樣本 C 的 X 走到 ±70、Y 走到 48.4，所以 X 正負向都會超出
  assert.ok(list.some((d) => /X 軸正向/.test(d.message)));
  assert.ok(list.some((d) => /X 軸負向/.test(d.message)));
  assert.ok(list.every((d) => d.pos && typeof d.pos.x === 'number'));
  // 同一個方向只留一筆
  const keys = list.map((d) => d.message.replace(/[\d.]+ mm$/, ''));
  assert.equal(new Set(keys).size, keys.length);
});

test('R33：軟極限夠大時什麼都不報', goldenSkip, () => {
  const softLimits = { min: { x: -500, y: -500, z: -500 }, max: { x: 500, y: 500, z: 500 } };
  const ctx = analyze(fixture(FIX_C), { settings: { softLimits } });
  assert.deepEqual(only(ctx, 'R33'), []);
});

// ---------------------------------------------------------------------------
// R34 重複層偏離
// ---------------------------------------------------------------------------
test('R34：樣本 B 的分層結構與三個偏離點', goldenSkip, () => {
  const list = only(plain(FIX_B), 'R34');
  assert.ok(list.every((d) => d.severity === 'info'));
  const summary = list.find((d) => /層重複的加工/.test(d.message));
  assert.ok(summary);
  assert.equal(summary.line, 11);
  assert.match(summary.message, /76 層/);
  assert.match(summary.message, /Z 從 -1 一路做到 -39/);
  assert.match(summary.detail, /多數層的深度間隔是 -0\.5 mm/);

  // L127「G1Z-15.5」漏了 F800，所以那一層變成 8 節
  const l123 = list.find((d) => d.line === 123);
  assert.ok(l123, 'L123 那一層應該被指出節數不同');
  assert.match(l123.message, /8 節/);

  // L252 走到 X-92（其他層都是 X-65）、L254 多了 Y-1.5
  assert.ok(list.some((d) => d.line === 252 && /X-92/.test(d.message)));
  assert.ok(list.some((d) => d.line === 254 && /Y-1\.5/.test(d.message)));
});

test('R34：只報「孤例」，重複出現的變化（F150 → F180）不算偏離', goldenSkip, () => {
  const list = only(plain(FIX_B), 'R34');
  // 樣本 B 從 L256 起 F 由 150 改成 180 共 16 層，那是刻意的，不該被列成偏離
  assert.equal(list.filter((d) => /F180/.test(d.message)).length, 0);
});

test('R34：樣本 D 抓到多寫一次抬刀的那一層', goldenSkip, () => {
  const list = only(plain(FIX_D), 'R34');
  const summary = list.find((d) => /層重複的加工/.test(d.message));
  assert.ok(summary);
  assert.equal(summary.line, 24);
  const odd = list.find((d) => d.line === 44);
  assert.ok(odd, 'L44–L54 那一層多了一個 G0Z5.');
  assert.match(odd.message, /11 節/);
});

test('R34：結構不規則的段落不會硬套（不亂報）', goldenSkip, () => {
  assert.deepEqual(only(plain(FIX_C), 'R34'), [], '樣本 C 太短、沒有分層結構');
  for (const name of FIXTURES) {
    assert.ok(only(plain(name), 'R34').every((d) => d.severity === 'info'), `${name}：R34 一律 info`);
  }
});

// ---------------------------------------------------------------------------
// R35 切削參數
// ---------------------------------------------------------------------------
test('R35：長徑比大於 6 → warning（需要確認刃長）', goldenSkip, () => {
  const list = only(plain(FIX_A), 'R35').filter((d) => /倍/.test(d.message));
  assert.deepEqual(lines(list), [1204, 1472, 1579]); // T5 Ø4→-35.1、T6 Ø4→-35、T4 Ø5→-32.2
  assert.ok(list.every((d) => d.severity === 'warning'));
  assert.match(list[0].message, /8\.775 倍/);
  assert.match(list[0].detail, /刃長目前是推估值/);
});

test('R35：啄鑽次數過多 → info', goldenSkip, () => {
  const d = only(plain(FIX_D), 'R35').find((x) => /啄/.test(x.message));
  assert.ok(d);
  assert.equal(d.severity, 'info');
  assert.equal(d.line, 289);   // G98R2.G83Q0.35Z-38. → 40 mm ÷ 0.35 ≈ 114 次
  assert.match(d.message, /114 次/);
});

test('R35：攻牙進給對得上螺距就不報（樣本 D T10 M4*P0.7 S200 F140）', goldenSkip, () => {
  const bad = only(plain(FIX_D), 'R35').filter((d) => d.severity === 'error');
  assert.deepEqual(bad, [], 'F140 = 0.7 × 200，完全正確');
});

test('R35：攻牙進給和螺距對不上 → error', () => {
  const src = [
    '%', 'O9035', 'G40G49G80', 'M6T1(M4*P0.7)',
    'G0G90G54X0.Y0.G43H1Z30.M3S200',
    'M29S200',
    'G98R3.G84Z-11.F100M8',   // 正確應該是 F140
    'G80M9', 'M5', 'G91G28Z0.', 'M30', '%',
  ].join('\n');
  const list = only(analyze(src), 'R35').filter((d) => d.severity === 'error');
  assert.equal(list.length, 1);
  assert.match(list[0].message, /攻牙進給對不上螺距/);
  assert.match(list[0].message, /140/);
});

test('R35：四支程式的 Vc 都在合理範圍，不該有切削速度的 info', goldenSkip, () => {
  for (const name of FIXTURES) {
    assert.deepEqual(only(plain(name), 'R35').filter((d) => /切削速度/.test(d.message)), [], name);
  }
});

// ---------------------------------------------------------------------------
// R36 同特徵多底深
// ---------------------------------------------------------------------------
test('R36：沒有素材模擬就不報', goldenSkip, () => {
  for (const name of FIXTURES) assert.deepEqual(only(plain(name), 'R36'), [], name);
});

test('R36：抓得到 0.1 mm 的殘料段差', goldenSkip, async () => {
  const ctx = await simmed(FIX_B);
  const list = only(ctx, 'R36');
  assert.equal(list.length, 1);
  assert.equal(list[0].severity, 'warning');
  assert.match(list[0].message, /0\.1 mm/);
  assert.match(list[0].message, /Z-39\.4/);
  assert.match(list[0].message, /Z-39\.5/);
  assert.match(list[0].detail, /T11/);
  assert.match(list[0].detail, /T12/);
});

test('R36：不會把鑽尖／倒角的錐面當成兩個底面', goldenSkip, async () => {
  const ctx = await simmed(FIX_C);
  assert.deepEqual(only(ctx, 'R36'), [], '樣本 C 只有倒角孔與側面，沒有兩個底面');
  const ctx4 = await simmed(FIX_D);
  assert.deepEqual(only(ctx4, 'R36'), []);
});

// ---------------------------------------------------------------------------
// 不誤報：四支真實程式跑出來的 error 必須每一筆都說得出理由
// ---------------------------------------------------------------------------
test('不誤報（無模擬）：四支真實程式一筆 error 都不該有', goldenSkip, () => {
  for (const name of FIXTURES) {
    const errs = diags(plain(name)).filter((d) => d.severity === 'error');
    assert.deepEqual(errs.map((d) => `${d.ruleId} L${d.line} ${d.message}`), [], name);
  }
});

test('不誤報（有模擬）：只有 3 筆 error，每一筆都是真的會撞刀', goldenSkip, async () => {
  const found = [];
  for (const name of FIXTURES) {
    const ctx = await simmed(name);
    for (const d of diags(ctx).filter((x) => x.severity === 'error')) {
      found.push(`${name}|${d.ruleId}|${d.line}`);
    }
  }
  /*
   * 這三筆 error 的理由（都是「block skip 開關打開時」才會發生）：
   *
   * 1) 樣本 A L1147「////G0Z5.」
   *    這一節是抬刀。跳過之後模態還是 G1，第 1148 行「X-27.Y-49.」就變成在 Z-36
   *    以 G1 F120 斜切過去。用「開關關」情境做完同一個作業（op#10）之後的高度圖去查，
   *    這條路徑上材料最高還在 Z-30，比刀尖高 6 mm——而那張高度圖是「當下材料」的下界
   *    （後面的作業只會再挖掉更多），所以當時材料一定在，Ø12 立銑刀會整支埋進實心料。
   *
   * 2) 樣本 B L443「/G0X-25.」
   *    跳過之後，下一節那個補正啟動節的起點跑到工件另一邊，
   *    刀具會在 Z-39.5（工件全深）從工件另一邊橫切過來。該處最終高度是 Z0，
   *    也就是那塊材料到程式結束都還在，Ø12 立銑刀等於用 F180 全深側銑一刀 59 mm 寬的實心料。
   *
   * 3) 樣本 D L113「/////G0Z5.」
   *    同樣是抬刀被跳過，第 114 行「X57.6Y10.」變成在 Z-24.4 以 G1 F150 橫越工件，
   *    而 Y10. 這一條線在成品上是完全沒有被加工過的素材頂面（Z2），比刀尖高 26.4 mm。
   *
   * 其餘所有「跳過後在切深橫移」的情形都只給 warning，因為用最終／作業結束的高度圖
   * 無法證明當下材料還在（可能已經被同一個作業前面的刀路挖掉了）。
   */
  assert.deepEqual(found.sort(), [
    `${FIX_A}|R06|1147`,
    `${FIX_B}|R06|443`,
    `${FIX_D}|R06|113`,
  ].sort());
});

test('不誤報：所有 error 都來自「有素材模擬佐證」的規則', goldenSkip, async () => {
  for (const name of FIXTURES) {
    const ctx = await simmed(name);
    for (const d of diags(ctx).filter((x) => x.severity === 'error')) {
      assert.equal(d.ruleId, 'R06', `${name} L${d.line}`);
      assert.match(d.detail, /素材模擬顯示/);
    }
  }
});

test('不誤報：needsInput 只出現在「需要使用者提供資訊」的地方', goldenSkip, () => {
  // R20：R 點在材料裡但不確定該處有沒有孔；R35：切削深度可能超過刃長，但刃長是推估值
  const ALLOW = new Set(['R20', 'R35']);
  for (const name of FIXTURES) {
    for (const d of diags(plain(name)).filter((x) => x.severity === 'needsInput')) {
      assert.ok(ALLOW.has(d.ruleId), `${name} L${d.line} ${d.ruleId} ${d.message}`);
      assert.ok((d.detail || '').length > 20, 'needsInput 一定要說清楚缺什麼資料');
    }
  }
});

test('不誤報：每支程式的診斷數量在可讀範圍內（不洗版）', goldenSkip, () => {
  const counts = {};
  for (const name of FIXTURES) counts[name] = diags(plain(name)).length;
  // 1593 行的 樣本 A 有 34 個斜線節，R06 本來就會逐行報，其餘規則都有聚合
  assert.ok(counts[FIX_A] < 120, `樣本 A 診斷數 ${counts[FIX_A]}`);
  assert.ok(counts[FIX_B] < 40, `樣本 B 診斷數 ${counts[FIX_B]}`);
  assert.ok(counts[FIX_C] < 20, `樣本 C 診斷數 ${counts[FIX_C]}`);
  assert.ok(counts[FIX_D] < 60, `樣本 D 診斷數 ${counts[FIX_D]}`);
  // 同一條規則不該在同一行重複出現
  for (const name of FIXTURES) {
    const seen = new Set();
    for (const d of diags(plain(name))) {
      const key = `${d.ruleId}|${d.line}|${d.message}`;
      assert.ok(!seen.has(key), `${name} 重複診斷：${key}`);
      seen.add(key);
    }
  }
});

test('效能：最大的程式跑完所有規則要在 300 ms 以內', goldenSkip, () => {
  const ctx = analyze(fixture(FIX_A));
  const t0 = Date.now();
  NC.rules.run(ctx);
  const ms = Date.now() - t0;
  assert.ok(ms < 300, `rules.run 花了 ${ms} ms`);
});

// ---------------------------------------------------------------------------
// R30 大徑刀與相鄰刀位互撞（現場真實事故：大直徑面銑刀把隔壁的刀撞飛）
// ---------------------------------------------------------------------------
test('R30：大徑刀的相鄰刀位有刀 → error（程式本身看不出來的問題）', goldenSkip, () => {
  const s = NC.util.defaultSettings();
  s.magazine = { size: 24, pots: { 20: 5, 11: 4, 12: 9 }, largeToolDiameter: 80, largeToolNeighbors: 1 };
  const r = NC.analyzeSync({ text: fixture(FIX_A), settings: s, toolTable: null, stock: null,
    scenarios: ['off'], sim: { enabled: false, cell: 0.5 } });
  const hit = r.diagnostics.filter((d) => d.ruleId === 'R30' && d.severity === 'error');
  assert.ok(hit.length >= 1, '應該抓到 T20(Ø100) 第 5 號刀位與隔壁第 4 號的 T11 相撞');
  assert.match(hit[0].message, /T20/);
  assert.match(hit[0].message, /隔壁第 4 號/);
  assert.match(hit[0].detail, /撞飛/);
});

test('R30：大徑刀兩側都空 → 不報', goldenSkip, () => {
  const s = NC.util.defaultSettings();
  s.magazine = { size: 24, pots: { 20: 5, 11: 8, 12: 9 }, largeToolDiameter: 80, largeToolNeighbors: 1 };
  const r = NC.analyzeSync({ text: fixture(FIX_A), settings: s, toolTable: null, stock: null,
    scenarios: ['off'], sim: { enabled: false, cell: 0.5 } });
  const hit = r.diagnostics.filter((d) => d.ruleId === 'R30' && /隔壁/.test(d.message));
  assert.equal(hit.length, 0, '兩側淨空不該報');
});

test('R30：刀庫是環狀的，第 1 號的隔壁是最後一號', goldenSkip, () => {
  const s = NC.util.defaultSettings();
  s.magazine = { size: 12, pots: { 20: 1, 11: 12 }, largeToolDiameter: 80, largeToolNeighbors: 1 };
  const r = NC.analyzeSync({ text: fixture(FIX_A), settings: s, toolTable: null, stock: null,
    scenarios: ['off'], sim: { enabled: false, cell: 0.5 } });
  const hit = r.diagnostics.filter((d) => d.ruleId === 'R30' && /隔壁第 12 號/.test(d.message));
  assert.ok(hit.length >= 1, '第 1 號與第 12 號在環狀刀庫上相鄰');
});

test('R30：沒有 magazine 設定就完全不檢查（不能亂猜刀庫配置）', goldenSkip, () => {
  const r = NC.analyzeSync({ text: fixture(FIX_A), settings: NC.util.defaultSettings(), toolTable: null,
    stock: null, scenarios: ['off'], sim: { enabled: false, cell: 0.5 } });
  assert.equal(r.diagnostics.filter((d) => d.ruleId === 'R30').length, 0);
});
