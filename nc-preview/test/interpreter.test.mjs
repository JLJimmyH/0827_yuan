// interpreter.js 測試（CONTRACT §2 驗收 + 各診斷規則）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNC, fixture, FIXTURES, goldenSkip, FIX_A, FIX_B, FIX_C, FIX_D } from './load.mjs';

const NC = loadNC();
const S = () => NC.util.defaultSettings();

const cache = new Map();
function run(name, scenario = 'off', settings = null) {
  const key = `${name}|${scenario}|${settings ? JSON.stringify(settings) : ''}`;
  if (!cache.has(key)) {
    const tok = NC.tokenize(fixture(name));
    cache.set(key, { tok, run: NC.interpret(tok.blocks, settings || S(), scenario) });
  }
  return cache.get(key);
}
/** 用字串程式直接跑（自動包 %/O/M30 以免 R32 干擾，除非 raw=true） */
function prog(src, opts = {}) {
  const text = opts.raw ? src : `%\nO1\n${src}\nM30\n%`;
  const tok = NC.tokenize(text);
  const r = NC.interpret(tok.blocks, Object.assign(S(), opts.settings || {}), opts.scenario || 'off');
  return { tok, run: r, at: (line) => r.executed[line - 1 + (opts.raw ? 0 : 2)] };
}
const byRule = (r, id, sev) => r.diagnostics.filter((d) => d.ruleId === id && (!sev || d.severity === sev));
const acts = (eb, kind) => eb.actions.filter((a) => a.kind === kind);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test('載入：NC.interpret 存在', () => {
  assert.equal(typeof NC.interpret, 'function');
});

// ---------------------------------------------------------------------------
// 驗收（四支真實程式，scenario off）
// ---------------------------------------------------------------------------
test('驗收：樣本 A ops 22 個、T 序列正確', goldenSkip, () => {
  const { run: r } = run(FIX_A);
  assert.equal(r.ops.length, 22);
  assert.deepEqual(r.ops.map((o) => o.tool), [20, 11, 12, 11, 11, 11, 3, 9, 8, 7, 11, 1, 14, 5, 2, 12, 6, 3, 10, 13, 20, 4]);
  assert.deepEqual(r.ops.map((o) => o.index), [...Array(22).keys()]);
});

test('驗收：樣本 A op 索引 1（T11）zMin = -30', goldenSkip, () => {
  const { run: r } = run(FIX_A);
  const op = r.ops[1];
  assert.equal(op.tool, 11);
  assert.equal(op.toolComment, '12MM');
  assert.equal(op.zMin, -30);
  assert.equal(op.lineStart, 10);
  assert.equal(op.lineEnd, 225);
  assert.equal(op.h, 11);
  assert.deepEqual(op.dList, [11]);
  assert.equal(op.kindGuess, 'contour');
  assert.ok(op.gCodes.includes('G41') && op.gCodes.includes('G2') && op.gCodes.includes('G05.1'));
  assert.deepEqual(op.feeds, [150]);
  assert.deepEqual(op.rpms, [1850]);
});

test('驗收：樣本 D 有 hole 動作，T10 那個 op 的 hole rigid=true', goldenSkip, () => {
  const { run: r } = run(FIX_D);
  const holes = r.executed.flatMap((e) => acts(e, 'hole'));
  assert.ok(holes.length > 0);
  const op10 = r.ops.find((o) => o.tool === 10);
  assert.ok(op10, '找不到 T10 op');
  const h10 = r.executed.filter((e) => e.opIndex === op10.index).flatMap((e) => acts(e, 'hole'));
  assert.equal(h10.length, 4);
  assert.ok(h10.every((h) => h.rigid === true && h.cycle === 'G84'));
  assert.equal(op10.kindGuess, 'tap');
  assert.equal(h10[0].z, -11);
  assert.equal(h10[0].r, 3);
  assert.equal(h10[0].initialZ, 30);
  assert.equal(h10[0].feed, 140);
  // 其他 op 的 hole 不是 rigid
  const others = r.executed.filter((e) => e.opIndex !== op10.index).flatMap((e) => acts(e, 'hole'));
  assert.ok(others.length > 0 && others.every((h) => !h.rigid));
});

test('驗收：G91 區段累積之後回 G90，絕對座標接得上', goldenSkip, () => {
  const { run: r } = run(FIX_D);
  const e297 = r.executed[296];
  assert.equal(e297.line, 297);
  assert.equal(e297.after.distance, 'G91');
  near(acts(e297, 'linear')[0].to.z, -2.5);
  near(r.executed[297].actions[0].to.x, -35);            // X-70. 增量
  near(r.executed[298].actions[0].to.y, -32.75);         // Y-11. 增量
  const arc301 = acts(r.executed[300], 'arc')[0];
  assert.ok(arc301, 'L301 應是圓弧');
  near(arc301.to.y, arc301.from.y + 22);
  const e445 = r.executed[444];
  assert.equal(e445.line, 445);
  assert.equal(e445.before.distance, 'G91');
  assert.equal(e445.after.distance, 'G90');
  const a = acts(e445, 'linear')[0];
  assert.ok(a);
  near(a.to.x, 0);
  near(Math.abs(a.from.x), 35);
  near(a.to.y, -21.75);
  near(a.to.z, -35); // 14 層 G91 Z-2.5（含 / 節與 //// 節，off 情境全部執行）
});

test('驗收：樣本 B scenario on 時 L254 skipped=true；off 時執行；multiIgnored 時 ignored', goldenSkip, () => {
  const on = run(FIX_B, 'on').run;
  const e = on.executed[253];
  assert.equal(e.line, 254);
  assert.equal(e.skipped, true);
  assert.equal(e.actions.length, 0);
  assert.deepEqual(e.after, e.before);
  const off = run(FIX_B, 'off').run;
  assert.equal(off.executed[253].skipped, false);
  assert.equal(off.executed[253].actions.length, 1);
  const mi = run(FIX_B, 'multiIgnored').run;
  assert.equal(mi.executed[253].ignored, true);
  assert.equal(mi.executed[253].skipped, false);
  // 單斜線節：on 跳過、multiIgnored 執行
  assert.equal(on.executed[442].skipped, true);   // L443 /G0X-25.
  assert.equal(mi.executed[442].skipped, false);
  assert.equal(mi.executed[442].ignored, false);
  assert.equal(mi.executed[442].actions.length, 1);
});

test('驗收：四支程式 R02 error = 0（G05.1 要認得）', goldenSkip, () => {
  for (const f of FIXTURES) {
    const { run: r } = run(f);
    assert.equal(byRule(r, 'R02', 'error').length, 0, `${f}: ${JSON.stringify(byRule(r, 'R02', 'error'))}`);
  }
});

test('驗收：樣本 C T3 第一個 op 有 4 個 hole', goldenSkip, () => {
  const { run: r } = run(FIX_C);
  const op = r.ops.find((o) => o.tool === 3);
  assert.equal(op.index, 0);
  const holes = r.executed.filter((e) => e.opIndex === op.index).flatMap((e) => acts(e, 'hole'));
  assert.equal(holes.length, 4);
  assert.deepEqual(holes.map((h) => h.x), [-45, -15, 15, 45]);
  assert.ok(holes.every((h) => h.y === 48.4 && h.z === -1.2 && h.r === 2 && h.cycle === 'G81' && h.retract === 'G98' && h.initialZ === 25));
  assert.equal(op.kindGuess, 'drill');
  // 孔完成後位置回到 initialZ
  near(r.executed[5].after.pos.z, 25);
});

