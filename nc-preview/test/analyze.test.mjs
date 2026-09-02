// analyze.js 測試：四支真實程式的完整分析（analyzeSync / analyze + 模擬）、診斷合併去重排序、中止、
// request 預設值與使用者資料覆蓋，並印出每支程式的診斷統計與耗時。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadNC, fixture, FIXTURES, ROOT, goldenSkip, FIX_A, FIX_B, FIX_C, FIX_D } from './load.mjs';

const NC = loadNC();
const hasRules = !!(NC.rules && typeof NC.rules.run === 'function');
const SEV_ORDER = { error: 0, warning: 1, needsInput: 2, info: 3 };

function req(text, extra) {
  return Object.assign(NC.analysis.defaultRequest(text), extra || {});
}
function ms(t0) {
  return Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 10) / 10;
}
function now() {
  return process.hrtime.bigint();
}
/** 診斷統計：{error:n, warning:n, …} 與 {R05:n, …} */
function stats(diags) {
  const sev = {}, rule = {};
  for (const d of diags) {
    sev[d.severity] = (sev[d.severity] || 0) + 1;
    rule[d.ruleId] = (rule[d.ruleId] || 0) + 1;
  }
  return { sev, rule };
}
function fmtCounts(o) {
  return Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join(' ') || '（無）';
}

// ---------------------------------------------------------------------------
// 基本結構
// ---------------------------------------------------------------------------
test('analyze：模組有掛上去', () => {
  assert.equal(typeof NC.analyze, 'function');
  assert.equal(typeof NC.analyzeSync, 'function');
  assert.equal(typeof NC.analysis.defaultRequest, 'function');
  assert.equal(typeof NC.analysis.isAbortError, 'function');
});

test('analyzeSync：四支程式都不拋錯，且有 toolTable / stock / diagnostics / scenarios', goldenSkip, () => {
  console.log('\n— analyzeSync（不含模擬）—' + (hasRules ? '' : '（rules.js 尚未載入，規則診斷從缺）'));
  for (const f of FIXTURES) {
    const t0 = now();
    const r = NC.analyzeSync(req(fixture(f)));
    const took = ms(t0);

    // 結構
    assert.ok(r.tok && Array.isArray(r.tok.blocks) && r.tok.blocks.length > 0, `${f}: tok`);
    assert.ok(r.scenarios && r.scenarios.off && r.scenarios.on, `${f}: scenarios`);
    for (const sc of ['off', 'on']) {
      const sr = r.scenarios[sc];
      assert.equal(sr.run.scenario, sc, `${f}: run.scenario ${sc}`);
      assert.ok(Array.isArray(sr.run.executed) && sr.run.executed.length === r.tok.blocks.length, `${f}: executed 與 blocks 對齊`);
      assert.ok(Array.isArray(sr.geometry.segments), `${f}: segments`);
      assert.equal(sr.sim, null, `${f}: analyzeSync 不跑模擬`);
    }
    assert.ok(r.toolTable && Array.isArray(r.toolTable.tools) && r.toolTable.tools.length > 0, `${f}: toolTable.tools`);
    assert.ok(Array.isArray(r.toolTable.offsets), `${f}: toolTable.offsets`);
    assert.ok(r.toolTable.programKey, `${f}: programKey`);
    assert.ok(r.stock && r.stock.min && r.stock.max, `${f}: stock`);
    assert.equal(r.stock.source, 'estimated', `${f}: 沒給素材就用推估`);
    assert.ok(r.stock.max.x > r.stock.min.x && r.stock.max.y > r.stock.min.y && r.stock.max.z > r.stock.min.z, `${f}: 素材尺寸`);
    assert.ok(Array.isArray(r.diagnostics), `${f}: diagnostics`);

    const st = stats(r.diagnostics);
    const ops = r.scenarios.off.run.ops.length;
    const segs = r.scenarios.off.geometry.segments.length;
    console.log(`  ${f}：${took} ms｜行 ${r.tok.blocks.length}、作業 ${ops}、段 ${segs}、刀 ${r.toolTable.tools.length}、診斷 ${r.diagnostics.length}`);
    console.log(`      嚴重度 ${fmtCounts(st.sev)}`);
    console.log(`      規則   ${fmtCounts(st.rule)}`);
  }
});

test('analyzeSync：樣本 A 兩個情境跑完仍在 1 秒內（效能目標）', goldenSkip, () => {
  const text = fixture(FIX_A);
  NC.analyzeSync(req(text)); // 暖機
  const t0 = now();
  const r = NC.analyzeSync(req(text));
  const took = ms(t0);
  console.log(`\n  樣本 A analyzeSync（off + on）：${took} ms`);
  assert.ok(took < 1000, `analyzeSync 太慢：${took} ms`);
  assert.equal(r.tok.blocks.length, 1593);
});

