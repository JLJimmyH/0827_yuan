// view3d.js 測試：3D 視圖的純函式部分（網格建構、路徑線、矩陣、投影）。
// Node 下沒有 WebGL 也沒有 document，view3d.js 只掛純函式，這裡就測那些。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadNC, ROOT } from './load.mjs';

const NC = loadNC();
{
  const p = path.join(ROOT, 'js', 'ui', 'view3d.js');
  vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
}
const V = NC.ui.view3d;

// ---------------------------------------------------------------------------
// 假 SimResult
// ---------------------------------------------------------------------------
/** 全平面 heightmap */
function flatSim(nx, ny, cell = 1, z = 0, floorZ = -10, origin = { x: 0, y: 0 }) {
  return {
    scenario: 'off', cell, nx, ny, origin,
    height: new Float32Array(nx * ny).fill(z),
    floorZ, snapshots: [], events: [], time: { perOp: [], total: 0 },
  };
}
/** 右半邊下沉 depth 的階梯 */
function stepSim(nx, ny, cell = 1, depth = -5, atIx = null) {
  const s = flatSim(nx, ny, cell);
  const cut = atIx == null ? Math.floor(nx / 2) : atIx;
  for (let iy = 0; iy < ny; iy++) for (let ix = cut; ix < nx; ix++) s.height[iy * nx + ix] = depth;
  return s;
}
function vertAt(mesh, i) {
  return { x: mesh.positions[i * 3], y: mesh.positions[i * 3 + 1], z: mesh.positions[i * 3 + 2] };
}
function normAt(mesh, i) {
  return { x: mesh.normals[i * 3], y: mesh.normals[i * 3 + 1], z: mesh.normals[i * 3 + 2] };
}

// ---------------------------------------------------------------------------
// 模組載入與 Node 安全
// ---------------------------------------------------------------------------
test('view3d：在 Node（無 document）下載入不炸，且掛好純函式', () => {
  assert.equal(typeof globalThis.document, 'undefined', '這個測試假設 Node 沒有 document');
  for (const fn of ['buildMesh', 'buildMeshAsync', 'planChunks', 'updateHeights', 'canUpdateHeights',
    'buildPathLines', 'buildStockLines', 'buildAxesLines', 'sceneBounds', 'toolColor',
    'mat4', 'mat4Mul', 'mat4LookAt', 'mat4Perspective', 'projectPoint', 'downsampleHeights', 'resolveDownsample']) {
    assert.equal(typeof V[fn], 'function', `NC.ui.view3d.${fn} 應該是函式`);
  }
  assert.equal(typeof NC.ui.createView3D, 'function');
  assert.equal(V.isSupported(), false, 'Node 沒有 document → isSupported() 應為 false');
  assert.equal(NC.ui.createView3D(null), null, '沒有 canvas 應回 null，讓呼叫端退回 2D');
});

test('view3d：刀具色表與 view2d.js 一致（T1 紅、12 色循環、null 灰藍）', () => {
  assert.deepEqual(V.TOOL_COLORS, ['#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf',
    '#e377c2', '#8c564b', '#bcbd22', '#0b8f8f', '#c05a00', '#5b3fd6']);
  assert.equal(V.toolColor(1), '#d62728');
  assert.equal(V.toolColor(13), '#d62728');
  assert.equal(V.toolColor(null), '#607d8b');
  assert.deepEqual(V.TOP_RGB, [222, 216, 206]);   // 頂面暖灰：要和背景 #fbfbfb 分得開
  assert.deepEqual(V.DEEP_RGB, [14, 34, 104]);
});

// ---------------------------------------------------------------------------
// buildMesh：頂點數、幾何
// ---------------------------------------------------------------------------
test('buildMesh：平面 heightmap 的頂點數＝頂面 + 外壁 + 底面', () => {
  const nx = 7, ny = 5;
  const mesh = V.buildMesh(flatSim(nx, ny));
  const quads = nx * ny + 2 * (nx + ny) + 1;      // 頂面 nx·ny、外壁 2(nx+ny)、底面 1
  assert.equal(mesh.counts.topQuads, nx * ny);
  assert.equal(mesh.counts.skirtQuads, 0, '完全平的 heightmap 不該有裙邊');
  assert.equal(mesh.counts.wallQuads, 2 * (nx + ny));
  assert.equal(mesh.counts.bottomQuads, 1);
  assert.equal(mesh.counts.quads, quads);
  assert.equal(mesh.counts.vertices, quads * 4);
  assert.equal(mesh.counts.indices, quads * 6);
  assert.equal(mesh.counts.triangles, quads * 2);
  assert.equal(mesh.positions.length, quads * 4 * 3);
  assert.equal(mesh.normals.length, quads * 4 * 3);
  assert.equal(mesh.indices.length, quads * 6);
  assert.ok(mesh.indices instanceof Uint32Array, '預設索引用 Uint32Array');
});

test('buildMesh：格 (ix,iy) 攤成中心在 origin+(ix·cell,iy·cell)、邊長 cell 的水平方塊', () => {
  const sim = flatSim(3, 2, 2, -1.5, -8, { x: 10, y: 20 });
  const mesh = V.buildMesh(sim);
  // 第 0 個頂面四邊形 = 格 (0,0)：中心 (10,20)、半格 1
  const c = [0, 1, 2, 3].map((i) => vertAt(mesh, i));
  assert.deepEqual(c.map((p) => [p.x, p.y, p.z]), [[9, 19, -1.5], [11, 19, -1.5], [11, 21, -1.5], [9, 21, -1.5]]);
  for (const p of c) assert.equal(p.z, -1.5, '同一格頂面四角同高（水平面，不是斜面）');
  // 格 (2,1) = 第 1*3+2 = 5 個頂面四邊形
  const d = vertAt(mesh, 5 * 4);
  assert.equal(d.x, 10 + 2 * 2 - 1);
  assert.equal(d.y, 20 + 1 * 2 - 1);
  // 包絡
  assert.equal(mesh.bounds.min.x, 9);
  assert.equal(mesh.bounds.max.x, 10 + 2 * 2 + 1);
  assert.equal(mesh.bounds.min.z, -8);
});

