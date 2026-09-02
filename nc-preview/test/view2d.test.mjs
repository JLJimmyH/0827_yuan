// view2d.js 測試：純邏輯（色階、影像、剖面、挑選、fit）＋ 用假 canvas 驗證繪圖與互動。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadNC, ROOT } from './load.mjs';

const NC = loadNC();
{
  const p = path.join(ROOT, 'js', 'ui', 'view2d.js');
  vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
}
const U = NC.ui.view2dUtil;
const PAD = U.PAD;

// ---------------------------------------------------------------------------
// 假 canvas / 2D context：記錄每次呼叫與當時的樣式
// ---------------------------------------------------------------------------
function mockCtx() {
  const ops = [];
  const ctx = { ops, font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic', imageSmoothingEnabled: true, _dash: [] };
  const methods = ['save', 'restore', 'setTransform', 'scale', 'translate', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'rect', 'clip', 'stroke', 'fill', 'fillText', 'strokeText', 'drawImage', 'putImageData'];
  for (const m of methods) {
    ctx[m] = (...args) => { ops.push({ op: m, args, stroke: ctx.strokeStyle, fill: ctx.fillStyle, dash: ctx._dash.slice(), alpha: ctx.globalAlpha, width: ctx.lineWidth }); };
  }
  ctx.setLineDash = (d) => { ctx._dash = d.slice(); ops.push({ op: 'setLineDash', args: [d.slice()] }); };
  ctx.measureText = (t) => ({ width: String(t).length * 6 });
  ctx.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  return ctx;
}
function mockCanvas(w = 800, h = 600) {
  const handlers = {};
  const ctx = mockCtx();
  const c = {
    width: w, height: h, clientWidth: w, clientHeight: h, style: { width: '', height: '' },
    // 記下 toggle 的結果，測標記模式有沒有加 is-marking
    classList: { set: new Set(), toggle(name, on) { if (on) this.set.add(name); else this.set.delete(name); }, contains(name) { return this.set.has(name); } },
    ownerDocument: { createElement: () => mockCanvas(1, 1) },
    ctx,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener: (t, fn) => { handlers[t] = (handlers[t] || []).filter((f) => f !== fn); },
    fire: (t, ev) => { for (const fn of handlers[t] || []) fn(Object.assign({ preventDefault() {}, clientX: 0, clientY: 0 }, ev)); },
    handlers,
  };
  return c;
}

// ---------------------------------------------------------------------------
// 假資料：素材 130×60×15（原點頂面中心）、格 1 mm、口袋 -5、少量手寫段
// ---------------------------------------------------------------------------
function makeData() {
  const stock = { min: { x: -65, y: -30, z: -15 }, max: { x: 65, y: 30, z: 0 }, source: 'user', fixtures: [] };
  const cell = 1, nx = 131, ny = 61, origin = { x: -65, y: -30 };
  // 與 simulation.js 相同的節點式格網：格 (ix,iy) 中心在 origin + (ix·cell, iy·cell)
  const height = new Float32Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const x = origin.x + ix * cell, y = origin.y + iy * cell;
    height[iy * nx + ix] = (x >= -40 && x <= -5 && y >= -15 && y <= 15) ? -5 : 0;
  }
  const sim = { scenario: 'off', cell, nx, ny, origin, height, floorZ: -15, snapshots: [{ afterOpIndex: 0, tool: 1, height: new Float32Array(nx * ny) }], events: [], time: { perOp: [], total: 0 } };
  const v = (x, y, z) => ({ x, y, z });
  let id = 0;
  const seg = (line, tool, kind, from, to, extra) => Object.assign({ id: ++id, line, opIndex: 0, tool, kind, from, to, feed: kind === 'rapid' ? null : 300, path: 'programmed' }, extra || {});
  const segments = [
    seg(10, 1, 'rapid', v(0, 0, 25), v(-50, 0, 25)),
    seg(11, 1, 'feed', v(-50, 0, 25), v(-50, 0, -5)),
    seg(12, 1, 'feed', v(-50, 0, -5), v(50, 0, -5)),
    seg(12, 1, 'feed', v(-50, 5, -5), v(50, 5, -5), { path: 'compensated' }),
    seg(13, 1, 'arc', v(50, 0, -5), v(50, 20, -5), { arc: { center: { x: 50, y: 10 }, cw: false, r: 10 } }),
    seg(20, 3, 'drill', v(45, 20, 2), v(45, 20, -8), { sub: 'plunge' }),
    seg(21, 3, 'rapid', v(45, 20, -8), v(45, 20, 2)),
    seg(30, 20, 'feed', v(-60, -25, 0), v(60, -25, 0)),
  ];
  const toolTable = { programKey: 'demo', tools: [{ t: 1, diameter: 10 }, { t: 3, diameter: 8 }, { t: 20, diameter: 10 }], offsets: [], updatedAt: '' };
  return { segments, sim, stock, toolTable, scenario: 'off' };
}

function makeView(data) {
  const c = mockCanvas();
  const view = NC.ui.createView2D(c);
  if (data) view.setData(data);
  view.render();
  c.ctx.ops.length = 0;
  return { c, view };
}
const strokes = (c) => c.ctx.ops.filter((o) => o.op === 'stroke');
const texts = (c) => c.ctx.ops.filter((o) => o.op === 'fillText').map((o) => o.args[0]);

// ---------------------------------------------------------------------------
// 純邏輯
// ---------------------------------------------------------------------------
test('view2d 載入：NC.ui.createView2D 與 view2dUtil', () => {
  assert.equal(typeof NC.ui.createView2D, 'function');
  assert.equal(typeof U.pickSegment, 'function');
  assert.equal(U.TOOL_COLORS.length, 12);
});

test('toolColor 12 色循環', () => {
  const set = new Set();
  for (let t = 1; t <= 12; t++) set.add(U.toolColor(t));
  assert.equal(set.size, 12);
  assert.equal(U.toolColor(13), U.toolColor(1));
  assert.equal(U.toolColor(24), U.toolColor(12));
  assert.equal(typeof U.toolColor(null), 'string');
});

test('depthColor 頂面暖灰（和背景分得開）、底部深藍、深度越深越藍', () => {
  const top = U.depthColor(0, 0, -15), bottom = U.depthColor(-15, 0, -15), mid = U.depthColor(-5, 0, -15);
  // 頂面色不可以和畫布背景 #fbfbfb（251,251,251）太接近，否則看不出「哪裡還是實心」
  assert.deepEqual(top, [222, 216, 206]);
  assert.ok(251 - top[0] >= 20, '頂面色和背景要有明顯差距');
  assert.deepEqual(bottom, [14, 34, 104]);
  assert.ok(mid[0] < top[0] && mid[0] > bottom[0], '中間色的紅分量介於兩端');
  assert.ok(mid[2] > mid[0], '中間色偏藍');
  const fixture = U.depthColor(5, 0, -15);
  assert.ok(fixture[0] > fixture[2], '高於頂面用土黃');
});

test('buildHeightImage 尺寸正確且上下翻轉（格 (0,0) 在影像最後一列）', () => {
  const d = makeData();
  const img = U.buildHeightImage(d.sim, d.sim.height, 0, -15);
  const { nx, ny } = d.sim;
  assert.equal(img.width, nx); assert.equal(img.height, ny);
  assert.equal(img.data.length, nx * ny * 4);
  // 格 (0,0)（左下）→ 影像最後一列第一個像素；頂面 → 淺灰
  const o = ((ny - 1) * nx + 0) * 4;
  assert.deepEqual([img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]], [222, 216, 206, 255]);
  // 口袋內 (x=-20, y=0) → ix=45, iy=30 → 影像列 ny-1-30
  const ix = 45, iy = 30, row = ny - 1 - iy;
  const p = (row * nx + ix) * 4;
  assert.ok(img.data[p] < 222 && img.data[p + 2] > img.data[p], '口袋格偏藍');
});

