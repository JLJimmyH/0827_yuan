// js/ui/panels.js 測試。契約說 UI 模組不在 Node 測，這裡用一個極小的假 DOM 讓面板能在 Node 下建立與操作。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadNC, ROOT, fixture, goldenSkip, FIX_A, FIX_D } from './load.mjs';

// ---------------------------------------------------------------------------
// 極小假 DOM：只實作 panels.js 用到的東西（createElement / appendChild / textContent / classList / dataset / 事件 / querySelectorAll）
// ---------------------------------------------------------------------------
class FakeNode {
  constructor() { this.childNodes = []; this.parentNode = null; this.listeners = {}; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
}
class FakeText extends FakeNode {
  constructor(t) { super(); this.nodeType = 3; this.nodeValue = String(t); }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
}
function splitCompound(sel) {
  // "tag.cls[attr=val]" → {tag, classes, attrs}
  const out = { tag: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="?([^"\]]*)"?)?\]/g;
  let m;
  while ((m = re.exec(sel))) {
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.classes.push(m[2]);
    else out.attrs.push([m[3], m[4] === undefined ? null : m[4]]);
  }
  return out;
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = {}; this.dataset = {}; this.style = {};
    this.className = ''; this.value = ''; this.checked = false; this.title = ''; this.type = '';
  }
  get classes() { return this.className.split(/\s+/).filter(Boolean); }
  get classList() {
    const el = this;
    const set = () => new Set(el.classes);
    const save = (s) => { el.className = Array.from(s).join(' '); };
    return {
      add: (...c) => { const s = set(); c.forEach((x) => s.add(x)); save(s); },
      remove: (...c) => { const s = set(); c.forEach((x) => s.delete(x)); save(s); },
      contains: (c) => set().has(c),
      toggle: (c) => { const s = set(); if (s.has(c)) s.delete(c); else s.add(c); save(s); return s.has(c); },
    };
  }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; } return n; }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  set textContent(v) { this.childNodes = []; if (v !== '' && v != null) this.appendChild(new FakeText(v)); }
  get textContent() { return super.textContent; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    let stopped = false;
    ev.stopPropagation = () => { stopped = true; };
    for (const fn of this.listeners[ev.type] || []) fn(ev);
    if (!stopped && ev.bubbles && this.parentNode && this.parentNode.dispatchEvent) this.parentNode.dispatchEvent(ev);
    return true;
  }
  matches(compound) {
    const c = splitCompound(compound);
    if (c.tag && c.tag !== this.tagName) return false;
    for (const cls of c.classes) if (!this.classes.includes(cls)) return false;
    for (const [k, v] of c.attrs) {
      let actual = k in this.attrs ? this.attrs[k] : null;
      if (actual == null && k.startsWith('data-')) { const dk = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()); actual = dk in this.dataset ? this.dataset[dk] : null; }
      if (actual == null && k in this) actual = String(this[k]);
      if (actual == null) return false;
      if (v != null && actual !== v) return false;
    }
    return true;
  }
  *descendants() { for (const c of this.children) { yield c; yield* c.descendants(); } }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/);
    const last = parts[parts.length - 1];
    const out = [];
    for (const el of this.descendants()) {
      if (!el.matches(last)) continue;
      let ok = true, p = el.parentNode, i = parts.length - 2;
      while (i >= 0 && p && p !== this.parentNode) { if (p.matches && p.matches(parts[i])) i--; p = p.parentNode; }
      if (i >= 0) ok = false;
      if (ok) out.push(el);
    }
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const fakeDocument = { createElement: (t) => new FakeElement(t), createTextNode: (t) => new FakeText(t) };
globalThis.document = fakeDocument;

const NC = loadNC();
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'ui', 'panels.js'), 'utf8'), { filename: 'panels.js' });
const P = NC.ui.panels;
const L = P.logic;

const fire = (el, type, bubbles = type === 'click') => el.dispatchEvent({ type, bubbles });
const setValue = (el, v) => { el.value = String(v); fire(el, 'change'); };
const container = () => new FakeElement('div');
const q = (root, sel) => root.querySelector(sel);
const qa = (root, sel) => root.querySelectorAll(sel);

// ---------------------------------------------------------------------------
// 假資料
// ---------------------------------------------------------------------------
function sampleTable() {
  return {
    programKey: 'O1001',
    tools: [
      { t: 11, label: '12MM', type: 'endmill', diameter: 12, angle: null, fluteLen: 36, stickout: null, pitch: null, resident: false, probe: false, source: { type: 'comment', diameter: 'comment', angle: 'default', fluteLen: 'default' } },
      { t: 20, label: '100MM', type: 'facemill', diameter: 100, angle: null, fluteLen: null, stickout: null, pitch: null, resident: true, probe: false, source: { type: 'comment', diameter: 'comment' } },
      { t: 7, label: 'SG-4.5', type: 'drill', diameter: 4.5, angle: 118, fluteLen: 13.5, stickout: null, pitch: null, resident: false, probe: false, source: { type: 'comment', diameter: 'comment', angle: 'default', fluteLen: 'default' } },
      { t: 15, label: 'T15', type: 'unknown', diameter: 10, angle: null, fluteLen: null, stickout: null, pitch: null, resident: false, probe: true, source: { type: 'default', diameter: 'default' } },
      { t: 3, label: '8V', type: 'chamfer', diameter: 8, angle: 90, fluteLen: null, stickout: null, pitch: null, resident: false, probe: false, source: { type: 'comment', diameter: 'comment', angle: 'default' } },
    ],
    offsets: [
      { n: 11, lenGeom: 0, lenWear: 0, radGeom: 6, radWear: 0, source: 'default' },
      { n: 31, lenGeom: 0, lenWear: 0, radGeom: 6, radWear: -0.02, source: 'user' },
      { n: 3, lenGeom: 0, lenWear: 0, radGeom: 4, radWear: 0, source: 'default' },
    ],
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}
function sampleOps() {
  return [
    { index: 0, tool: 20, toolComment: '100MM', h: 20, dList: [], lineStart: 4, lineEnd: 12, zMin: 0, feeds: [800], rpms: [1200], gCodes: ['G0', 'G1'], kindGuess: 'face' },
    { index: 1, tool: 11, toolComment: '12MM', h: 11, dList: [11, 31], lineStart: 13, lineEnd: 80, zMin: -30, feeds: [200, 400], rpms: [3000], gCodes: ['G1', 'G2', 'G41'], kindGuess: 'contour' },
    { index: 2, tool: 7, toolComment: 'SG-4.5', h: 7, dList: [], lineStart: 81, lineEnd: 95, zMin: -7, feeds: [50], rpms: [1050], gCodes: ['G83'], kindGuess: 'drill' },
    { index: 3, tool: 15, toolComment: null, h: 15, dList: [], lineStart: 96, lineEnd: 100, zMin: null, feeds: [], rpms: [], gCodes: ['G0'], kindGuess: 'unknown' },
    { index: 4, tool: 3, toolComment: '8V', h: 3, dList: [3], lineStart: 101, lineEnd: 130, zMin: -1.2, feeds: [80], rpms: [1500], gCodes: ['G1', 'G81'], kindGuess: 'chamfer' },
  ];
}
function sampleDiags() {
  return [
    { id: 'R11:40:a', ruleId: 'R11', line: 40, severity: 'error', message: '內凹半徑小於刀徑補正量', detail: '機台會發 PS0041，請改用較小的刀或改路徑。', fanucAlarm: 'PS0041', pos: { x: 1, y: 2, z: -3 } },
    { id: 'R05:810:b', ruleId: 'R05', line: 810, severity: 'warning', message: '多斜線節 ///', detail: '多數 Fanuc 只認第一個斜線。', fix: { label: '改成單斜線', edits: [{ line: 810, text: '/G0Y3.' }] } },
    { id: 'R06:325:c', ruleId: 'R06', line: 325, severity: 'error', scenario: 'on', message: '跳過此節後下一段切削位置不同' },
    { id: 'R14:30:d', ruleId: 'R14', line: 30, severity: 'info', message: 'D30 與 T11 不同號' },
    { id: 'R10:14:e', ruleId: 'R10', line: 14, severity: 'needsInput', message: 'T11 需輸入 D11 的值' },
    { id: 'R32:0:f', ruleId: 'R32', line: 0, severity: 'warning', message: '沒有 O 號' },
    { id: 'R07:254:g', ruleId: 'R07', line: 254, severity: 'warning', scenario: 'on', message: '被跳過的節含模態字 G91' },
  ];
}
function sampleModal() {
  return {
    motion: 'G1', distance: 'G90', plane: 'G17', units: 'G21', feedMode: 'G94', wcs: 'G54', comp: 'G41', d: 11, lengthComp: 'G43', h: 11,
    cycle: null, retractMode: 'G98', feed: 400, spindle: { dir: 'M3', rpm: 3000 }, coolant: true, toolInSpindle: 11, toolStaged: 12,
    aicc: false, rigidTap: false, rigidTapS: null, pos: { x: 58, y: -80.5, z: -30 }, lengthCompActive: true,
  };
}
function sampleStock() {
  return { min: { x: -65, y: -30, z: -15 }, max: { x: 65, y: 30, z: 0 }, source: 'estimated', fixtures: [] };
}

// ---------------------------------------------------------------------------
// 純邏輯
// ---------------------------------------------------------------------------
test('logic.dListByTool：由 ops 取得每把刀的 D 號；無 ops 退而用 offsets n === t', () => {
  const m = L.dListByTool(sampleTable(), sampleOps());
  assert.deepEqual(m[11], [11, 31]);
  assert.deepEqual(m[3], [3]);
  assert.deepEqual(m[20], []);
  const m2 = L.dListByTool(sampleTable(), null);
  assert.deepEqual(m2[11], [11]);
  assert.deepEqual(m2[3], [3]);
  assert.deepEqual(m2[7], []);
  const m3 = L.dListByTool(sampleTable(), null, { 7: [7, 27] });
  assert.deepEqual(m3[7], [7, 27]);
});

test('logic.ensureOffsets：用到但沒有的 D 補上 radGeom = 直徑/2、來源 default', () => {
  const t = sampleTable();
  const m = L.dListByTool(t, sampleOps());
  L.ensureOffsets(t, m);
  const d31 = t.offsets.find((o) => o.n === 31);
  assert.equal(d31.source, 'user'); // 既有的不動
  assert.equal(t.offsets.length, 3);
  t.tools[0].diameter = 16;
  t.offsets = t.offsets.filter((o) => o.n !== 11);
  L.ensureOffsets(t, m);
  const d11 = t.offsets.find((o) => o.n === 11);
  assert.equal(d11.radGeom, 8);
  assert.equal(d11.source, 'default');
});

test('logic.countDefaultTools：型式／直徑／任一 D 來源為 default 的刀', () => {
  const t = sampleTable();
  const m = L.dListByTool(t, sampleOps());
  // T11（D11 default）、T15（default）、T3（D3 default）→ 3；T20、T7 不算
  assert.equal(L.countDefaultTools(t, m), 3);
});

test('logic.setToolField：改直徑時來源非 user 的 D 連動 radGeom = 直徑/2；手填後解除', () => {
  const t = sampleTable();
  const m = L.dListByTool(t, sampleOps());
  const linked = L.setToolField(t, 11, 'diameter', 10, m);
  assert.deepEqual(linked, [11]); // D31 是 user，不連動
  assert.equal(t.offsets.find((o) => o.n === 11).radGeom, 5);
  assert.equal(t.offsets.find((o) => o.n === 31).radGeom, 6);
  assert.equal(t.tools[0].source.diameter, 'user');
  L.setOffsetField(t, 11, 'radGeom', 4.98);
  assert.equal(t.offsets.find((o) => o.n === 11).source, 'user');
  const linked2 = L.setToolField(t, 11, 'diameter', 12, m);
  assert.deepEqual(linked2, []);
  assert.equal(t.offsets.find((o) => o.n === 11).radGeom, 4.98);
  // resident / label 不改 source
  L.setToolField(t, 11, 'resident', true, m);
  assert.equal(t.tools[0].resident, true);
  assert.equal(t.tools[0].source.resident, undefined);
});

test('logic.filterDiagnostics：嚴重度、只看 skip ON 差異、文字', () => {
  const items = sampleDiags();
  assert.equal(L.filterDiagnostics(items, {}).length, 7);
  assert.equal(L.filterDiagnostics(items, { severities: ['error'] }).length, 2);
  const on = L.filterDiagnostics(items, { onlyScenarioOn: true });
  assert.deepEqual(on.map((x) => x.id).sort(), ['R06:325:c', 'R07:254:g']);
  assert.equal(L.filterDiagnostics(items, { text: 'ps0041' }).length, 1);
  assert.equal(L.filterDiagnostics(items, { severities: ['warning'], onlyScenarioOn: true }).length, 1);
  assert.deepEqual(L.countBySeverity(items), { error: 2, warning: 3, needsInput: 1, info: 1 });
});

test('logic.formatTime / listText', () => {
  assert.equal(L.formatTime(null), '—');
  assert.equal(L.formatTime(12.4), '12 s');
  assert.equal(L.formatTime(185), '3:05');
  assert.equal(L.formatTime(3723), '1:02:03');
  assert.equal(L.listText([400, 200, 200]), '200, 400');
  assert.equal(L.listText([]), '—');
});

// ---------------------------------------------------------------------------
// 刀具表
// ---------------------------------------------------------------------------
test('toolTable：每把刀一列、來源標籤四色、★、probe 標記、預設值橫幅', () => {
  const c = container();
  const changes = [];
  const hnd = P.toolTable(c, { table: sampleTable(), ops: sampleOps(), onChange: (t) => changes.push(t) });
  assert.equal(qa(c, 'tr.nc-tool').length, 5);
  const banner = q(c, '.nc-banner');
  assert.equal(banner.textContent, '3 把刀使用預設值，成品圖可能不準');
  assert.ok(!banner.classList.contains('nc-hidden'));
  assert.ok(qa(c, '.nc-tag-holder .nc-src-comment').length > 0);
  assert.ok(qa(c, '.nc-tag-holder .nc-src-default').length > 0);
  assert.ok(qa(c, '.nc-td-d .nc-src-user').length === 1); // D31
  assert.ok(qa(c, '.nc-legend .nc-src-motion').length === 1); // 圖例四色
  const row20 = q(c, 'tr[data-t="20"]');
  assert.ok(q(row20, '.nc-star').classList.contains('nc-on'));
  const row11 = q(c, 'tr[data-t="11"]');
  assert.ok(!q(row11, '.nc-star').classList.contains('nc-on'));
  assert.ok(q(q(c, 'tr[data-t="15"]'), '.nc-badge-probe'));
  assert.equal(qa(row11, '.nc-dline').length, 2);
  // 型式下拉
  const sel = q(row11, 'select[data-field="type"]');
  assert.equal(sel.value, 'endmill');
  assert.equal(qa(sel, 'option').length, L.TOOL_TYPES.length);
  // 常駐刀切換
  fire(q(row11, '.nc-star'), 'click');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].tools.find((x) => x.t === 11).resident, true);
  assert.ok(changes[0].updatedAt > '2026-08-27T00:00:00.000Z');
  assert.ok(q(row11, '.nc-star').classList.contains('nc-on'));
  assert.equal(hnd.getTable().tools.find((x) => x.t === 11).resident, true);
});