test('四支程式：沒有意外的 error（只允許已知的 R17 兩軸 warning 等）', goldenSkip, () => {
  for (const f of FIXTURES) {
    const { run: r } = run(f);
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    assert.deepEqual(errors, [], `${f} errors: ${JSON.stringify(errors.map((d) => [d.ruleId, d.line, d.message]))}`);
    for (const id of ['R03', 'R04', 'R08', 'R09', 'R13', 'R16', 'R18', 'R21', 'R23']) {
      assert.equal(byRule(r, id).length, 0, `${f} ${id}: ${JSON.stringify(byRule(r, id).map((d) => [d.line, d.message]))}`);
    }
    console.log(`  ${f}: ${r.ops.length} ops, ${r.diagnostics.length} diags ${JSON.stringify(r.diagnostics.map((d) => d.ruleId + '@' + d.line))}`);
  }
});

test('四支程式：executed 與 blocks 一一對應、finalState 在參考點', goldenSkip, () => {
  for (const f of FIXTURES) {
    const { tok, run: r } = run(f);
    assert.equal(r.executed.length, tok.blocks.length);
    r.executed.forEach((e, i) => assert.equal(e.line, tok.blocks[i].line));
    assert.equal(r.scenario, 'off');
    assert.equal(r.finalState.pos.z, 150);
    assert.equal(r.finalState.comp, 'G40');
    assert.equal(r.finalState.cycle, null);
    assert.equal(r.finalState.aicc, false);
  }
});

// ---------------------------------------------------------------------------
// 初始狀態、模態、位置
// ---------------------------------------------------------------------------
test('初始狀態符合契約', () => {
  const { run: r } = prog('G0X1.');
  const b = r.executed[0].before;
  assert.equal(b.motion, null);
  assert.equal(b.distance, 'G90');
  assert.equal(b.plane, 'G17');
  assert.equal(b.units, 'G21');
  assert.equal(b.feedMode, 'G94');
  assert.equal(b.wcs, 'G54');
  assert.equal(b.comp, 'G40');
  assert.equal(b.d, 0);
  assert.equal(b.lengthComp, 'G49');
  assert.equal(b.h, 0);
  assert.equal(b.cycle, null);
  assert.equal(b.retractMode, 'G98');
  assert.equal(b.feed, null);
  assert.deepEqual(b.spindle, { dir: 'M5', rpm: null });
  assert.equal(b.coolant, false);
  assert.equal(b.toolInSpindle, null);
  assert.equal(b.toolStaged, null);
  assert.equal(b.aicc, false);
  assert.equal(b.rigidTap, false);
  assert.equal(b.rigidTapS, null);
  assert.deepEqual(b.pos, { x: 0, y: 0, z: 150 });
  assert.equal(b.lengthCompActive, false);
});

test('G0 多軸 → rapid nonLinear；單軸 → 直線 rapid；未指定軸保持', () => {
  const p = prog('G0G90X10.Y20.\nZ5.\nX-3.');
  const a1 = p.at(1).actions.find((a) => a.kind === 'rapid');
  assert.deepEqual(a1.from, { x: 0, y: 0, z: 150 });
  assert.deepEqual(a1.to, { x: 10, y: 20, z: 150 });
  assert.equal(a1.nonLinear, true);
  const a2 = p.at(2).actions[0];
  assert.deepEqual(a2.to, { x: 10, y: 20, z: 5 });
  assert.equal(a2.nonLinear, false);
  assert.deepEqual(p.at(3).actions[0].to, { x: -3, y: 20, z: 5 });
  assert.deepEqual(p.at(3).after.pos, { x: -3, y: 20, z: 5 });
});

test('只有在有座標字時才產生移動；模態字不移動', () => {
  const p = prog('G0X1.Y1.Z1.\nG1F100\nG90\nS1000M3');
  assert.equal(p.at(2).actions.length, 0);
  assert.equal(p.at(2).after.feed, 100);
  assert.equal(p.at(2).after.motion, 'G1');
  assert.equal(p.at(3).actions.length, 0);
  assert.deepEqual(p.at(4).actions.map((a) => a.kind), ['spindle']);
});

test('G91 增量累積；同節 G90/G91 立即生效', () => {
  const p = prog('G0G90X10.Y10.Z10.\nG91X5.\nY-3.Z-2.\nG90X0.\nG91G1X1.F100');
  assert.deepEqual(p.at(2).actions[0].to, { x: 15, y: 10, z: 10 });
  assert.deepEqual(p.at(3).actions[0].to, { x: 15, y: 7, z: 8 });
  assert.deepEqual(p.at(4).actions[0].to, { x: 0, y: 7, z: 8 });
  assert.deepEqual(p.at(5).actions[0].to, { x: 1, y: 7, z: 8 });
  assert.equal(p.at(5).actions[0].kind, 'linear');
});

test('G1 feed 帶入動作；F 同節先套用', () => {
  const p = prog('G0X0.Y0.Z0.\nG1X10.F150\nY5.F200\nX0.');
  assert.equal(p.at(2).actions[0].feed, 150);
  assert.equal(p.at(3).actions[0].feed, 200);
  assert.equal(p.at(4).actions[0].feed, 200);
});

// ---------------------------------------------------------------------------
// 圓弧
// ---------------------------------------------------------------------------
test('圓弧：R 指定的圓弧：圓心、繞向、半徑都算得對', goldenSkip, () => {
  const { run: r } = run(FIX_A);
  const a = acts(r.executed[15], 'arc')[0];
  assert.ok(a);
  assert.deepEqual(a.from, { x: 58, y: -74.5, z: -2 });
  assert.deepEqual(a.to, { x: 52, y: -80.5, z: -2 });
  near(a.center.x, 52);
  near(a.center.y, -74.5);
  assert.equal(a.cw, true);
  assert.equal(a.r, 6);
  assert.equal(a.feed, 150);
});

test('圓弧：G91 的 G3 半圓：圓心落在弦中點', goldenSkip, () => {
  const { run: r } = run(FIX_D);
  const a = acts(r.executed[300], 'arc')[0];
  assert.ok(a);
  assert.equal(a.cw, false);
  assert.equal(a.r, 11);
  near(a.to.y - a.from.y, 22);
  near(a.center.x, a.from.x);
  near(a.center.y, (a.from.y + a.to.y) / 2);
});

test('圓弧：G3 小弧圓心在左側；R<0 大弧在另一側；I/J 指定', () => {
  const p = prog('G0X0.Y0.Z0.\nG1F100\nG3X10.Y10.R10.\nG0X0.Y0.\nG3X10.Y10.R-10.\nG0X0.Y0.\nG2X10.Y10.I10.J0.\nG0X0.Y0.\nG2X0.Y0.I5.J0.');
  const a1 = p.at(3).actions[0];
  assert.equal(a1.kind, 'arc');
  near(a1.center.x, 0); near(a1.center.y, 10);
  const a2 = p.at(5).actions[0];
  near(a2.center.x, 10); near(a2.center.y, 0);
  const a3 = p.at(7).actions[0];
  near(a3.center.x, 10); near(a3.center.y, 0); near(a3.r, 10);
  assert.equal(a3.cw, true);
  const full = p.at(9).actions[0];
  assert.equal(full.kind, 'arc');
  near(full.r, 5);
  assert.equal(byRule(p.run, 'R23').length, 0);
});