test('buildMesh：有階梯時產生垂直裙邊（4 角同 X、法線水平、跨越兩個高度）', () => {
  const nx = 6, ny = 4, cell = 1, depth = -5;
  const sim = stepSim(nx, ny, cell, depth, 3);
  const mesh = V.buildMesh(sim);
  assert.equal(mesh.counts.skirtQuads, ny, '每一列在 ix=2→3 的交界各一片裙邊');
  const first = mesh.counts.topQuads * 4;
  const q = [0, 1, 2, 3].map((i) => vertAt(mesh, first + i));
  const xs = new Set(q.map((p) => p.x));
  assert.equal(xs.size, 1, '裙邊四個角同一個 X → 完全垂直，不是斜面');
  assert.equal([...xs][0], 0 + 2 * cell + cell / 2, '牆面落在兩格中間（格 2 的右邊界）');
  const zs = q.map((p) => p.z).sort((a, b) => a - b);
  assert.deepEqual(zs, [depth, depth, 0, 0], '裙邊從低格拉到高格');
  for (let i = 0; i < 4; i++) {
    const n = normAt(mesh, first + i);
    assert.equal(Math.abs(n.z) < 1e-6, true, '垂直壁的法線必須水平');
    assert.equal(Math.abs(Math.abs(n.x) - 1) < 1e-6, true, 'X 向裙邊法線為 ±X');
  }
});

test('buildMesh：階梯上下相鄰的頂面仍是水平面（斜面糊過去就會抓到）', () => {
  const nx = 6, ny = 4;
  const mesh = V.buildMesh(stepSim(nx, ny, 1, -5, 3));
  for (let q = 0; q < mesh.counts.topQuads; q++) {
    const z0 = vertAt(mesh, q * 4).z;
    for (let i = 1; i < 4; i++) assert.equal(vertAt(mesh, q * 4 + i).z, z0);
  }
});

test('buildMesh：底面與四周外壁存在，且拉到 floorZ', () => {
  const nx = 5, ny = 4, floorZ = -12;
  const sim = flatSim(nx, ny, 1, 0, floorZ);
  const mesh = V.buildMesh(sim);
  const wallFirst = (mesh.counts.topQuads + mesh.counts.skirtQuads) * 4;
  const bottomFirst = wallFirst + mesh.counts.wallQuads * 4;
  // 外壁：法線水平、有頂點落在 floorZ
  const sides = { '-x': 0, '+x': 0, '-y': 0, '+y': 0 };
  for (let q = 0; q < mesh.counts.wallQuads; q++) {
    const n = normAt(mesh, wallFirst + q * 4);
    assert.ok(Math.abs(n.z) < 1e-6, '外壁法線水平');
    if (n.x < -0.5) sides['-x']++; else if (n.x > 0.5) sides['+x']++;
    else if (n.y < -0.5) sides['-y']++; else sides['+y']++;
    const zs = [0, 1, 2, 3].map((i) => vertAt(mesh, wallFirst + q * 4 + i).z);
    assert.ok(zs.some((z) => z === floorZ), '外壁要拉到 floorZ');
  }
  assert.deepEqual(sides, { '-x': ny, '+x': ny, '-y': nx, '+y': nx });
  // 底面：法線朝下、四角都在 floorZ
  for (let i = 0; i < 4; i++) {
    assert.equal(vertAt(mesh, bottomFirst + i).z, floorZ);
    assert.equal(normAt(mesh, bottomFirst + i).z, -1);
  }
});

test('buildMesh：sides:false 時只有頂面與裙邊（分塊或只看表面時用）', () => {
  const mesh = V.buildMesh(flatSim(4, 3), { sides: false });
  assert.equal(mesh.counts.wallQuads, 0);
  assert.equal(mesh.counts.bottomQuads, 0);
  assert.equal(mesh.counts.quads, 12);
});

test('buildMesh：索引不越界、每個四邊形兩個三角形、繞向一致', () => {
  const mesh = V.buildMesh(stepSim(9, 7, 0.5, -3));
  const n = mesh.counts.vertices;
  let max = -1;
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i];
    assert.ok(v >= 0 && v < n, `索引 ${v} 越界（頂點數 ${n}）`);
    if (v > max) max = v;
  }
  assert.equal(max, n - 1, '最後一個頂點應該有被用到');
  for (let q = 0; q < mesh.counts.quads; q++) {
    const b = q * 4, o = q * 6;
    assert.deepEqual(Array.from(mesh.indices.slice(o, o + 6)), [b, b + 1, b + 2, b, b + 2, b + 3]);
  }
});

test('buildMesh：所有法線都是單位長度', () => {
  const sim = flatSim(12, 9, 0.5, 0, -6);
  // 弄一個有斜坡、階梯、圓孔的高度場
  for (let iy = 0; iy < 9; iy++) for (let ix = 0; ix < 12; ix++) {
    let z = -ix * 0.05;                                  // 緩斜坡（會用到梯度法線）
    if (ix >= 6 && iy >= 4) z = -3;                      // 階梯
    if (Math.hypot(ix - 3, iy - 6) < 2) z = -5;          // 圓孔
    sim.height[iy * 12 + ix] = z;
  }
  const mesh = V.buildMesh(sim);
  assert.ok(mesh.counts.skirtQuads > 0);
  for (let i = 0; i < mesh.counts.vertices; i++) {
    const nv = normAt(mesh, i);
    const len = Math.hypot(nv.x, nv.y, nv.z);
    assert.ok(Math.abs(len - 1) < 1e-5, `第 ${i} 個頂點法線長度 ${len} 不是 1`);
  }
});

test('buildMesh：緩斜坡的頂面法線帶梯度、階梯旁的頂面法線回到垂直（不被階梯拉歪）', () => {
  const nx = 7, ny = 3, cell = 1;
  const sim = flatSim(nx, ny, cell);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) sim.height[iy * nx + ix] = ix < 4 ? -ix * 0.2 : -20;
  }
  const mesh = V.buildMesh(sim);
  const nSlope = normAt(mesh, (1 * nx + 2) * 4);      // 斜坡中段
  assert.ok(nSlope.x > 0.1, '斜坡法線應該往上坡方向傾（-dz/dx > 0）');
  const nEdge = normAt(mesh, (1 * nx + 3) * 4);       // 緊鄰 -20 大階梯那格
  assert.ok(nEdge.z > 0.9, '階梯（差 > 門檻）不該把旁邊頂面的法線拉歪');
});