test('toolTable：直徑↔D 連動；手填 D 後解除；橫幅計數更新', () => {
  const c = container();
  const changes = [];
  P.toolTable(c, { table: sampleTable(), ops: sampleOps(), onChange: (t) => changes.push(t) });
  const row11 = q(c, 'tr[data-t="11"]');
  const dia = q(row11, 'input[data-field="diameter"]');
  const rad11 = q(row11, 'input[data-d="11"][data-field="radGeom"]');
  const rad31 = q(row11, 'input[data-d="31"][data-field="radGeom"]');
  assert.equal(rad11.value, '6');
  setValue(dia, 10);
  assert.equal(rad11.value, '5');           // 來源 default → 連動
  assert.equal(rad31.value, '6');           // 來源 user → 不動
  const last = changes[changes.length - 1];
  assert.equal(last.tools.find((x) => x.t === 11).diameter, 10);
  assert.equal(last.tools.find((x) => x.t === 11).source.diameter, 'user');
  assert.equal(last.offsets.find((o) => o.n === 11).radGeom, 5);
  assert.equal(last.offsets.find((o) => o.n === 11).source, 'default');
  assert.ok(q(q(row11, '.nc-tag-holder[data-field="diameter"]'), '.nc-src-user'));
  // 手填 D11
  setValue(rad11, 4.9);
  assert.equal(changes[changes.length - 1].offsets.find((o) => o.n === 11).source, 'user');
  assert.ok(q(q(row11, '.nc-tag-holder[data-d="11"]'), '.nc-src-user'));
  setValue(dia, 12);
  assert.equal(rad11.value, '4.9'); // 解除連動
  assert.equal(changes[changes.length - 1].offsets.find((o) => o.n === 11).radGeom, 4.9);
  // T11 不再用預設 → 橫幅 3 → 2
  assert.equal(q(c, '.nc-banner').textContent, '2 把刀使用預設值，成品圖可能不準');
  // 無效直徑不送出
  const n = changes.length;
  setValue(dia, '');
  assert.equal(changes.length, n);
  assert.equal(dia.value, '12');
  // 型式改變 → 來源手填
  const sel = q(q(c, 'tr[data-t="15"]'), 'select[data-field="type"]');
  setValue(sel, 'drill');
  assert.equal(changes[changes.length - 1].tools.find((x) => x.t === 15).type, 'drill');
  assert.equal(changes[changes.length - 1].tools.find((x) => x.t === 15).source.type, 'user');
});

test('toolTable：圓鼻刀／T型刀會多出角R、頸徑欄，平刀沒有', () => {
  const c = container();
  const changes = [];
  P.toolTable(c, { table: sampleTable(), ops: sampleOps(), onChange: (t) => changes.push(t) });
  const row11 = q(c, 'tr[data-t="11"]');
  const sel = q(row11, 'select[data-field="type"]');
  const extras = () => qa(row11, '.nc-td-extra .nc-extra-line').length;
  // 22 種型式都要在選單裡
  assert.equal(qa(sel, 'option').length, 22);
  // 平刀：沒有要補的尺寸
  assert.equal(extras(), 0);
  // 圓鼻刀 → 角R 欄，填了就是手填
  setValue(sel, 'bullnose');
  assert.equal(extras(), 1);
  const rad = q(row11, 'input[data-field="cornerRad"]');
  setValue(rad, 0.8);
  const t11 = changes[changes.length - 1].tools.find((x) => x.t === 11);
  assert.equal(t11.cornerRad, 0.8);
  assert.equal(t11.source.cornerRad, 'user');
  // T型刀 → 換成頸徑欄
  setValue(sel, 'slotmill');
  assert.equal(qa(row11, 'input[data-field="cornerRad"]').length, 0);
  assert.equal(qa(row11, 'input[data-field="neckDia"]').length, 1);
  // 換回平刀 → 收起來
  setValue(sel, 'endmill');
  assert.equal(extras(), 0);
});

test('toolTable：沒有 ops 時退而用 offsets；全部手填則橫幅隱藏；空表', () => {
  const c = container();
  const t = sampleTable();
  for (const tool of t.tools) tool.source = { type: 'user', diameter: 'user' };
  for (const o of t.offsets) o.source = 'user';
  P.toolTable(c, { table: t, onChange: () => {} });
  assert.ok(q(c, '.nc-banner').classList.contains('nc-hidden'));
  assert.equal(qa(q(c, 'tr[data-t="11"]'), '.nc-dline').length, 1);
  const c2 = container();
  P.toolTable(c2, { table: { programKey: 'x', tools: [], offsets: [], updatedAt: '' } });
  assert.ok(q(c2, '.nc-empty'));
});