test('整圓：G2/G3 模式下只寫 I/J（沒有 X/Y/Z）→ 終點＝起點的圓弧；只寫 R → R23 error', () => {
  // CAM 銑孔的標準寫法：切入圓弧之後「J-8.」單獨一節繞一整圈，再切出。
  // 以前這種節因為沒有 X/Y/Z 被當成「沒有移動」整節消失：路徑、材料、估時全部少掉一個圓。
  const p = prog('G0X10.Y-7.Z0.\nG1F100\nG3X10.Y0.R7.\nJ-8.\nG2J-4.F150\nX6.Y-2.R7.\nG3R5.');
  const full = p.at(4).actions[0];
  assert.ok(full && full.kind === 'arc', 'J-only 節應產生圓弧動作');
  near(full.from.x, 10); near(full.from.y, 0);
  near(full.to.x, full.from.x); near(full.to.y, full.from.y);       // 終點＝起點
  near(full.center.x, 10); near(full.center.y, -8);
  near(full.r, 8);
  assert.equal(full.cw, false);
  const g2 = p.at(5).actions[0];                                     // G2 也一樣；同節帶 F 沒差
  assert.equal(g2.kind, 'arc'); assert.equal(g2.cw, true); near(g2.r, 4);
  near(g2.feed, 150);
  const next = p.at(6).actions[0];                                   // 整圓之後位置不變，下一節從同一點接下去
  near(next.from.x, 10); near(next.from.y, 0);
  // 只寫 R：起終點重合、圓弧無法定義 → R23 error（以前也是整節無聲消失）
  const r23 = byRule(p.run, 'R23', 'error');
  assert.equal(r23.length, 1); assert.equal(r23[0].line, 7 + 2);
  assert.equal(byRule(p.run, 'R23', 'warning').length, 0);
});

test('R23：弦長 > 2|R| → error 並退化成直線；起終點重合用 R → error；無 I/J/R → error', () => {
  const p = prog('G0X0.Y0.Z0.\nG1F100\nG2X30.Y0.R10.\nG0X0.Y0.\nG2X0.Y0.R5.\nG0X0.Y0.\nG2X5.Y5.');
  assert.equal(p.at(3).actions[0].kind, 'linear');
  assert.deepEqual(p.at(3).actions[0].to, { x: 30, y: 0, z: 0 });
  assert.equal(byRule(p.run, 'R23', 'error').length, 3);
  assert.equal(byRule(p.run, 'R23', 'error')[0].fanucAlarm, 'PS0020');
  assert.deepEqual(byRule(p.run, 'R23', 'error').map((d) => d.line), [5, 7, 9]);
});

test('R02：非 G17 平面圓弧 → warning（程式合法、是本工具做不到，不能用紅字）', () => {
  const p = prog('G0X0.Y0.Z0.\nG18\nG1F100\nG2X10.Z-10.R10.');
  assert.equal(byRule(p.run, 'R02', 'error').length, 0);
  const w = byRule(p.run, 'R02', 'warning').filter((d) => /平面的圓弧/.test(d.message));
  assert.equal(w.length, 1);
  assert.match(w[0].message, /不模擬 G18 平面的圓弧/);
  assert.equal(p.at(4).actions[0].kind, 'linear');
});

// ---------------------------------------------------------------------------
// 換刀、預選、Operation
// ---------------------------------------------------------------------------
test('T 預選 vs M6：M6 用同節 T，否則用 toolStaged；M6 後 staged 清空', () => {
  const p = prog('T5\nM6\nG0X0.\nM6T7\nG1X1.F100T9\nM6(12MM)');
  assert.equal(p.at(1).after.toolStaged, 5);
  assert.equal(p.at(1).after.toolInSpindle, null);
  assert.equal(p.at(1).opIndex, -1);
  assert.equal(p.at(2).after.toolInSpindle, 5);
  assert.equal(p.at(2).after.toolStaged, null);
  assert.deepEqual(acts(p.at(2), 'toolchange'), [{ kind: 'toolchange', tool: 5 }]);
  assert.equal(p.at(2).opIndex, 0);
  assert.equal(p.at(4).after.toolInSpindle, 7);
  assert.equal(p.at(4).after.toolStaged, null);
  assert.equal(p.at(4).opIndex, 1);
  assert.equal(p.at(5).after.toolStaged, 9);
  assert.equal(p.at(6).after.toolInSpindle, 9);
  assert.equal(p.run.ops.length, 3);
  assert.deepEqual(p.run.ops.map((o) => o.tool), [5, 7, 9]);
  assert.equal(p.run.ops[2].toolComment, '12MM');
  assert.equal(p.run.ops[0].toolComment, null);
  assert.equal(p.run.ops[0].lineStart, 4);
  assert.equal(p.run.ops[0].lineEnd, 5);
  assert.equal(p.run.ops[1].lineStart, 6);
  assert.equal(p.run.ops[1].lineEnd, 7);
  assert.equal(p.run.finalState.toolInSpindle, 9);
});

test('樣本 A 換刀前的節 opIndex = -1；op 的 lineStart/lineEnd 銜接', goldenSkip, () => {
  const { run: r } = run(FIX_A);
  assert.equal(r.executed[0].opIndex, -1);
  assert.equal(r.executed[1].opIndex, -1);
  assert.equal(r.executed[2].opIndex, 0);
  for (let i = 1; i < r.ops.length; i++) assert.equal(r.ops[i].lineStart, r.ops[i - 1].lineEnd + 1);
  assert.equal(r.ops[0].lineStart, 3);
  // 最後一個作業的行號範圍停在 M30（1592），不再延伸到檔尾的「%」（1593）
  assert.equal(r.ops[21].lineEnd, 1592);
  assert.equal(r.finalState.toolStaged, 20);
});

test('樣本 A 預選：L5 T11 → toolStaged 11，L10 M6T11 → 主軸 11', goldenSkip, () => {
  const { run: r } = run(FIX_A);
  assert.equal(r.executed[4].after.toolStaged, 11);
  assert.equal(r.executed[9].after.toolInSpindle, 11);
  assert.equal(r.executed[9].after.toolStaged, null);
  assert.equal(r.executed[9].after.lengthCompActive, false);
  assert.equal(r.executed[11].after.lengthCompActive, true);
  assert.equal(r.executed[11].after.h, 11);
});

test('kindGuess：face / contour / drill / ream / tap / chamfer / pocket', goldenSkip, () => {
  const r = run(FIX_A).run;
  const kinds = r.ops.map((o) => `T${o.tool}:${o.kindGuess}`);
  assert.equal(r.ops[0].kindGuess, 'face');       // T20 100MM Z0.05
  assert.equal(r.ops[1].kindGuess, 'contour');    // T11 G41
  assert.equal(r.ops[3].kindGuess, 'pocket');     // T11 L245 來回銑無 G41
  assert.equal(r.ops[6].kindGuess, 'drill');      // T3 G81 點孔
  assert.equal(r.ops[7].kindGuess, 'drill');      // T9 G83
  assert.equal(r.ops[19].kindGuess, 'ream');      // T13 G85
  assert.equal(r.ops[17].kindGuess, 'chamfer');   // T3(10V) G41 倒角
  assert.equal(r.ops[20].kindGuess, 'face');      // T20 Z0
  const r4 = run(FIX_D).run;
  assert.equal(r4.ops.find((o) => o.tool === 10).kindGuess, 'tap');
  console.log('  ' + kinds.join(' '));
});