// ---------------------------------------------------------------------------
// 診斷合併：排序、去重、id、scenario 標記
// ---------------------------------------------------------------------------
test('診斷：依 error > warning > needsInput > info 再依行號排序', goldenSkip, () => {
  for (const f of FIXTURES) {
    const d = NC.analyzeSync(req(fixture(f))).diagnostics;
    for (let i = 1; i < d.length; i++) {
      const a = d[i - 1], b = d[i];
      const ra = SEV_ORDER[a.severity], rb = SEV_ORDER[b.severity];
      assert.ok(ra != null && rb != null, `${f}: 未知嚴重度 ${a.severity}/${b.severity}`);
      assert.ok(ra < rb || (ra === rb && a.line <= b.line), `${f}: 排序錯了 #${i} ${a.severity}L${a.line} → ${b.severity}L${b.line}`);
    }
  }
});

test('診斷：含模擬時排序仍然成立（降級發生在排序之前）', goldenSkip, async () => {
  // 推估素材會把 R27/R28 的 error 降成 warning；降級如果發生在排序之後，
  // 整張清單會被一堆「本來是 error」的 warning 佔在最前面，真正的 error 被埋掉。
  for (const f of FIXTURES) {
    const d = (await NC.analyze(req(fixture(f), { sim: { enabled: true, cell: 0.5 } }))).diagnostics;
    for (let i = 1; i < d.length; i++) {
      const a = d[i - 1], b = d[i];
      const ra = SEV_ORDER[a.severity], rb = SEV_ORDER[b.severity];
      assert.ok(ra < rb || (ra === rb && a.line <= b.line), `${f}: 排序錯了 #${i} ${a.severity}L${a.line} → ${b.severity}L${b.line}`);
    }
    const firstError = d.findIndex((x) => x.severity === 'error');
    if (firstError >= 0) assert.equal(firstError, 0, `${f}: error 應該排在最前面`);
  }
});

test('診斷：推估素材時，依賴素材的規則一律附註判定依據', goldenSkip, async () => {
  const r = await NC.analyze(req(fixture(FIX_B), { sim: { enabled: true, cell: 0.5 } }));
  assert.equal(r.stock.source, 'estimated');
  const dep = r.diagnostics.filter((d) => ['R06', 'R20', 'R27', 'R28', 'R36'].includes(d.ruleId)
    && (d.severity === 'error' || d.severity === 'warning'));
  assert.ok(dep.length > 0);
  for (const d of dep) {
    assert.equal(d.estimatedStock, true, `${d.ruleId} L${d.line} 要標明依據推估素材`);
    assert.match(d.detail, /推估素材/);
    // 還留著紅字的，一定是干涉位置落在「程式真的有切到的範圍」之內
    if (d.severity === 'error') assert.equal(d.estimatedStockInside, true, `${d.ruleId} L${d.line}`);
  }
});

test('契約 §5：樣本 B 用推估素材跑完沒有 R27 error（外擴的那一圈不算數）', goldenSkip, async () => {
  const r = await NC.analyze(req(fixture(FIX_B), { sim: { enabled: true, cell: 0.5 } }));
  assert.equal(r.stock.source, 'estimated');
  const bad = r.diagnostics.filter((d) => d.ruleId === 'R27' && d.severity === 'error');
  assert.deepEqual(bad.map((d) => `L${d.line} ${d.message}`), []);
  // 但那一段還是要被看見（降成 warning，不是消失）
  assert.ok(r.diagnostics.some((d) => d.ruleId === 'R27' && d.line === 443 && d.severity === 'warning'));
});

// 這一條原本斷言這個 G0 下刀點必須維持 error（審查者假設那 44 mm 是實心料）。
// 整合者複查後改判：刀具涵蓋的範圍有一部分落在成品輪廓之外，干涉點就在外面那一段，
// 且該處材料是「未加工的毛胚頂面」（程式從沒在那裡切過）。
// 程式用 G0 全深下刀、又在切深橫越中央，可知毛胚是前工程的半成品，
// 不是實心方料；那裡到底有沒有料只有毛胚尺寸能回答。
// 把「取決於毛胚」的事說成確定的撞刀，和漏報一樣會讓現場不再相信紅字，
// 所以改成 warning + 明講需要什麼資料；填入真實素材後會重新判定。
test('樣本 D 推估素材下，工件輪廓外的 G0 深下刀降為 warning 但保留干涉深度與原因', goldenSkip, async () => {
  const r = await NC.analyze(req(fixture(FIX_D), { sim: { enabled: true, cell: 0.5 } }));
  assert.equal(r.stock.source, 'estimated');
  const d = r.diagnostics.find((x) => x.ruleId === 'R27' && x.line === 227);
  assert.ok(d, 'L227 一定要有 R27');
  assert.equal(d.severity, 'warning', '干涉點在工件輪廓外、材料未經加工 → 取決於毛胚，不能報成確定的撞刀');
  assert.ok(d.magnitude > 40, `干涉深度仍要保留：${d.magnitude}`);
  assert.match(d.detail, /推估素材/, '要註明依據');
  assert.match(d.detail, /毛胚/, '要說明需要什麼資料才能確認');
});