test('sectionProfile：X=-20 的折線長 ny，Y=0 處 -5、Y=25 處 0；格外 → null', () => {
  const d = makeData();
  const prof = U.sectionProfile(d.sim, d.sim.height, 'x', -20);
  assert.equal(prof.pos.length, d.sim.ny);
  const at = (y) => prof.z[prof.pos.findIndex((p) => Math.abs(p - y) < 0.51)];
  assert.equal(at(0), -5);
  assert.equal(at(25), 0);
  const py = U.sectionProfile(d.sim, d.sim.height, 'y', 0);
  assert.equal(py.pos.length, d.sim.nx);
  assert.equal(U.sectionProfile(d.sim, d.sim.height, 'x', 999), null);
  assert.equal(prof.pos[0], -30, '折線第一點在 origin（節點中心）');
  assert.equal(U.heightAt(d.sim, null, -20, 0), -5);
  assert.equal(U.heightAt(d.sim, null, -4.6, 0), -5, '查表四捨五入到最近節點');
  assert.equal(U.heightAt(d.sim, null, -4.4, 0), 0);
  assert.equal(U.heightAt(d.sim, null, 999, 0), null);
});

test('pickSegment：距離門檻 6 px、同距離偏好 compensated、圓弧距離', () => {
  const { segments } = makeData();
  let r = U.pickSegment(segments, 0, 5.01, 1, 6);
  assert.equal(r.seg.path, 'compensated'); assert.ok(r.dist < 0.02);
  r = U.pickSegment(segments, 0, 2.5, 2, 6);            // 與 programmed(y=0)、compensated(y=5) 等距 5 px
  assert.equal(r.seg.path, 'compensated');
  assert.equal(U.pickSegment(segments, 0, 2.5, 3, 6), null, '7.5 px > 門檻');
  assert.equal(U.pickSegment(segments, 0, 30, 1, 6), null);
  // 圓弧：圓心 (50,10) r10，從 (50,0) 逆時針到 (50,20)，經過 (60,10)
  const arc = segments.find((s) => s.arc);
  assert.ok(Math.abs(U.segDistance2D(arc, 60, 10)) < 1e-9);
  assert.ok(Math.abs(U.segDistance2D(arc, 40, 10) - Math.hypot(10, 10)) < 1e-9, '弧外側角度 → 到端點距離');
  // 篩選函式：只允許 rapid 時，最近的是第 10 行的 rapid（5 px）；只允許 drill 時沒有東西在門檻內
  assert.equal(U.pickSegment(segments, 0, 5, 1, 6, (s) => s.kind === 'rapid').seg.line, 10);
  assert.equal(U.pickSegment(segments, 0, 5, 1, 6, (s) => s.kind === 'drill'), null);
});

test('fitTransform 把包絡放進繪圖區（留標尺邊）', () => {
  const b = { minH: -65, maxH: 65, minV: -30, maxV: 30 };
  const V = U.fitTransform(b, 800, 600, PAD);
  const sx = (h) => V.ox + h * V.scale, sy = (v) => V.oy - v * V.scale;
  assert.ok(sx(-65) >= PAD.l && sx(65) <= 800 - PAD.r);
  assert.ok(sy(30) >= PAD.t && sy(-30) <= 600 - PAD.b);
  assert.ok(Math.abs(sx(0) - (PAD.l + (800 - PAD.l - PAD.r) / 2)) < 1e-9, '包絡中心在繪圖區中心');
  assert.equal(U.niceStep(0.7), 1); assert.equal(U.niceStep(1.5), 2); assert.equal(U.niceStep(3), 5); assert.equal(U.niceStep(30), 50);
});

test('topBounds / sectionBounds 忽略 G28 與 rapid', () => {
  const d = makeData();
  d.segments.push({ id: 99, line: 50, opIndex: 0, tool: 1, kind: 'rapid', from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 150 }, feed: null, path: 'programmed', refReturn: true });
  const tb = U.topBounds({ segments: d.segments, stock: d.stock, sim: d.sim });
  // 節點式格網：nx = ceil(span/cell)+1 個節點剛好覆蓋素材，外緣各多半格
  assert.deepEqual([tb.minH, tb.maxH, tb.minV, tb.maxV], [-65.5, 65.5, -30.5, 30.5]);
  assert.deepEqual(U.simExtent(d.sim), { minX: -65.5, minY: -30.5, maxX: 65.5, maxY: 30.5 });
  const tbNoSim = U.topBounds({ segments: d.segments, stock: d.stock, sim: null });
  assert.deepEqual([tbNoSim.minH, tbNoSim.maxH, tbNoSim.minV, tbNoSim.maxV], [-65, 65, -30, 30]);
  const sb = U.sectionBounds({ segments: d.segments, stock: d.stock, sim: d.sim }, 'x');
  assert.ok(sb.maxV < 150, 'rapid 的 Z150 不進剖面包絡');
  assert.equal(U.topBounds({ segments: [], stock: null, sim: null }), null);
});

// ---------------------------------------------------------------------------
// View：繪圖
// ---------------------------------------------------------------------------
test('createView2D：setData + render 畫 heightmap（離屏 putImageData → drawImage）與素材外框', () => {
  const d = makeData();
  const c = mockCanvas();
  const view = NC.ui.createView2D(c);
  view.setData(d);
  view.render();
  const draws = c.ctx.ops.filter((o) => o.op === 'drawImage');
  assert.equal(draws.length, 1);
  const off = draws[0].args[0];
  assert.equal(off.width, d.sim.nx); assert.equal(off.height, d.sim.ny);
  assert.ok(off.ctx.ops.some((o) => o.op === 'putImageData'), '離屏 canvas 有 putImageData');
  // drawImage 尺寸 = 格數 × 格距 × scale
  const V = view.getTransform();
  assert.ok(Math.abs(draws[0].args[3] - d.sim.nx * d.sim.cell * V.scale) < 1e-6);
  assert.ok(c.ctx.ops.some((o) => o.op === 'strokeRect' && o.stroke === '#4a4a4a'), '素材外框');
  // 再 render 一次不重建影像（快取）
  c.ctx.ops.length = 0; off.ctx.ops.length = 0;
  view.render();
  assert.equal(off.ctx.ops.filter((o) => o.op === 'putImageData').length, 0);
  assert.equal(c.ctx.ops.filter((o) => o.op === 'drawImage').length, 1);
});

test('fit 後包絡中心落在繪圖區中心、素材完整可見', () => {
  const d = makeData();
  const { view } = makeView(d);
  const b = U.topBounds(d);
  const [sx, sy] = view.worldToScreen((b.minH + b.maxH) / 2, (b.minV + b.maxV) / 2);
  assert.ok(Math.abs(sx - (PAD.l + (800 - PAD.l - PAD.r) / 2)) < 1e-6);
  assert.ok(Math.abs(sy - (PAD.t + (600 - PAD.t - PAD.b) / 2)) < 1e-6);
  const [ax, ay] = view.worldToScreen(-65, 30), [bx, by] = view.worldToScreen(65, -30);
  assert.ok(ax >= PAD.l && ay >= PAD.t && bx <= 800 - PAD.r && by <= 600 - PAD.b);
});

test('路徑樣式：rapid 灰虛線、feed 刀具色、compensated 粗於 programmed、drill 孔標記', () => {
  const { c, view } = makeView(makeData());
  view.render();
  const st = strokes(c);
  const rapid = st.filter((o) => o.stroke === '#9a9a9a' && o.dash.length === 2);
  assert.ok(rapid.length >= 1, 'rapid 虛線');
  const t1 = st.filter((o) => o.stroke === U.toolColor(1) && o.dash.length === 0);
  assert.ok(t1.some((o) => o.width === 2) && t1.some((o) => o.width === 1), 'compensated 2 px、programmed 1 px');
  const t3 = st.filter((o) => o.stroke === U.toolColor(3));
  assert.ok(t3.length >= 2, '孔標記（圓 + 十字）');
  const arcs = c.ctx.ops.filter((o) => o.op === 'arc' && o.stroke === U.toolColor(3));
  assert.ok(arcs.length >= 1);
  // 孔標記半徑 = 刀半徑 4 mm × scale
  const V = view.getTransform();
  assert.ok(arcs.some((o) => Math.abs(o.args[2] - 4 * V.scale) < 1e-6));
});