// ---------------------------------------------------------------------------
// 錯誤清單
// ---------------------------------------------------------------------------
test('diagnostics：pill、行號、訊息、篩選、展開、跳轉', () => {
  const c = container();
  const jumps = [];
  const fixes = [];
  const hnd = P.diagnostics(c, { items: sampleDiags(), onJump: (line, it) => jumps.push([line, it.id]), onFix: (it) => fixes.push(it.id) });
  assert.equal(qa(c, 'li.nc-diag').length, 7);
  assert.equal(q(c, '.nc-diag-summary').textContent, '顯示 7 / 7 筆');
  const first = q(c, 'li[data-id="R11:40:a"]');
  assert.equal(q(first, '.nc-pill').textContent, '錯誤');
  assert.ok(q(first, '.nc-pill').classList.contains('nc-pill-error'));
  assert.equal(q(first, '.nc-diag-line').textContent, 'L40');
  assert.equal(q(first, '.nc-diag-msg').textContent, '內凹半徑小於刀徑補正量');
  assert.equal(q(first, '.nc-diag-alarm code').textContent, 'PS0041');
  assert.equal(q(q(c, 'li[data-id="R32:0:f"]'), '.nc-diag-line').textContent, '全程式');
  assert.ok(q(q(c, 'li[data-id="R06:325:c"]'), '.nc-badge-scn'));
  assert.equal(q(c, '.nc-count[data-sev="warning"]').textContent, '3');
  // 展開（按鈕不觸發跳轉）
  assert.ok(!first.classList.contains('nc-open'));
  fire(q(first, '.nc-expand'), 'click');
  assert.ok(first.classList.contains('nc-open'));
  assert.equal(jumps.length, 0);
  // 點擊列 → onJump
  fire(first, 'click');
  assert.deepEqual(jumps, [[40, 'R11:40:a']]);
  assert.ok(first.classList.contains('nc-selected'));
  // 修正按鈕
  fire(q(q(c, 'li[data-id="R05:810:b"]'), '.nc-diag-fix button'), 'click');
  assert.deepEqual(fixes, ['R05:810:b']);
  assert.equal(jumps.length, 1);
  // 篩選：取消 error
  const checks = qa(c, '.nc-filter input[type="checkbox"]');
  checks[0].checked = false; fire(checks[0], 'change');
  assert.equal(qa(c, 'li.nc-diag').length, 5);
  assert.deepEqual(hnd.getFilter().severities, ['warning', 'needsInput', 'info']);
  checks[0].checked = true; fire(checks[0], 'change');
  // 只看 skip ON 差異
  const onlyOn = q(c, '.nc-check-scn input');
  onlyOn.checked = true; fire(onlyOn, 'change');
  assert.deepEqual(qa(c, 'li.nc-diag').map((li) => li.dataset.id).sort(), ['R06:325:c', 'R07:254:g']);
  assert.equal(q(c, '.nc-diag-summary').textContent, '顯示 2 / 7 筆');
  // 文字搜尋
  hnd.setFilter({ onlyScenarioOn: false, text: 'D30' });
  assert.equal(qa(c, 'li.nc-diag').length, 1);
  hnd.setFilter({ text: 'zzz' });
  assert.equal(q(c, 'li.nc-empty').textContent, '篩選後沒有項目');
  // 更新資料、展開狀態保留
  hnd.setFilter({ text: '' });
  hnd.update({ items: sampleDiags().slice(0, 2) });
  assert.equal(qa(c, 'li.nc-diag').length, 2);
  assert.ok(q(c, 'li[data-id="R11:40:a"]').classList.contains('nc-open'));
  hnd.highlight('R05:810:b');
  assert.ok(q(c, 'li[data-id="R05:810:b"]').classList.contains('nc-selected'));
  assert.ok(!q(c, 'li[data-id="R11:40:a"]').classList.contains('nc-selected'));
  hnd.update({ items: [] });
  assert.equal(q(c, 'li.nc-empty').textContent, '沒有問題');
});

test('diagnostics：同一原因（groupKey）摺成一列，×N 與行號小方塊可跳轉，「逐行列出」可攤平', () => {
  const c = container();
  const jumps = [];
  // analyze.js 會標好 groupKey/groupCount/groupFirst；同一原因、只是行號不同
  const items = [
    { id: 'R27:13:1', ruleId: 'R27', line: 13, severity: 'warning', message: 'G0 下刀終點在材料內', detail: '干涉 4 mm', groupKey: 'R27|plunge', groupCount: 3, groupFirst: true, groupLines: [13, 27, 41] },
    { id: 'R27:27:1', ruleId: 'R27', line: 27, severity: 'warning', message: 'G0 下刀終點在材料內', detail: '干涉 2 mm', groupKey: 'R27|plunge', groupCount: 3, groupFirst: false },
    { id: 'R27:41:1', ruleId: 'R27', line: 41, severity: 'warning', message: 'G0 下刀終點在材料內', detail: '干涉 2 mm', groupKey: 'R27|plunge', groupCount: 3, groupFirst: false },
    { id: 'R06:1147:1', ruleId: 'R06', line: 1147, severity: 'error', message: '跳過後切進實心材料', groupKey: 'R06|solid', groupCount: 1, groupFirst: true },
  ];
  const hnd = P.diagnostics(c, { items, onJump: (line, it) => jumps.push([line, it.id]) });
  // 3 筆 R27 摺成 1 列 + 1 筆 R06 = 2 列
  const rows = qa(c, 'li.nc-diag');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((li) => li.dataset.id), ['R27:13:1', 'R06:1147:1']);
  assert.equal(q(c, '.nc-diag-summary').textContent, '顯示 2 組（4 / 4 筆）');
  const head = q(c, 'li[data-id="R27:13:1"]');
  assert.equal(q(head, '.nc-diag-count').textContent, '×3');
  assert.ok(!q(c, 'li[data-id="R06:1147:1"] .nc-diag-count'), '只有一筆的組不顯示 ×N');
  // 行號小方塊：全部 3 行都列出來，點了跳到那一行、但選取仍留在摺疊列
  const chips = qa(head, '.nc-lineno');
  assert.deepEqual(chips.map((b) => b.textContent), ['L13', 'L27', 'L41']);
  fire(chips[2], 'click');
  assert.deepEqual(jumps, [[41, 'R27:41:1']]);
  assert.ok(head.classList.contains('nc-selected'));
  // 「逐行列出」→ 攤平成 4 列
  const flat = q(c, '.nc-check-flat input');
  flat.checked = true; fire(flat, 'change');
  assert.equal(qa(c, 'li.nc-diag').length, 4);
  assert.equal(q(c, '.nc-diag-summary').textContent, '顯示 4 / 4 筆');
  assert.equal(hnd.getFilter().flat, true);
  // 篩選之後只算篩選後還看得到的那幾筆
  hnd.setFilter({ flat: false, severities: ['warning'] });
  assert.equal(qa(c, 'li.nc-diag').length, 1);
  assert.equal(q(c, '.nc-diag-count').textContent, '×3');
});

// ---------------------------------------------------------------------------
// 模態
// ---------------------------------------------------------------------------
test('modal：位置、G 群組、F/S/M、刀具、循環', () => {
  const c = container();
  const hnd = P.modal(c, sampleModal(), { line: 40, text: 'G1X58.Y-80.5', opIndex: 1 });
  const v = (key) => { const el = qa(c, '.nc-v').find((e) => e.dataset.key === key); assert.ok(el, `找不到 ${key}`); return el.textContent; };
  assert.equal(v('位置'), 'X58  Y-80.5  Z-30');
  assert.equal(v('刀徑補正'), 'G41 D11');
  assert.equal(v('刀長補正'), 'G43 H11');
  assert.equal(v('F'), '400 mm/min');
  assert.equal(v('S'), 'M3 3000 rpm');
  assert.equal(v('冷卻'), 'M8 開');
  assert.equal(v('主軸'), 'T11');
  assert.equal(v('預選'), 'T12');
  assert.equal(v('固定循環'), 'G80');
  assert.equal(v('行'), 'L40');
  assert.equal(v('作業'), '#2');
  assert.equal(qa(c, '.nc-modal-sec').length, 5);
  const st = sampleModal();
  st.cycle = { code: 'G83', r: 2, z: -7, q: 1, p: null, retract: 'G98', initialZ: 25 };
  st.feed = null; st.spindle = { dir: 'M5', rpm: null }; st.rigidTap = true; st.rigidTapS = 500; st.comp = 'G40'; st.d = 0;
  hnd.update(st, { line: 90, skipped: true });
  assert.equal(v('固定循環'), 'G83');
  assert.equal(v('R 點'), '2');
  assert.equal(v('孔底 Z'), '-7');
  assert.equal(v('Q'), '1');
  assert.equal(v('退回'), 'G98 初始面');
  assert.equal(v('F'), '未指定');
  assert.ok(q(c, '.nc-v[data-key="F"]').classList.contains('nc-warn'));
  assert.equal(v('S'), 'M5');
  assert.equal(v('剛性攻牙'), 'M29 S500');
  assert.equal(v('刀徑補正'), 'G40');
  assert.equal(v('狀態'), '此情境下被跳過');
  hnd.update(null);
  assert.ok(q(c, '.nc-empty'));
});

// ---------------------------------------------------------------------------
// 作業摘要
// ---------------------------------------------------------------------------
test('ops：欄位、時間、跳轉、選取', () => {
  const c = container();
  const jumps = [];
  const hnd = P.ops(c, { ops: sampleOps(), onJump: (line, op) => jumps.push([line, op.index]), time: { perOp: [30, 185, 61, 5, 40], total: 321 } });
  const rows = qa(c, 'tr.nc-op');
  assert.equal(rows.length, 5);
  const cells = (i) => qa(rows[i], 'td').map((td) => td.textContent);
  assert.deepEqual(cells(1), ['2', 'T11', '12MM', 'H11', 'D11 D31', '輪廓', '-30', '200, 400', '3000', '13–80', '3:05']);
  assert.deepEqual(cells(3), ['4', 'T15', '', 'H15', '—', '未知', '—', '—', '—', '96–100', '5 s']);
  assert.ok(qa(rows[1], 'td')[6].classList.contains('nc-deep'));
  assert.ok(q(rows[4], '.nc-kind').classList.contains('nc-kind-chamfer'));
  assert.equal(qa(c, 'tfoot td')[1].textContent, '5:21');
  fire(rows[2], 'click');
  assert.deepEqual(jumps, [[81, 2]]);
  assert.ok(rows[2].classList.contains('nc-selected'));
  hnd.select(0);
  assert.ok(rows[0].classList.contains('nc-selected'));
  assert.ok(!rows[2].classList.contains('nc-selected'));
  // 無時間、用刀具表補註解
  hnd.update({ time: null, toolTable: sampleTable() });
  assert.equal(qa(c, 'tfoot').length, 0);
  assert.equal(qa(qa(c, 'tr.nc-op')[3], 'td')[2].textContent, 'T15');
  assert.equal(qa(qa(c, 'tr.nc-op')[3], 'td')[10].textContent, '—');
  hnd.update({ ops: [] });
  assert.ok(q(c, '.nc-empty'));
});

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------
test('stock：推估反算預填、改尺寸轉手動、pos 微調（錨點只由拖曳設定）', () => {
  const c = container();
  const changes = [];
  P.stock(c, { stock: sampleStock(), onChange: (s) => changes.push(s) });
  // 推估 → 反算 spec 預填欄位（130×60×15、原點中心）
  assert.equal(q(c, '.nc-badge[data-source]').dataset.source, 'estimated');
  assert.equal(qa(c, '.nc-btn-reset').length, 0);
  assert.equal(q(c, 'input[data-field="size.x"]').value, '130');
  assert.equal(q(c, 'input[data-field="size.z"]').value, '15');
  // 錨點沒有獨立的表單控制項（拖預覽的 ⊕ 才是入口），標題顯示現在的位置
  assert.equal(qa(c, 'select[data-field="anchor.z"]').length, 0);
  assert.match(c.textContent, /原點位置：中心（頂面）/);
  // 改尺寸 → 轉手動，min/max 由 spec 重算
  setValue(q(c, 'input[data-field="size.x"]'), 100);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].source, 'user');
  assert.equal(changes[0].spec.size.x, 100);
  assert.deepEqual(changes[0].min, { x: -50, y: -30, z: -15 });
  assert.deepEqual(changes[0].max, { x: 50, y: 30, z: 0 });
  assert.equal(q(c, '.nc-badge[data-source]').dataset.source, 'user');
  // pos 微調 = 素材整體平移
  setValue(q(c, 'input[data-field="pos.x"]'), 2);
  assert.deepEqual(changes[1].min, { x: -48, y: -30, z: -15 });
  assert.deepEqual(changes[1].max, { x: 52, y: 30, z: 0 });
  // 回到推估 → onChange(null)
  fire(q(c, '.nc-btn-reset'), 'click');
  assert.equal(changes[2], null);
});