test('推估素材：工件輪廓內、程式自己切出來的材料，紅字要留著', goldenSkip, async () => {
  const r = await NC.analyze(req(fixture(FIX_A), { sim: { enabled: true, cell: 0.5 } }));
  assert.equal(r.stock.source, 'estimated');
  const errs = r.diagnostics.filter((d) => d.severity === 'error');
  assert.ok(errs.length > 0, '不能因為降級就把真正的問題全部消音');
  // L1147：////G0Z5. 被跳過後在 Z-36 的實心材料裡斜切（材料是前面工序挖出來的底面，
  // 干涉位置落在工件輪廓內 → 不論毛胚多大那塊料都存在）
  const d = errs.find((x) => x.line === 1147);
  assert.ok(d, 'L1147 必須是 error');
  assert.equal(d.scenario, 'on', '這是 block skip 開關「開」才會發生的');
});

test('推估素材：正常生產（開關關）四支程式不該有紅字', goldenSkip, async () => {
  for (const f of FIXTURES) {
    const r = await NC.analyze(req(fixture(f), { scenarios: ['off'], sim: { enabled: true, cell: 0.5 } }));
    const errs = r.diagnostics.filter((d) => d.severity === 'error');
    assert.equal(errs.length, 0,
      `${f} 在開關關、素材為推估值時出現 ${errs.length} 筆紅字：`
      + errs.slice(0, 3).map((d) => `L${d.line} ${d.ruleId} ${d.message}`).join(' / '));
  }
});

test('診斷分組：摺疊列的代表要挑組內最嚴重的一筆，不是行號最小的', goldenSkip, async () => {
  const r = await NC.analyze(req(fixture(FIX_D), { sim: { enabled: true, cell: 0.5 } }));
  const groups = new Map();
  for (const d of r.diagnostics) {
    if (!groups.has(d.groupKey)) groups.set(d.groupKey, []);
    groups.get(d.groupKey).push(d);
  }
  for (const [, arr] of groups) {
    const lead = arr.find((d) => d.groupFirst);
    assert.ok(lead, '每組都要有一個代表');
    const mags = arr.map((d) => (typeof d.magnitude === 'number' ? d.magnitude : -1));
    const max = Math.max.apply(null, mags);
    if (max > 0) {
      const leadMag = typeof lead.magnitude === 'number' ? lead.magnitude : -1;
      assert.equal(leadMag, max, `代表 L${lead.line} 的 magnitude ${leadMag} 不是組內最大 ${max}`);
    }
  }
  // 那一組 25 筆的 R27 代表必須是最深的那一筆，而且要標出範圍
  const big = [...groups.values()].filter((a) => a.length > 5 && a[0].ruleId === 'R27');
  assert.ok(big.length > 0);
  for (const arr of big) {
    const lead = arr.find((d) => d.groupFirst);
    assert.ok(lead.groupRange && lead.groupRange.max >= lead.groupRange.min);
    assert.equal(lead.groupLines.length, arr.length);
  }
});

test('R17：G28 多軸同動時 Z 已高過素材頂面 → 降成 info，還在低處才是 warning', goldenSkip, async () => {
  // 四支程式的 G91G28Y0.Z0. 都是刻意把工作台送到前面方便卸料，Z 早就拉到 Z30/Z50
  const r = await NC.analyze(req(fixture(FIX_D)));
  const multi = r.diagnostics.filter((d) => d.ruleId === 'R17' && d.multiAxis);
  assert.ok(multi.length >= 3);
  const top = r.stock.max.z;
  for (const d of multi) {
    assert.ok(d.pos, 'R17 多軸診斷要帶執行到該行時的位置');
    const safe = d.pos.z >= top + 5;
    assert.equal(d.severity, safe ? 'info' : 'warning', `L${d.line} Z${d.pos.z}（素材頂 ${top}）`);
  }
  // L541 的 Z 只有 5（素材頂 2 以上 3 mm）→ 仍然是 warning
  const low = multi.find((d) => d.line === 541);
  assert.ok(low && low.severity === 'warning');
});