test('setVisible：關 rapid 後無虛線；tools 篩選只留該刀', () => {
  const { c, view } = makeView(makeData());
  view.setVisible({ rapid: false }); view.render();
  assert.equal(strokes(c).filter((o) => o.stroke === '#9a9a9a').length, 0);
  c.ctx.ops.length = 0;
  view.setVisible({ rapid: true, tools: new Set([3]) }); view.render();
  assert.equal(strokes(c).filter((o) => o.stroke === U.toolColor(1)).length, 0);
  assert.ok(strokes(c).filter((o) => o.stroke === U.toolColor(3)).length > 0);
  c.ctx.ops.length = 0;
  view.setVisible({ tools: null, stock: false, feed: false }); view.render();
  assert.equal(c.ctx.ops.filter((o) => o.op === 'drawImage').length, 0, 'stock 關掉就不畫 heightmap');
  assert.equal(strokes(c).filter((o) => o.stroke === U.toolColor(1)).length, 0);
  assert.equal(view.getVisible().feed, false);
});

test('highlightTool 淡化其他刀；highlightLine 用亮色粗線', () => {
  const { c, view } = makeView(makeData());
  view.highlightTool(3); view.render();
  const t1 = strokes(c).filter((o) => o.stroke === U.toolColor(1));
  assert.ok(t1.length > 0 && t1.every((o) => o.alpha < 0.2), 'T1 被淡化');
  assert.ok(strokes(c).filter((o) => o.stroke === U.toolColor(3)).every((o) => o.alpha === 1));
  c.ctx.ops.length = 0;
  view.highlightTool(null).highlightLine(12); view.render();
  const hl = strokes(c).filter((o) => o.stroke === '#ff2d55' && o.width === 3);
  assert.equal(hl.length, 2, '第 12 行的 programmed 與 compensated 兩段都高亮');
  assert.ok(strokes(c).some((o) => o.width === 7), '白色光暈');
  c.ctx.ops.length = 0;
  view.highlightLine(null); view.render();
  assert.equal(strokes(c).filter((o) => o.stroke === '#ff2d55').length, 0);
});

test('hover 顯示工件座標與該格深度（右下角）', () => {
  const { c, view } = makeView(makeData());
  const [sx, sy] = view.worldToScreen(-20, 0);
  c.fire('mousemove', { clientX: sx, clientY: sy });
  view.render();
  const t = texts(c).find((s) => s.startsWith('X '));
  assert.ok(t, '有座標文字');
  assert.match(t, /X -20\s+Y 0/);
  assert.match(t, /Z面 -5/);
  assert.match(t, /深 5/);
  c.fire('mouseleave', {});
  c.ctx.ops.length = 0; view.render();
  assert.ok(!texts(c).some((s) => s.startsWith('X ')));
});

test('setSnapshot 切換高度來源', () => {
  const { c, view } = makeView(makeData());
  const [sx, sy] = view.worldToScreen(-20, 0);
  c.fire('mousemove', { clientX: sx, clientY: sy });
  view.setSnapshot(0); view.render();
  assert.match(texts(c).find((s) => s.startsWith('X ')), /Z面 0/);
  assert.ok(texts(c).some((s) => s.includes('快照 0')));
  c.ctx.ops.length = 0;
  view.setSnapshot(null); view.render();
  assert.match(texts(c).find((s) => s.startsWith('X ')), /Z面 -5/);
});

// ---------------------------------------------------------------------------
// View：互動
// ---------------------------------------------------------------------------
test('滾輪縮放以滑鼠為中心', () => {
  const { c, view } = makeView(makeData());
  const before = view.getTransform();
  const w0 = view.screenToWorld(500, 200);
  c.fire('wheel', { clientX: 500, clientY: 200, deltaY: -100 });
  const after = view.getTransform();
  assert.ok(after.scale > before.scale, '向上滾放大');
  const w1 = view.screenToWorld(500, 200);
  assert.ok(Math.abs(w0[0] - w1[0]) < 1e-9 && Math.abs(w0[1] - w1[1]) < 1e-9, '滑鼠下的工件點不動');
  c.fire('wheel', { clientX: 500, clientY: 200, deltaY: 100 });
  assert.ok(Math.abs(view.getTransform().scale - before.scale) < 1e-9);
});

test('拖曳平移；拖曳結束不觸發 onPick', () => {
  const { c, view } = makeView(makeData());
  let picked = 0;
  view.onPick(() => { picked++; });
  const before = view.getTransform();
  c.fire('mousedown', { clientX: 400, clientY: 300, button: 0 });
  c.fire('mousemove', { clientX: 450, clientY: 320 });
  c.fire('mouseup', { clientX: 450, clientY: 320, button: 0 });
  const after = view.getTransform();
  assert.ok(Math.abs(after.ox - before.ox - 50) < 1e-9 && Math.abs(after.oy - before.oy - 20) < 1e-9);
  assert.equal(picked, 0);
});