test('op 統計：feeds/rpms/dList/gCodes 去重、zMin 含 hole', goldenSkip, () => {
  const r = run(FIX_A).run;
  const op6 = r.ops[6]; // T3 L966–978：G81 R-28 Z-31、R1 Z-1
  assert.equal(op6.zMin, -31);
  assert.deepEqual(op6.feeds, [50]);
  assert.deepEqual(op6.rpms, [1850]);
  assert.deepEqual(op6.dList, []);
  assert.equal(op6.h, 3);
  assert.ok(op6.gCodes.includes('G81') && op6.gCodes.includes('G98') && op6.gCodes.includes('G28') && op6.gCodes.includes('G80'));
  const op10 = r.ops[10]; // T11 L998
  assert.deepEqual(op10.feeds, [800, 150, 120]);
  assert.equal(op10.zMin, -36);
});

// ---------------------------------------------------------------------------
// 固定循環
// ---------------------------------------------------------------------------
test('固定循環模態：之後每個含 X/Y/Z/R 的節都鑽一次；循環中可改 R/Z；G80 取消', goldenSkip, () => {
  const r = run(FIX_A).run;
  const e969 = r.executed[968];
  const h1 = acts(e969, 'hole')[0];
  assert.ok(h1, 'L969 應鑽孔');
  assert.deepEqual([h1.x, h1.y, h1.z, h1.r, h1.initialZ, h1.retract, h1.cycle], [35, -21.75, -31, -28, 10, 'G98', 'G81']);
  assert.deepEqual(h1.from, { x: 35, y: -21.75, z: 10 });
  assert.deepEqual(h1.to, { x: 35, y: -21.75, z: 10 });
  const h2 = acts(r.executed[969], 'hole')[0];
  assert.deepEqual([h2.x, h2.y, h2.z, h2.r], [-35, -21.75, -31, -28]);
  const h3 = acts(r.executed[970], 'hole')[0]; // R1.X-46.Y-58.5Z-1.
  assert.deepEqual([h3.x, h3.y, h3.z, h3.r], [-46, -58.5, -1, 1]);
  const h4 = acts(r.executed[971], 'hole')[0]; // X-42.Y-67.5 沿用 R1 Z-1
  assert.deepEqual([h4.x, h4.y, h4.z, h4.r], [-42, -67.5, -1, 1]);
  assert.equal(acts(r.executed[974], 'hole').length, 0); // M9 不鑽
  const e976 = r.executed[975]; // G91G28G80Z0.
  assert.equal(e976.after.cycle, null);
  assert.equal(acts(e976, 'hole').length, 0);
  assert.equal(acts(e976, 'refReturn').length, 1);
  assert.equal(e976.before.cycle.code, 'G81');
  // 整個 op 6 個孔
  const op = r.ops[6];
  assert.equal(r.executed.filter((e) => e.opIndex === op.index).flatMap((e) => acts(e, 'hole')).length, 6);
});

test('固定循環：Q/P 模態、G83 q、G99 回 R 點、G91 換算', () => {
  const p = prog('G0G90X0.Y0.Z10.\nG99G83X1.Y1.R2.Z-8.Q0.5P100F50\nX2.\nG91X3.R1.Z-3.Q0.7\nG80\nG0Z20.');
  const h1 = p.at(2).actions.find((a) => a.kind === 'hole');
  assert.deepEqual([h1.x, h1.y, h1.r, h1.z, h1.q, h1.p, h1.retract, h1.initialZ], [1, 1, 2, -8, 0.5, 100, 'G99', 10]);
  assert.deepEqual(p.at(2).after.pos, { x: 1, y: 1, z: 2 });
  const h2 = p.at(3).actions[0];
  assert.deepEqual([h2.x, h2.y, h2.r, h2.z, h2.q], [2, 1, 2, -8, 0.5]);
  const h3 = p.at(4).actions[0]; // G91：X 相對、R 相對初始面、Z 相對 R
  assert.deepEqual([h3.x, h3.y, h3.r, h3.z, h3.q], [5, 1, 11, 8, 0.7]);
  assert.equal(p.at(5).after.cycle, null);
  assert.equal(p.at(6).actions[0].kind, 'rapid');
  assert.equal(byRule(p.run, 'R18').length, 0);
});

test('R18：G73/G83 無 Q → error PS0045；循環第一節無 Z/R → error', () => {
  const p = prog('G0G90X0.Y0.Z10.\nG83X1.Y1.R2.Z-8.F50\nG80\nG81X5.F50\nG80');
  const d = byRule(p.run, 'R18', 'error');
  assert.equal(d.length, 2);
  assert.equal(d[0].line, 4);
  assert.equal(d[0].fanucAlarm, 'PS0045');
  assert.equal(d[1].line, 6);
  assert.ok(d[1].message.includes('R') && d[1].message.includes('Z'));
  assert.equal(p.at(4).actions.filter((a) => a.kind === 'hole').length, 1);
});

test('R18：循環中 G28 且同節無 G80 → error PS0044；G28 同節有 G80 → 先取消循環不報', () => {
  const p = prog('G0G90X0.Y0.Z10.\nG81X1.Y1.R2.Z-5.F50\nG91G28Z0.\nG80');
  const d = byRule(p.run, 'R18', 'error');
  assert.equal(d.length, 1);
  assert.equal(d[0].line, 5);
  assert.equal(d[0].fanucAlarm, 'PS0044');
  const ok = prog('G0G90X0.Y0.Z10.\nG81X1.Y1.R2.Z-5.F50\nG91G28G80Z0.');
  assert.equal(byRule(ok.run, 'R18').length, 0);
  assert.equal(ok.at(3).actions[0].kind, 'refReturn');
});

test('R18：G0–G3 與循環同節 → warning，循環取消不鑽孔', () => {
  const p = prog('G0G90X0.Y0.Z10.\nG0G81X1.Y1.R2.Z-5.F50\nX2.');
  assert.equal(byRule(p.run, 'R18', 'warning').length, 1);
  assert.equal(p.at(2).actions.filter((a) => a.kind === 'hole').length, 0);
  assert.equal(p.at(2).actions[0].kind, 'rapid');
  assert.equal(p.at(2).after.cycle, null);
  assert.equal(p.at(3).actions[0].kind, 'rapid');
});