// ---------------------------------------------------------------------------
// 降採樣
// ---------------------------------------------------------------------------
test('downsampleHeights：min 取整塊最小值、sample 取最近格', () => {
  const nx0 = 4, ny0 = 4;
  const h = new Float32Array(nx0 * ny0);
  for (let iy = 0; iy < ny0; iy++) for (let ix = 0; ix < nx0; ix++) h[iy * nx0 + ix] = -(iy * nx0 + ix);
  const mn = V.downsampleHeights(h, nx0, ny0, 2, 'min');
  assert.equal(mn.nx, 2); assert.equal(mn.ny, 2);
  assert.equal(mn.z[0], -5);          // 區塊 {0,1,4,5} 的最小
  assert.equal(mn.z[3], -15);         // 區塊 {10,11,14,15}
  const sp = V.downsampleHeights(h, nx0, ny0, 2, 'sample');
  assert.equal(sp.z[0], -0);
  assert.equal(sp.z[3], -10);
  const k1 = V.downsampleHeights(h, nx0, ny0, 1, 'min');
  assert.equal(k1.z, h, 'k=1 時直接沿用原陣列，不複製');
});

test('buildMesh：降採樣後格數、格距、座標都對', () => {
  const nx0 = 9, ny0 = 7, cell0 = 0.25;
  const sim = flatSim(nx0, ny0, cell0, 0, -4, { x: -1, y: -2 });
  const mesh = V.buildMesh(sim, { downsample: 2 });
  assert.equal(mesh.counts.downsample, 2);
  assert.equal(mesh.nx, 5);          // floor((9-1)/2)+1
  assert.equal(mesh.ny, 4);          // floor((7-1)/2)+1
  assert.equal(mesh.cell, 0.5);
  assert.equal(mesh.counts.topQuads, 5 * 4);
  const p0 = vertAt(mesh, 0);
  assert.equal(p0.x, -1 - 0.25);     // origin.x − cell/2
  assert.equal(p0.y, -2 - 0.25);
  const mesh4 = V.buildMesh(sim, { downsample: 4 });
  assert.equal(mesh4.nx, 3);
  assert.equal(mesh4.ny, 2);
  assert.equal(mesh4.cell, 1);
});

test('resolveDownsample：頂點超過上限時自動 2×/4× 降採樣', () => {
  const sim = flatSim(561, 401, 0.25);
  assert.equal(V.resolveDownsample(sim, {}), 1, '400 萬頂點上限下，561×401 不需要降採樣');
  assert.equal(V.resolveDownsample(sim, { maxVertices: 250000 }), 2);
  assert.equal(V.resolveDownsample(sim, { maxVertices: 60000 }), 4);
  assert.equal(V.resolveDownsample(sim, { downsample: 8 }), 8, '明確指定就照指定的');
  const mesh = V.buildMesh(sim, { maxVertices: 250000 });
  assert.equal(mesh.counts.downsample, 2);
  assert.ok(mesh.counts.vertices <= 250000);
});

// ---------------------------------------------------------------------------
// 只更新高度（不重建 index buffer）
// ---------------------------------------------------------------------------
test('updateHeights：拓樸相同時只改 Z 與法線，索引物件原封不動', () => {
  const sim = stepSim(8, 6, 1, -4, 4);
  const mesh = V.buildMesh(sim);
  const idxRef = mesh.indices;
  const posRef = mesh.positions;
  const skirts = mesh.counts.skirtQuads;
  const h2 = Float32Array.from(sim.height);
  for (let i = 0; i < h2.length; i++) if (h2[i] < 0) h2[i] = -9;    // 同樣位置、更深
  assert.equal(V.updateHeights(mesh, h2), true);
  assert.equal(mesh.indices, idxRef, '索引不可重建');
  assert.equal(mesh.positions, posRef, '頂點緩衝就地更新');
  assert.equal(mesh.counts.skirtQuads, skirts);
  assert.equal(mesh.zMin, -9);
  const first = mesh.counts.topQuads * 4;
  const zs = [0, 1, 2, 3].map((i) => vertAt(mesh, first + i).z).sort((a, b) => a - b);
  assert.deepEqual(zs, [-9, -9, 0, 0], '裙邊跟著拉深');
  // 頂面也更新了
  let deep = 0;
  for (let q = 0; q < mesh.counts.topQuads; q++) if (vertAt(mesh, q * 4).z === -9) deep++;
  assert.equal(deep, 4 * 6);
});

test('canUpdateHeights / updateHeights：出現新階梯（沒配置裙邊）時拒絕，交給重建', () => {
  const sim = flatSim(6, 5);
  const mesh = V.buildMesh(sim);
  assert.equal(mesh.counts.skirtQuads, 0);
  const h2 = Float32Array.from(sim.height);
  for (let iy = 0; iy < 5; iy++) h2[iy * 6 + 3] = -2;     // 憑空長出一道階梯
  assert.equal(V.canUpdateHeights(mesh, h2), false);
  assert.equal(V.updateHeights(mesh, h2), false, '拓樸不相容必須回 false 而不是畫出裂縫');
  const same = Float32Array.from(sim.height);
  assert.notEqual(V.canUpdateHeights(mesh, same), false, '同拓樸應可快路徑更新');
});