test('點擊挑最近的段 → onPick(line, seg)；超過 6 px 不觸發', () => {
  const { c, view } = makeView(makeData());
  const calls = [];
  view.onPick((line, seg) => calls.push([line, seg]));
  const [sx, sy] = view.worldToScreen(0, 5);
  c.fire('mousedown', { clientX: sx, clientY: sy, button: 0 });
  c.fire('mouseup', { clientX: sx + 1, clientY: sy + 1, button: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 12);
  assert.equal(calls[0][1].path, 'compensated');
  // 遠離所有段
  const [fx, fy] = view.worldToScreen(0, -14);
  c.fire('mousedown', { clientX: fx, clientY: fy, button: 0 });
  c.fire('mouseup', { clientX: fx, clientY: fy, button: 0 });
  assert.equal(calls.length, 1);
  // 隱藏的段挑不到
  view.setVisible({ feed: false });
  c.fire('mousedown', { clientX: sx, clientY: sy, button: 0 });
  c.fire('mouseup', { clientX: sx, clientY: sy, button: 0 });
  assert.equal(calls.length, 1);
  // 右鍵不算
  view.setVisible({ feed: true });
  c.fire('mousedown', { clientX: sx, clientY: sy, button: 2 });
  c.fire('mouseup', { clientX: sx, clientY: sy, button: 2 });
  assert.equal(calls.length, 1);
});

test('雙擊 fit 回到初始視角', () => {
  const { c, view } = makeView(makeData());
  const before = view.getTransform();
  c.fire('wheel', { clientX: 100, clientY: 100, deltaY: -300 });
  assert.notEqual(view.getTransform().scale, before.scale);
  c.fire('dblclick', {});
  const after = view.getTransform();
  assert.ok(Math.abs(after.scale - before.scale) < 1e-9 && Math.abs(after.ox - before.ox) < 1e-9);
});

// ---------------------------------------------------------------------------
// View：剖面
// ---------------------------------------------------------------------------
test('sectionX 模式畫高度折線、素材輪廓、標尺與標題', () => {
  const { c, view } = makeView(makeData());
  view.setMode('sectionX').setSection(-20);
  view.render();
  assert.ok(c.ctx.ops.some((o) => o.op === 'fill' && o.fill === 'rgba(70,120,210,0.28)'), '折線填色');
  assert.ok(strokes(c).some((o) => o.stroke === '#1d4ed8'), '折線');
  assert.ok(c.ctx.ops.some((o) => o.op === 'strokeRect' && o.stroke === '#4a4a4a'), '素材輪廓');
  const tx = texts(c);
  assert.ok(tx.some((s) => s.includes('剖面 X = -20')));
  assert.ok(tx.includes('Y') && tx.includes('Z'), '標尺軸名');
  assert.ok(tx.filter((s) => /^-?\d+(\.\d+)?$/.test(s)).length >= 4, '標尺刻度');
  // 折線點在格中心（節點）：Y=0 處在 Z=-5（螢幕位置對得上）
  const [px, zNeg5] = view.worldToScreen(0, -5);
  const lineTos = c.ctx.ops.filter((o) => o.op === 'lineTo' && Math.abs(o.args[0] - px) < 0.6 && Math.abs(o.args[1] - zNeg5) < 0.6);
  assert.ok(lineTos.length >= 1, '折線經過 (Y=0, Z=-5)');
  assert.ok(!c.ctx.ops.some((o) => o.op === 'drawImage'), '剖面不畫 heightmap');
  // hover 顯示 Y/Z 與該格深度
  const [hx, hy] = view.worldToScreen(0, -2);
  c.fire('mousemove', { clientX: hx, clientY: hy });
  c.ctx.ops.length = 0; view.render();
  const t = texts(c).find((s) => s.startsWith('Y '));
  assert.match(t, /Y 0\s+Z -2/);
  assert.match(t, /Z面 -5/);
});

test('sectionY 模式：投影落在剖面帶內的段並可點選', () => {
  const { c, view } = makeView(makeData());
  const calls = [];
  view.onPick((line) => calls.push(line));
  view.setMode('sectionY').setSection(20);
  view.render();
  assert.ok(strokes(c).some((o) => o.stroke === U.toolColor(3)), 'X=45 的鑽孔段投影出來');
  assert.ok(!strokes(c).some((o) => o.stroke === U.toolColor(20)), 'Y=-25 的段不在帶內');
  const [sx, sy] = view.worldToScreen(45, -3);
  c.fire('mousedown', { clientX: sx, clientY: sy, button: 0 });
  c.fire('mouseup', { clientX: sx, clientY: sy, button: 0 });
  assert.deepEqual(calls, [20]);
  // 俯視就是從上往下看整塊成品，不該再畫剖面指示線（現場：「他也不需要剖面 X 軸」）
  view.setMode('top'); c.ctx.ops.length = 0; view.render();
  assert.ok(!strokes(c).some((o) => o.stroke === '#ff9500'), '俯視不畫剖面指示線');
  assert.throws(() => view.setMode('side'), /未知的視圖模式/);
});

// ---------------------------------------------------------------------------
// 尺寸 / dpr / 生命週期
// ---------------------------------------------------------------------------
test('devicePixelRatio：像素尺寸乘 dpr、setTransform 以 dpr 縮放', () => {
  globalThis.window = { devicePixelRatio: 2 };
  try {
    const { c, view } = makeView(makeData());
    view.render();
    assert.equal(c.width, 1600); assert.equal(c.height, 1200);
    assert.deepEqual(c.ctx.ops.find((o) => o.op === 'setTransform').args, [2, 0, 0, 2, 0, 0]);
    assert.deepEqual(view.getSize(), { w: 800, h: 600, dpr: 2 });
    // 座標換算仍用 CSS px
    const [sx] = view.worldToScreen(0, 0);
    assert.ok(sx < 800);
  } finally { delete globalThis.window; }
});

test('尺寸改變後 render 會同步 canvas 像素尺寸；無資料顯示提示', () => {
  const c = mockCanvas(400, 300);
  const view = NC.ui.createView2D(c);
  view.render();
  assert.ok(texts(c).includes('尚無資料'));
  c.clientWidth = 640; c.clientHeight = 480;
  view.render();
  assert.equal(c.width, 640); assert.equal(c.height, 480);
  // 之後才有資料 → 自動 fit
  const d = makeData();
  view.setData(d); view.render();
  const b = U.topBounds(d);
  const [sx] = view.worldToScreen((b.minH + b.maxH) / 2, 0);
  assert.ok(Math.abs(sx - (PAD.l + (640 - PAD.l - PAD.r) / 2)) < 1e-6);
});

test('destroy 移除事件監聽', () => {
  const { c, view } = makeView(makeData());
  assert.ok(Object.values(c.handlers).some((a) => a.length > 0));
  view.destroy();
  assert.ok(Object.values(c.handlers).every((a) => a.length === 0));
  assert.doesNotThrow(() => view.render());
});

test('沒有 sim 只畫素材填色與外框；沒有 canvas 拋錯', () => {
  const d = makeData(); d.sim = null;
  const { c, view } = makeView(d);
  view.render();
  assert.equal(c.ctx.ops.filter((o) => o.op === 'drawImage').length, 0);
  assert.ok(c.ctx.ops.some((o) => o.op === 'fillRect' && o.fill === 'rgba(214,214,214,0.55)'));
  assert.throws(() => NC.ui.createView2D(null), /canvas/);
});

// ---------------------------------------------------------------------------
// 第四軸：剖面 X → 圓棒橫截面（與 3D／展開圖同一套工件座標）
// ---------------------------------------------------------------------------
function rotaryData() {
  // A0 與 A90 各一個徑向孔：從 R 點 Z25 鑽到 Z10（工件半徑 25）
  const mk = (line, a, fromZ, toZ) => ({
    id: line, line, opIndex: 0, tool: 1, kind: 'drill', sub: 'plunge',
    from: { x: 20, y: 0, z: fromZ }, to: { x: 20, y: 0, z: toZ },
    feed: 70, path: 'programmed', a,
  });
  return {
    segments: [mk(1, 0, 25, 10), mk(2, 90, 25, 10)],
    sim: null, stock: null,
    toolTable: { programKey: 'r', tools: [{ t: 1, diameter: 8 }], offsets: [], updatedAt: '' },
    scenario: 'off',
    rotary: { center: { y: 0, z: 0 }, radius: 25 },
    rotaryCenter: { y: 0, z: 0 },
  };
}

test('四軸剖面 X：孔轉到工件座標——A0 在正上方、A90 在 +Y 側', () => {
  const { view } = makeView(rotaryData());
  view.setMode('sectionX').setSection(20).fit(false).render();
  // 內部投影不外露，改由「畫出來的線」驗證：兩個孔應該互相垂直（一個沿 Z、一個沿 Y）
  const R = NC.geometry.rotary;
  const segs = rotaryData().segments;
  const p0 = R.samples(segs[0], { center: { y: 0, z: 0 } });
  const p1 = R.samples(segs[1], { center: { y: 0, z: 0 } });
  // A0：Y 不動、Z 從 25 到 10（正上方往中心）
  assert.ok(Math.abs(p0[0].y) < 1e-9 && Math.abs(p0[p0.length - 1].y) < 1e-9);
  assert.ok(p0[0].z > p0[p0.length - 1].z);
  // A90：Z 不動、Y 從 25 到 10（+Y 側往中心）
  assert.ok(Math.abs(p1[0].z) < 1e-9 && Math.abs(p1[p1.length - 1].z) < 1e-9);
  assert.ok(p1[0].y > p1[p1.length - 1].y);
});

test('四軸剖面 X：素材畫成圓（不是方塊），HUD 標明是橫截面', () => {
  const { c, view } = makeView(rotaryData());
  view.setMode('sectionX').setSection(20).fit(false).render();
  const arcs = c.ctx.ops.filter((o) => o.op === 'arc');
  assert.ok(arcs.length >= 1, '應該有圓（圓棒外圓）');
  assert.ok(texts(c).some((t) => /圓棒橫截面/.test(t)), 'HUD 要說明這是橫截面');
  assert.ok(texts(c).some((t) => /Y（工件）/.test(t)), '軸名要標明是工件座標');
});

test('沒有第四軸時剖面 X 維持原本行為（方塊素材、Z 基準線）', () => {
  const d = rotaryData();
  delete d.rotary; delete d.rotaryCenter;
  d.stock = { min: { x: 0, y: -10, z: -5 }, max: { x: 40, y: 10, z: 0 }, source: 'user', fixtures: [] };
  const { c, view } = makeView(d);
  view.setMode('sectionX').setSection(20).fit(false).render();
  assert.ok(!texts(c).some((t) => /圓棒橫截面/.test(t)));
  assert.ok(c.ctx.ops.some((o) => o.op === 'fillRect'), '三軸剖面的素材仍是方塊');
});

// ---------------------------------------------------------------------------
// 第四軸：圓棒攤成直角座標 → 俯視與剖面 Y
// ---------------------------------------------------------------------------
/** 未加工的圓棒模擬格（形狀與 simulation.createCylinder 相同） */
function cylSim(opts) {
  opts = opts || {};
  const R = opts.radius || 25;
  const cell = opts.cell || 1;
  const xMin = 0, xMax = opts.xMax || 40;
  const nx = Math.ceil((xMax - xMin) / cell - 1e-9) + 1;
  const circumference = 2 * Math.PI * R;
  const ny = Math.max(16, Math.round(circumference / cell));
  const cellY = circumference / ny;
  return {
    cylinder: true, cell, cellX: cell, cellY, wrapY: true, nx, ny,
    origin: { x: xMin, y: 0 }, height: new Float32Array(nx * ny).fill(R),
    floorZ: 0, topZ: R, radius: R, center: { y: 0, z: 0 }, circumference, snapshots: [],
  };
}

test('cylToCartesian：未加工的圓棒攤平後，半徑處處等於外圓、棒身以外是 NaN', () => {
  const sim = cylSim();
  const cart = U.cylToCartesian(sim);
  assert.equal(cart.nx, sim.nx);
  assert.ok(cart.ny >= 2 * sim.radius / cart.cell, '縱向要蓋得住整個直徑');
  let material = 0, empty = 0;
  for (let i = 0; i < cart.radius.length; i++) {
    const r = cart.radius[i];
    if (!Number.isFinite(r)) { empty++; continue; }
    material++;
    // 攤平是用多邊形的弦逼近圓，只會比外圓小一點點，絕不會大——大了會被當成治具塗成土黃
    assert.ok(r <= sim.radius + 1e-6, `半徑 ${r} 不該超過外圓 ${sim.radius}`);
    assert.ok(r > sim.radius - cart.cell, `半徑 ${r} 掉太多`);
  }
  assert.ok(material > 0 && empty > 0, '棒身內外都要有');
  // 上下對稱：同一格的上緣與下緣互為相反數（中心在 Z0）
  const midIy = Math.round((0 - cart.origin.y) / cart.cell);
  const o = midIy * cart.nx + Math.floor(cart.nx / 2);
  assert.ok(Math.abs(cart.height[o] - sim.radius) < 1e-6);
  // 下緣落在弦上（θ=π 剛好不是取樣點），只會比外圓小一點點
  assert.ok(Math.abs(cart.bottom[o] + sim.radius) < 0.05, String(cart.bottom[o]));
});

test('cylToCartesian：頂面銑平之後，那一帶的半徑跟著掉下來', () => {
  const sim = cylSim();
  const flat = 20;
  // θ ≈ 0（正上方）附近的一圈格子挖到 R=20
  for (const iy of [0, 1, 2, sim.ny - 1, sim.ny - 2]) {
    for (let ix = 0; ix < sim.nx; ix++) sim.height[iy * sim.nx + ix] = flat;
  }
  const cart = U.cylToCartesian(sim);
  const iy0 = Math.round((0 - cart.origin.y) / cart.cell);   // Y = 0 = 正上方那一條
  const o = iy0 * cart.nx + Math.floor(cart.nx / 2);
  assert.ok(Math.abs(cart.radius[o] - flat) < 0.5, `銑平處半徑應該接近 ${flat}，得到 ${cart.radius[o]}`);
  assert.ok(Math.abs(cart.height[o] - flat) < 0.5, '上表面 Z 也跟著降到銑平的高度');
  // 側邊（Y 接近 ±R）沒被碰到，仍然是外圓
  const iySide = Math.round((sim.radius - 1 - cart.origin.y) / cart.cell);
  const os = iySide * cart.nx + Math.floor(cart.nx / 2);
  assert.ok(cart.radius[os] > sim.radius - 1, '沒切到的地方要維持外圓');
});

test('cylToCartesian：非圓柱的 sim 回 null', () => {
  assert.equal(U.cylToCartesian(makeData().sim), null);
  assert.equal(U.cylToCartesian(null), null);
});

test('buildHeightImage：NaN 的格畫成全透明（棒身以外不是「挖很深」）', () => {
  const sim = { nx: 2, ny: 1, cell: 1, origin: { x: 0, y: 0 }, height: new Float32Array([0, NaN]) };
  const img = U.buildHeightImage(sim, sim.height, 0, -10);
  assert.equal(img.data[3], 255, '有材料的格不透明');
  assert.equal(img.data[7], 0, '沒有材料的格 alpha = 0');
});

test('四軸俯視：畫的是攤平後的圓棒，HUD 標明是工件座標', () => {
  const d = rotaryData();
  d.sim = cylSim();
  const { c, view } = makeView(d);
  view.setMode('top').fit(false).render();
  assert.ok(c.ctx.ops.some((o) => o.op === 'drawImage'), '要把攤平後的高度圖畫出來');
  assert.ok(texts(c).some((t) => /圓棒俯視（工件座標）/.test(t)), 'HUD 要說明這是圓棒俯視');
  assert.ok(texts(c).some((t) => /Y（工件）/.test(t)), '縱軸要標明是工件座標');
});

test('四軸剖面 Y：畫成沿軸向的縱剖面，HUD 標明是縱剖面', () => {
  const d = rotaryData();
  d.sim = cylSim();
  const { c, view } = makeView(d);
  view.setMode('sectionY').setSection(0).fit(false).render();
  assert.ok(texts(c).some((t) => /圓棒縱剖面/.test(t)), 'HUD 要說明這是縱剖面');
  assert.ok(texts(c).some((t) => /^X$/.test(t)), '橫軸是 X（軸向）');
  assert.ok(c.ctx.ops.some((o) => o.op === 'fill' && o.fill === 'rgba(70,120,210,0.28)'), '材料要填色');
});

test('steppedProfile：鉛直牆畫成階梯，緩坡維持直連', () => {
  // 逐欄直連會把「17 → 10 的孔壁」畫成一格寬的斜線（直上直下的刀看起來歪 3~4°）。
  // 跳變超過兩格：在兩欄的中線插兩點 → 真正的鉛直線；緩坡（鑽尖錐面）不動。
  const pts = U.steppedProfile([0, 0.5, 1.0, 1.5], [17, 17, 10, 10.3], 0.5);
  // 17→10 是牆：插 (0.75,17)(0.75,10)；10→10.3 是緩坡：直連
  assert.deepEqual(pts, [
    { x: 0, v: 17 }, { x: 0.5, v: 17 },
    { x: 0.75, v: 17 }, { x: 0.75, v: 10 },
    { x: 1.0, v: 10 }, { x: 1.5, v: 10.3 },
  ]);
  // 純緩坡完全不插點
  assert.equal(U.steppedProfile([0, 0.5, 1.0], [10, 10.3, 10.6], 0.5).length, 3);
});

// ---------------------------------------------------------------------------
// 廢料判定：影像上色、剖面分段、記號、標記模式（判定本身在 core，這裡只吃 ChunkResult）
// ---------------------------------------------------------------------------
/** 離屏 canvas 最後一次 putImageData 的像素資料 */
function lastImageData(off) {
  const puts = off.ctx.ops.filter((o) => o.op === 'putImageData');
  return puts.length ? puts[puts.length - 1].args[0].data : null;
}
/** 影像裡格 (ix, iy) 的 RGBA（影像列是上下翻轉的） */
function px(img, nx, ny, ix, iy) {
  const o = ((ny - 1 - iy) * nx + ix) * 4;
  return [img[o], img[o + 1], img[o + 2], img[o + 3]];
}

test('buildHeightImage：切穿到底的格畫成棋盤（不是深藍）；air:false 照舊；NaN 仍透明', () => {
  const sim = { nx: 3, ny: 2, cell: 1, origin: { x: 0, y: 0 }, height: new Float32Array([-10, -10, 0, NaN, -10, -5]) };
  const img = U.buildHeightImage(sim, sim.height, 0, -10).data;
  assert.deepEqual(px(img, 3, 2, 0, 0), [255, 255, 255, 255], '(0,0) 棋盤 A');
  assert.deepEqual(px(img, 3, 2, 1, 0), [226, 229, 233, 255], '(1,0) 棋盤 B');
  assert.deepEqual(px(img, 3, 2, 1, 1), [255, 255, 255, 255], '(1,1) 又是 A（ix+iy 偶數）');
  assert.deepEqual(px(img, 3, 2, 2, 0), [222, 216, 206, 255], '頂面照舊');
  assert.equal(px(img, 3, 2, 0, 1)[3], 0, 'NaN 仍全透明');
  assert.ok(px(img, 3, 2, 2, 1)[2] > px(img, 3, 2, 2, 1)[0], '-5 是一般的藍');
  // air 關掉（圓棒攤平那份的 0 是鑽到軸心，不是空氣）→ 底部深藍
  const noAir = U.buildHeightImage(sim, sim.height, 0, -10, { air: false }).data;
  assert.deepEqual(px(noAir, 3, 2, 0, 0), [14, 34, 104, 255]);
  // airZ 可以另外給：門檻抬到 -5，那格也變棋盤（(2,1) 是奇數格 → B）
  const hiAir = U.buildHeightImage(sim, sim.height, 0, -10, { airZ: -5 }).data;
  assert.deepEqual(px(hiAir, 3, 2, 2, 1), [226, 229, 233, 255]);
});

test('buildHeightImage：mark 廢料格混橘＋alpha 190、hide 畫成棋盤（不是透明）、off 照舊；非廢料的塊與沒歸類的格不動', () => {
  const sim = { nx: 4, ny: 1, cell: 1, origin: { x: 0, y: 0 }, height: new Float32Array([0, 0, 0, 0]) };
  const labels = new Int32Array([1, 1, 2, 2]);
  const scrapByLabel = new Uint8Array([0, 0, 1]);   // 第 2 塊是廢料
  const plain = U.buildHeightImage(sim, sim.height, 0, -10).data;
  const mark = U.buildHeightImage(sim, sim.height, 0, -10, { labels, scrapByLabel, mode: 'mark' }).data;
  // mix(頂面色, 橘, 0.65)：222→227、216→158、206→94
  assert.deepEqual(px(mark, 4, 1, 2, 0), [227, 158, 94, 190]);
  assert.deepEqual(px(mark, 4, 1, 0, 0), [222, 216, 206, 255], '工件塊不變');
  // hide：廢料格跟切穿的格長得一樣——白灰棋盤、alpha 255（透明會透出素材灰底，看起來像還有一整塊料）
  const hide = U.buildHeightImage(sim, sim.height, 0, -10, { labels, scrapByLabel, mode: 'hide' }).data;
  assert.deepEqual(px(hide, 4, 1, 2, 0), [255, 255, 255, 255], '(2,0) ix+iy 偶數 → 棋盤 A');
  assert.deepEqual(px(hide, 4, 1, 3, 0), [226, 229, 233, 255], '(3,0) 奇數 → 棋盤 B');
  assert.deepEqual(px(hide, 4, 1, 1, 0), [222, 216, 206, 255], '工件塊不變');
  // label 0（沒歸類）不動
  const labels0 = new Int32Array([1, 1, 2, 0]);
  const mark0 = U.buildHeightImage(sim, sim.height, 0, -10, { labels: labels0, scrapByLabel, mode: 'mark' }).data;
  assert.deepEqual(px(mark0, 4, 1, 3, 0), [222, 216, 206, 255], 'label 0 不變');
  const hide0 = U.buildHeightImage(sim, sim.height, 0, -10, { labels: labels0, scrapByLabel, mode: 'hide' }).data;
  assert.deepEqual(px(hide0, 4, 1, 3, 0), [222, 216, 206, 255], 'label 0 在 hide 也不變');
  const off = U.buildHeightImage(sim, sim.height, 0, -10, { labels, scrapByLabel, mode: 'off' }).data;
  assert.deepEqual(Array.from(off), Array.from(plain));
  // labels 長度跟格網對不上 → 當沒有
  const bad = U.buildHeightImage(sim, sim.height, 0, -10, { labels: new Int32Array([2]), scrapByLabel, mode: 'mark' }).data;
  assert.deepEqual(Array.from(bad), Array.from(plain));
});

test('scrapLookup：label → 是否廢料；不支援／沒 labels → null', () => {
  const r = { supported: true, labels: new Int32Array(1), chunks: [{ label: 1, part: true }, { label: 3, part: false }] };
  assert.deepEqual(Array.from(U.scrapLookup(r)), [0, 0, 0, 1]);
  assert.equal(U.scrapLookup({ supported: false, labels: null, chunks: [] }), null);
  assert.equal(U.scrapLookup(null), null);
});

test('sectionRuns：類別交界在兩欄中線（鉛直牆取牆的兩端、緩坡插值）；全同類別等於 steppedProfile', () => {
  // 工件 | 切穿：0,0 → -15,-15 是牆，交界在 x=1.5
  let runs = U.sectionRuns([0, 1, 2, 3], [0, 0, -15, -15], ['part', 'part', 'air', 'air'], 1);
  assert.deepEqual(runs, [
    { cat: 'part', pts: [{ x: 0, v: 0 }, { x: 1, v: 0 }, { x: 1.5, v: 0 }] },
    { cat: 'air', pts: [{ x: 1.5, v: -15 }, { x: 2, v: -15 }, { x: 3, v: -15 }] },
  ]);
  // 緩坡：交界點在中線插值
  runs = U.sectionRuns([0, 1, 2, 3], [0, -1, -1.5, -1.5], ['part', 'scrap', 'scrap', 'scrap'], 1);
  assert.deepEqual(runs[0], { cat: 'part', pts: [{ x: 0, v: 0 }, { x: 0.5, v: -0.5 }] });
  assert.deepEqual(runs[1].pts[0], { x: 0.5, v: -0.5 });
  assert.equal(runs[1].pts.length, 4);
  // 全同類別：跟 steppedProfile 一模一樣（含階梯點）
  const pos = [0, 0.5, 1.0, 1.5], z = [17, 17, 10, 10.3];
  runs = U.sectionRuns(pos, z, ['part', 'part', 'part', 'part'], 0.5);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].pts, U.steppedProfile(pos, z, 0.5));
});