test('G84 剛性攻牙：M29 S → rigid；G80 清除 rigidTap；M29 與 G84 同節亦可', () => {
  const p = prog('G0G90X0.Y0.Z10.M3S200\nM29S200\nG98G84X1.Y1.R3.Z-11.F140\nX5.\nG80\nG84X1.R3.Z-11.F140\nG80\nM29S300G84X2.R3.Z-5.F200\nG80');
  assert.equal(p.at(2).after.rigidTap, true);
  assert.equal(p.at(2).after.rigidTapS, 200);
  assert.equal(p.at(3).actions.find((a) => a.kind === 'hole').rigid, true);
  assert.equal(p.at(4).actions[0].rigid, true);
  assert.equal(p.at(5).after.rigidTap, false);
  assert.equal(p.at(5).after.rigidTapS, null);
  assert.equal(p.at(6).actions[0].rigid, false);
  assert.equal(p.at(8).actions.find((a) => a.kind === 'hole').rigid, true);
  assert.equal(byRule(p.run, 'R21').length, 0);
});

test('R21：M29 與 G84 之間有軸移動或 S → error PS0203；G84 無 F → error', () => {
  const p = prog('G0G90X0.Y0.Z10.M3S200\nM29S200\nG0X5.\nS300\nG98G84X1.Y1.R3.Z-11.F140\nG80\nG84X1.R3.Z-11.\nG80');
  const d = byRule(p.run, 'R21');
  assert.deepEqual(d.map((x) => [x.line, x.severity]), [[5, 'error'], [6, 'error'], [9, 'warning']]);
  assert.equal(d[0].fanucAlarm, 'PS0203');
  const noF = prog('G0G90X0.Y0.Z10.M3S200\nM29S200\nG84X1.R3.Z-11.\nG80');
  const d2 = byRule(noF.run, 'R21', 'error');
  assert.equal(d2.length, 1);
  assert.equal(d2[0].line, 5);
});

// ---------------------------------------------------------------------------
// G28
// ---------------------------------------------------------------------------
test('G28 中間點：G91 Z0. → via = 目前位置、to 只替換回歸軸；之後 pos = to', () => {
  const p = prog('G0G90X10.Y20.Z5.\nG91G28Z0.\nG28X0.');
  const a = p.at(2).actions[0];
  assert.equal(a.kind, 'refReturn');
  assert.deepEqual(a.axes, ['Z']);
  assert.deepEqual(a.from, { x: 10, y: 20, z: 5 });
  assert.deepEqual(a.via, { x: 10, y: 20, z: 5 });
  assert.deepEqual(a.to, { x: 10, y: 20, z: 150 });
  assert.deepEqual(p.at(2).after.pos, { x: 10, y: 20, z: 150 });
  const b = p.at(3).actions[0];
  assert.deepEqual(b.axes, ['X']);
  assert.deepEqual(b.to, { x: 0, y: 20, z: 150 });
  assert.equal(byRule(p.run, 'R17').length, 0);
});

test('R17：G90 且中間點 ≠ 目前位置 → error；兩軸以上 → warning；無軸 → warning', goldenSkip, () => {
  const p = prog('G0G90X10.Y20.Z5.\nG90G28Z0.\nG91G28X0.Y0.\nG28');
  const d = byRule(p.run, 'R17');
  assert.deepEqual(d.map((x) => [x.line, x.severity]), [[4, 'error'], [5, 'warning'], [6, 'warning']]);
  assert.deepEqual(p.at(2).actions[0].via, { x: 10, y: 20, z: 0 });
  assert.deepEqual(p.at(3).actions[0].to, { x: 0, y: 0, z: 150 });
  assert.equal(p.at(4).actions.length, 0);
  const r4 = run(FIX_D).run;
  const w = byRule(r4, 'R17', 'warning');
  assert.ok(w.some((x) => x.line === 541) && w.some((x) => x.line === 552) && w.some((x) => x.line === 560));
  assert.equal(byRule(r4, 'R17', 'error').length, 0);
});

// ---------------------------------------------------------------------------
// 刀徑／刀長補正
// ---------------------------------------------------------------------------
test('G41/G42：啟動節 compStart、G40 節 compEnd；狀態 comp/d', goldenSkip, () => {
  const r = run(FIX_A).run;
  const e14 = r.executed[13]; // G1G41D11X58.F150
  assert.equal(e14.actions[0].compStart, true);
  assert.equal(e14.actions[0].compEnd, undefined);
  assert.equal(e14.after.comp, 'G41');
  assert.equal(e14.after.d, 11);
  assert.equal(e14.before.comp, 'G40');
  const e15 = r.executed[14];
  assert.equal(e15.actions[0].compStart, undefined);
  const e18 = r.executed[17]; // G40Y-90.
  assert.equal(e18.actions[0].compEnd, true);
  assert.equal(e18.after.comp, 'G40');
  assert.equal(acts(e18, 'linear').length, 1);
});

test('G41 無移動節 → compStart 掛到下一個移動動作', () => {
  const p = prog('G0X0.Y0.Z0.\nG41D5\nG1X10.F100\nY10.\nG40\nG0X0.');
  assert.equal(p.at(2).actions.length, 0);
  assert.equal(p.at(3).actions[0].compStart, true);
  assert.equal(p.at(4).actions[0].compStart, undefined);
  assert.equal(p.at(6).actions[0].compEnd, true);
});

test('R09：D0 或 D > maxOffsets → error PS0030；G2/G3 節啟動／取消 → error PS0034', () => {
  const p = prog('G0X0.Y0.Z0.\nG1G41X10.F100\nG40X0.\nG1G41D99X10.\nG40X0.\nG2G41D5X10.Y10.R10.\nG3G40X0.Y0.R10.');
  const d = byRule(p.run, 'R09', 'error');
  assert.deepEqual(d.map((x) => [x.line, x.fanucAlarm]), [[4, 'PS0030'], [6, 'PS0030'], [8, 'PS0034'], [9, 'PS0034']]);
});

test('R13：G41 模態下 M6 / G28 / M30 / 換平面 → error', () => {
  const p = prog('G0X0.Y0.Z0.\nG1G41D5X10.F100\nM6T2\nG91G28Z0.\nG18\nG40G17', { raw: false });
  const d = byRule(p.run, 'R13', 'error');
  assert.deepEqual(d.map((x) => x.line), [5, 6, 7]);
  const m30 = NC.interpret(NC.tokenize('%\nO1\nG0X0.Y0.Z0.\nG1G41D5X10.F100\nM30\n%').blocks, S(), 'off');
  assert.equal(byRule(m30, 'R13', 'error').length, 1);
  assert.equal(byRule(m30, 'R13', 'error')[0].line, 5);
});

test('R16：G43 同節無 Z → warning；新刀第一次 Z 向下前未 G43 → error（每把刀一次）', () => {
  const p = prog('M6T1\nG0G90X0.Y0.G43H1\nZ10.\nM6T2\nG0G90X0.Y0.\nZ10.\nZ5.\nM6T3\nG0G90X0.Y0.G43H3Z10.');
  assert.deepEqual(byRule(p.run, 'R16', 'warning').map((d) => d.line), [4]);
  const e = byRule(p.run, 'R16', 'error');
  assert.equal(e.length, 1);
  assert.equal(e[0].line, 9); // T2 換刀時 Z=10，Z10. 不算向下，Z5. 才是第一次向下
  assert.equal(p.at(2).after.lengthCompActive, true);
  assert.equal(p.at(4).after.lengthCompActive, false);
  assert.equal(p.at(9).after.lengthCompActive, true);
  assert.equal(p.at(9).after.lengthComp, 'G43');
  assert.equal(p.at(9).after.h, 3);
});