// ---------------------------------------------------------------------------
// 分塊（WebGL1 沒有 OES_element_index_uint 時的降級）
// ---------------------------------------------------------------------------
test('planChunks / buildMeshAsync：分塊覆蓋所有列、頂點數與單塊一致、可用 Uint16 索引', async () => {
  const sim = stepSim(40, 30, 1, -3, 20);
  const one = V.buildMesh(sim);
  const plan = V.planChunks(sim, { maxVertsPerChunk: 4096 });
  assert.ok(plan.bands.length > 1, '應該切成多塊');
  assert.equal(plan.bands[0][0], 0);
  assert.equal(plan.bands[plan.bands.length - 1][1], 30);
  for (let i = 1; i < plan.bands.length; i++) assert.equal(plan.bands[i][0], plan.bands[i - 1][1], '區塊要接得上，不能漏列');

  let progress = [];
  const res = await V.buildMeshAsync(sim, { maxVertsPerChunk: 4096, uint16: true, onProgress: (p) => progress.push(p) });
  assert.ok(res && res.chunks.length > 1);
  assert.equal(res.counts.topQuads, one.counts.topQuads);
  assert.equal(res.counts.skirtQuads, one.counts.skirtQuads);
  // 每塊各有自己的底面，外壁只在真正的邊界上
  assert.equal(res.counts.bottomQuads, res.chunks.length);
  assert.equal(res.counts.wallQuads, 30 * 2 + 40 * 2);
  for (const c of res.chunks) {
    assert.ok(c.indices instanceof Uint16Array, '要求 uint16 且頂點數夠小時應給 Uint16Array');
    for (let i = 0; i < c.indices.length; i++) assert.ok(c.indices[i] < c.counts.vertices);
  }
  assert.ok(progress.length >= 1);
  assert.equal(progress[progress.length - 1], 1);
});

test('buildMeshAsync：shouldCancel 可中止（切刀具表時丟掉過時的建構）', async () => {
  const sim = stepSim(60, 40, 1, -2, 30);
  const res = await V.buildMeshAsync(sim, { maxVertsPerChunk: 2048, shouldCancel: () => true });
  assert.equal(res, null);
});

// ---------------------------------------------------------------------------
// 效能
// ---------------------------------------------------------------------------
test('效能：561×401（≈ 22.5 萬格、140×100 mm / 0.25 mm）建網格 < 2 s', () => {
  const nx = 561, ny = 401, cell = 0.25;
  const sim = flatSim(nx, ny, cell, 0, -20, { x: -70, y: -50 });
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      let z = 0;
      if (ix > 100 && ix < 400 && iy > 80 && iy < 320) z = -6;
      if (Math.hypot(ix - 460, iy - 330) < 40) z = -20;
      sim.height[iy * nx + ix] = z;
    }
  }
  const t0 = Date.now();
  const mesh = V.buildMesh(sim);
  const dt = Date.now() - t0;
  assert.ok(mesh.counts.topQuads === nx * ny);
  assert.ok(mesh.counts.skirtQuads > 0);
  assert.ok(dt < 2000, `建網格花了 ${dt} ms，超過 2 s`);
  // 一次寫入的 typed array，index 用 Uint32Array
  assert.ok(mesh.positions instanceof Float32Array);
  assert.ok(mesh.indices instanceof Uint32Array);
  const t1 = Date.now();
  assert.equal(V.updateHeights(mesh, sim.height), true);
  assert.ok(Date.now() - t1 < 2000, '只更新 Z 應該更快');
});

// ---------------------------------------------------------------------------
// 路徑線
// ---------------------------------------------------------------------------
function seg(o) {
  return Object.assign({ id: 0, line: 1, opIndex: 0, tool: 1, kind: 'feed', feed: 500, path: 'programmed' }, o);
}
test('buildPathLines：rapid 與 feed 分組、依刀具著色、byLine 可查', () => {
  const segs = [
    seg({ id: 0, line: 10, tool: 1, kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 10, y: 0, z: 5 } }),
    seg({ id: 1, line: 11, tool: 1, kind: 'feed', from: { x: 10, y: 0, z: 0 }, to: { x: 10, y: 10, z: 0 } }),
    seg({ id: 2, line: 12, tool: 2, kind: 'feed', from: { x: 10, y: 10, z: 0 }, to: { x: 0, y: 10, z: 0 } }),
    seg({ id: 3, line: 12, tool: 2, kind: 'drill', from: { x: 0, y: 10, z: 0 }, to: { x: 0, y: 10, z: -5 } }),
  ];
  const r = V.buildPathLines(segs);
  assert.equal(r.vertexCount, 8);
  assert.equal(r.positions.length, 24);
  assert.equal(r.ranges.length, 3, 'rapid(T1) / feed(T1) / feed(T2) 三組');
  assert.equal(r.ranges[0].cls, 'rapid');
  assert.equal(r.ranges[0].tool, 1);
  assert.equal(r.ranges[1].cls, 'feed');
  assert.equal(r.ranges[1].tool, 1);
  assert.equal(r.ranges[2].tool, 2);
  assert.equal(r.ranges[2].count, 4, 'T2 的 feed 與 drill 併在同一組');
  // 顏色：rapid 灰 #9a9a9a、T1 紅 #d62728
  const g = 0x9a / 255;
  assert.ok(Math.abs(r.colors[0] - g) < 1e-3 && Math.abs(r.colors[1] - g) < 1e-3);
  const t1 = V.hexRgb('#d62728');
  const o = r.ranges[1].first * 3;
  assert.ok(Math.abs(r.colors[o] - t1[0]) < 1e-3 && Math.abs(r.colors[o + 2] - t1[2]) < 1e-3);
  // byLine
  assert.equal(r.byLine.get(12).length, 2);
  assert.equal(r.byLine.get(10).length, 1);
  assert.equal(r.segRanges.length, 4);
  // 座標：第一段 rapid
  assert.deepEqual(Array.from(r.positions.slice(0, 6)), [0, 0, 5, 10, 0, 5]);
});

test('buildPathLines：圓弧細分、Z 線性內插（螺旋）', () => {
  const s = seg({
    line: 20, kind: 'arc', from: { x: 10, y: 0, z: 0 }, to: { x: -10, y: 0, z: -4 },
    arc: { center: { x: 0, y: 0 }, cw: false, r: 10 },
  });
  const n = V.arcSteps(s, 0.05);
  assert.ok(n > 8, `半圓 R10 在 0.05 mm 弦差下應細分成多段，實際 ${n}`);
  const r = V.buildPathLines([s]);
  assert.equal(r.vertexCount, n * 2);
  // 每個點都在圓上、Z 單調下降
  let prevZ = Infinity;
  for (let i = 0; i < r.vertexCount; i++) {
    const x = r.positions[i * 3], y = r.positions[i * 3 + 1], z = r.positions[i * 3 + 2];
    assert.ok(Math.abs(Math.hypot(x, y) - 10) < 1e-3);
    assert.ok(z <= prevZ + 1e-6);
    prevZ = z;
  }
  assert.ok(Math.abs(r.positions[(r.vertexCount - 1) * 3] - (-10)) < 1e-6);
  assert.ok(Math.abs(r.positions[(r.vertexCount - 1) * 3 + 2] - (-4)) < 1e-6);
});