test('stock：形狀切立圓柱＝直徑接手 X、XY 錨鎖軸心', () => {
  const c = container();
  const changes = [];
  P.stock(c, { stock: sampleStock(), onChange: (s) => changes.push(s) });
  fire(q(c, '.nc-shape-btn[data-shape="cylZ"]'), 'click');
  const s = changes[0];
  assert.equal(s.spec.shape, 'cylZ');
  assert.equal(s.shape, 'cylZ');
  assert.equal(s.spec.size.y, 130);            // 直徑 = 原本的 X
  assert.deepEqual(s.min, { x: -65, y: -65, z: -15 });
  assert.deepEqual(s.max, { x: 65, y: 65, z: 0 });
  assert.match(c.textContent, /原點位置：軸心（頂面）/);
});

test('stock：夾具新增、編輯、刪除', () => {
  const c = container();
  const changes = [];
  P.stock(c, { stock: sampleStock(), onChange: (s) => changes.push(s) });
  fire(q(c, '.nc-btn-add'), 'click');
  assert.equal(changes[0].fixtures.length, 1);
  assert.equal(changes[0].fixtures[0].name, '夾具 1');
  assert.equal(changes[0].fixtures[0].max.z, 0);
  assert.equal(qa(c, '.nc-fixture').length, 1);
  setValue(q(c, 'input[data-field="fixture0.max.z"]'), 5);
  assert.equal(changes[1].fixtures[0].max.z, 5);
  const nameInput = q(q(c, '.nc-fixture'), 'input[type="text"]');
  setValue(nameInput, '虎鉗左');
  assert.equal(changes[2].fixtures[0].name, '虎鉗左');
  fire(q(c, '.nc-fixture .nc-btn-danger'), 'click');
  assert.equal(changes[3].fixtures.length, 0);
  assert.equal(qa(c, '.nc-fixture').length, 0);
});

test('stock：四軸程式預設躺圓柱但不鎖，換形狀有警示', () => {
  const c = container();
  const changes = [];
  const cyl = {
    kind: 'cylinder', radius: 20, center: { y: 0, z: 0 },
    xMin: 0, xMax: 80, source: 'estimated', fixtures: [],
    min: { x: 0, y: -20, z: -20 }, max: { x: 80, y: 20, z: 20 },
  };
  const hnd = P.stock(c, { stock: cyl, rotaryUsed: true, onChange: (s) => changes.push(s) });
  // 三顆形狀鈕都在（工具的用法是先挑素材試，不鎖人），預設 cylX
  assert.equal(qa(c, '.nc-shape-btn').length, 3);
  assert.ok(q(c, '.nc-shape-btn[data-shape="cylX"]').classList.contains('is-on'));
  assert.equal(qa(c, '.nc-stock-warn').length, 0);
  assert.equal(q(c, 'input[data-field="size.y"]').value, '40');   // 直徑
  assert.equal(hnd.getStock().spec.anchor.x, 0);                  // 原點在左端面（反算）
  assert.match(c.textContent, /原點位置：左端面・軸心/);
  setValue(q(c, 'input[data-field="size.y"]'), 50);
  assert.equal(changes[0].spec.size.y, 50);
  assert.equal(changes[0].spec.shape, 'cylX');
  assert.deepEqual(changes[0].min, { x: 0, y: -25, z: -25 });
  // 換成長方體：允許，但要有「四軸下模擬會不準」的警示
  fire(q(c, '.nc-shape-btn[data-shape="box"]'), 'click');
  assert.equal(changes[1].spec.shape, 'box');
  assert.equal(qa(c, '.nc-stock-warn').length, 1);
});

// ---------------------------------------------------------------------------
// 預覽拖曳（純邏輯：transform 往返、命中、套用）
// ---------------------------------------------------------------------------
function dragStock() {
  return NC.analysis.stockFromSpec({
    shape: 'box', size: { x: 100, y: 60, z: 20 },
    anchor: { x: 0.5, y: 0.5, z: 1 }, pos: { x: 0, y: 0, z: 0 },
  });
}

test('drag：transform 螢幕↔工件座標往返', () => {
  const tf = L.stockPreviewTransform(dragStock(), 440, 300, 'top');
  assert.equal(tf.ax, 'x');
  assert.equal(tf.ay, 'y');
  for (const v of [-50, 0, 12.34, 50]) {
    assert.ok(Math.abs(L.tfWx(tf, L.tfPx(tf, v)) - v) < 1e-9);
    assert.ok(Math.abs(L.tfWy(tf, L.tfPy(tf, v)) - v) < 1e-9);
  }
  const front = L.stockPreviewTransform(dragStock(), 440, 220, 'front');
  assert.equal(front.ay, 'z');
});

test('drag：命中 ⊕、四條邊、空白、立圓柱圓周', () => {
  const s = dragStock();
  const tf = L.stockPreviewTransform(s, 440, 300, 'top');
  assert.deepEqual(L.stockDragHit(tf, s, L.tfPx(tf, 0), L.tfPy(tf, 0)), { kind: 'origin' });
  assert.deepEqual(L.stockDragHit(tf, s, L.tfPx(tf, 50), L.tfPy(tf, 10)), { kind: 'edge', which: 'maxX' });
  assert.deepEqual(L.stockDragHit(tf, s, L.tfPx(tf, -50), L.tfPy(tf, 10)), { kind: 'edge', which: 'minX' });
  assert.deepEqual(L.stockDragHit(tf, s, L.tfPx(tf, 30), L.tfPy(tf, 30)), { kind: 'edge', which: 'maxY' });
  assert.deepEqual(L.stockDragHit(tf, s, L.tfPx(tf, 30), L.tfPy(tf, -30)), { kind: 'edge', which: 'minY' });
  assert.equal(L.stockDragHit(tf, s, 3, 3), null);
  const cyl = NC.analysis.stockFromSpec({ shape: 'cylZ', size: { x: 40, y: 40, z: 20 }, anchor: { x: 0.5, y: 0.5, z: 1 } });
  const tfc = L.stockPreviewTransform(cyl, 440, 300, 'top');
  assert.deepEqual(L.stockDragHit(tfc, cyl, L.tfPx(tfc, 20), L.tfPy(tfc, 0)), { kind: 'radius' });
  assert.equal(L.stockDragHit(tfc, cyl, L.tfPx(tfc, 19), L.tfPy(tfc, 19)), null);  // 圓外的「角」不是東西
});

test('drag：拖 ⊕ 到角落磁吸九點、拖到中途殘量進 pos', () => {
  const s = dragStock();
  const tf = L.stockPreviewTransform(s, 440, 300, 'top');
  // 差一點點到左上角（f = 0.02／0.97）→ 磁吸成 (0,1)、pos 歸零
  const snapped = L.stockDragApply(s.spec, tf, { kind: 'origin' }, -48, 28.2);
  assert.equal(snapped.anchor.x, 0);
  assert.equal(snapped.anchor.y, 1);
  assert.equal(snapped.pos.x, 0);
  assert.equal(snapped.pos.y, 0);
  // 拖到 f=0.6：不吸，最近錨 0.5、殘量 -10 進 pos
  const free = L.stockDragApply(s.spec, tf, { kind: 'origin' }, 10, 0);
  assert.equal(free.anchor.x, 0.5);
  assert.equal(free.pos.x, -10);
  assert.equal(free.pos.y, 0);
});

test('drag：拖邊只長那一邊，對邊與原點不動', () => {
  const s = dragStock();
  const tf = L.stockPreviewTransform(s, 440, 300, 'top');
  const grow = L.stockDragApply(s.spec, tf, { kind: 'edge', which: 'maxX' }, 70, 0);
  assert.equal(grow.size.x, 120);
  assert.equal(grow.pos.x, 10);
  let st = NC.analysis.stockFromSpec(grow);
  assert.equal(st.min.x, -50);   // 對邊固定
  assert.equal(st.max.x, 70);
  const shrink = L.stockDragApply(s.spec, tf, { kind: 'edge', which: 'minX' }, -40, 0);
  assert.equal(shrink.size.x, 90);
  st = NC.analysis.stockFromSpec(shrink);
  assert.equal(st.min.x, -40);
  assert.equal(st.max.x, 50);    // 對邊固定
  // 尺寸吸 0.5 mm 格
  const snap = L.stockDragApply(s.spec, tf, { kind: 'edge', which: 'maxX' }, 70.3, 0);
  assert.equal(snap.size.x, 120.5);
});

test('drag：立圓柱拖圓周改直徑、拖 ⊕ 錨鎖軸心殘量進 pos', () => {
  const cyl = NC.analysis.stockFromSpec({ shape: 'cylZ', size: { x: 40, y: 40, z: 20 }, anchor: { x: 0.5, y: 0.5, z: 1 } });
  const tf = L.stockPreviewTransform(cyl, 440, 300, 'top');
  const bigger = L.stockDragApply(cyl.spec, tf, { kind: 'radius' }, 25, 0);
  assert.equal(bigger.size.x, 50);
  assert.equal(bigger.size.y, 50);
  const moved = L.stockDragApply(cyl.spec, tf, { kind: 'origin' }, 10, 0);
  assert.equal(moved.anchor.x, 0.5);   // 鎖軸心
  assert.equal(moved.pos.x, -10);      // 原點在軸心右 10 → 軸心在 −10
});