// ---------------------------------------------------------------------------
// 其他動作與規則
// ---------------------------------------------------------------------------
test('G05.1 Q1/Q0 → aicc 動作與狀態；R02 不報錯', () => {
  const p = prog('G05.1Q1\nG0X1.\nG05.1Q0');
  assert.deepEqual(p.at(1).actions, [{ kind: 'aicc', on: true }]);
  assert.equal(p.at(1).after.aicc, true);
  assert.equal(p.at(2).after.aicc, true);
  assert.deepEqual(p.at(3).actions, [{ kind: 'aicc', on: false }]);
  assert.equal(p.at(3).after.aicc, false);
  assert.equal(byRule(p.run, 'R02').length, 0);
  assert.equal(byRule(p.run, 'R04').length, 0);
});

test('M3/M4/M5 spindle、M8/M9 coolant、M0/M1/M2/M30 stop、G4 dwell、S 只更新 rpm', () => {
  const p = prog('S1200\nM3\nG0X1.M8\nM5M9\nM4S500\nM0\nM1\nG4P1500\nG4X2.5');
  assert.equal(p.at(1).actions.length, 0);
  assert.equal(p.at(1).after.spindle.rpm, 1200);
  assert.equal(p.at(1).after.spindle.dir, 'M5');
  assert.deepEqual(p.at(2).actions, [{ kind: 'spindle', dir: 'M3', rpm: 1200 }]);
  assert.deepEqual(p.at(3).actions.map((a) => a.kind), ['coolant', 'rapid']);
  assert.equal(p.at(3).after.coolant, true);
  assert.deepEqual(p.at(4).actions, [{ kind: 'spindle', dir: 'M5', rpm: 1200 }, { kind: 'coolant', on: false }]);
  assert.equal(p.at(4).after.coolant, false);
  assert.deepEqual(p.at(5).actions, [{ kind: 'spindle', dir: 'M4', rpm: 500 }]);
  assert.deepEqual(p.at(6).actions, [{ kind: 'stop', code: 'M0' }]);
  assert.deepEqual(p.at(7).actions, [{ kind: 'stop', code: 'M1' }]);
  assert.deepEqual(p.at(8).actions, [{ kind: 'dwell', seconds: 1.5 }]);
  assert.deepEqual(p.at(9).actions, [{ kind: 'dwell', seconds: 2.5 }]);
  assert.deepEqual(p.at(9).after.pos, { x: 1, y: 0, z: 150 }); // G4 的 X 不是座標
  const m30 = p.run.executed[p.run.executed.length - 2];
  assert.deepEqual(m30.actions, [{ kind: 'stop', code: 'M30' }]);
});

test('R02：未知 G → error PS0010；未知 M → info', () => {
  const p = prog('G99.5X1.\nG12X1.\nM77');
  const e = byRule(p.run, 'R02', 'error');
  assert.equal(e.length, 2);
  assert.equal(e[0].fanucAlarm, 'PS0010');
  const i = byRule(p.run, 'R02', 'info');
  assert.equal(i.length, 1);
  assert.equal(i[0].line, 5);
});

test('R03：同節同群組兩個以上 → warning，後者有效', () => {
  const p = prog('G0G1X1.F100\nG90G91X1.\nG17G18');
  const d = byRule(p.run, 'R03', 'warning');
  assert.deepEqual(d.map((x) => x.line), [3, 4, 5]);
  assert.equal(p.at(1).actions[0].kind, 'linear');
  assert.equal(p.at(1).after.motion, 'G1');
  assert.equal(p.at(2).after.distance, 'G91');
  assert.deepEqual(p.at(2).actions[0].to, { x: 2, y: 0, z: 150 });
  assert.equal(p.at(3).after.plane, 'G18');
});

test('R04：無小數點的 X/Y/Z/I/J/K/R（dpi=false）→ warning，值仍照字面用；排除 G05.1 Q、P、S、T、M、N、D、H；dpi=true 不報', () => {
  const src = 'G0X65Y-3.Z10\nG1X1.F100S1000T5D3H3\nG2X2.Y0.R6\nG05.1Q1\nG83X1.R2.Z-5.Q1F50\nG80\nG83X1.R2.Z-5.Q1.F50\nG80';
  const p = prog(src);
  const d = byRule(p.run, 'R04', 'warning');
  assert.deepEqual(d.map((x) => [x.line, x.message.split(' ')[0]]), [[3, 'X65'], [3, 'Z10'], [5, 'R6'], [7, 'Q1']]);
  assert.ok(d[0].message.includes('0.065'));
  assert.deepEqual(p.at(1).actions[0].to, { x: 65, y: -3, z: 10 });
  const p2 = prog(src, { settings: { dpi: true } });
  assert.equal(byRule(p2.run, 'R04').length, 0);
});

test('R08：G1 無 F → error 但仍產生動作', () => {
  const p = prog('G0X0.Y0.Z0.\nG1X10.\nY5.\nF100X0.');
  const d = byRule(p.run, 'R08', 'error');
  assert.equal(d.length, 1);
  assert.equal(d[0].line, 4);
  assert.equal(p.at(2).actions[0].kind, 'linear');
  assert.equal(p.at(2).actions[0].feed, null);
  assert.equal(p.at(4).actions[0].feed, 100);
});

test('R22：,C/,R 在非 G1/G2/G3 節 → warning 被忽略；在 G1 節掛 corner', goldenSkip, () => {
  const p = prog('G0X0.Y0.Z0.\nG0X10.,C0.3\nG1X20.F100,C0.5\nY10.,R2.');
  assert.equal(byRule(p.run, 'R22', 'warning').length, 1);
  assert.equal(byRule(p.run, 'R22', 'warning')[0].line, 4);
  assert.equal(p.at(2).actions[0].corner, undefined);
  assert.deepEqual(p.at(3).actions[0].corner, { c: 0.5 });
  assert.deepEqual(p.at(4).actions[0].corner, { r: 2 });
  const r = run(FIX_A).run;
  assert.deepEqual(r.executed[1014].actions[0].corner, { c: 0.3 });
  assert.deepEqual(r.executed[1218].actions[0].corner, { r: 2 });
});

test('R32：無 O 號 warning；無 M30/M02 error；/M30 warning；% 缺 info', goldenSkip, () => {
  const a = NC.interpret(NC.tokenize('%\nG0X1.\nM30\n%').blocks, S(), 'off');
  assert.equal(byRule(a, 'R32', 'warning').length, 1);
  assert.equal(byRule(a, 'R32', 'warning')[0].line, 0);
  const b = NC.interpret(NC.tokenize('%\nO1\nG0X1.\n%').blocks, S(), 'off');
  assert.equal(byRule(b, 'R32', 'error').length, 1);
  const c = NC.interpret(NC.tokenize('%\nO1\nG0X1.\n/M30\n%').blocks, S(), 'off');
  assert.equal(byRule(c, 'R32', 'error').length, 0);
  assert.equal(byRule(c, 'R32', 'warning').length, 1);
  assert.equal(byRule(c, 'R32', 'warning')[0].line, 4);
  const d = NC.interpret(NC.tokenize('O1\nG0X1.\nM30').blocks, S(), 'off');
  assert.equal(byRule(d, 'R32', 'info').length, 2);
  const e = NC.interpret(NC.tokenize('%\nO1\nG0X1.\nM02\n%').blocks, S(), 'off');
  assert.equal(byRule(e, 'R32').length, 0);
  for (const f of FIXTURES) assert.equal(byRule(run(f).run, 'R32').length, 0, f);
});