test('診斷：同 ruleId+line+scenario+message 只留一則，id 唯一', goldenSkip, () => {
  for (const f of FIXTURES) {
    const d = NC.analyzeSync(req(fixture(f))).diagnostics;
    const keys = new Set(), ids = new Set();
    for (const x of d) {
      const k = [x.ruleId, x.line, x.scenario || '', x.message].join('|');
      assert.ok(!keys.has(k), `${f}: 重複診斷 ${k}`);
      keys.add(k);
      assert.ok(!ids.has(x.id), `${f}: 重複 id ${x.id}`);
      ids.add(x.id);
      assert.ok(x.scenario === undefined || ['off', 'on', 'multiIgnored'].includes(x.scenario), `${f}: scenario 值不合法 ${x.scenario}`);
      assert.equal(typeof x.message, 'string');
      assert.ok(x.line >= 0);
    }
  }
});

test('診斷：兩情境都有的不標 scenario，只有單一情境有的才標', goldenSkip, () => {
  // 樣本 B 有 / 節（254、349、375、401），on 情境會跳過 → 兩邊診斷不同
  const r = NC.analyzeSync(req(fixture(FIX_B)));
  const tagged = r.diagnostics.filter((d) => d.scenario);
  const plain = r.diagnostics.filter((d) => !d.scenario);
  assert.ok(plain.length > 0, '應該有與情境無關的診斷');
  console.log(`\n  樣本 B：共同診斷 ${plain.length} 則、情境專屬 ${tagged.length} 則` +
    (tagged.length ? `（${[...new Set(tagged.map((d) => d.scenario))].join('/')}）` : ''));
  // 標了 scenario 的，必定只在該情境的來源裡出現
  for (const d of tagged) {
    const src = r.scenarios[d.scenario];
    const inSrc = [...src.run.diagnostics, ...src.geometry.diagnostics]
      .some((x) => x.ruleId === d.ruleId && x.line === d.line && x.message === d.message);
    assert.ok(inSrc || hasRules, `情境專屬診斷應來自該情境：${d.ruleId} L${d.line}`);
  }
});

test('診斷：只在 off 發生的錯誤會標上 scenario', () => {
  // /G1X10. 沒有 F：off 會執行（R08 error）；on 把這節跳過 → 只有 off 有這則診斷
  const r = NC.analyzeSync({ text: '%\nO0001\nG0G90G54X0.Y0.\n/G1X10.\nG0Z10.\nM30\n%\n' });
  const r08 = r.diagnostics.filter((d) => d.ruleId === 'R08' && d.line === 4 && d.severity === 'error');
  assert.equal(r08.length, 1, '同一則錯誤不該兩個情境各留一份');
  assert.equal(r08[0].scenario, 'off', '只有 off 會執行這節 → 要標成 off');
});

test('診斷：tokenizer / interpreter / geometry 的診斷都有進來', goldenSkip, () => {
  const f = FIX_A;
  const r = NC.analyzeSync(req(fixture(f)));
  const inResult = (d) => r.diagnostics.some((x) => x.ruleId === d.ruleId && x.line === d.line && x.message === d.message);
  for (const d of r.scenarios.off.run.diagnostics) assert.ok(inResult(d), `interpreter 診斷漏了 ${d.ruleId} L${d.line}`);
  for (const d of r.scenarios.off.geometry.diagnostics) assert.ok(inResult(d), `geometry 診斷漏了 ${d.ruleId} L${d.line}`);
  for (const d of r.tok.diagnostics) assert.ok(inResult(d), `tokenizer 診斷漏了 ${d.ruleId} L${d.line}`);
});

// ---------------------------------------------------------------------------
// request 的處理
// ---------------------------------------------------------------------------
test('request：預設情境為 off + on；指定 ["on"] 時仍會補上 off（比較基準）', goldenSkip, () => {
  const text = fixture(FIX_C);
  const a = NC.analyzeSync({ text });
  assert.deepEqual(Object.keys(a.scenarios), ['off', 'on']);
  const b = NC.analyzeSync({ text, scenarios: ['on'] });
  assert.deepEqual(Object.keys(b.scenarios), ['off', 'on']);
  const c = NC.analyzeSync({ text, scenarios: ['off', 'multiIgnored'] });
  assert.deepEqual(Object.keys(c.scenarios), ['off', 'multiIgnored']);
  assert.equal(c.scenarios.multiIgnored.run.scenario, 'multiIgnored');
});

test('request：只有 text 也能跑（settings/sim/scenarios 都有預設）', () => {
  const r = NC.analyzeSync({ text: '%\nO0001\nG0X10.\nM30\n%\n' });
  assert.equal(r.tok.programNumber, 1);
  assert.ok(r.stock && r.toolTable);
  assert.ok(Array.isArray(r.diagnostics));
});

test('request：空字串不會爆', () => {
  const r = NC.analyzeSync({ text: '' });
  assert.ok(Array.isArray(r.diagnostics));
  assert.ok(r.stock.min && r.stock.max);
});