test('stockSummary：摘要文字、推估警語、開啟設定頁', () => {
  const c = container();
  let opened = 0;
  const hnd = P.stockSummary(c, { stock: null, onOpen: () => { opened++; } });
  // 沒有素材（可能連程式都還沒有）也要給入口——先設素材再寫程式是正常流程
  assert.match(c.textContent, /先把素材設好/);
  fire(q(c, '.nc-btn-open-setup'), 'click');
  assert.equal(opened, 1);
  const user = NC.analysis.stockFromSpec({
    shape: 'box', size: { x: 100, y: 60, z: 20 }, anchor: { x: 0.5, y: 1, z: 1 }, pos: { x: 0, y: 0, z: 0 },
  });
  hnd.update({ stock: user });
  assert.equal(q(c, '.nc-badge[data-source]').dataset.source, 'user');
  assert.match(q(c, '.nc-stock-brief').textContent, /長方體 100×60×20 mm・原點在上邊中點（頂面）/);
  assert.equal(qa(c, '.nc-stock-note').length, 0);
  fire(q(c, '.nc-btn-open-setup'), 'click');
  assert.equal(opened, 2);
  // 推估 → 有警語
  hnd.update({ stock: sampleStock() });
  assert.equal(q(c, '.nc-badge[data-source]').dataset.source, 'estimated');
  assert.equal(qa(c, '.nc-stock-note').length, 1);
});

test('logic.stockAnchorText / stockSummaryText：現場說法', () => {
  const at = (shape, anchor) => L.stockAnchorText({ shape, anchor });
  assert.equal(at('box', { x: 0.5, y: 0.5, z: 1 }), '中心（頂面）');
  assert.equal(at('box', { x: 0, y: 1, z: 1 }), '左上角（頂面）');
  assert.equal(at('box', { x: 0.5, y: 1, z: 0.5 }), '上邊中點（半高）');
  assert.equal(at('box', { x: 1, y: 0, z: 0 }), '右下角（底面）');
  assert.equal(at('cylZ', { x: 0.5, y: 0.5, z: 1 }), '軸心（頂面）');
  assert.equal(at('cylX', { x: 0, y: 0.5, z: 0.5 }), '左端面・軸心');
  const withOff = NC.analysis.stockFromSpec({
    shape: 'box', size: { x: 50, y: 40, z: 10 }, anchor: { x: 0, y: 1, z: 1 }, pos: { x: 2, y: 0, z: 0 },
  });
  assert.match(L.stockSummaryText(withOff), /左上角（頂面），偏移 \(2, 0, 0\)/);
});

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
test('settings：block skip 情境、multiSlash、requireM5、rapidRate、plungeFeedMax、格距', () => {
  const c = container();
  const changes = [];
  const hnd = P.settings(c, { settings: NC.util.defaultSettings(), scenario: 'off', cell: 0.5, onChange: (s) => changes.push(s) });
  const scn = q(c, 'select[data-field="scenario"]');
  assert.deepEqual(qa(scn, 'option').map((o) => o.value), ['off', 'on', 'multiIgnored']);
  assert.equal(scn.value, 'off');
  setValue(scn, 'on');
  assert.equal(changes[0].scenario, 'on');
  assert.equal(changes[0].settings.multiSlash, 'asSingle');
  setValue(q(c, 'select[data-field="multiSlash"]'), 'ignoreBlock');
  assert.equal(changes[1].settings.multiSlash, 'ignoreBlock');
  assert.equal(changes[1].scenario, 'on');
  const m5 = qa(c, 'input[type="checkbox"]')[0];
  m5.checked = true; fire(m5, 'change');
  assert.equal(changes[2].settings.requireM5BeforeM6, true);
  setValue(q(c, 'input[data-field="rapidRate"]'), 15000);
  assert.equal(changes[3].settings.rapidRate, 15000);
  setValue(q(c, 'input[data-field="plungeFeedMax"]'), 200);
  assert.equal(changes[4].settings.plungeFeedMax, 200);
  setValue(q(c, 'select[data-field="cell"]'), '0.25');
  assert.equal(changes[5].cell, 0.25);
  setValue(q(c, 'input[data-field="skipLevelsOn"]'), '1, 2');
  assert.deepEqual(changes[6].settings.skipLevelsOn, [1, 2]);
  // 無效值不送出
  setValue(q(c, 'input[data-field="rapidRate"]'), -5);
  assert.equal(changes.length, 7);
  assert.equal(q(c, 'input[data-field="rapidRate"]').value, '15000');
  assert.equal(hnd.getState().settings.rapidRate, 15000);
  assert.equal(hnd.getState().cell, 0.25);
  // 原始物件未被修改
  const orig = NC.util.defaultSettings();
  assert.equal(orig.rapidRate, 20000);
});

// ===========================================================================
// 刀庫（settings.magazine）純邏輯
// ===========================================================================
test('logic.normalizeMagazine：補齊預設、"T20" key 轉數字、超出刀位總數的登記丟掉', () => {
  const m = L.normalizeMagazine({ size: 24, pots: { 20: 5, T11: '4', 9: 30, bad: 2, 7: null } });
  assert.equal(m.size, 24);
  assert.deepEqual(m.pots, { 11: 4, 20: 5 });   // T9 的 30 號刀位不存在、bad/null 丟掉
  assert.deepEqual(m.resident, []);
  assert.equal(m.largeToolDiameter, 80);
  assert.equal(m.largeToolNeighbors, 1);
  // 空物件 → 一份可用的預設（24 / 80 / 1）
  const d = L.normalizeMagazine({});
  assert.equal(d.size, 24);
  assert.equal(d.largeToolDiameter, 80);
  assert.equal(d.largeToolNeighbors, 1);
  assert.deepEqual(d.pots, {});
  // 亂填的值收斂到範圍內
  const c = L.normalizeMagazine({ size: '0', largeToolDiameter: -5, largeToolNeighbors: 99, resident: ['T20', 3, 'x'] });
  assert.equal(c.size, 1);
  assert.equal(c.largeToolDiameter, 80);
  assert.equal(c.largeToolNeighbors, 8);
  assert.deepEqual(c.resident, [3, 20]);
});

test('logic.normalizeMagazine：不是物件 → null（等於不啟用，R30 整條不跑）', () => {
  for (const v of [null, undefined, 0, '', 'x', 12]) assert.equal(L.normalizeMagazine(v), null);
  assert.notEqual(L.normalizeMagazine({}), null);
});

test('logic.defaultMagazine：新開一份是空刀位（不亂填假資料）', () => {
  const d = L.defaultMagazine();
  assert.deepEqual(d.pots, {});
  assert.deepEqual(d.resident, []);
  assert.equal(d.size, 24);
});

test('logic.wrapPot / ringPositions：刀庫是環狀的，第 1 號的隔壁是最後一號', () => {
  assert.equal(L.wrapPot(0, 24), 24);
  assert.equal(L.wrapPot(-1, 24), 23);
  assert.equal(L.wrapPot(25, 24), 1);
  assert.equal(L.wrapPot(24, 24), 24);
  const pos = L.ringPositions(24);
  assert.equal(pos.length, 24);
  assert.equal(pos[0].pot, 1);
  // 第 1 號在正上方（x 置中、y 最小）
  assert.ok(Math.abs(pos[0].x - 50) < 1e-9);
  assert.ok(pos[0].y < 20);
  // 順時針：第 7 號在右側
  assert.ok(pos[6].x > 80);
});

test('logic.magazineStatus：大徑刀撞隔壁刀位（現場真的發生過的那件事）', () => {
  const tools = [
    { t: 20, diameter: 100, resident: true }, { t: 11, diameter: 12 }, { t: 5, diameter: 4 },
  ];
  const st = L.magazineStatus({ size: 24, pots: { 20: 5, 11: 4 }, largeToolDiameter: 80, largeToolNeighbors: 1 }, tools, [20, 11, 5]);
  const clash = st.issues.filter((i) => i.severity === 'error' && i.text.indexOf('互撞') >= 0);
  assert.equal(clash.length, 1);
  assert.match(clash[0].text, /T20（Ø100）在第 5 號刀位，隔壁第 4 號放了 T11（Ø12）/);
  assert.equal(st.cells[4].big, true);          // 第 5 號是大徑刀
  assert.deepEqual(st.cells[4].bigOwners, [20]);
  assert.equal(st.cells[3].conflict, true);      // 第 4 號標紅
  assert.equal(st.cells[4].conflict, true);
  assert.deepEqual(st.cells[5].clearFor, [20]);  // 第 6 號空著但必須為 T20 淨空
  assert.equal(st.cells[5].conflict, false);
  // T5 沒指定刀位 → warning
  assert.ok(st.issues.some((i) => i.severity === 'warning' && i.text.indexOf('T5') >= 0));
  assert.deepEqual(st.unassigned, [5]);
});

test('logic.magazineStatus：環狀相鄰——第 1 號的大徑刀會撞到最後一號', () => {
  const tools = [{ t: 20, diameter: 100 }, { t: 11, diameter: 12 }];
  const st = L.magazineStatus({ size: 24, pots: { 20: 1, 11: 24 }, largeToolDiameter: 80, largeToolNeighbors: 1 }, tools, [20, 11]);
  assert.ok(st.issues.some((i) => /第 1 號刀位，隔壁第 24 號放了 T11/.test(i.text)));
  assert.equal(st.cells[23].conflict, true);
});

test('logic.magazineStatus：單邊淨空 2 個刀位時，隔兩格也算撞', () => {
  const tools = [{ t: 20, diameter: 100 }, { t: 11, diameter: 12 }];
  const near = L.magazineStatus({ size: 24, pots: { 20: 5, 11: 7 }, largeToolDiameter: 80, largeToolNeighbors: 1 }, tools, [20, 11]);
  assert.equal(near.issues.filter((i) => i.text.indexOf('互撞') >= 0).length, 0);
  const far = L.magazineStatus({ size: 24, pots: { 20: 5, 11: 7 }, largeToolDiameter: 80, largeToolNeighbors: 2 }, tools, [20, 11]);
  assert.equal(far.issues.filter((i) => i.text.indexOf('互撞') >= 0).length, 1);
});