// ---------------------------------------------------------------------------
// 情境
// ---------------------------------------------------------------------------
test('情境 on：skipLevelsOn 控制 /n；多斜線依 multiSlash（asSingle / ignoreBlock / alarm）', () => {
  const src = 'G0X0.Y0.Z0.\n/X1.\n/2X2.\n//X3.\nX4.';
  const on = prog(src, { scenario: 'on' });
  assert.deepEqual([2, 3, 4, 5].map((l) => on.at(l).skipped), [true, false, true, false]);
  assert.deepEqual(on.at(5).actions[0].from, { x: 2, y: 0, z: 0 });
  const lv2 = prog(src, { scenario: 'on', settings: { skipLevelsOn: [2] } });
  assert.deepEqual([2, 3, 4, 5].map((l) => lv2.at(l).skipped), [false, true, false, false]);
  const ign = prog(src, { scenario: 'on', settings: { multiSlash: 'ignoreBlock' } });
  assert.equal(ign.at(4).ignored, true);
  assert.equal(ign.at(4).skipped, false);
  assert.equal(ign.at(4).actions.length, 0);
  const alarm = prog(src, { scenario: 'on', settings: { multiSlash: 'alarm' } });
  assert.equal(alarm.at(4).skipped, false);
  assert.equal(alarm.at(4).actions.length, 1);
  const mi = prog(src, { scenario: 'multiIgnored' });
  assert.deepEqual([2, 3, 4, 5].map((l) => mi.at(l).ignored), [false, false, true, false]);
  assert.deepEqual([2, 3, 4, 5].map((l) => mi.at(l).actions.length), [1, 1, 0, 1]);
  assert.equal(mi.run.scenario, 'multiIgnored');
});

test('情境 on：樣本 A 被跳過的節不影響狀態；ops 數不變', goldenSkip, () => {
  const on = run(FIX_A, 'on').run;
  const off = run(FIX_A, 'off').run;
  assert.equal(on.ops.length, 22);
  const e286 = on.executed[285]; // /Z-5.
  assert.equal(e286.skipped, true);
  assert.equal(e286.after.pos.z, -2.5);
  assert.equal(off.executed[285].after.pos.z, -5);
  assert.equal(on.executed[286].actions[0].from.z, -2.5);
});

test('接受 TokenizeResult 物件當第一個參數', () => {
  const tok = NC.tokenize('%\nO1\nG0X1.\nM30\n%');
  const r = NC.interpret(tok, S(), 'off');
  assert.equal(r.executed.length, 5);
});

test('效能：樣本 A tokenize + interpret < 100 ms', goldenSkip, () => {
  const text = fixture(FIX_A);
  NC.interpret(NC.tokenize(text).blocks, S(), 'off'); // 暖身
  const t0 = performance.now();
  const tok = NC.tokenize(text);
  const t1 = performance.now();
  NC.interpret(tok.blocks, S(), 'off');
  const t2 = performance.now();
  console.log(`  樣本 A: tokenize ${(t1 - t0).toFixed(2)} ms + interpret ${(t2 - t1).toFixed(2)} ms = ${(t2 - t0).toFixed(2)} ms`);
  assert.ok(t2 - t0 < 100, `tokenize+interpret 花了 ${(t2 - t0).toFixed(1)} ms`);
});


// ---------------------------------------------------------------------------
// 審查修正：不模擬的碼要講出來、不能報假警報，也不能靜靜吞掉
// ---------------------------------------------------------------------------
test('M98：副程式呼叫要出 warning，不能靜靜吞掉（整段沒預演卻顯示乾淨最危險）', () => {
  const p = prog('M98P9000L2');
  const d = byRule(p.run, 'R02', 'warning').find((x) => /M98/.test(x.message));
  assert.ok(d, 'M98 一定要有診斷');
  assert.match(d.message, /O9000/);
  assert.match(d.message, /2 次/);
  assert.match(d.detail, /素材|碰撞/);
  const a = p.at(1).actions.find((x) => x.kind === 'subCall');
  assert.ok(a && a.program === 9000 && a.repeat === 2, 'P/L 要記進 Action 供之後統計');
});

test('M99：主程式裡出現 → info 說明這支可能是副程式', () => {
  const p = prog('M99');
  assert.equal(byRule(p.run, 'R02', 'info').filter((d) => /M99/.test(d.message)).length, 1);
  assert.equal(byRule(p.run, 'R02', 'error').length, 0);
});

test('0i／30i 標配但本工具不模擬的 G 碼 → info/warning，不是 error PS0010', () => {
  for (const code of ['G64', 'G61', 'G09', 'G15', 'G62', 'G63', 'G69', 'G50']) {
    const p = prog(code + '\nG0X10.Y10.');
    assert.equal(byRule(p.run, 'R02', 'error').length, 0, code + ' 不該報 error');
    assert.ok(byRule(p.run, 'R02').length > 0, code + ' 要有一則說明');
    assert.ok(p.at(2).actions.some((a) => a.kind === 'rapid'), code + ' 之後的移動要照畫');
  }
});

test('G68 座標旋轉：warning，而且不可以把旋轉中心當成移動終點畫幽靈路徑', () => {
  const p = prog('G68X0.Y0.R30.');
  const w = byRule(p.run, 'R02', 'warning').find((d) => /G68/.test(d.message));
  assert.ok(w);
  assert.equal(byRule(p.run, 'R02', 'error').length, 0);
  assert.equal(p.at(1).actions.length, 0, 'G68 節不產生移動');
  assert.equal(byRule(p.run, 'R02').filter((d) => /尚未指定/.test(d.message)).length, 0);
});

test('G65 巨集呼叫：warning「該段未預演」，引數不當座標', () => {
  const p = prog('G65P9010X10.Y20.Z-5.');
  assert.ok(byRule(p.run, 'R02', 'warning').some((d) => /G65/.test(d.message)));
  assert.equal(p.at(1).actions.length, 0);
});

test('真的查無此碼 → 仍是 error PS0010，但不產生幽靈路徑', () => {
  const p = prog('G100X10.');
  const e = byRule(p.run, 'R02', 'error');
  assert.equal(e.length, 1);
  assert.equal(e[0].fanucAlarm, 'PS0010');
  assert.equal(p.at(1).actions.length, 0);
});

test('G53：不畫路徑、發 warning，位置視為到參考點（免得被 R27 判成往工件裡撞）', () => {
  const p = prog('G0G90X0.Y0.\nG1Z-5.F100\nG53G0Z0.');
  const w = byRule(p.run, 'R02', 'warning').find((d) => /G53/.test(d.message));
  assert.ok(w);
  assert.equal(p.at(3).actions.length, 0, 'G53 節不產生移動');
  assert.equal(p.run.finalState.pos.z, S().refPosition.z);
});