test('buildPathLines：整圓（起終點重合）要走滿 360°', () => {
  const s = seg({ line: 21, kind: 'arc', from: { x: 5, y: 0, z: -1 }, to: { x: 5, y: 0, z: -1 }, arc: { center: { x: 0, y: 0 }, cw: false, r: 5 } });
  const r = V.buildPathLines([s]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < r.vertexCount; i++) {
    minX = Math.min(minX, r.positions[i * 3]); maxX = Math.max(maxX, r.positions[i * 3]);
    minY = Math.min(minY, r.positions[i * 3 + 1]); maxY = Math.max(maxY, r.positions[i * 3 + 1]);
  }
  assert.ok(minX < -4.9 && maxX > 4.9 && minY < -4.9 && maxY > 4.9, '整圓要涵蓋四個象限');
});

test('buildStockLines / buildAxesLines：素材線框與三軸箭頭都有頂點', () => {
  const stock = { min: { x: -10, y: -5, z: -8 }, max: { x: 10, y: 5, z: 0 }, source: 'user', fixtures: [{ min: { x: 11, y: -5, z: -8 }, max: { x: 14, y: 5, z: -2 } }] };
  const b = V.buildStockLines(stock);
  assert.ok(b.vertexCount > 24, '12 條稜邊切成虛線後頂點數應遠多於 24');
  assert.equal(b.vertexCount % 2, 0);
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < b.vertexCount; i++) { minX = Math.min(minX, b.positions[i * 3]); maxX = Math.max(maxX, b.positions[i * 3]); }
  assert.ok(minX >= -10 - 1e-6 && maxX <= 14 + 1e-6, '含治具的線框不超出範圍');
  const a = V.buildAxesLines(20);
  assert.ok(a.vertexCount >= 6 * 3, '三軸各有主線與箭羽');
  const empty = V.buildStockLines(null);
  assert.equal(empty.vertexCount, 0);
});

// ---------------------------------------------------------------------------
// 場景包絡與矩陣／投影（fit 與挑選用）
// ---------------------------------------------------------------------------
test('sceneBounds：含素材、模擬格與非 G28 段', () => {
  const sim = flatSim(5, 5, 2, 0, -9, { x: 0, y: 0 });
  const stock = { min: { x: -1, y: -1, z: -9 }, max: { x: 9, y: 9, z: 0 }, source: 'user', fixtures: [] };
  const segs = [
    seg({ from: { x: 0, y: 0, z: 30 }, to: { x: 200, y: 0, z: 30 }, kind: 'rapid', refReturn: true }),
    seg({ from: { x: 2, y: 2, z: -3 }, to: { x: 6, y: 7, z: -3 } }),
  ];
  const b = V.sceneBounds({ sim, stock, segments: segs });
  assert.equal(b.min.x, -1);
  assert.equal(b.max.x, 9, 'G28 段（refReturn）不列入包絡');
  assert.equal(b.min.z, -9);
  assert.equal(b.max.z, 0);
  assert.equal(V.sceneBounds({}), null);
});

test('mat4 / projectPoint：已知相機下的投影位置正確', () => {
  const proj = V.mat4(), view = V.mat4(), mvp = V.mat4();
  V.mat4Perspective(proj, Math.PI / 2, 1, 0.1, 100);      // fov 90°、正方形畫面
  V.mat4LookAt(view, [0, 0, 10], [0, 0, 0], [0, 1, 0]);   // 從 +Z 往原點看，up = +Y
  V.mat4Mul(mvp, proj, view);
  const c = V.projectPoint(mvp, 0, 0, 0, 200, 200);
  assert.ok(Math.abs(c.x - 100) < 1e-3 && Math.abs(c.y - 100) < 1e-3, '原點應落在畫面中心');
  // 距離 10、fov 90° → 半視野寬 10；x = 10 應落在畫面右緣
  const right = V.projectPoint(mvp, 10, 0, 0, 200, 200);
  assert.ok(Math.abs(right.x - 200) < 1e-3);
  const up = V.projectPoint(mvp, 0, 10, 0, 200, 200);
  assert.ok(Math.abs(up.y - 0) < 1e-3, '+Y 在畫面上方（螢幕 Y 朝下）');
  assert.equal(V.projectPoint(mvp, 0, 0, 20, 200, 200), null, '相機後方回 null');
});

test('distPointSeg2D：畫面空間點到線段距離（挑選門檻用）', () => {
  assert.equal(V.distPointSeg2D(5, 3, 0, 0, 10, 0), 3);
  assert.equal(V.distPointSeg2D(-4, 0, 0, 0, 10, 0), 4, '投影落在線段外時取端點距離');
  assert.equal(V.PICK_PX, 6, '挑選門檻與 view2d.js 一致');
});

// ---------------------------------------------------------------------------
// 驗收補測（第二輪）：背面剔除的前提、fit 的 Z 包絡、補正段淡化、真實資料
// ---------------------------------------------------------------------------