test('logic.magazineStatus：同刀位兩把刀、刀號超出刀庫、常駐清單對不上', () => {
  const tools = [{ t: 4, diameter: 5 }, { t: 11, diameter: 12 }, { t: 20, diameter: 100, resident: true }, { t: 30, diameter: 6 }];
  const st = L.magazineStatus({ size: 24, pots: { 4: 4, 11: 4, 20: 12 }, resident: [], largeToolDiameter: 80 }, tools, [4, 11, 20, 30]);
  assert.ok(st.issues.some((i) => i.severity === 'error' && /第 4 號刀位登記了 T4、T11/.test(i.text)));
  assert.equal(st.cells[3].conflict, true);
  assert.ok(st.issues.some((i) => i.severity === 'error' && /T30 超出刀庫範圍/.test(i.text)));
  assert.ok(st.issues.some((i) => i.severity === 'info' && /T20 .*★ 常駐刀/.test(i.text)));
  // 常駐清單有列到就不再提醒
  const st2 = L.magazineStatus({ size: 24, pots: { 20: 12 }, resident: [20], largeToolDiameter: 80 }, tools, [20]);
  assert.equal(st2.issues.filter((i) => i.severity === 'info').length, 0);
  assert.equal(st2.cells[11].resident, true);
});

test('logic.magazineStatus：沒啟用時什麼都不算', () => {
  const st = L.magazineStatus(null, [{ t: 1, diameter: 10 }], [1]);
  assert.deepEqual(st.cells, []);
  assert.deepEqual(st.issues, []);
});

// ===========================================================================
// CSV 匯入／匯出純邏輯
// ===========================================================================
test('logic.withBOM：補上 UTF-8 BOM，已經有就不重複補', () => {
  const s = L.withBOM('程式,T\r\n');
  assert.equal(s.charCodeAt(0), 0xFEFF);
  assert.equal(L.withBOM(s), s);              // 不會變成兩個 BOM
  assert.equal(s.slice(1), '程式,T\r\n');
  assert.equal(L.withBOM('').charCodeAt(0), 0xFEFF);
  assert.equal(L.withBOM(null).charCodeAt(0), 0xFEFF);
});

test('logic.csvFileName：帶程式號，去掉 Windows 檔名不能用的字元', goldenSkip, () => {
  assert.equal(L.csvFileName('O1001'), '刀具表_O1001.csv');
  assert.equal(L.csvFileName(''), '刀具表.csv');
  assert.equal(L.csvFileName(null), '刀具表.csv');
  assert.equal(L.csvFileName('P-1234(A)'), '刀具表_P-1234(A).csv');
  assert.equal(L.csvFileName('a/b:c*d?'), '刀具表_a_b_c_d_.csv');
});

test('logic.looksLikeToolCSV：分得出刀具表 CSV 與 NC 程式（拖放要靠它分流）', () => {
  assert.equal(L.looksLikeToolCSV('刀具表.csv', ''), true);
  assert.equal(L.looksLikeToolCSV('X.CSV', 'anything'), true);
  // 沒有副檔名 → 看第一列欄名
  assert.equal(L.looksLikeToolCSV('待補', '﻿程式,T,程式註解,推測型式,推測直徑mm\r\nO1001,T1,63MM,面銑刀,63'), true);
  assert.equal(L.looksLikeToolCSV('tools', '程式,T,用到的D號\n'), true);
  // NC 程式不能被當成 CSV
  assert.equal(L.looksLikeToolCSV('demo-plate.nc', '%\nO1001\nM6T1(63MM)\n'), false);
  assert.equal(L.looksLikeToolCSV('demo-tap.nc', 'G0G90G54X118.,Y-40.25\n'), false);   // 有逗號但沒有 T 欄
  assert.equal(L.looksLikeToolCSV('', ''), false);
});