test('request.stock：有給就照用（source 保持 user）', goldenSkip, () => {
  const stock = { min: { x: -65, y: -10, z: -15 }, max: { x: 65, y: 50, z: 0 }, source: 'user', fixtures: [] };
  const r = NC.analyzeSync(req(fixture(FIX_C), { stock }));
  assert.equal(r.stock.source, 'user');
  assert.deepEqual(r.stock.min, stock.min);
  assert.deepEqual(r.stock.max, stock.max);
  assert.notEqual(r.stock.min, stock.min, '應該是複本，不要就地共用');
});

test('request.toolTable：使用者填的直徑與補正覆蓋推測值', goldenSkip, () => {
  const text = fixture(FIX_A);
  const before = NC.analyzeSync(req(text));
  const t11 = before.toolTable.tools.find((t) => t.t === 11);
  assert.ok(t11, '應該有 T11');
  const saved = {
    programKey: before.toolTable.programKey,
    tools: [{ t: 11, label: 'T11', type: 'endmill', diameter: 11.8, angle: null, fluteLen: null, stickout: null, pitch: null, resident: false, probe: false, source: { diameter: 'user' } }],
    offsets: [{ n: 11, lenGeom: 0, lenWear: 0, radGeom: 5.9, radWear: 0.01, source: 'user' }],
    updatedAt: new Date().toISOString(),
  };
  const after = NC.analyzeSync(req(text, { toolTable: saved }));
  const merged = after.toolTable.tools.find((t) => t.t === 11);
  assert.equal(merged.diameter, 11.8);
  assert.equal(merged.source.diameter, 'user');
  const off11 = after.toolTable.offsets.find((o) => o.n === 11);
  assert.equal(off11.radGeom, 5.9);
  assert.equal(off11.source, 'user');
  // 其他 D 號仍有預設值
  assert.ok(after.toolTable.offsets.length >= before.toolTable.offsets.length);
  // 補正值改了 → 補正後的路徑跟著改
  const compBefore = before.scenarios.off.geometry.segments.filter((s) => s.path === 'compensated').length;
  const compAfter = after.scenarios.off.geometry.segments.filter((s) => s.path === 'compensated').length;
  assert.ok(compBefore > 0 && compAfter > 0);
});

test('request：D 號的預設補正用「使用該 D 的作業的刀」直徑', goldenSkip, () => {
  const r = NC.analyzeSync(req(fixture(FIX_B)));
  // 樣本 B 用 D30/D31，刀是 T1（12MM）→ 半徑 6
  for (const n of [30, 31]) {
    const o = r.toolTable.offsets.find((x) => x.n === n);
    assert.ok(o, `應該有 D${n} 的預設補正`);
    assert.equal(o.radGeom, 6, `D${n} 預設半徑`);
    assert.equal(o.source, 'default');
  }
});

// ---------------------------------------------------------------------------
// 模擬
// ---------------------------------------------------------------------------
test('analyze：sim.enabled=false 時不跑模擬，結果與 analyzeSync 一致', goldenSkip, async () => {
  const text = fixture(FIX_C);
  const a = NC.analyzeSync(req(text));
  const b = await NC.analyze(req(text));
  assert.equal(b.scenarios.off.sim, null);
  assert.equal(b.scenarios.on.sim, null);
  assert.equal(b.diagnostics.length, a.diagnostics.length);
});

test('analyze：樣本 C 含模擬（cell 0.5）5 秒內跑完', goldenSkip, async () => {
  const t0 = now();
  const stages = [];
  const r = await NC.analyze(req(fixture(FIX_C), { sim: { enabled: true, cell: 0.5 } }),
    (stage, sc, p) => { stages.push(stage + (sc ? ':' + sc : '') + (p != null ? ':' + p.toFixed(2) : '')); });
  const took = ms(t0);
  console.log(`\n— analyze + 模擬 —\n  樣本 C cell 0.5：${took} ms`);
  for (const sc of ['off', 'on']) {
    const sim = r.scenarios[sc].sim;
    assert.ok(sim, `${sc} 應該有模擬結果`);
    assert.equal(sim.scenario, sc);
    assert.equal(sim.cell, 0.5);
    assert.ok(sim.nx > 0 && sim.ny > 0 && sim.height.length === sim.nx * sim.ny);
    assert.ok(Array.isArray(sim.events));
    const st = stats(sim.events);
    console.log(`      ${sc}：格 ${sim.nx}×${sim.ny}、事件 ${sim.events.length}（${fmtCounts(st.sev)}）、加工時間 ${Math.round(sim.time.total)} 秒`);
  }
  const st = stats(r.diagnostics);
  console.log(`      診斷 ${r.diagnostics.length}：${fmtCounts(st.sev)}｜${fmtCounts(st.rule)}`);
  // 模擬事件有進到 diagnostics
  const simIds = new Set(r.scenarios.off.sim.events.map((e) => e.ruleId));
  for (const id of simIds) assert.ok(r.diagnostics.some((d) => d.ruleId === id), `模擬事件 ${id} 沒進診斷清單`);
  // 階段回報
  assert.ok(stages.includes('tokenize') && stages.includes('tools') && stages.includes('stock') && stages.includes('done'));
  assert.ok(stages.some((s) => s.startsWith('sim:off')) && stages.some((s) => s.startsWith('sim:on')));
  assert.ok(took < 5000, `太慢：${took} ms`);
});