/** 每個四邊形的幾何繞向（cross(b-a, c-b)）要和宣告的法線同向，view3d 才敢開 gl.CULL_FACE */
function windingReport(mesh) {
  const P = mesh.positions, N = mesh.normals;
  const bad = [];
  for (let q = 0; q < mesh.counts.quads; q++) {
    const i = q * 4;
    const p = (k) => [P[(i + k) * 3], P[(i + k) * 3 + 1], P[(i + k) * 3 + 2]];
    const a = p(0), b = p(1), c = p(2);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const g = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(g[0], g[1], g[2]);
    if (len < 1e-12) continue;                       // 退化四邊形（階梯剛好消失）不算
    const n = [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]];
    const dot = (g[0] * n[0] + g[1] * n[1] + g[2] * n[2]) / len;
    if (!(dot > 0.2)) bad.push({ q, dot });
  }
  return bad;
}
/** 裙邊／外壁必須是完全垂直的牆：四角同 X 或同 Y，且剛好兩個相異 Z */
function verticalityReport(mesh) {
  const P = mesh.positions, c = mesh.counts;
  const bad = [];
  for (let q = c.topQuads; q < c.topQuads + c.skirtQuads + c.wallQuads; q++) {
    const xs = [], ys = [], zs = new Set();
    for (let k = 0; k < 4; k++) {
      xs.push(P[(q * 4 + k) * 3]); ys.push(P[(q * 4 + k) * 3 + 1]);
      zs.add(Math.round(P[(q * 4 + k) * 3 + 2] * 1e6) / 1e6);
    }
    const flatX = Math.max(...xs) - Math.min(...xs) < 1e-9;
    const flatY = Math.max(...ys) - Math.min(...ys) < 1e-9;
    if (!(flatX || flatY) || zs.size > 2) bad.push({ q, flatX, flatY, zs: zs.size });
  }
  return bad;
}

test('buildMesh：每個四邊形的繞向與法線同向（gl.CULL_FACE 背面剔除的前提）', () => {
  const sim = flatSim(14, 11, 0.5, 0, -6);
  for (let iy = 0; iy < 11; iy++) for (let ix = 0; ix < 14; ix++) {
    let z = -ix * 0.05;                                   // 緩斜坡
    if (ix >= 7 && iy >= 5) z = -3;                       // 階梯（往 +X、+Y 下降）
    if (ix <= 3 && iy <= 3) z = -2;                       // 反方向的階梯（往 -X、-Y 下降）
    if (Math.hypot(ix - 4, iy - 8) < 2.5) z = -6;         // 貫穿孔（到 floorZ）
    sim.height[iy * 14 + ix] = z;
  }
  const mesh = V.buildMesh(sim);
  assert.ok(mesh.counts.skirtQuads > 20 && mesh.counts.wallQuads > 0);
  const bad = windingReport(mesh);
  assert.deepEqual(bad, [], `有 ${bad.length} 個四邊形繞向與法線相反，開了背面剔除會破洞`);
});

test('buildMesh：所有裙邊與外壁都是完全垂直的牆（口袋壁不是斜坡）', () => {
  const sim = flatSim(14, 11, 0.5, 0, -6);
  for (let iy = 0; iy < 11; iy++) for (let ix = 0; ix < 14; ix++) {
    sim.height[iy * 14 + ix] = (ix >= 5 && ix <= 9 && iy >= 3 && iy <= 7) ? -4 : 0;
  }
  const mesh = V.buildMesh(sim);
  const bad = verticalityReport(mesh);
  assert.deepEqual(bad, [], `有 ${bad.length} 片牆不是垂直面`);
  assert.equal(mesh.counts.skirtQuads, 20, '5×5 口袋四周應該剛好 20 片裙邊（X 向 10、Y 向 10）');
});

test('updateHeights 快路徑：階梯方向反轉之後繞向仍然正確（不然剔除會反向破洞）', () => {
  const nx = 6, ny = 4, cell = 1;
  const sim = flatSim(nx, ny, cell, 0, -8);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) sim.height[iy * nx + ix] = ix < 3 ? 0 : -4;
  const mesh = V.buildMesh(sim);
  assert.deepEqual(windingReport(mesh), []);
  // 把階梯翻過來：左低右高（同一條邊，所以快路徑吃得下）
  const flipped = new Float32Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) flipped[iy * nx + ix] = ix < 3 ? -4 : 0;
  assert.ok(V.updateHeights(mesh, flipped), '同一條邊上的階梯翻向，應該走得了快路徑');
  assert.deepEqual(windingReport(mesh), [], '翻向後繞向沒有跟著翻，背面剔除會露出內部');
  assert.deepEqual(verticalityReport(mesh), []);
});

test('sceneBounds：Z 包絡不吃 rapid（G0 拉到 Z150 不該把工件壓成一條線）', () => {
  const stock = { min: { x: -65, y: -10, z: -15 }, max: { x: 65, y: 50, z: 0 }, source: 'user', fixtures: [] };
  const segs = [
    seg({ line: 1, kind: 'rapid', from: { x: 0, y: 0, z: 150 }, to: { x: -60, y: 0, z: 150 } }),
    seg({ line: 2, kind: 'rapid', from: { x: -60, y: 0, z: 150 }, to: { x: -60, y: 0, z: 2 } }),
    seg({ line: 3, kind: 'feed', from: { x: -60, y: 0, z: 2 }, to: { x: -60, y: 0, z: -10 } }),
    seg({ line: 4, kind: 'feed', from: { x: -60, y: 0, z: -10 }, to: { x: -60, y: 40, z: -10 } }),
  ];
  const b = V.sceneBounds({ sim: null, stock, segments: segs });
  assert.equal(b.max.z, 2, 'Z 上限應該來自切削段／素材，不是 rapid 的 Z150');
  assert.equal(b.min.z, -15);
  assert.equal(b.min.x, -65, 'XY 仍然要吃 rapid（與 view2d.topBounds 一致）');
  // 完全沒有切削段時才退回用 rapid 的 Z，否則 Z 包絡會是空的
  const onlyRapid = V.sceneBounds({ segments: [seg({ kind: 'rapid', from: { x: 0, y: 0, z: 3 }, to: { x: 10, y: 0, z: 9 } })] });
  assert.equal(onlyRapid.min.z, 3);
  assert.equal(onlyRapid.max.z, 9);
});