function csvTable() {
  return {
    programKey: 'O1001',
    tools: [
      { t: 11, label: '12MM', type: 'endmill', diameter: 8, angle: null, fluteLen: null, stickout: null, pitch: null, resident: false, probe: false, source: { type: 'comment', diameter: 'user' } },
      { t: 3, label: '10V', type: 'chamfer', diameter: 10, angle: 90, fluteLen: 12, stickout: null, pitch: null, resident: false, probe: false, source: { type: 'comment', diameter: 'user', angle: 'user', fluteLen: 'user' } },
      { t: 99, label: '別支程式的刀', type: 'drill', diameter: 6, angle: 118, fluteLen: null, stickout: null, pitch: null, resident: false, probe: false, source: { type: 'user', diameter: 'user' } },
    ],
    offsets: [
      { n: 11, lenGeom: 0, lenWear: 0, radGeom: 4.01, radWear: -0.02, source: 'user' },
      { n: 3, lenGeom: 0, lenWear: 0, radGeom: 5, radWear: 0, source: 'default' },
    ],
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

test('logic.mergeCSVTable：只吃「手填」欄位，沒用到的 T 記在 skipped', () => {
  const cur = sampleTable();
  const r = L.mergeCSVTable(cur, csvTable());
  assert.equal(r.tools, 2);          // T11、T3
  assert.equal(r.fields, 4);         // T11 直徑；T3 直徑／角度／刃長
  assert.equal(r.offsets, 1);        // 只有 D11 是 user
  assert.deepEqual(r.skipped, [99]); // 這支程式沒用到 → 不塞進來
  const t11 = r.table.tools.find((x) => x.t === 11);
  assert.equal(t11.diameter, 8);
  assert.equal(t11.source.diameter, 'user');
  assert.equal(t11.label, '12MM');                 // 沒填的欄位不動
  assert.equal(t11.source.type, 'comment');
  const t3 = r.table.tools.find((x) => x.t === 3);
  assert.equal(t3.diameter, 10);
  assert.equal(t3.fluteLen, 12);
  assert.equal(t3.source.fluteLen, 'user');
  const d11 = r.table.offsets.find((o) => o.n === 11);
  assert.equal(d11.radGeom, 4.01);
  assert.equal(d11.radWear, -0.02);
  assert.equal(d11.source, 'user');
  // D3 在匯入檔裡是 default → 不覆蓋原本的 default
  assert.equal(r.table.offsets.find((o) => o.n === 3).radGeom, 4);
  // 原始物件沒被改到
  assert.equal(cur.tools.find((x) => x.t === 11).diameter, 12);
});

test('logic.mergeCSVTable：整份都沒填 → 什麼都不改，計數為 0', () => {
  const empty = { programKey: 'O1001', tools: [{ t: 11, diameter: 12, source: { type: 'comment', diameter: 'comment' } }], offsets: [], updatedAt: '' };
  const r = L.mergeCSVTable(sampleTable(), empty);
  assert.equal(r.tools, 0);
  assert.equal(r.offsets, 0);
  assert.equal(r.table.tools.find((x) => x.t === 11).diameter, 12);
  assert.match(L.describeImport(r), /沒有「請填_」欄位的值可以匯入/);
});

test('logic.describeImport：一句話講清楚匯進了什麼', () => {
  assert.equal(L.describeImport({ tools: 4, offsets: 2, skipped: [] }), '匯入了 4 把刀、2 筆補正值');
  assert.equal(L.describeImport({ tools: 0, offsets: 3, skipped: [] }), '匯入了 3 筆補正值');
  assert.match(L.describeImport({ tools: 1, offsets: 0, skipped: [98, 99] }), /T98、T99 這支程式沒用到，已略過/);
  assert.equal(L.describeImport(null), '匯入失敗');
});

test('logic.csvFieldError：負值、0、天文數字、非數字都不能收', () => {
  assert.equal(L.csvFieldError('diameter', 8), null);
  assert.match(L.csvFieldError('diameter', -5), /大於 0/);
  assert.match(L.csvFieldError('diameter', 0), /大於 0/);
  assert.match(L.csvFieldError('diameter', 5000), /大得不合理/);
  assert.match(L.csvFieldError('fluteLen', -1), /大於 0/);
  assert.equal(L.csvFieldError('angle', 118), null);
  assert.match(L.csvFieldError('angle', 0), /0～180/);
  assert.match(L.csvFieldError('angle', 200), /0～180/);
  assert.match(L.csvFieldError('diameter', 'abc'), /不是數字/);
  assert.equal(L.csvFieldError('type', 'endmill'), null);
  assert.match(L.csvFieldError('type', ''), /讀不出來/);
});

test('logic.mergeCSVTable：直徑填 -5／0 不會收進來，而且會講出來', () => {
  const imported = {
    programKey: 'O1001',
    tools: [
      { t: 11, diameter: -5, source: { diameter: 'user' } },
      { t: 20, diameter: 0, source: { diameter: 'user' } },
      { t: 7, angle: 400, fluteLen: 20, source: { angle: 'user', fluteLen: 'user' } },
    ],
    offsets: [{ n: 11, lenGeom: 0, lenWear: 0, radGeom: -3, radWear: 0, source: 'user' }],
    updatedAt: '',
  };
  const cur = sampleTable();
  const r = L.mergeCSVTable(cur, imported);
  assert.equal(r.table.tools.find((x) => x.t === 11).diameter, 12);   // 原值不動
  assert.equal(r.table.tools.find((x) => x.t === 20).diameter, 100);
  assert.equal(r.table.tools.find((x) => x.t === 7).angle, 118);      // 角度 400 度不收
  assert.equal(r.table.tools.find((x) => x.t === 7).fluteLen, 20);    // 同一列合理的欄位照收
  assert.equal(r.tools, 1);
  assert.equal(r.offsets, 0);                                        // 半徑形狀 -3 不收
  assert.equal(r.table.offsets.find((o) => o.n === 11).radGeom, 6);
  assert.equal(r.rejected.length, 4);
  const msg = L.describeImport(r);
  assert.match(msg, /T11 的直徑（-5：要大於 0）/);
  assert.match(msg, /D11 的補正值/);
  assert.equal(L.importStatusKind(r), 'warn');
});

test('logic.csvUnparsedCells：「8?」這種有寫東西但不是數字的格子要抓出來', () => {
  const csv = '程式,T,程式註解,請填_直徑mm,請填_刃長mm\r\n'
    + 'O1001,T11,12MM,8?,\r\n'
    + 'O1001,T12,12MM,約 8,36\r\n'
    + 'O1001,T20,100MM,100,\r\n'
    + 'O1001,T7,SG-4.5,,-\r\n';
  const bad = L.csvUnparsedCells(csv);
  assert.deepEqual(bad, [
    { t: 11, column: '請填_直徑mm', raw: '8?' },
    { t: 12, column: '請填_直徑mm', raw: '約 8' },
    { t: 7, column: '請填_刃長mm', raw: '-' },
  ]);
  // 沒有 T 欄或整份空白時不要炸
  assert.deepEqual(L.csvUnparsedCells(''), []);
  assert.deepEqual(L.csvUnparsedCells('a,b\r\n1,2'), []);
  const msg = L.describeImport({ tools: 0, offsets: 2, skipped: [], rejected: [] }, bad);
  assert.match(msg, /T11 的「請填_直徑mm」寫的是「8\?」/);
  assert.match(msg, /只填得下純數字/);
  assert.equal(L.importStatusKind({ tools: 0, offsets: 2, rejected: [] }, bad), 'warn');
  assert.equal(L.importStatusKind({ tools: 2, offsets: 0, rejected: [] }, []), 'ok');
});

test('logic.csvUnparsedCells / groupUnparsed：同一份 CSV 放了多支程式的列時不重複報', () => {
  const csv = '程式,T,請填_直徑mm\r\n'
    + '樣本 A,T11,8?\r\n樣本 A,T12,8?\r\n'
    + '樣本 B,T11,8?\r\n樣本 B,T12,8?\r\n';
  const bad = L.csvUnparsedCells(csv);
  assert.equal(bad.length, 2, '同一把刀同一格重複出現只算一次');
  assert.deepEqual(L.groupUnparsed(bad), ['T11、T12 的「請填_直徑mm」寫的是「8?」']);
  const msg = L.describeImport({ tools: 0, offsets: 2, skipped: [], rejected: [] }, bad);
  assert.equal(msg, '匯入了 2 筆補正值；T11、T12 的「請填_直徑mm」寫的是「8?」——這幾格只填得下純數字，沒有匯進來');
});

test('刀具 CSV：填不出數字的直徑（例如「8?」）不會被默默吞掉', () => {
  // 現場常把「大概 8，還要量」寫成 8?。這種值不能當成 8 收進去，但也不能靜靜丟掉。
  const csv = '﻿' + [
    NC.tools.CSV_HEADER.join(','),
    'demo-plate,T11,12MM,平銑刀,12,G41,-36.0,,8?,,,,D11,,',
    'demo-plate,T12,12MM,平銑刀,12,G41,-30.2,,8?,,,,D12,,',
  ].join('\r\n');
  const bad = L.csvUnparsedCells(csv);
  assert.ok(bad.some((x) => x.t === 11 && x.raw === '8?'), '應該抓到 T11 的 8?');
  assert.ok(bad.some((x) => x.t === 12 && x.raw === '8?'), '應該抓到 T12 的 8?');
  const imported = NC.tools.fromCSV(csv, 'demo-plate');
  const r = L.mergeCSVTable({ programKey: 'O1001', tools: [{ t: 11, diameter: 12, source: {} }, { t: 12, diameter: 12, source: {} }], offsets: [], updatedAt: '' }, imported);
  assert.equal(r.tools, 0);                       // 直徑沒收進來（8? 不是數字）
  assert.match(L.describeImport(r, bad), /8\?/);  // 但訊息一定要講
});

// ===========================================================================
// 刀庫面板
// ===========================================================================
function magTools() {
  return {
    programKey: 'O1001',
    tools: [
      { t: 20, label: '100MM', type: 'facemill', diameter: 100, resident: true, probe: false, source: {} },
      { t: 11, label: '12MM', type: 'endmill', diameter: 12, resident: false, probe: false, source: {} },
      { t: 5, label: '4MM', type: 'endmill', diameter: 4, resident: false, probe: false, source: {} },
    ],
    offsets: [], updatedAt: '',
  };
}

test('magazine：預設不啟用；打開給 24／80／1，關掉回傳 null（settings.magazine 要消失）', () => {
  const c = container();
  const changes = [];
  P.magazine(c, { magazine: null, toolTable: magTools(), usedTools: [20, 11, 5], onChange: (m) => changes.push(m) });
  assert.equal(qa(c, '.nc-pot').length, 0);
  assert.match(c.textContent, /目前不檢查刀庫/);
  const cb = q(c, '.nc-mag-head input');
  cb.checked = true; fire(cb, 'change');
  assert.equal(changes[0].size, 24);
  assert.equal(changes[0].largeToolDiameter, 80);
  assert.equal(changes[0].largeToolNeighbors, 1);
  assert.deepEqual(changes[0].pots, {});
  assert.equal(qa(c, '.nc-pot').length, 24);
  // 關掉 → null
  const cb2 = q(c, '.nc-mag-head input');
  cb2.checked = false; fire(cb2, 'change');
  assert.equal(changes[1], null);
  assert.equal(qa(c, '.nc-pot').length, 0);
});

test('magazine：關掉再打開，原本填好的刀位不會整份消失', () => {
  const c = container();
  const changes = [];
  P.magazine(c, { magazine: { size: 24, pots: { 20: 5 } }, toolTable: magTools(), usedTools: [20], onChange: (m) => changes.push(m) });
  const off = q(c, '.nc-mag-head input');
  off.checked = false; fire(off, 'change');
  assert.equal(changes[0], null);
  const on = q(c, '.nc-mag-head input');
  on.checked = true; fire(on, 'change');
  assert.deepEqual(changes[1].pots, { 20: 5 });
});

test('magazine：點刀名拿起來、點刀位放進去；再點該刀位清空', () => {
  const c = container();
  const changes = [];
  P.magazine(c, { magazine: { size: 24, pots: {} }, toolTable: magTools(), usedTools: [20, 11, 5], onChange: (m) => changes.push(m) });
  const arm = q(c, '.nc-mag-tool[data-t="20"]');
  assert.ok(arm.className.indexOf('is-unplaced') >= 0);
  fire(arm, 'click');
  assert.ok(q(c, '.nc-mag-tool[data-t="20"]').className.indexOf('is-armed') >= 0);
  assert.equal(changes.length, 0);   // 只是拿起來，還沒改設定
  fire(q(c, '.nc-pot[data-pot="5"]'), 'click');
  assert.deepEqual(changes[0].pots, { 20: 5 });
  assert.equal(q(c, '.nc-pot[data-pot="5"]').dataset.tools, '20');
  // 再點一次同一個刀位 → 清空
  fire(q(c, '.nc-pot[data-pot="5"]'), 'click');
  assert.deepEqual(changes[1].pots, {});
});

test('magazine：刀位號輸入格、常駐勾選、依刀號自動填入、全部清空', () => {
  const c = container();
  const changes = [];
  const hnd = P.magazine(c, { magazine: { size: 24, pots: {} }, toolTable: magTools(), usedTools: [20, 11, 5], onChange: (m) => changes.push(m) });
  setValue(q(c, 'input[data-t="11"][data-field="pot"]'), 4);
  assert.deepEqual(changes[0].pots, { 11: 4 });
  // 超出刀庫的號碼不接受，輸入格退回原值
  const potIn = q(c, 'input[data-t="11"][data-field="pot"]');
  potIn.value = '99'; fire(potIn, 'change');
  assert.equal(changes.length, 1);
  assert.equal(q(c, 'input[data-t="11"][data-field="pot"]').value, '4');
  // 清空輸入格 = 取消指定
  setValue(q(c, 'input[data-t="11"][data-field="pot"]'), '');
  assert.deepEqual(changes[1].pots, {});
  // 常駐刀勾選
  const res = q(c, 'input[data-t="20"][data-field="resident"]');
  res.checked = true; fire(res, 'change');
  assert.deepEqual(changes[2].resident, [20]);
  // 依刀號自動填入 → T20 放第 20 號、T11 放第 11 號
  const auto = qa(c, '.nc-mag-actions .nc-btn').find((b) => b.textContent.indexOf('依刀號自動填入') >= 0);
  fire(auto, 'click');
  assert.deepEqual(changes[3].pots, { 5: 5, 11: 11, 20: 20 });
  assert.match(c.textContent, /已依刀號填入刀位/);
  // 全部清空
  const clr = qa(c, '.nc-mag-actions .nc-btn').find((b) => b.textContent.indexOf('全部清空') >= 0);
  fire(clr, 'click');
  assert.deepEqual(changes[4].pots, {});
  assert.deepEqual(hnd.getMagazine().pots, {});
});

test('magazine：大徑刀撞隔壁刀位 → 面板上直接標紅並列出來（不用等錯誤清單）', () => {
  const c = container();
  P.magazine(c, {
    magazine: { size: 24, pots: { 20: 5, 11: 4 }, largeToolDiameter: 80, largeToolNeighbors: 1 },
    toolTable: magTools(), usedTools: [20, 11, 5], onChange: () => {},
  });
  const errs = qa(c, '.nc-mag-issue[data-severity="error"]');
  assert.ok(errs.length >= 1);
  assert.ok(errs.some((e) => /T20（Ø100）在第 5 號刀位，隔壁第 4 號放了 T11（Ø12）/.test(e.textContent)));
  assert.equal(q(c, '.nc-pot[data-pot="4"]').dataset.conflict, '1');
  assert.equal(q(c, '.nc-pot[data-pot="5"]').dataset.conflict, '1');
  assert.equal(q(c, '.nc-pot[data-pot="5"]').dataset.big, '1');
  // 第 6 號空著、必須淨空 → 上色但不算衝突
  assert.equal(q(c, '.nc-pot[data-pot="6"]').dataset.conflict, '0');
  assert.ok(q(c, '.nc-pot[data-pot="6"]').className.indexOf('is-clear') >= 0);
  // 大徑刀徽章只掛在真的大徑那一把上
  const row20 = q(c, 'tr[data-t="20"]');
  const row11 = q(c, 'tr[data-t="11"]');
  assert.match(row20.textContent, /大徑刀/);
  assert.equal(/大徑刀/.test(row11.textContent), false);
});

test('magazine：縮小刀位總數會把不存在的刀位登記移除並說明', () => {
  const c = container();
  const changes = [];
  P.magazine(c, {
    magazine: { size: 24, pots: { 20: 20, 11: 4 } }, toolTable: magTools(), usedTools: [20, 11], onChange: (m) => changes.push(m),
  });
  setValue(q(c, 'input[data-field="size"]'), 12);
  assert.equal(changes[0].size, 12);
  assert.deepEqual(changes[0].pots, { 11: 4 });
  assert.match(c.textContent, /刀庫縮成 12 個刀位/);
  assert.equal(qa(c, '.nc-pot').length, 12);
});

test('magazine：刀庫裡本程式沒用到的鄰居刀也列得出來、可以移除', () => {
  const c = container();
  const changes = [];
  P.magazine(c, {
    magazine: { size: 24, pots: { 20: 5, 7: 4 }, largeToolDiameter: 80 },
    toolTable: magTools(), usedTools: [20, 11, 5], onChange: (m) => changes.push(m),
  });
  const row7 = q(c, 'tr[data-t="7"]');
  assert.ok(row7);
  assert.match(row7.textContent, /他程式/);
  // 沒有直徑資料的鄰居刀還是會被算成「佔著大徑刀該淨空的刀位」
  assert.ok(qa(c, '.nc-mag-issue[data-severity="error"]').some((e) => /隔壁第 4 號放了 T7/.test(e.textContent)));
  // 刀號改得動（登記進來的預設號碼不一定是現場的號碼）
  setValue(q(row7, 'input[data-field="t"]'), 21);
  assert.deepEqual(changes[0].pots, { 20: 5, 21: 4 });
  // 已經被佔用的刀號不接受
  const t21 = q(c, 'tr[data-t="21"] input[data-field="t"]');
  t21.value = '20'; fire(t21, 'change');
  assert.equal(changes.length, 1);
  assert.equal(q(c, 'tr[data-t="21"] input[data-field="t"]').value, '21');
  fire(q(c, 'tr[data-t="21"] .nc-btn-danger'), 'click');
  assert.deepEqual(changes[1].pots, { 20: 5 });
});

test('magazine：「＋ 登記其他刀」挑的是本程式沒用到的刀號（不然只是默默幫 T5 指定刀位）', () => {
  const c = container();
  const changes = [];
  P.magazine(c, {
    magazine: { size: 24, pots: {}, largeToolDiameter: 80 },
    toolTable: magTools(), usedTools: [20, 11, 5], onChange: (m) => changes.push(m),
  });
  const add = () => fire(qa(c, '.nc-btn').find((b) => /登記其他刀/.test(b.textContent)), 'click');
  add();
  // T5 是本程式的刀 → 不能被當成「其他刀」；第一個沒人用的號碼是 T1
  assert.deepEqual(changes[0].pots, { 1: 1 });
  assert.ok(q(c, 'tr[data-t="1"]'), '要有 T1 那一列');
  assert.match(q(c, 'tr[data-t="1"]').textContent, /他程式/);
  add(); add();
  assert.deepEqual(changes[2].pots, { 1: 1, 2: 2, 3: 3 });
  assert.match(q(c, '.nc-mag-note').textContent, /別支程式的刀/);
});

test('magazine：刀位全滿時「＋ 登記其他刀」不會偷偷疊在別人身上', () => {
  const c = container();
  const changes = [];
  P.magazine(c, {
    magazine: { size: 2, pots: { 30: 1, 31: 2 }, largeToolDiameter: 80 },
    toolTable: magTools(), usedTools: [], onChange: (m) => changes.push(m),
  });
  fire(qa(c, '.nc-btn').find((b) => /登記其他刀/.test(b.textContent)), 'click');
  assert.equal(changes.length, 0);
  assert.match(q(c, '.nc-mag-note').textContent, /都登記滿了/);
});

test('magazine：大徑刀的刀位有「大」記號——撞刀時三格全紅，要分得出誰是肇事者', () => {
  const c = container();
  P.magazine(c, {
    magazine: { size: 24, pots: { 20: 5, 11: 4 }, largeToolDiameter: 80, largeToolNeighbors: 1 },
    toolTable: magTools(), usedTools: [20, 11], onChange: () => {},
  });
  const potOf = (n) => qa(c, '.nc-pot').find((e) => e.dataset.pot === String(n));
  assert.ok(q(potOf(5), '.nc-pot-big'), '第 5 號（T20 Ø100）要有「大」記號');
  assert.equal(q(potOf(4), '.nc-pot-big'), null, '被撞的鄰居不可以標成大徑刀');
  assert.equal(potOf(5).dataset.big, '1');
  assert.equal(potOf(4).dataset.conflict, '1');
});

// ===========================================================================
// 刀具表：CSV 按鈕與拖放
// ===========================================================================
test('toolTable：匯出／匯入按鈕接到 app，結果訊息顯示在面板上', () => {
  const c = container();
  let exported = 0;
  const files = [];
  const hnd = P.toolTable(c, {
    table: sampleTable(), ops: sampleOps(), onChange: () => {},
    onExportCSV: () => { exported++; },
    onImportFile: (f) => files.push(f),
  });
  fire(q(c, 'button[data-action="exportCsv"]'), 'click');
  assert.equal(exported, 1);
  // 匯入：<input type=file> 的 change
  const input = q(c, 'input[data-role="csv"]');
  assert.equal(input.getAttribute('accept'), '.csv,text/csv');
  input.files = [{ name: '刀具表_O1001.csv' }];
  fire(input, 'change');
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '刀具表_O1001.csv');
  assert.match(q(c, '.nc-import-msg').textContent, /讀取中/);
  hnd.setImportStatus('匯入了 4 把刀、2 筆補正值', 'ok');
  assert.match(q(c, '.nc-import-msg').textContent, /匯入了 4 把刀、2 筆補正值/);
  assert.ok(q(c, '.nc-import-msg').className.indexOf('is-ok') >= 0);
  // 重新整理面板之後訊息還在（app 匯入完會 refresh）
  hnd.update({ table: sampleTable(), ops: sampleOps() });
  assert.match(q(c, '.nc-import-msg').textContent, /匯入了 4 把刀/);
  hnd.setImportStatus('這個 CSV 讀不進來：欄位對不上', 'error');
  assert.ok(q(c, '.nc-import-msg').className.indexOf('is-error') >= 0);
});

test('toolTable：沒有刀具時 CSV 按鈕還是在（不然匯不進來就永遠沒有刀）', () => {
  const c = container();
  P.toolTable(c, { table: { programKey: '', tools: [], offsets: [], updatedAt: '' }, onChange: () => {} });
  assert.ok(q(c, 'button[data-action="exportCsv"]'));
  assert.ok(q(c, 'button[data-action="importCsv"]'));
  assert.match(c.textContent, /沒有刀具/);
});

test('toolTable：CSV 拖進面板會被接住；其他檔案讓它冒泡給整頁拖放開程式', goldenSkip, () => {
  const c = container();
  const files = [];
  P.toolTable(c, { table: sampleTable(), ops: sampleOps(), onChange: () => {}, onImportFile: (f) => files.push(f) });
  const panel = q(c, '.nc-panel-tools') || c.children[0];
  const dropEvent = (name) => {
    let prevented = false, stopped = false;
    const ev = {
      type: 'drop', bubbles: true,
      dataTransfer: { types: ['Files'], files: [{ name }] },
      preventDefault: () => { prevented = true; },
    };
    panel.dispatchEvent(ev);
    stopped = prevented;   // 本面板只在攔下來的時候 preventDefault
    return { prevented, stopped };
  };
  // dragover 會亮起來
  panel.dispatchEvent({ type: 'dragover', dataTransfer: { types: ['Files'] }, preventDefault: () => {} });
  assert.ok(panel.className.indexOf('is-csv-drop') >= 0);
  panel.dispatchEvent({ type: 'dragleave' });
  assert.equal(panel.className.indexOf('is-csv-drop'), -1);
  // .csv → 面板自己吃掉
  const a = dropEvent('刀具表_O1001.csv');
  assert.equal(a.prevented, true);
  assert.equal(files.length, 1);
  // NC 程式 → 不攔，讓 app 去開
  const b = dropEvent(FIX_A);
  assert.equal(b.prevented, false);
  assert.equal(files.length, 1);
});

// ===========================================================================
// 真實資料
// ===========================================================================
test('真實資料 樣本 A：刀庫填好之後 R30 抓得到 T20 撞隔壁刀位', goldenSkip, () => {
  const text = fixture(FIX_A);
  const settings = Object.assign(NC.util.defaultSettings(), {
    magazine: L.normalizeMagazine({ size: 24, pots: { 20: 5, 11: 4 }, largeToolDiameter: 80, largeToolNeighbors: 1 }),
  });
  const res = NC.analyzeSync({ text, settings, scenarios: ['off'], sim: { enabled: false } });
  const r30 = res.diagnostics.filter((d) => d.ruleId === 'R30');
  const clash = r30.filter((d) => d.severity === 'error');
  assert.equal(clash.length, 1);
  assert.equal(clash[0].message, 'T20（Ø100）在第 5 號刀位，隔壁第 4 號放了 T11（Ø12）');
  // 面板算出來的結論要和 R30 一致
  const st = L.magazineStatus(settings.magazine, res.toolTable.tools, res.scenarios.off.run.ops.map((o) => o.tool).filter((t) => t != null));
  assert.equal(st.issues.filter((i) => i.severity === 'error' && i.text.indexOf('互撞') >= 0).length, 1);
  // 沒啟用（magazine 不存在）→ R30 一則都不出
  const plain = NC.analyzeSync({ text, settings: NC.util.defaultSettings(), scenarios: ['off'], sim: { enabled: false } });
  assert.equal(plain.diagnostics.filter((d) => d.ruleId === 'R30').length, 0);
});

test('刀具表 CSV：toCSV → fromCSV → mergeCSVTable，手填值帶得回來且有 BOM', () => {
  const text = fs.readFileSync(path.join(ROOT, 'samples', 'demo-plate.nc'), 'latin1');
  const res = NC.analyzeSync({ text, settings: NC.util.defaultSettings(), scenarios: ['off'], sim: { enabled: false } });
  const csv = L.withBOM(NC.tools.toCSV(res.toolTable, { tok: res.tok, run: res.scenarios.off.run }));
  assert.equal(csv.charCodeAt(0), 0xFEFF);   // 少了 BOM，Excel 開起來整排中文是亂碼
  const rows = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(rows[0], NC.tools.CSV_HEADER.join(','));
  assert.equal(rows.length, 1 + res.toolTable.tools.length);
  // 現場填直徑（程式註解寫 10MM，實際裝的是 8MM）與 D2 補正
  const key = res.toolTable.programKey;
  const filled = rows.map((r, i) => {
    if (i === 0 || r.indexOf(key + ',T2,') !== 0) return r;
    const c = r.split(',');
    c[8] = '8';                                   // 請填_直徑mm
    c[15] = 'D2=3.9500/0';                        // 請填_各D補正值
    return c.join(',');
  }).join('\r\n');
  const imported = NC.tools.fromCSV(filled, key);
  const merged = L.mergeCSVTable(res.toolTable, imported);
  assert.equal(merged.tools, 1);
  assert.equal(merged.offsets, 1);
  assert.deepEqual(merged.skipped, []);
  const t2 = merged.table.tools.find((x) => x.t === 2);
  assert.equal(t2.diameter, 8);
  assert.equal(t2.source.diameter, 'user');
  assert.equal(merged.table.offsets.find((o) => o.n === 2).radGeom, 3.95);
  assert.match(L.describeImport(merged), /^匯入了 1 把刀、1 筆補正值$/);
});