test('analyze：樣本 A 含模擬（cell 0.25）8 秒內跑完', goldenSkip, async () => {
  const t0 = now();
  const r = await NC.analyze(req(fixture(FIX_A), { sim: { enabled: true, cell: 0.25 } }));
  const took = ms(t0);
  console.log(`\n  樣本 A cell 0.25：${took} ms`);
  for (const sc of ['off', 'on']) {
    const sim = r.scenarios[sc].sim;
    assert.ok(sim, `${sc} 應該有模擬結果`);
    assert.equal(sim.cell, 0.25);
    assert.ok(sim.height.length === sim.nx * sim.ny);
    const st = stats(sim.events);
    console.log(`      ${sc}：格 ${sim.nx}×${sim.ny}、事件 ${sim.events.length}（${fmtCounts(st.sev)}）、加工時間 ${Math.round(sim.time.total / 60)} 分`);
  }
  const st = stats(r.diagnostics);
  console.log(`      診斷 ${r.diagnostics.length}：${fmtCounts(st.sev)}｜${fmtCounts(st.rule)}`);
  assert.ok(took < 8000, `太慢：${took} ms`);
});

test('analyze：四支程式含模擬（cell 0.5）都跑得完，並印出診斷統計', goldenSkip, async () => {
  console.log('\n— 四支程式完整分析（含模擬 cell 0.5）—');
  for (const f of FIXTURES) {
    const t0 = now();
    const r = await NC.analyze(req(fixture(f), { sim: { enabled: true, cell: 0.5 } }));
    const took = ms(t0);
    const st = stats(r.diagnostics);
    const sim = r.scenarios.off.sim;
    console.log(`  ${f}：${took} ms｜診斷 ${r.diagnostics.length}（${fmtCounts(st.sev)}）｜格 ${sim.nx}×${sim.ny}｜移除 ${Math.round((sim.removedVolume || 0) / 1000)} cm³`);
    console.log(`      ${fmtCounts(st.rule)}`);
    for (const d of r.diagnostics.filter((x) => x.severity === 'error').slice(0, 3)) {
      console.log(`      error L${d.line} ${d.ruleId}${d.scenario ? '(' + d.scenario + ')' : ''} ${d.message.slice(0, 70)}`);
    }
    assert.ok(r.scenarios.off.sim && r.scenarios.on.sim);
  }
});

// ---------------------------------------------------------------------------
// 中止
// ---------------------------------------------------------------------------
test('signal：一開始就中止 → 丟出 AbortError', goldenSkip, async () => {
  const signal = { aborted: true };
  await assert.rejects(() => NC.analyze(req(fixture(FIX_C), { signal })), (e) => {
    assert.ok(NC.analysis.isAbortError(e), '應該是 AbortError');
    assert.equal(e.name, 'AbortError');
    return true;
  });
  assert.throws(() => NC.analyzeSync(req(fixture(FIX_C), { signal })), (e) => NC.analysis.isAbortError(e));
});

test('signal：分析途中中止 → 丟出 AbortError', goldenSkip, async () => {
  const signal = { aborted: false };
  const seen = [];
  await assert.rejects(() => NC.analyze(req(fixture(FIX_A), { signal, sim: { enabled: true, cell: 0.25 } }),
    (stage) => { seen.push(stage); if (stage === 'stock') signal.aborted = true; }),
  (e) => NC.analysis.isAbortError(e));
  assert.ok(seen.includes('stock'));
  assert.ok(!seen.includes('done'), '中止後不應該跑到底');
});

test('signal：模擬進行中中止 → 丟出 AbortError', goldenSkip, async () => {
  const signal = { aborted: false };
  let sawProgress = false;
  const p = NC.analyze(req(fixture(FIX_A), { signal, sim: { enabled: true, cell: 0.25 } }),
    (stage, sc, prog) => {
      if (stage === 'sim' && prog > 0 && prog < 1) { sawProgress = true; signal.aborted = true; }
    });
  if (sawProgress) {
    await assert.rejects(() => p, (e) => NC.analysis.isAbortError(e));
  } else {
    // 模擬太快、沒有中途回報進度 → 只要能正常跑完就好
    const r = await p.catch((e) => { assert.ok(NC.analysis.isAbortError(e)); return null; });
    assert.ok(r === null || r.diagnostics);
  }
});