// ---------------------------------------------------------------------------
// 審查修正：R04 只查「值是 mm 距離」的位址
// ---------------------------------------------------------------------------
test('R04：固定循環的 K（重複次數）不是距離，不可以叫人加小數點', () => {
  const p = prog('G90G99G81X10.Y0.Z-5.R2.K3F100\nG80');
  assert.equal(byRule(p.run, 'R04').filter((d) => /K3/.test(d.message)).length, 0);
});

test('R04：I/J 只在圓弧節查；G17 的 K 一律不查', () => {
  const p = prog('G0X0.Y0.\nG1X1.F100\nG2X10.Y0.I5J0\nG1X20.K3');
  const hits = byRule(p.run, 'R04').map((d) => d.message);
  assert.ok(hits.some((m) => /I5/.test(m)), '圓弧節的 I 要查');
  assert.ok(!hits.some((m) => /K3/.test(m)), 'G17 平面的 K 不是距離');
});

test('R04：,C1 沒有小數點也要查（DPI=0 時是 0.001 mm 的倒角）', () => {
  const p = prog('G0X0.Y0.\nG1X10.,C1F100\nG1Y10.');
  const d = byRule(p.run, 'R04').find((x) => /,C1/.test(x.message));
  assert.ok(d);
  assert.match(d.message, /0\.001 mm/);
});

test('G4 X 無小數點：訊息與 dwell 動作要用同一個數字', () => {
  const p = prog('G4X1000');
  const d = byRule(p.run, 'R04').find((x) => /G4/.test(x.message));
  assert.match(d.message, /1 秒/);
  assert.equal(p.at(1).actions[0].seconds, 1);
  assert.equal(prog('G4X2.').at(1).actions[0].seconds, 2);
});

// ---------------------------------------------------------------------------
// 審查修正：R23 容差、攻牙主軸方向、固定循環重複次數
// ---------------------------------------------------------------------------
test('R23：半徑差在 0.01 mm 之內（CAM 四捨五入）不報錯，仍畫成圓弧', () => {
  const p = prog('G0X0.Y0.\nG1X0.Y0.F100\nG3Y22.001R11.');
  assert.equal(byRule(p.run, 'R23').length, 0);
  assert.equal(p.at(3).actions[0].kind, 'arc');
  const bad = prog('G0X0.Y0.\nG1X0.Y0.F100\nG3Y23.R11.');
  assert.equal(byRule(bad.run, 'R23', 'error').length, 1);
  assert.equal(bad.at(3).actions[0].kind, 'linear');
});

test('R21：G84 要 M3、G74 要 M4，方向反了 → error（會斷絲攻）', () => {
  const bad = prog('M4S500\nG90G99G84X0.Y0.Z-10.R2.F500\nG80');
  const e = byRule(bad.run, 'R21', 'error').find((d) => /G84/.test(d.message));
  assert.ok(e);
  assert.match(e.detail, /斷/);
  const ok1 = prog('M3S500\nG90G99G84X0.Y0.Z-10.R2.F500\nG80');
  assert.equal(byRule(ok1.run, 'R21', 'error').length, 0);
  const bad2 = prog('M3S500\nG90G99G74X0.Y0.Z-10.R2.F500\nG80');
  assert.ok(byRule(bad2.run, 'R21', 'error').some((d) => /G74/.test(d.message)));
  const stopped = prog('G90G99G84X0.Y0.Z-10.R2.F500\nG80');
  assert.ok(byRule(stopped.run, 'R21', 'error').some((d) => /停止/.test(d.message)));
});

test('固定循環 + 第四軸：G91 A45. K7 每重複一次再轉 45°，7 個孔各自帶轉動起點', () => {
  // 分度鑽孔的標準寫法。以前 K 重複只累加 X/Y，7 個孔全疊在 A45：畫面只剩兩個孔、R19 誤報、少算 6 次分度時間。
  const p = prog('G0G90X10.Y0.A0.Z60.\nG81R2.Z-1.F65\nG91A45.K7\nG80');
  assert.equal(acts(p.at(2), 'hole').length, 1);                                    // 第一個孔在 A0
  const holes = acts(p.at(3), 'hole');
  assert.equal(holes.length, 7);
  assert.deepEqual(holes.map((h) => h.a), [45, 90, 135, 180, 225, 270, 315]);
  assert.deepEqual(holes.map((h) => h.aFrom), [0, 45, 90, 135, 180, 225, 270]);   // 每個孔前面都有一次轉動
  for (const h of holes) { near(h.x, 10); near(h.y, 0); near(h.z, -1); }
  assert.equal(p.at(3).after.a, 315);
  // 同節 X 與 A 一起增量也各自累加；X/Y 陣列孔的既有行為不變
  const both = prog('G0G90X0.Y0.A0.Z60.\nG91G99G81X10.A90.Z-5.R-8.K3F100\nG80');
  assert.deepEqual(acts(both.at(2), 'hole').map((h) => [h.x, h.a]), [[10, 90], [20, 180], [30, 270]]);
});

test('固定循環的重複次數：G91 + K3 → 展開成 3 個孔；G90 + K3 → 1 個孔加 warning', () => {
  const inc = prog('G91G99G81X10.Y0.Z-5.R-8.K3F100\nG80');
  const holes = inc.at(1).actions.filter((a) => a.kind === 'hole');
  assert.equal(holes.length, 3);
  assert.deepEqual(holes.map((h) => h.x), [10, 20, 30]);
  const abs = prog('G90G99G81X10.Y0.Z-5.R2.K3F100\nG80');
  assert.equal(abs.at(1).actions.filter((a) => a.kind === 'hole').length, 1);
  assert.ok(byRule(abs.run, 'R18', 'warning').some((d) => /同一個位置重複鑽 3 次/.test(d.message)));
  const withL = prog('G91G99G81X10.Y0.Z-5.R-8.L2F100\nG80');
  assert.equal(withL.at(1).actions.filter((a) => a.kind === 'hole').length, 2);
});

test('G87 背搪孔：interpreter 要先講清楚本工具只是近似', () => {
  const p = prog('G90G99G87X0.Y0.Z-10.R2.Q1.F100\nG80');
  assert.ok(byRule(p.run, 'R18', 'warning').some((d) => /G87/.test(d.message)));
});

// ---------------------------------------------------------------------------
// 審查修正：節中斜線依情境執行
// ---------------------------------------------------------------------------
test('節中斜線：開關關（off）照跑尾段，不會衍生假的 R08', () => {
  const p = prog('G0X0.Y0.\nG1X10./X20.F100');
  assert.equal(byRule(p.run, 'R08').length, 0, '尾段的 F100 要算數');
  assert.equal(p.at(2).actions[0].to.x, 20);
  assert.equal(p.at(2).actions[0].feed, 100);
  assert.ok(byRule(p.run, 'R02', 'info').some((d) => /節中間有斜線/.test(d.message)));
});

test('節中斜線：開關開（on）才忽略尾段', () => {
  const p = prog('G0X0.Y0.\nG1X10./X20.F100', { scenario: 'on' });
  assert.equal(p.at(2).actions[0].to.x, 10);
});

test('最後一個作業的行號範圍不延伸到 M30 之後的空行與 %', () => {
  const p = prog('M6T1\nG0X0.Y0.');
  const last = p.run.ops[p.run.ops.length - 1];
  assert.equal(last.lineEnd, 5, 'M30 那一行（5）是最後一行，% 不算');
});