/**
 * 假的 ChunkResult：makeData 的素材上，外圈 4 格寬是廢料（label 2、碰到夾具），
 * 第 5 格那一圈切穿到 floorZ（label 0），中間是工件（label 1）。
 */
function chunkData() {
  const d = makeData();
  const { nx, ny } = d.sim;
  const labels = new Int32Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const o = iy * nx + ix;
    if (ix <= 3 || ix >= nx - 4 || iy <= 3 || iy >= ny - 4) labels[o] = 2;
    else if (ix === 4 || ix === nx - 5 || iy === 4 || iy === ny - 5) { labels[o] = 0; d.sim.height[o] = d.sim.floorZ; }
    else labels[o] = 1;
  }
  const result = {
    supported: true, labels,
    chunks: [
      { label: 1, cells: 0, areaMm2: 0, part: true, touchesFixture: false, why: 'origin' },
      { label: 2, cells: 0, areaMm2: 0, part: false, touchesFixture: true, why: 'other' },
    ],
    partCount: 1, scrapCount: 1, scrapAreaMm2: 0, partTouchesFixture: false, hasFixture: true,
  };
  return { d, result };
}

test('setChunks：mark 把廢料格混橘、切穿的一圈是棋盤；hide 廢料格也是棋盤；off 照舊；快取只在變更時重建', () => {
  const { d, result } = chunkData();
  const { c, view } = makeView(d);
  const { nx, ny } = d.sim;
  view.setChunks(result, 'mark'); view.render();
  let off = c.ctx.ops.filter((o) => o.op === 'drawImage')[0].args[0];
  let img = lastImageData(off);
  assert.deepEqual(px(img, nx, ny, 0, 0), [227, 158, 94, 190], '外圈廢料格混橘');
  assert.deepEqual(px(img, nx, ny, 65, 30), [222, 216, 206, 255], '中間工件照舊');
  const air = px(img, nx, ny, 4, 30);
  assert.ok(air[3] === 255 && air[0] >= 226, '切穿的一圈是棋盤（白或淺灰）');
  // 再 render 一次不重建
  c.ctx.ops.length = 0; off.ctx.ops.length = 0;
  view.render();
  assert.equal(off.ctx.ops.filter((o) => o.op === 'putImageData').length, 0);
  // hide
  c.ctx.ops.length = 0;
  view.setChunks(result, 'hide'); view.render();
  off = c.ctx.ops.filter((o) => o.op === 'drawImage')[0].args[0];
  img = lastImageData(off);
  assert.deepEqual(px(img, nx, ny, 0, 0), [255, 255, 255, 255], 'hide：廢料格畫成棋盤 A（跟切穿一樣，不是透明）');
  assert.deepEqual(px(img, nx, ny, 1, 0), [226, 229, 233, 255], 'hide：隔壁格棋盤 B');
  assert.deepEqual(px(img, nx, ny, 65, 30), [222, 216, 206, 255], 'hide：工件照舊');
  // off：跟沒有 chunks 一樣
  c.ctx.ops.length = 0;
  view.setChunks(result, 'off'); view.render();
  off = c.ctx.ops.filter((o) => o.op === 'drawImage')[0].args[0];
  img = lastImageData(off);
  assert.deepEqual(px(img, nx, ny, 0, 0), [222, 216, 206, 255]);
  assert.equal(view.getScrapMode(), 'off');
  // 不支援（圓棒）的結果當 null；mode 省略沿用
  view.setChunks({ supported: false, labels: null, chunks: [], partCount: 0, scrapCount: 0 });
  assert.equal(view.getChunks(), null);
  assert.equal(view.getScrapMode(), 'off');
  view.setChunks(result, 'mark');
  assert.equal(view.getChunks(), result);
  // 換資料 → 舊結果作廢
  view.setData(makeData());
  assert.equal(view.getChunks(), null);
});