// ---------------------------------------------------------------------------
// rules.js 尚未載入時的容錯 / 已載入時的串接
// ---------------------------------------------------------------------------
test('rules：未載入時略過，載入後其診斷會併進來', goldenSkip, () => {
  const r = NC.analyzeSync(req(fixture(FIX_A)));
  assert.ok(Array.isArray(r.diagnostics));
  assert.equal(r.rulesError, undefined, `rules.run 丟了例外：${JSON.stringify(r.rulesError)}`);
  if (!hasRules) {
    console.log('\n  rules.js 尚未載入 → 分析仍完成（診斷只含 tokenizer/interpreter/geometry/sim）');
    return;
  }
  const own = new Set([...r.scenarios.off.run.diagnostics, ...r.scenarios.off.geometry.diagnostics, ...r.tok.diagnostics]
    .map((d) => d.ruleId));
  const extra = [...new Set(r.diagnostics.map((d) => d.ruleId))].filter((id) => !own.has(id));
  console.log(`\n  rules.js 已載入：額外規則命中 ${extra.sort().join(' ') || '（無）'}`);
});

test('rules：有模擬時跑兩趟，sim/cross 階段以第二趟（有 sim）的結果為準', goldenSkip, async () => {
  const saved = NC.rules;
  const calls = [];
  NC.rules = {
    registry: [
      { id: 'R05', title: '多斜線', severity: 'warning', phase: 'run', check: () => [] },
      { id: 'R06', title: '情境差異', severity: 'warning', phase: 'cross', check: () => [] },
      { id: 'R36', title: '薄壁', severity: 'warning', phase: 'sim', check: () => [] },
    ],
    run(ctx, opts) {
      const hasSim = !!(ctx.scenarios.off && ctx.scenarios.off.sim);
      // phases 必須從第二個參數進來（rules.js 的簽章是 run(ctx, opts)）
      calls.push({ phases: (opts && opts.phases) || null, hasSim });
      assert.ok(ctx.tok && ctx.scenarios && ctx.toolTable && ctx.stock && ctx.settings, 'rules 的 ctx 欄位不齊');
      const out = [
        NC.util.diag('R05', 810, 'warning', '多斜線節'),
        NC.util.diag('R06', 325, hasSim ? 'error' : 'warning', hasSim ? '跳過後在材料裡下刀' : '跳過後的第一個動作不同'),
      ];
      if (hasSim) out.push(NC.util.diag('R36', 100, 'warning', '相鄰高度差過小'));
      return out;
    },
  };
  try {
    const r = await NC.analyze(req(fixture(FIX_D), { sim: { enabled: true, cell: 0.5 } }));
    assert.equal(calls.length, 2, 'rules.run 應該跑兩趟');
    assert.deepEqual(calls[0], { phases: null, hasSim: false });
    assert.deepEqual(calls[1], { phases: ['sim', 'cross'], hasSim: true });
    const r06 = r.diagnostics.filter((d) => d.ruleId === 'R06');
    assert.equal(r06.length, 1, 'cross 階段的規則不該兩趟都留');
    assert.equal(r06[0].message, '跳過後在材料裡下刀', '應該用有 sim 的那趟');
    assert.equal(r.diagnostics.filter((d) => d.ruleId === 'R05').length, 1);
    assert.equal(r.diagnostics.filter((d) => d.ruleId === 'R36').length, 1);
    // 不跑模擬時只跑一趟
    calls.length = 0;
    const s = NC.analyzeSync(req(fixture(FIX_D)));
    assert.equal(calls.length, 1);
    assert.equal(s.diagnostics.filter((d) => d.ruleId === 'R06')[0].severity, 'warning');
    assert.equal(s.diagnostics.filter((d) => d.ruleId === 'R36').length, 0);
  } finally {
    if (saved === undefined) delete NC.rules; else NC.rules = saved;
  }
});

test('rules：rules.run 爆掉時分析仍完成，錯誤記在 result.rulesError', goldenSkip, () => {
  const saved = NC.rules;
  NC.rules = { registry: [], run() { throw new Error('故意的'); } };
  try {
    const r = NC.analyzeSync(req(fixture(FIX_C)));
    assert.ok(Array.isArray(r.diagnostics) && r.diagnostics.length > 0);
    assert.ok(r.rulesError && r.rulesError[0].message.includes('故意的'));
  } finally {
    if (saved === undefined) delete NC.rules; else NC.rules = saved;
  }
});