test('buildPathLines：同一行已有 compensated 段時，programmed 段分到 faded 組（與 view2d 淡化一致）', () => {
  const segs = [
    seg({ id: 0, line: 30, tool: 1, path: 'programmed', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } }),
    seg({ id: 1, line: 30, tool: 1, path: 'compensated', from: { x: 0, y: 6, z: 0 }, to: { x: 10, y: 6, z: 0 } }),
    seg({ id: 2, line: 31, tool: 1, path: 'programmed', from: { x: 10, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 } }),
  ];
  const r = V.buildPathLines(segs);
  assert.ok(r.compLines.has(30) && !r.compLines.has(31));
  const faded = r.ranges.filter((x) => x.faded), solid = r.ranges.filter((x) => !x.faded);
  assert.equal(faded.length, 1, 'L30 的 programmed 段要自成一組才畫得出不同 alpha');
  assert.equal(faded[0].count, 2, '只有 L30 那一段被淡化');
  assert.equal(solid.reduce((n, x) => n + x.count, 0), 4, '補正段與沒有補正的 L31 維持原樣');
  // 沒有補正段時不該多切一組
  const plain = V.buildPathLines([segs[0], segs[2]]);
  assert.equal(plain.ranges.length, 1);
  assert.equal(plain.ranges[0].faded, false);
});

// ---------------------------------------------------------------------------
// 真實資料驗收：test/fixture-sim.json 由 tools/make-fixture-sim.mjs 對
// test/fixtures/樣本 C 跑 NC.analyze 產生（沒有就跳過，不擋 CI）
// ---------------------------------------------------------------------------
const REAL_PATH = path.join(ROOT, 'test', 'fixture-sim.json');
const REAL = fs.existsSync(REAL_PATH) ? JSON.parse(fs.readFileSync(REAL_PATH, 'utf8')) : null;
const realSim = REAL ? {
  scenario: REAL.scenario, cell: REAL.cell, nx: REAL.nx, ny: REAL.ny, origin: REAL.origin,
  height: Float32Array.from(REAL.height), floorZ: REAL.floorZ, snapshots: [], events: [], time: REAL.time,
} : null;
const skipReal = REAL ? false : '缺 test/fixture-sim.json（跑 node tools/make-fixture-sim.mjs 產生）';

test('真實資料 樣本 C：heightmap 與契約 §5 驗收數字相符', { skip: skipReal }, () => {
  const at = (x, y) => realSim.height[Math.round((y - realSim.origin.y) / realSim.cell) * realSim.nx + Math.round((x - realSim.origin.x) / realSim.cell)];
  assert.ok(Math.abs(at(-62.5, 0) - -10) < 0.05, `X=-62.5 應 ≈ -10，實際 ${at(-62.5, 0)}`);
  assert.equal(at(0, 0), 0, 'X=0 中央不動');
  for (const x of [-45, -15, 15, 45]) assert.ok(at(x, 48.4) <= -7, `孔 X${x} 高度 ${at(x, 48.4)} 應 ≤ -7`);
  assert.equal(realSim.nx, 521);
  assert.equal(realSim.ny, 241);
});

test('真實資料 樣本 C：建網格正確、牆垂直、繞向一致、2 秒內完成', { skip: skipReal }, () => {
  const t0 = Date.now();
  const mesh = V.buildMesh(realSim, { downsample: 1 });
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `125,561 格建網格花了 ${ms} ms`);
  assert.ok(mesh.counts.triangles > 200000, `三角數 ${mesh.counts.triangles}`);
  assert.ok(Math.abs(mesh.zMin - -10) < 1e-3 && Math.abs(mesh.zMax - 0) < 1e-3, `zMin/zMax = ${mesh.zMin}/${mesh.zMax}`);
  assert.equal(mesh.floorZ, -15, '底面拉到素材底 Z');
  assert.deepEqual(windingReport(mesh), [], '真實資料也要每片都朝外');
  assert.deepEqual(verticalityReport(mesh), [], '真實資料的孔壁／側銑面必須是垂直牆');
  // 頂面高度必須落在 heightmap 的值上（沒有被平滑掉）
  const zs = new Set();
  for (let q = 0; q < mesh.counts.topQuads; q++) zs.add(Math.round(mesh.positions[q * 4 * 3 + 2] * 1000) / 1000);
  assert.ok(zs.has(0) && zs.has(-10), `頂面 Z 應含 0 與 -10，實際 ${[...zs].sort((a, b) => b - a).slice(0, 8)}`);
});

test('真實資料：fit 用的包絡不會被高處的 G0 撐爆', { skip: skipReal }, () => {
  const b = V.sceneBounds({ sim: realSim, stock: REAL.stock, segments: REAL.segments });
  const rapidTop = Math.max(...REAL.segments.filter((s) => s.kind === 'rapid' && !s.refReturn).map((s) => Math.max(s.from.z, s.to.z)));
  assert.ok(rapidTop >= 150, `這支程式本來就有 G0 到 Z${rapidTop}，測試才有意義`);
  assert.ok(b.max.z <= 12, `Z 上限 ${b.max.z} 應該貼著工件（≤ 12），不是 rapid 的 ${rapidTop}`);
  assert.equal(b.min.z, -15);
  assert.ok(b.max.z - b.min.z < (b.max.x - b.min.x), 'Z 跨距不該比 X 跨距還大，否則 fit 會把工件縮成一條線');
});

test('真實資料 樣本 C：路徑線含補正段，programmed 會被淡化', { skip: skipReal }, () => {
  const r = V.buildPathLines(REAL.segments);
  assert.ok(r.compLines.size >= 20, `應該有補正段（實際 ${r.compLines.size} 行）`);
  assert.ok(r.ranges.some((x) => x.faded), '同一行的 programmed 段要能被分出來淡化');
  assert.ok(r.vertexCount > 400, `路徑頂點 ${r.vertexCount}`);
  // 每個 segRange 都要對得回原本的段
  assert.equal(r.segRanges.length, REAL.segments.length);
  for (const rec of r.segRanges) assert.ok(rec.count >= 2 && rec.first + rec.count <= r.vertexCount);
});

// ---------------------------------------------------------------------------
// 圓柱成品網格（第四軸）
// ---------------------------------------------------------------------------
function fakeCylSim(radius = 20, nx = 5, ny = 16) {
  const circumference = 2 * Math.PI * radius;
  return {
    cylinder: true, nx, ny,
    cellX: 1, cellY: circumference / ny, circumference,
    origin: { x: 0, y: 0 },
    radius, center: { y: 0, z: 0 },
    height: new Float32Array(nx * ny).fill(radius),
    floorZ: 0, topZ: radius,
  };
}