test('hover 滑到廢料格說「廢料（跟工件不相連）」、碰到夾具也說；off 不說；getChunkAt', () => {
  const { d, result } = chunkData();
  const { c, view } = makeView(d);
  view.setChunks(result, 'mark');
  let [sx, sy] = view.worldToScreen(-65, -30);   // ix 0, iy 0 → 外圈
  c.fire('mousemove', { clientX: sx, clientY: sy });
  c.ctx.ops.length = 0; view.render();
  let t = texts(c).find((s) => s.startsWith('X '));
  assert.match(t, /廢料（跟工件不相連），碰到夾具/);
  [sx, sy] = view.worldToScreen(0, 0);
  c.fire('mousemove', { clientX: sx, clientY: sy });
  c.ctx.ops.length = 0; view.render();
  t = texts(c).find((s) => s.startsWith('X '));
  assert.ok(!/廢料/.test(t), '工件格不說廢料');
  // off：照舊，連 hover 也不提
  view.setChunks(result, 'off');
  [sx, sy] = view.worldToScreen(-65, -30);
  c.fire('mousemove', { clientX: sx, clientY: sy });
  c.ctx.ops.length = 0; view.render();
  assert.ok(!/廢料/.test(texts(c).find((s) => s.startsWith('X '))));
  // getChunkAt
  view.setChunks(result, 'mark');
  assert.equal(view.getChunkAt(-65, -30).label, 2);
  assert.equal(view.getChunkAt(0, 0).label, 1);
  assert.equal(view.getChunkAt(-61, 0), null, '切穿的格沒歸類');
  assert.equal(view.getChunkAt(999, 0), null);
  view.setChunks(null);
  assert.equal(view.getChunkAt(0, 0), null);
});