// ---------------------------------------------------------------------------
// js/ui/samples.js（由 tools/make-samples.mjs 產生）
// ---------------------------------------------------------------------------
test('samples.js：samples/ 的示範程式都內嵌了，內容一致且分析得動', () => {
  const p = path.join(ROOT, 'js', 'ui', 'samples.js');
  assert.ok(fs.existsSync(p), '請先執行 node tools/make-samples.mjs');
  const dir = path.join(ROOT, 'samples');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.nc')).sort();
  assert.ok(files.length >= 1, 'samples/ 應該要有示範程式');
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p });
  const samples = sandbox.NC.ui.samples;
  assert.equal(samples.length, files.length);
  for (const file of files) {
    const name = file.replace(/\.nc$/i, '');
    const s = samples.find((x) => x.name === name);
    assert.ok(s, `缺少範例 ${name}`);
    const rawText = fs.readFileSync(path.join(dir, file), 'latin1').replace(/\r\n/g, '\n');
    assert.equal(s.text, rawText, `${name} 內容不一致（跑 node tools/make-samples.mjs 重新產生）`);
    // 範例附的素材（samples/<name>.stock.json）也要跟內嵌的一致；沒有側車檔就不該有 stock 欄位
    const sidecar = path.join(dir, name + '.stock.json');
    if (fs.existsSync(sidecar)) {
      const o = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      // samples.js 是在另一個 vm context 跑的，物件原型不同，strict deepEqual 會失敗——先 JSON 往返再比
      assert.deepEqual(JSON.parse(JSON.stringify(s.stock && s.stock.spec)), o.spec, `${name} 附的素材不一致（跑 node tools/make-samples.mjs 重新產生）`);
      assert.ok(NC.analysis.stockFromSpec(s.stock.spec, s.stock.fixtures), `${name} 附的素材 spec 要能正規化`);
    } else {
      assert.equal(s.stock, undefined, `${name} 沒有側車檔卻有 stock 欄位`);
    }
    const r = NC.analyzeSync({ text: s.text });
    assert.ok(r.tok.blocks.length > 1, `${name} 範例應該能分析`);
    assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), [], `${name} 示範程式不該有 error`);
  }
});

// demo-cutout 是廢料判定的示範：用它附的 120×80×10 素材跑完整模擬，外框要判成廢料、原點那塊是工件。
// 用推估素材則永遠不會切穿（底面比最深切削低 5 mm）——這正是範例要附素材的原因，一起釘住。
test('samples.js：demo-cutout 用附的素材模擬後外框是廢料、推估素材則不會切穿', async () => {
  const p = path.join(ROOT, 'js', 'ui', 'samples.js');
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p });
  const s = sandbox.NC.ui.samples.find((x) => x.name === 'demo-cutout');
  assert.ok(s && s.stock, 'demo-cutout 要附素材');
  const stock = NC.analysis.stockFromSpec(s.stock.spec, s.stock.fixtures);
  const settings = NC.util.defaultSettings();
  const withStock = await NC.analyze({ text: s.text, settings, toolTable: null, stock, scenarios: ['off'], sim: { enabled: true, cell: 0.5 } });
  const sim = withStock.scenarios.off.sim;
  assert.ok(sim && !sim.cylinder);
  assert.equal(sim.floorZ, -10);
  const r = NC.sim.chunks(sim, sim.height, NC.sim.defaultScrap());
  assert.equal(r.supported, true);
  assert.equal(r.partCount, 1);
  assert.equal(r.scrapCount, 1);
  const part = r.chunks.find((c) => c.part), scrap = r.chunks.find((c) => !c.part);
  assert.equal(part.why, 'origin');
  assert.ok(part.bbox.x0 > -32 && part.bbox.x1 < 32 && part.bbox.y0 > -22 && part.bbox.y1 < 22, '中間 60×40 的零件是工件');
  assert.ok(scrap.areaMm2 > part.areaMm2, '外框（廢料）比零件大');
  // 中間的零件（原點）與外框（角落固定孔旁）各抽一格
  const at = (x, y) => r.labels[Math.round((y - sim.origin.y) / sim.cell) * sim.nx + Math.round((x - sim.origin.x) / sim.cell)];
  assert.equal(at(0, 0), part.label);
  assert.equal(at(-56, 0), scrap.label);

  const estimated = await NC.analyze({ text: s.text, settings, toolTable: null, stock: null, scenarios: ['off'], sim: { enabled: true, cell: 0.5 } });
  const simE = estimated.scenarios.off.sim;
  assert.equal(estimated.stock.source, 'estimated');
  assert.ok(simE.floorZ < -11, '推估底面在最深切削之下');
  const rE = NC.sim.chunks(simE, simE.height, NC.sim.defaultScrap());
  assert.equal(rE.scrapCount, 0);
  assert.equal(rE.partCount, 1);
});