test('buildCylinderMesh：頂點落在圓柱面上，周向接得起來', () => {
  const V3 = NC.ui.view3d;
  const sim = fakeCylSim(20, 5, 16);
  const m = V3.buildCylinderMesh(sim);
  assert.equal(m.cylinder, true);
  // 側面 + 兩個端面（圓心 + 一圈）
  assert.equal(m.counts.vertices, 5 * 16 + (16 + 1) * 2);
  // 每個側面頂點離軸心都是 radius
  for (let i = 0; i < 5 * 16; i++) {
    const y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
    assert.ok(Math.abs(Math.hypot(y, z) - 20) < 1e-4, `頂點 ${i} 不在圓柱面上`);
  }
  // 索引都在範圍內
  for (let i = 0; i < m.indices.length; i++) assert.ok(m.indices[i] < m.counts.vertices);
});

test('buildCylinderMesh：挖過的格子半徑變小，法線跟著轉', () => {
  const sim = fakeCylSim(20, 5, 16);
  sim.height[3 * 5 + 2] = 12;   // 第 3 圈第 2 格挖到剩 12
  const m = NC.ui.view3d.buildCylinderMesh(sim);
  const i = 3 * 5 + 2;
  const y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
  assert.ok(Math.abs(Math.hypot(y, z) - 12) < 1e-4, '挖過的頂點應該離軸心 12');
  // 法線是單位向量
  const n = Math.hypot(m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]);
  assert.ok(Math.abs(n - 1) < 1e-5);
});

test('buildCylinderMesh：downsample 會減少頂點數', () => {
  const sim = fakeCylSim(20, 9, 32);
  const full = NC.ui.view3d.buildCylinderMesh(sim);
  const half = NC.ui.view3d.buildCylinderMesh(sim, { downsample: 2 });
  assert.ok(half.counts.vertices < full.counts.vertices);
  assert.equal(half.downsample, 2);
});

test('buildCylinderMesh：所有三角形都朝外（背面剔除才不會看穿）', () => {
  // 未加工的圓柱是凸體：每個三角形的法線與「重心 → 物體中心」的反方向點積都該 > 0。
  // 端面繞向寫反的話這條會抓到——症狀是從某些角度直接看穿進圓棒內部。
  const sim = fakeCylSim(20, 7, 24);
  const m = NC.ui.view3d.buildCylinderMesh(sim);
  const P = m.positions;
  const cx = (sim.origin.x + (sim.nx - 1) * sim.cellX) / 2;
  let bad = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;   // 退化三角形（挖到軸心）不算
    const gx = (P[a] + P[b] + P[c]) / 3 - cx;
    const gy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    const gz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    if (nx * gx + ny * gy + nz * gz <= 0) bad++;
  }
  assert.equal(bad, 0, `${bad} 個三角形朝內`);
});

test('buildCylinderMesh：兩端封口的法線分別朝 ∓X', () => {
  const sim = fakeCylSim(20, 5, 16);
  const m = NC.ui.view3d.buildCylinderMesh(sim);
  const side = sim.nx * 16;          // 側面頂點數（downsample 1 時 ny 不變）
  const capA = side, capB = side + 17;
  assert.equal(m.normals[capA * 3], -1, 'xMin 端法線朝 -X');
  assert.equal(m.normals[capB * 3], 1, 'xMax 端法線朝 +X');
});

// ---------------------------------------------------------------------------
// 剖面：3D 上的那片平面 + 剖切
// ---------------------------------------------------------------------------
const BOUNDS = { min: { x: -10, y: -20, z: -5 }, max: { x: 30, y: 20, z: 0 } };

test('buildSectionPlane：整片頂點都落在剖面上，外框是四條線', () => {
  const p = V.buildSectionPlane(BOUNDS, 'x', 12);
  assert.equal(p.fill.vertexCount, 6, '兩個三角形');
  assert.equal(p.edge.vertexCount, 8, '四條線 = 八個頂點');
  for (let i = 0; i < p.fill.vertexCount; i++) assert.equal(p.fill.positions[i * 3], 12, 'X 全部等於剖面位置');
  for (let i = 0; i < p.edge.vertexCount; i++) assert.equal(p.edge.positions[i * 3], 12);
  // 平面要比工件大一點，不然貼齊邊緣看不出那是一個面
  let maxY = -Infinity;
  for (let i = 0; i < p.fill.vertexCount; i++) maxY = Math.max(maxY, p.fill.positions[i * 3 + 1]);
  assert.ok(maxY > BOUNDS.max.y, '往外放一點');

  const q = V.buildSectionPlane(BOUNDS, 'y', -3);
  for (let i = 0; i < q.fill.vertexCount; i++) assert.equal(q.fill.positions[i * 3 + 1], -3, 'Y 全部等於剖面位置');
});

test('buildSectionPlane：軸或位置不合法回 null', () => {
  assert.equal(V.buildSectionPlane(BOUNDS, 'z', 0), null);
  assert.equal(V.buildSectionPlane(BOUNDS, 'x', NaN), null);
  assert.equal(V.buildSectionPlane(null, 'x', 0), null);
});

test('clipPlaneFor：切掉的永遠是相機那一側，斷面才看得到', () => {
  // 相機在 +X 側 → 丟掉 x > value
  const a = V.clipPlaneFor('x', 5, [100, 0, 0]);
  assert.deepEqual(a, [1, 0, 0, 5]);
  assert.ok(6 * a[0] > a[3], 'x=6（相機側）被丟掉');
  assert.ok(!(4 * a[0] > a[3]), 'x=4 留著');
  // 相機在 -X 側 → 反過來
  const b = V.clipPlaneFor('x', 5, [-100, 0, 0]);
  assert.deepEqual(b, [-1, 0, 0, -5]);
  assert.ok(4 * b[0] > b[3], 'x=4（這時候才是相機側）被丟掉');
  assert.ok(!(6 * b[0] > b[3]), 'x=6 留著');
  // Y 軸同理
  assert.deepEqual(V.clipPlaneFor('y', -2, [0, 50, 0]), [0, 1, 0, -2]);
  assert.equal(V.clipPlaneFor('z', 0, [0, 0, 1]), null);
});
