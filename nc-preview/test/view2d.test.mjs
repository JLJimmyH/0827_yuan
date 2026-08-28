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
    classList: { toggle() {} },
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
  // 回俯視會畫剖面指示線（橘色虛線）
  view.setMode('top'); c.ctx.ops.length = 0; view.render();
  assert.ok(strokes(c).some((o) => o.stroke === '#ff9500' && o.dash.length === 2));
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