test('剖面 Y：廢料那幾欄填橘、切穿的欄填棋盤（素材底到素材頂）、其餘照舊；hide 的廢料也填棋盤；輪廓線仍一整條', () => {
  const { d, result } = chunkData();
  const { c, view } = makeView(d);
  view.setChunks(result, 'mark');
  view.setMode('sectionY').setSection(0); c.ctx.ops.length = 0; view.render();
  const fills = (col) => c.ctx.ops.filter((o) => o.op === 'fill' && o.fill === col);
  // 假 ctx 沒有 createPattern → 退回 AIR_RGB_B 純色；切穿的欄用 fillRect 填一整欄
  const AIR = `rgb(${U.AIR_RGB_B.join(',')})`;
  const airRects = () => c.ctx.ops.filter((o) => o.op === 'fillRect' && o.fill === AIR);
  assert.equal(fills('rgba(230,126,34,0.45)').length, 2, '左右兩邊的外圈各一段橘');
  assert.equal(fills('rgba(70,120,210,0.28)').length, 1, '中間工件一段藍');
  assert.equal(airRects().length, 2, '切穿的一圈左右各一塊棋盤');
  assert.ok(strokes(c).some((o) => o.stroke === '#1d4ed8'), '輪廓線');
  // 棋盤那一塊要從素材底鋪到素材頂（x 範圍是切穿那幾欄的中線到中線：ix 4 → 3.5～4.5 → 工件座標 -61.5～-60.5）
  const r = airRects()[0].args;
  const [x0, yTop] = view.worldToScreen(-61.5, 0), [x1, yBot] = view.worldToScreen(-60.5, -15);
  assert.ok(Math.abs(r[0] - x0) < 1e-6 && Math.abs(r[2] - (x1 - x0)) < 1e-6, '寬度＝切穿那一欄');
  assert.ok(Math.abs(r[1] - yTop) < 1e-6 && Math.abs(r[3] - (yBot - yTop)) < 1e-6, '高度＝素材頂到素材底');
  // hide：橘不填、廢料當空的畫——跟旁邊切穿的欄併成一塊棋盤；藍照舊
  view.setChunks(result, 'hide'); c.ctx.ops.length = 0; view.render();
  assert.equal(fills('rgba(230,126,34,0.45)').length, 0);
  assert.equal(fills('rgba(70,120,210,0.28)').length, 1);
  assert.equal(airRects().length, 2, 'hide：左右各一塊（廢料＋切穿併成一段）');
  const hr = airRects()[0].args;
  const [hx0] = view.worldToScreen(-65, 0), [hx1] = view.worldToScreen(-60.5, 0);
  assert.ok(Math.abs(hr[0] - hx0) < 1e-6 && Math.abs(hr[2] - (hx1 - hx0)) < 1e-6, 'hide：棋盤從素材邊鋪到切穿欄的內側中線');
  // off：廢料當一般料——外圈、中間各一段藍，中間隔著切穿的棋盤
  view.setChunks(result, 'off'); c.ctx.ops.length = 0; view.render();
  assert.equal(fills('rgba(230,126,34,0.45)').length, 0);
  assert.equal(fills('rgba(70,120,210,0.28)').length, 3);
  assert.equal(airRects().length, 2);
  // 沒有廢料判定（setChunks(null)）切穿的欄一樣要填棋盤——圖例說棋盤＝切穿，跟廢料開不開無關
  view.setChunks(null); c.ctx.ops.length = 0; view.render();
  assert.equal(fills('rgba(70,120,210,0.28)').length, 3);
  assert.equal(airRects().length, 2);
});

test('剖面棋盤：ctx 有 createPattern 就用 8×8 離屏棋盤做的 pattern（只建一次）；沒有就退回純色，不會炸', () => {
  const { d } = chunkData();
  const c = mockCanvas();
  const patterns = [];
  c.ctx.createPattern = (img, rep) => { const p = { pattern: true, img, rep }; patterns.push(p); return p; };
  const view = NC.ui.createView2D(c);
  view.setData(d).setMode('sectionY').setSection(0); c.ctx.ops.length = 0; view.render();
  const rects = c.ctx.ops.filter((o) => o.op === 'fillRect' && o.fill && o.fill.pattern);
  assert.equal(rects.length, 2, '切穿的欄用 pattern 填');
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].rep, 'repeat');
  // 離屏 8×8：先鋪 A 再用 B 填左上／右下兩格
  const off = patterns[0].img;
  assert.equal(off.width, 8); assert.equal(off.height, 8);
  const offRects = off.ctx.ops.filter((o) => o.op === 'fillRect');
  assert.deepEqual(offRects.map((o) => o.fill), [`rgb(${U.AIR_RGB_A.join(',')})`, `rgb(${U.AIR_RGB_B.join(',')})`, `rgb(${U.AIR_RGB_B.join(',')})`]);
  assert.deepEqual(offRects.map((o) => o.args), [[0, 0, 8, 8], [0, 0, 4, 4], [4, 4, 4, 4]]);
  // 再 render 不再建
  c.ctx.ops.length = 0; view.render();
  assert.equal(patterns.length, 1);
  // createPattern 會炸的環境：退回純色
  const c2 = mockCanvas();
  c2.ctx.createPattern = () => { throw new Error('nope'); };
  const v2 = NC.ui.createView2D(c2);
  v2.setData(chunkData().d).setMode('sectionY').setSection(0); c2.ctx.ops.length = 0; v2.render();
  assert.equal(c2.ctx.ops.filter((o) => o.op === 'fillRect' && o.fill === `rgb(${U.AIR_RGB_B.join(',')})`).length, 2);
});

test('頁尾圖例跟實際畫出來的顏色一致：i.scrap = mix(TOP_RGB, SCRAP_RGB, SCRAP_MIX) 的淡桃色、i.air = AIR_RGB_A/B 棋盤', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'view2d.css'), 'utf8');
  const mix = [0, 1, 2].map((k) => Math.round(U.TOP_RGB[k] + (U.SCRAP_RGB[k] - U.TOP_RGB[k]) * U.SCRAP_MIX));
  assert.deepEqual(mix, [227, 158, 94], '俯視廢料格的實際顏色');
  const scrap = css.match(/\.nc-view2d-key i\.scrap\s*\{([^}]*)\}/);
  assert.ok(scrap, '要有 .nc-view2d-key i.scrap');
  assert.match(scrap[1], new RegExp(`rgb\\(\\s*${mix[0]}\\s*,\\s*${mix[1]}\\s*,\\s*${mix[2]}\\s*\\)`), '圖例不能用飽和的橘，圖上沒有那種顏色');
  const air = css.match(/\.nc-view2d-key i\.air\s*\{([^}]*)\}/);
  assert.ok(air);
  const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  assert.ok(/#fff\b|#ffffff/i.test(air[1]), '棋盤 A 白');
  assert.ok(air[1].toLowerCase().includes(hex(U.AIR_RGB_B)), '棋盤 B 淺灰');
});

test('標記模式：點擊回 onMark 工件座標、不觸發 onPick；拖曳不算；剖面上點也標得到；離開後恢復挑選', () => {
  const { c, view } = makeView(makeData());
  const picks = [], marks = [];
  view.onPick((line) => picks.push(line));
  view.onMark((x, y, kind) => marks.push([x, y, kind]));
  assert.equal(view.getMarkMode(), null);
  view.setMarkMode('scrap');
  assert.equal(view.getMarkMode(), 'scrap');
  assert.ok(c.classList.contains('is-marking'), 'canvas 要加 is-marking');
  // 點在路徑上：只放記號，不挑路徑
  const [sx, sy] = view.worldToScreen(0, 5);
  c.fire('mousedown', { clientX: sx, clientY: sy, button: 0 });
  c.fire('mouseup', { clientX: sx + 1, clientY: sy, button: 0 });
  assert.equal(marks.length, 1);
  // 放開時偏 1 px（≈ 0.2 mm，沒超過拖曳門檻）：回的是放開那一點的座標
  assert.ok(Math.abs(marks[0][0]) < 0.5 && Math.abs(marks[0][1] - 5) < 0.5, String(marks[0]));
  assert.equal(marks[0][2], 'scrap');
  assert.equal(picks.length, 0);
  // 拖曳不算
  c.fire('mousedown', { clientX: 400, clientY: 300, button: 0 });
  c.fire('mousemove', { clientX: 450, clientY: 320 });
  c.fire('mouseup', { clientX: 450, clientY: 320, button: 0 });
  assert.equal(marks.length, 1);
  // 剖面 X = -20 上點 (Y=10, Z=-2) → 記號在 (-20, 10)
  view.setMarkMode('part').setMode('sectionX').setSection(-20); view.render();
  const [hx, hy] = view.worldToScreen(10, -2);
  c.fire('mousedown', { clientX: hx, clientY: hy, button: 0 });
  c.fire('mouseup', { clientX: hx, clientY: hy, button: 0 });
  assert.equal(marks.length, 2);
  assert.ok(Math.abs(marks[1][0] + 20) < 1e-9 && Math.abs(marks[1][1] - 10) < 0.1);
  assert.equal(marks[1][2], 'part');
  // 離開標記模式 → 又能挑路徑
  view.setMarkMode(null).setMode('top'); view.render();
  assert.ok(!c.classList.contains('is-marking'));
  const [px2, py2] = view.worldToScreen(0, 5);   // 剛才拖曳過，螢幕座標要重算
  c.fire('mousedown', { clientX: px2, clientY: py2, button: 0 });
  c.fire('mouseup', { clientX: px2, clientY: py2, button: 0 });
  assert.equal(picks.length, 1);
  assert.equal(marks.length, 2);
  assert.equal(view.setMarkMode('bogus').getMarkMode(), null);
});

test('setMarks：俯視畫 ⊙（綠）與 ✕（紅）；剖面不畫；座標壞掉的記號丟掉', () => {
  const { c, view } = makeView(makeData());
  view.setMarks([{ x: 0, y: 0, kind: 'part' }, { x: 10, y: 5, kind: 'scrap' }, { x: NaN, y: 0, kind: 'part' }, null]);
  assert.deepEqual(view.getMarks(), [{ x: 0, y: 0, kind: 'part' }, { x: 10, y: 5, kind: 'scrap' }]);
  view.render();
  assert.ok(strokes(c).some((o) => o.stroke === '#2e7d32'), '⊙ 綠');
  assert.ok(c.ctx.ops.some((o) => o.op === 'fill' && o.fill === '#2e7d32'), '⊙ 中心點');
  assert.ok(strokes(c).some((o) => o.stroke === '#c62828'), '✕ 紅');
  assert.ok(strokes(c).some((o) => o.stroke === 'rgba(255,255,255,0.95)' && o.width === 5), '白色描邊');
  // 記號畫在正確的螢幕位置
  const [mx, my] = view.worldToScreen(0, 0);
  assert.ok(c.ctx.ops.some((o) => o.op === 'arc' && o.args[2] === 7 && Math.abs(o.args[0] - mx) < 1e-9 && Math.abs(o.args[1] - my) < 1e-9));
  view.setMode('sectionX').setSection(0); c.ctx.ops.length = 0; view.render();
  assert.ok(!strokes(c).some((o) => o.stroke === '#2e7d32' || o.stroke === '#c62828'), '剖面不畫記號');
  view.setMarks(null);
  assert.deepEqual(view.getMarks(), []);
});

