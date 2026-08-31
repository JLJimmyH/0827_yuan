/*
 * NC 預演台 — 3D 成品視圖（原生 WebGL1，帶 WebGL2 偵測；不使用任何外部函式庫）。
 *
 *   NC.ui.createView3D(canvas, options?) → View3D | null   （建立失敗回 null，呼叫端可退回 2D）
 *   NC.ui.view3d.isSupported()                             → 這個環境能不能開 WebGL
 *   NC.ui.view3d.buildMesh(sim, opts) → {positions, normals, indices, counts, …}   純函式、不碰 WebGL
 *
 * 成品實體：把 SimResult 的 heightmap 轉成「階梯式」三角網格 —— 每個格點 (ix,iy) 攤成一個
 * cell×cell 的水平頂面方塊（中心在 origin + (ix·cell, iy·cell)，與 simulation.js 的節點式格網一致），
 * 相鄰格高度不同時在兩塊交界處補一片**完全垂直**的裙邊（skirt），所以口袋壁是垂直牆不是斜坡。
 * 外圈再從邊界格拉到 floorZ 當外壁，底部補一片底面，看起來就是一塊實體方料。
 *
 * 路徑：Segment[] 以 GL_LINES 畫，圓弧細分；rapid 細灰線、feed/arc/drill 依刀具著色
 *      （色表與 view2d.js 相同，刻意複製常數而不是 import）。
 * 素材：Stock 線框方塊（切成短線段做出虛線感）。座標：原點 XYZ 三軸小箭頭（紅綠藍）。
 *
 * 互動：左鍵拖曳＝軌道旋轉、滾輪＝縮放、右鍵／中鍵拖曳＝平移、雙擊＝fit()、
 *      觸控單指旋轉／雙指縮放平移；prefers-reduced-motion 時不做慣性。
 *
 * Node 下（沒有 document）只掛純函式，不會碰到任何 DOM。
 */
(function (NC) {
  'use strict';
  NC.ui = NC.ui || {};

  const util = NC.util || {};
  const clamp = util.clamp || ((v, lo, hi) => Math.min(hi, Math.max(lo, v)));
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;

  // ---------------------------------------------------------------------------
  // 色彩常數（與 js/ui/view2d.js 一致；依契約複製常數，不做跨模組 import）
  // ---------------------------------------------------------------------------
  const TOOL_COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#e377c2', '#8c564b', '#bcbd22', '#0b8f8f', '#c05a00', '#5b3fd6'];
  const TOP_RGB = [222, 216, 206];       // 頂面暖灰（與 view2d.js 一致；要和背景 #fbfbfb 分得開）
  const DEEP_RGB = [14, 34, 104];        // 深處深藍
  const FIXTURE_RGB = [196, 160, 120];   // 治具土黃（3D 只用在色階上限之上）
  const CUT_RGB = [188, 178, 164];       // 剖開之後看到的斷面（背面）色：一塊實心的料，不是被光打反的殼
  const C = {
    bg: '#fbfbfb',
    rapid: '#9a9a9a',
    highlight: '#ff2d55',
    stockLine: '#4a4a4a',
    section: '#ff9500',   // 剖面平面（與 view2d 的剖面指示線同色）
    axisX: '#d62728',
    axisY: '#2ca02c',
    axisZ: '#1f77b4',
  };
  const PICK_PX = 6;      // 點選距離門檻（CSS px）
  const DRAG_PX = 3;      // 超過此位移視為拖曳而非點擊
  const ARC_TOL = 0.05;   // 圓弧細分弦差 mm（與 geometry.sampleSegment 預設一致）
  const DEFAULT_MAX_VERTICES = 4000000;
  const MAX_TOP_SLOPE = 0.6;   // 頂面法線梯度上限（避免階梯處法線爆掉）
  // 仰角上下限。四軸的工件是一根躺著的圓棒，孔分佈在整個圓周上——把仰角卡在 −5° 會讓
  // 下半圈永遠是死角（現場回報「有 A 軸的物件看了會有死角」）。放到 ±89°：正上方與正下方
  // 都看得到，只留最後 1° 不給，因為 up 向量（0,0,1）在正負 90° 剛好退化、lookAt 會算不出來。
  const EL_MIN = -89 * DEG, EL_MAX = 89 * DEG;
  // 剖切預設切掉哪一側（+1 = 丟掉座標大的那半邊）。挑的是預設相機（az −60°、el 28°，
  // 眼睛在 +X／−Y 側）看得到斷面的那一邊：剖面 X 丟 +X、剖面 Y 丟 −Y。
  // **這是固定值，不跟相機也不跟滑桿走**——見 clipPlaneFor 的說明。
  const CLIP_SIGN = { x: 1, y: -1 };

  function hexRgb(hex) {
    const s = String(hex).replace('#', '');
    const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  /** 刀具色：T 號 12 色循環；null → 灰藍（與 view2d.toolColor 相同） */
  function toolColor(t) {
    if (t == null || !Number.isFinite(t)) return '#607d8b';
    const i = (((Math.round(t) - 1) % TOOL_COLORS.length) + TOOL_COLORS.length) % TOOL_COLORS.length;
    return TOOL_COLORS[i];
  }

  // ---------------------------------------------------------------------------
  // 純數學：4×4 矩陣（column-major，與 WebGL 相同）
  // ---------------------------------------------------------------------------
  function mat4() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
  function mat4Mul(out, a, b) {   // out = a · b
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
  }
  function mat4Perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect; out[5] = f; out[11] = -1;
    out[10] = (far + near) / (near - far);
    out[14] = (2 * far * near) / (near - far);
    return out;
  }
  function normalize3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function mat4LookAt(out, eye, center, up) {
    const f = normalize3([center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]]);
    let s = cross3(f, up);
    if (Math.hypot(s[0], s[1], s[2]) < 1e-9) s = cross3(f, [0, 1, 0]);
    s = normalize3(s);
    const u = cross3(s, f);
    out[0] = s[0]; out[4] = s[1]; out[8] = s[2]; out[12] = -dot3(s, eye);
    out[1] = u[0]; out[5] = u[1]; out[9] = u[2]; out[13] = -dot3(u, eye);
    out[2] = -f[0]; out[6] = -f[1]; out[10] = -f[2]; out[14] = dot3(f, eye);
    out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1;
    return out;
  }
  /** 世界點 → 畫面 CSS px；回傳 null 表示在相機後方 */
  function projectPoint(m, x, y, z, w, h) {
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(cw > 1e-8)) return null;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    return { x: (cx / cw * 0.5 + 0.5) * w, y: (0.5 - cy / cw * 0.5) * h, z: cz / cw };
  }
  function distPointSeg2D(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = 0;
    if (l2 > 1e-18) t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }

  // ---------------------------------------------------------------------------
  // 純函式：heightmap → 三角網格
  // ---------------------------------------------------------------------------
  /** 依 maxVertices 自動決定降採樣倍率（1/2/4/8/16） */
  function resolveDownsample(sim, opts) {
    let k = opts && opts.downsample;
    if (k != null && k !== 'auto' && k >= 1) return Math.max(1, Math.round(k));
    const maxV = (opts && opts.maxVertices > 0) ? opts.maxVertices : DEFAULT_MAX_VERTICES;
    k = 1;
    while (k < 16 && 4 * dsDim(sim.nx, k) * dsDim(sim.ny, k) > maxV) k *= 2;
    return k;
  }
  function dsDim(n, k) { return Math.floor((n - 1) / k) + 1; }

  /**
   * 降採樣格點高度。mode：'min'（預設，保住口袋深度）／'max'／'sample'（最近取樣）。
   * k = 1 時直接沿用原陣列（不複製）。
   */
  const MAX_SHEETS = 6;      // 圓棒網格的層數上限（每格最多 3 段材料 → 6 個端點）

  function downsampleHeights(heightArr, nx0, ny0, k, mode) {
    if (!(k > 1)) return { z: heightArr, nx: nx0, ny: ny0 };
    const nx = dsDim(nx0, k), ny = dsDim(ny0, k);
    const z = new Float32Array(nx * ny);
    for (let iy = 0; iy < ny; iy++) {
      const sy = iy * k, ey = Math.min(sy + k, ny0);
      for (let ix = 0; ix < nx; ix++) {
        const sx = ix * k, ex = Math.min(sx + k, nx0);
        if (mode === 'sample') { z[iy * nx + ix] = heightArr[sy * nx0 + sx]; continue; }
        let v = mode === 'max' ? -Infinity : Infinity;
        for (let jy = sy; jy < ey; jy++) {
          const r = jy * nx0;
          for (let jx = sx; jx < ex; jx++) {
            const hv = heightArr[r + jx];
            if (mode === 'max') { if (hv > v) v = hv; } else if (hv < v) v = hv;
          }
        }
        z[iy * nx + ix] = v;
      }
    }
    return { z, nx, ny };
  }

  /** 頂面法線：用相鄰高度差算梯度；碰到階梯（差 > step）就改用另一側的單邊差 */
  function topNormal(M, ix, iy, out) {
    const zs = M.zs, nx = M.nx, ny = M.ny, cell = M.cell, step = M.step;
    const i = iy * nx + ix, zc = zs[i];
    let dl = null, dr = null, db = null, dt = null, g;
    if (ix > 0) { const d = zc - zs[i - 1]; if (Math.abs(d) <= step) dl = d; }
    if (ix < nx - 1) { const d = zs[i + 1] - zc; if (Math.abs(d) <= step) dr = d; }
    if (iy > 0) { const d = zc - zs[i - nx]; if (Math.abs(d) <= step) db = d; }
    if (iy < ny - 1) { const d = zs[i + nx] - zc; if (Math.abs(d) <= step) dt = d; }
    if (dl !== null && dr !== null) g = (dl + dr) / (2 * cell);
    else if (dl !== null) g = dl / cell;
    else if (dr !== null) g = dr / cell;
    else g = 0;
    const gx = clamp(g, -MAX_TOP_SLOPE, MAX_TOP_SLOPE);
    if (db !== null && dt !== null) g = (db + dt) / (2 * cell);
    else if (db !== null) g = db / cell;
    else if (dt !== null) g = dt / cell;
    else g = 0;
    const gy = clamp(g, -MAX_TOP_SLOPE, MAX_TOP_SLOPE);
    const len = Math.sqrt(gx * gx + gy * gy + 1);
    out[0] = -gx / len; out[1] = -gy / len; out[2] = 1 / len;
  }

  function quad(M, qi, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nxv, nyv, nzv) {
    const P = M.P, N = M.N, o = qi * 12;
    P[o] = ax; P[o + 1] = ay; P[o + 2] = az;
    P[o + 3] = bx; P[o + 4] = by; P[o + 5] = bz;
    P[o + 6] = cx; P[o + 7] = cy; P[o + 8] = cz;
    P[o + 9] = dx; P[o + 10] = dy; P[o + 11] = dz;
    for (let j = 0; j < 4; j++) { const p = o + j * 3; N[p] = nxv; N[p + 1] = nyv; N[p + 2] = nzv; }
  }

  /** 頂面方塊（水平），中心 (ox+ix·cell, oy+iy·cell)，邊長 cell */
  function writeTop(M, qi, ix, iy) {
    const h = M.h2, z = M.zs[iy * M.nx + ix];
    const x = M.ox + ix * M.cell, y = M.oy + iy * M.cell;
    const P = M.P, N = M.N, o = qi * 12;
    P[o] = x - h; P[o + 1] = y - h; P[o + 2] = z;
    P[o + 3] = x + h; P[o + 4] = y - h; P[o + 5] = z;
    P[o + 6] = x + h; P[o + 7] = y + h; P[o + 8] = z;
    P[o + 9] = x - h; P[o + 10] = y + h; P[o + 11] = z;
    topNormal(M, ix, iy, M.tmp);
    const a = M.tmp[0], b = M.tmp[1], c = M.tmp[2];
    for (let j = 0; j < 4; j++) { const p = o + j * 3; N[p] = a; N[p + 1] = b; N[p + 2] = c; }
  }
  /** X 向裙邊：格 (ix,iy) 與 (ix+1,iy) 之間的垂直牆，法線 ±X */
  function writeSkirtX(M, qi, ix, iy) {
    const i = iy * M.nx + ix, h = M.h2;
    const z0 = M.zs[i], z1 = M.zs[i + 1];
    const xe = M.ox + ix * M.cell + h, y = M.oy + iy * M.cell;
    if (z0 > z1) quad(M, qi, xe, y - h, z1, xe, y + h, z1, xe, y + h, z0, xe, y - h, z0, 1, 0, 0);
    else quad(M, qi, xe, y - h, z0, xe, y - h, z1, xe, y + h, z1, xe, y + h, z0, -1, 0, 0);
  }
  /** Y 向裙邊：格 (ix,iy) 與 (ix,iy+1) 之間的垂直牆，法線 ±Y */
  function writeSkirtY(M, qi, ix, iy) {
    const nx = M.nx, i = iy * nx + ix, h = M.h2;
    const z0 = M.zs[i], z1 = M.zs[i + nx];
    const x = M.ox + ix * M.cell, ye = M.oy + iy * M.cell + h;
    if (z0 > z1) quad(M, qi, x + h, ye, z1, x - h, ye, z1, x - h, ye, z0, x + h, ye, z0, 0, 1, 0);
    else quad(M, qi, x - h, ye, z0, x + h, ye, z0, x + h, ye, z1, x - h, ye, z1, 0, -1, 0);
  }
  /** 外壁：side 0=-X 1=+X 2=-Y 3=+Y，從格高拉到 floorZ */
  function writeWall(M, qi, side, ix, iy) {
    const h = M.h2, f = M.floorZ, z = M.zs[iy * M.nx + ix];
    const x = M.ox + ix * M.cell, y = M.oy + iy * M.cell;
    if (side === 0) { const w = x - h; quad(M, qi, w, y - h, f, w, y - h, z, w, y + h, z, w, y + h, f, -1, 0, 0); }
    else if (side === 1) { const w = x + h; quad(M, qi, w, y - h, f, w, y + h, f, w, y + h, z, w, y - h, z, 1, 0, 0); }
    else if (side === 2) { const w = y - h; quad(M, qi, x - h, w, f, x + h, w, f, x + h, w, z, x - h, w, z, 0, -1, 0); }
    else { const w = y + h; quad(M, qi, x + h, w, f, x - h, w, f, x - h, w, z, x + h, w, z, 0, 1, 0); }
  }
  /** 底面（一片，覆蓋本區塊的 Y 範圍） */
  function writeBottom(M, qi, y0, y1) {
    const h = M.h2, f = M.floorZ;
    const x0 = M.ox - h, x1 = M.ox + (M.nx - 1) * M.cell + h;
    const ya = M.oy + y0 * M.cell - h, yb = M.oy + (y1 - 1) * M.cell + h;
    quad(M, qi, x0, ya, f, x0, yb, f, x1, yb, f, x1, ya, f, 0, 0, -1);
  }

  /**
   * heightmap → 三角網格（純函式，不碰 WebGL）。
   * @param {Object} sim  SimResult（需要 nx, ny, cell, origin, height, floorZ）
   * @param {Object} [opts]
   *   height       {Float32Array} 改用這份高度（例如 snapshot），預設 sim.height
   *   downsample   {number|'auto'} 降採樣倍率，預設依 maxVertices 自動
   *   maxVertices  {number} 自動降採樣門檻（預設 400 萬）
   *   reduce       {'min'|'max'|'sample'} 降採樣取值方式，預設 'min'
   *   step         {number} 視為「階梯」的高度差門檻（預設 = cell）
   *   sides        {boolean} 是否產生外壁與底面（預設 true）
   *   y0,y1        {number} 只建這個 Y 區間的列（分塊用；索引為降採樣後）
   *   uint16       {boolean} 索引盡量用 Uint16Array（不夠用時自動退回 Uint32Array）
   *   _pre         {Object} 已降採樣好的 {z,nx,ny}，避免重複計算
   * @returns {{positions:Float32Array, normals:Float32Array, indices:Uint32Array|Uint16Array, counts:Object}|null}
   */
  function buildMesh(sim, opts) {
    opts = opts || {};
    if (!sim || !(sim.nx > 0) || !(sim.ny > 0) || !sim.height) return null;
    const heightArr = opts.height || sim.height;
    const k = resolveDownsample(sim, opts);
    const reduce = opts.reduce || 'min';
    const ds = opts._pre || downsampleHeights(heightArr, sim.nx, sim.ny, k, reduce);
    const zs = ds.z, nx = ds.nx, ny = ds.ny;
    const cell = sim.cell * k;
    const ox = sim.origin ? sim.origin.x : 0, oy = sim.origin ? sim.origin.y : 0;

    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < zs.length; i++) { const v = zs[i]; if (v < zMin) zMin = v; if (v > zMax) zMax = v; }
    if (!Number.isFinite(zMin)) { zMin = 0; zMax = 0; }
    let floorZ = Number.isFinite(opts.floorZ) ? opts.floorZ : (Number.isFinite(sim.floorZ) ? sim.floorZ : zMin - 1);
    if (floorZ > zMin) floorZ = zMin;

    const step = Number.isFinite(opts.step) ? opts.step : cell;
    const eps = Math.max(cell * 0.02, 1e-4);
    const y0 = clamp(Math.round(opts.y0 != null ? opts.y0 : 0), 0, ny);
    const y1 = clamp(Math.round(opts.y1 != null ? opts.y1 : ny), y0, ny);
    const sides = opts.sides !== false;
    const rows = y1 - y0;

    // ---- 計數（先算好才能一次配置 typed array）----
    let topQuads = rows * nx, skirtQuads = 0;
    for (let iy = y0; iy < y1; iy++) {
      const r = iy * nx;
      for (let ix = 0; ix < nx - 1; ix++) if (Math.abs(zs[r + ix + 1] - zs[r + ix]) > eps) skirtQuads++;
    }
    const yEnd = Math.min(y1, ny - 1);
    for (let iy = y0; iy < yEnd; iy++) {
      const r = iy * nx;
      for (let ix = 0; ix < nx; ix++) if (Math.abs(zs[r + nx + ix] - zs[r + ix]) > eps) skirtQuads++;
    }
    let wallQuads = 0, bottomQuads = 0;
    if (sides) {
      wallQuads = rows * 2 + (y0 === 0 ? nx : 0) + (y1 === ny ? nx : 0);
      bottomQuads = rows > 0 ? 1 : 0;
    }
    const quads = topQuads + skirtQuads + wallQuads + bottomQuads;
    const verts = quads * 4;

    const M = {
      P: new Float32Array(verts * 3), N: new Float32Array(verts * 3),
      zs, nx, ny, cell, h2: cell / 2, ox, oy, floorZ, step, tmp: [0, 0, 1],
    };
    const useU16 = opts.uint16 === true && verts <= 65536;
    const I = useU16 ? new Uint16Array(quads * 6) : new Uint32Array(quads * 6);
    const skirtSrc = new Int32Array(skirtQuads);   // 值 = 格索引*2 + 方向（0=X, 1=Y）
    const wallSrc = new Int32Array(wallQuads);     // 值 = 格索引*4 + side
    const edgeX = new Uint8Array(nx * ny), edgeY = new Uint8Array(nx * ny);

    // ---- 寫入 ----
    let q = 0;
    for (let iy = y0; iy < y1; iy++) for (let ix = 0; ix < nx; ix++) writeTop(M, q++, ix, iy);
    let s = 0;
    for (let iy = y0; iy < y1; iy++) {
      const r = iy * nx;
      for (let ix = 0; ix < nx - 1; ix++) {
        if (Math.abs(zs[r + ix + 1] - zs[r + ix]) <= eps) continue;
        edgeX[r + ix] = 1; skirtSrc[s++] = (r + ix) * 2;
        writeSkirtX(M, q++, ix, iy);
      }
    }
    for (let iy = y0; iy < yEnd; iy++) {
      const r = iy * nx;
      for (let ix = 0; ix < nx; ix++) {
        if (Math.abs(zs[r + nx + ix] - zs[r + ix]) <= eps) continue;
        edgeY[r + ix] = 1; skirtSrc[s++] = (r + ix) * 2 + 1;
        writeSkirtY(M, q++, ix, iy);
      }
    }
    let w = 0;
    if (sides) {
      for (let iy = y0; iy < y1; iy++) { wallSrc[w++] = (iy * nx) * 4 + 0; writeWall(M, q++, 0, 0, iy); }
      for (let iy = y0; iy < y1; iy++) { wallSrc[w++] = (iy * nx + nx - 1) * 4 + 1; writeWall(M, q++, 1, nx - 1, iy); }
      if (y0 === 0) for (let ix = 0; ix < nx; ix++) { wallSrc[w++] = ix * 4 + 2; writeWall(M, q++, 2, ix, 0); }
      if (y1 === ny) for (let ix = 0; ix < nx; ix++) { wallSrc[w++] = ((ny - 1) * nx + ix) * 4 + 3; writeWall(M, q++, 3, ix, ny - 1); }
      if (bottomQuads) writeBottom(M, q++, y0, y1);
    }
    for (let i = 0; i < quads; i++) {
      const b = i * 4, o = i * 6;
      I[o] = b; I[o + 1] = b + 1; I[o + 2] = b + 2;
      I[o + 3] = b; I[o + 4] = b + 2; I[o + 5] = b + 3;
    }

    return {
      positions: M.P, normals: M.N, indices: I,
      counts: {
        vertices: verts, indices: quads * 6, triangles: quads * 2, quads,
        topQuads, skirtQuads, wallQuads, bottomQuads,
        nx, ny, cell, downsample: k, step, y0, y1, uint16: useU16,
      },
      nx, ny, cell, origin: { x: ox, y: oy }, floorZ, zMin, zMax, downsample: k,
      bounds: {
        min: { x: ox - M.h2, y: oy + y0 * cell - M.h2, z: floorZ },
        max: { x: ox + (nx - 1) * cell + M.h2, y: oy + (y1 - 1) * cell + M.h2, z: zMax },
      },
      _src: { skirtSrc, wallSrc, edgeX, edgeY, y0, y1, eps, step, reduce, k, srcNx: sim.nx, srcNy: sim.ny, topQuads, skirtQuads, wallQuads, bottomQuads, sides },
    };
  }

  /** 新的高度陣列能不能用「只改 Z」的快路徑更新（不重建 index buffer） */
  function canUpdateHeights(mesh, heightArr) {
    const s = mesh && mesh._src;
    if (!s) return false;
    const ds = downsampleHeights(heightArr, s.srcNx, s.srcNy, s.k, s.reduce);
    if (ds.nx !== mesh.nx || ds.ny !== mesh.ny) return false;
    return checkEdges(mesh, ds.z) ? ds : false;
  }
  function checkEdges(mesh, zs) {
    const s = mesh._src, nx = mesh.nx, ny = mesh.ny, eps = s.eps;
    for (let iy = s.y0; iy < s.y1; iy++) {
      const r = iy * nx;
      for (let ix = 0; ix < nx - 1; ix++) if (Math.abs(zs[r + ix + 1] - zs[r + ix]) > eps && !s.edgeX[r + ix]) return false;
    }
    const yEnd = Math.min(s.y1, ny - 1);
    for (let iy = s.y0; iy < yEnd; iy++) {
      const r = iy * nx;
      for (let ix = 0; ix < nx; ix++) if (Math.abs(zs[r + nx + ix] - zs[r + ix]) > eps && !s.edgeY[r + ix]) return false;
    }
    return true;
  }
  /**
   * 只更新頂點 Z 與法線（index buffer 原封不動）。
   * 新高度需要的裙邊若超出既有配置 → 回傳 false，呼叫端改走重建。
   * @returns {boolean}
   */
  function updateHeights(mesh, heightArr, opts) {
    const s = mesh && mesh._src;
    if (!s) return false;
    const ds = (opts && opts._pre) || downsampleHeights(heightArr, s.srcNx, s.srcNy, s.k, s.reduce);
    if (ds.nx !== mesh.nx || ds.ny !== mesh.ny) return false;
    if (!(opts && opts.force) && !checkEdges(mesh, ds.z)) return false;
    const zs = ds.z, nx = mesh.nx;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < zs.length; i++) { const v = zs[i]; if (v < zMin) zMin = v; if (v > zMax) zMax = v; }
    const floorZ = Math.min(mesh.floorZ, zMin);
    const M = {
      P: mesh.positions, N: mesh.normals, zs, nx, ny: mesh.ny, cell: mesh.cell,
      h2: mesh.cell / 2, ox: mesh.origin.x, oy: mesh.origin.y, floorZ, step: s.step, tmp: [0, 0, 1],
    };
    let q = 0;
    for (let iy = s.y0; iy < s.y1; iy++) for (let ix = 0; ix < nx; ix++) writeTop(M, q++, ix, iy);
    for (let i = 0; i < s.skirtSrc.length; i++) {
      const v = s.skirtSrc[i], cellIdx = v >> 1, ix = cellIdx % nx, iy = (cellIdx - ix) / nx;
      if (v & 1) writeSkirtY(M, q++, ix, iy); else writeSkirtX(M, q++, ix, iy);
    }
    for (let i = 0; i < s.wallSrc.length; i++) {
      const v = s.wallSrc[i], side = v & 3, cellIdx = v >> 2, ix = cellIdx % nx, iy = (cellIdx - ix) / nx;
      writeWall(M, q++, side, ix, iy);
    }
    if (s.bottomQuads) writeBottom(M, q++, s.y0, s.y1);
    mesh.zMin = zMin; mesh.zMax = zMax; mesh.floorZ = floorZ;
    mesh.bounds.min.z = floorZ; mesh.bounds.max.z = zMax;
    return true;
  }

  /** 分塊計畫：每列的四邊形數（精準），再打包成頂點數不超過 maxVertsPerChunk 的區塊 */
  function planChunks(sim, opts) {
    opts = opts || {};
    const k = resolveDownsample(sim, opts);
    const heightArr = opts.height || sim.height;
    const pre = downsampleHeights(heightArr, sim.nx, sim.ny, k, opts.reduce || 'min');
    const zs = pre.z, nx = pre.nx, ny = pre.ny;
    const cell = sim.cell * k;
    const eps = Math.max(cell * 0.02, 1e-4);
    const sides = opts.sides !== false;
    const rowQuads = new Int32Array(ny);
    for (let iy = 0; iy < ny; iy++) {
      const r = iy * nx;
      let n = nx + (sides ? 2 : 0);
      for (let ix = 0; ix < nx - 1; ix++) if (Math.abs(zs[r + ix + 1] - zs[r + ix]) > eps) n++;
      if (iy < ny - 1) for (let ix = 0; ix < nx; ix++) if (Math.abs(zs[r + nx + ix] - zs[r + ix]) > eps) n++;
      if (sides && (iy === 0 || iy === ny - 1)) n += nx;
      rowQuads[iy] = n;
    }
    const cap = Math.max(4096, (opts.maxVertsPerChunk > 0 ? opts.maxVertsPerChunk : 400000));
    const bands = [];
    let start = 0, acc = sides ? 4 : 0;
    for (let iy = 0; iy < ny; iy++) {
      const add = rowQuads[iy] * 4;
      if (iy > start && acc + add > cap) { bands.push([start, iy]); start = iy; acc = sides ? 4 : 0; }
      acc += add;
    }
    if (start < ny) bands.push([start, ny]);
    if (!bands.length) bands.push([0, ny]);
    return { k, nx, ny, cell, bands, pre };
  }

  /**
   * 非同步分批建網格（每 ~16 ms 讓出一次），大檔不會卡住畫面。
   * @returns {Promise<{chunks:Array, counts:Object, downsample:number}|null>}  被取消時回 null
   */
  async function buildMeshAsync(sim, opts) {
    opts = opts || {};
    if (!sim || !(sim.nx > 0) || !(sim.ny > 0)) return null;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const cancelled = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : () => false;
    const yieldMs = opts.yieldEveryMs > 0 ? opts.yieldEveryMs : 16;
    const plan = planChunks(sim, opts);
    const chunks = [];
    const counts = { vertices: 0, indices: 0, triangles: 0, topQuads: 0, skirtQuads: 0, wallQuads: 0, bottomQuads: 0, chunks: 0 };
    let t = Date.now();
    if (onProgress) onProgress(0);
    for (let i = 0; i < plan.bands.length; i++) {
      if (cancelled()) return null;
      const b = plan.bands[i];
      const sub = buildMesh(sim, Object.assign({}, opts, { downsample: plan.k, y0: b[0], y1: b[1], _pre: plan.pre }));
      if (sub) {
        chunks.push(sub);
        counts.vertices += sub.counts.vertices; counts.indices += sub.counts.indices; counts.triangles += sub.counts.triangles;
        counts.topQuads += sub.counts.topQuads; counts.skirtQuads += sub.counts.skirtQuads;
        counts.wallQuads += sub.counts.wallQuads; counts.bottomQuads += sub.counts.bottomQuads;
      }
      if (Date.now() - t >= yieldMs || i === plan.bands.length - 1) {
        if (onProgress) onProgress((i + 1) / plan.bands.length);
        await new Promise((r) => setTimeout(r, 0));
        t = Date.now();
      }
    }
    counts.chunks = chunks.length;
    let zMin = Infinity, zMax = -Infinity;
    for (const c of chunks) { if (c.zMin < zMin) zMin = c.zMin; if (c.zMax > zMax) zMax = c.zMax; }
    return { chunks, counts, downsample: plan.k, zMin, zMax, cell: plan.cell, nx: plan.nx, ny: plan.ny };
  }

  // ---------------------------------------------------------------------------
  // 純函式：路徑線段 → GL_LINES 頂點
  // ---------------------------------------------------------------------------
  function normAngle(a) { a %= TAU; if (a < 0) a += TAU; return a; }
  /** 圓弧細分點數（弦差 tol） */
  function arcSteps(seg, tol) {
    const r = seg.arc.r;
    if (!(r > 1e-9)) return 1;
    const a0 = Math.atan2(seg.from.y - seg.arc.center.y, seg.from.x - seg.arc.center.x);
    const a1 = Math.atan2(seg.to.y - seg.arc.center.y, seg.to.x - seg.arc.center.x);
    let sweep = seg.arc.cw ? normAngle(a0 - a1) : normAngle(a1 - a0);
    if (sweep < 1e-9 && Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) < 1e-6) sweep = TAU;
    const dth = 2 * Math.acos(clamp(1 - Math.min(tol, r * 0.5) / r, -1, 1));
    return Math.max(1, Math.min(720, Math.ceil(sweep / Math.max(dth, 1e-3))));
  }
  /** 圓弧取樣（含 Z 線性內插，支援螺旋） */
  function arcPoints(seg, n, out) {
    const c = seg.arc.center, r = seg.arc.r;
    const a0 = Math.atan2(seg.from.y - c.y, seg.from.x - c.x);
    const a1 = Math.atan2(seg.to.y - c.y, seg.to.x - c.x);
    let sweep = seg.arc.cw ? -normAngle(a0 - a1) : normAngle(a1 - a0);
    if (Math.abs(sweep) < 1e-9 && Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) < 1e-6) sweep = seg.arc.cw ? -TAU : TAU;
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = a0 + sweep * t;
      out[i * 3] = c.x + r * Math.cos(a);
      out[i * 3 + 1] = c.y + r * Math.sin(a);
      out[i * 3 + 2] = seg.from.z + (seg.to.z - seg.from.z) * t;
    }
    return out;
  }

  /**
   * Segment[] → GL_LINES 頂點／顏色，並依「rapid／刀具」分組（方便顯示開關）。
   * @returns {{positions:Float32Array, colors:Float32Array, ranges:Array, segRanges:Array, byLine:Map}}
   */
  function buildPathLines(segments, opts) {
    opts = opts || {};
    const tol = opts.arcTol > 0 ? opts.arcTol : ARC_TOL;
    const segs = Array.isArray(segments) ? segments : [];
    // 第四軸：整段換算到「跟著工件轉」的座標，畫出來才是圓棒上真的被切到的位置。
    // 沒有 rotary 就走原本的直線／圓弧路徑（三軸程式一切不變）。
    const rotFn = rotarySampler(opts.rotary, tol);
    // 同一行若已經有 compensated 段，programmed 段淡化（與 view2d.drawSegmentsTop 的 alpha 0.55 一致）
    const compLines = new Set();
    for (const seg of segs) if (seg && seg.path === 'compensated') compLines.add(seg.line);
    const buckets = new Map();   // key → {cls, tool, dim, list:[{seg,n}], verts}
    let total = 0;
    for (const seg of segs) {
      if (!seg || !seg.from || !seg.to) continue;
      if (opts.skipRefReturn && seg.refReturn) continue;
      const pw = rotFn ? rotFn(seg) : null;
      if (pw && pw.length < 2) continue;   // 轉換後退化成一個點（零長度段）
      const n = pw ? pw.length - 1 : (seg.arc ? arcSteps(seg, tol) : 1);
      // 轉動期間的移動要獨立成一類：在工件座標下它是一條繞著工件的大弧，
      // 但那不是刀走過的路——刀只走直線，是工件在轉。混在 rapid 裡會被誤讀成「刀在轉彎」。
      const cls = (pw && seg.aFrom !== undefined) ? 'rotate' : (seg.kind === 'rapid' ? 'rapid' : 'feed');
      const faded = seg.path === 'programmed' && compLines.has(seg.line);
      const key = cls + ':' + (seg.tool == null ? 'x' : seg.tool) + ':' + (faded ? 'f' : 'n');
      let b = buckets.get(key);
      if (!b) { b = { cls, tool: seg.tool == null ? null : seg.tool, faded, list: [], verts: 0 }; buckets.set(key, b); }
      b.list.push({ seg, n, pw });
      b.verts += n * 2;
      total += n * 2;
    }
    // 先 rapid 再 feed，各自依刀號排序，讓 draw call 數量少且穩定
    const order = Array.from(buckets.values()).sort((a, b) => {
      if (a.cls !== b.cls) return (a.cls === 'rapid' || (a.cls === 'rotate' && b.cls !== 'rapid')) ? -1 : 1;
      const ta = a.tool == null ? 1e9 : a.tool, tb = b.tool == null ? 1e9 : b.tool;
      if (ta !== tb) return ta - tb;
      return (a.faded ? 1 : 0) - (b.faded ? 1 : 0);
    });
    const positions = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    const ranges = [], segRanges = [], byLine = new Map();
    const rapidRgb = hexRgb(C.rapid);
    let v = 0;
    const buf = new Float32Array(3 * 800);
    for (const b of order) {
      const first = v;
      const rgb = b.cls === 'rapid' ? rapidRgb : hexRgb(toolColor(b.tool));
      for (const it of b.list) {
        const seg = it.seg, sFirst = v;
        if (it.pw) {
          const pts = it.pw;
          for (let i = 0; i + 1 < pts.length; i++) {
            const o = v * 3, a = pts[i], c = pts[i + 1];
            positions[o] = a.x; positions[o + 1] = a.y; positions[o + 2] = a.z;
            positions[o + 3] = c.x; positions[o + 4] = c.y; positions[o + 5] = c.z;
            v += 2;
          }
        } else if (seg.arc) {
          const n = it.n;
          const pts = n + 1 <= 800 ? buf : new Float32Array((n + 1) * 3);
          arcPoints(seg, n, pts);
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < 2; j++) {
              const p = (i + j) * 3, o = (v + j) * 3;
              positions[o] = pts[p]; positions[o + 1] = pts[p + 1]; positions[o + 2] = pts[p + 2];
            }
            v += 2;
          }
        } else {
          let o = v * 3;
          positions[o] = seg.from.x; positions[o + 1] = seg.from.y; positions[o + 2] = seg.from.z;
          positions[o + 3] = seg.to.x; positions[o + 4] = seg.to.y; positions[o + 5] = seg.to.z;
          v += 2;
        }
        for (let i = sFirst; i < v; i++) { const o = i * 3; colors[o] = rgb[0]; colors[o + 1] = rgb[1]; colors[o + 2] = rgb[2]; }
        const rec = { seg, first: sFirst, count: v - sFirst };
        segRanges.push(rec);
        let arr = byLine.get(seg.line);
        if (!arr) { arr = []; byLine.set(seg.line, arr); }
        arr.push(rec);
      }
      ranges.push({ cls: b.cls, tool: b.tool, faded: b.faded, first, count: v - first });
    }
    return { positions, colors, ranges, segRanges, byLine, compLines, vertexCount: v };
  }

  /**
   * 圓棒素材 → 三角網格（純函式，不碰 WebGL）。
   *
   * 素材每格記的是**一串材料區間**（見 CONTRACT §13.10）。把每格的邊界由內往外編號，
   * 第 k 層就是一張 (X, 弧長) 的格網「面」：
   *   θ = 弧長 / 半徑 ;  x = 軸向 ;  y = cy + r·sinθ ;  z = cz + r·cosθ
   *
   * 為什麼要分層：一格只畫最外面那個邊界的話，槽口那一格會直接連到槽底，
   * 側壁就被畫成一條斜的倒角。真正的側壁是**相鄰射線的內側邊界連起來**的那一面
   * ——它在第 1 層。沒有那一層的格（例如槽正中央，整條射線都被挖掉）就把該層
   * 夾到自己最外面的邊界，讓面自然收合，不會破洞。
   *
   * 層數 L 取全場最多的邊界數：沒切過的圓棒 L = 1，跟舊版一模一樣（單一張面 + 兩端封口）。
   * 第 1 層以上只在「四個角至少有一個真的有那一層」的地方才鋪面，
   * 否則整根棒子會被三張重疊的面蓋住（互相 z-fighting，又白白多三倍三角形）。
   *
   * 法線用半徑梯度算（徑向再減掉軸向與周向的斜率），內向的面要反過來，
   * 背面剔除才不會把孔壁剃掉。
   *
   * @param {Object} sim  cylinder 模式的 SimResult 或 sim
   * @param {{height?:Float32Array, extra?:Map, downsample?:number}} [opts]
   */
  function buildCylinderMesh(sim, opts) {
    opts = opts || {};
    const H = opts.height || sim.height;
    const src = { height: H, extra: opts.extra !== undefined ? opts.extra : sim.extra };
    const k = Math.max(1, Math.floor(opts.downsample > 0 ? opts.downsample : 1));
    const nx0 = sim.nx, ny0 = sim.ny;
    const nx = Math.floor((nx0 - 1) / k) + 1;
    const ny = Math.max(3, Math.floor(ny0 / k));
    const cellX = sim.cellX * k;
    const cellY = sim.circumference / ny;
    const R = sim.radius;
    const cy = (sim.center && sim.center.y) || 0;
    const cz = (sim.center && sim.center.z) || 0;
    const srcIdx = (ix, iy) => {
      const sx = Math.min(nx0 - 1, ix * k);
      const sy = ((Math.round(iy * ny0 / ny) % ny0) + ny0) % ny0;
      return sy * nx0 + sx;
    };
    // 每個格點的材料區間 [lo0,hi0,lo1,hi1,…]。層 = 區間的端點：偶數是內向面（lo）、
    // 奇數是外向面（hi）。core 沒載入時退回單一區間 [0, 高度]，行為同舊版。
    const bounds = new Array(nx * ny);
    let L = 1;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const si = srcIdx(ix, iy);
        const b = (NC.sim && typeof NC.sim.spansOf === 'function')
          ? NC.sim.spansOf(src, si)
          : (H[si] > 0 ? [0, H[si]] : []);
        bounds[iy * nx + ix] = b;
        if (b.length > L) L = b.length;
      }
    }
    L = Math.min(L, MAX_SHEETS);
    const lenAt = (i) => bounds[i].length;
    const rAt = (i, lv) => { const b = bounds[i]; return b[lv < b.length ? lv : b.length - 1]; };
    // 端點是內向（lo，面朝軸心）還是外向（hi）；夾到最外面時一律是外向
    const outAt = (i, lv) => { const n = bounds[i].length; return (Math.min(lv, n - 1) % 2) === 1; };

    // ---- 哪些（層, 格點）真的要頂點 ----
    const vid = new Int32Array(L * nx * ny).fill(-1);
    const quads = [];   // [lv, i00, i10, i11, i01, outward]
    for (let iy = 0; iy < ny; iy++) {
      const iy1 = (iy + 1) % ny;
      for (let ix = 0; ix + 1 < nx; ix++) {
        const c = [iy * nx + ix, iy * nx + ix + 1, iy1 * nx + ix + 1, iy1 * nx + ix];
        if (lenAt(c[0]) === 0 || lenAt(c[1]) === 0 || lenAt(c[2]) === 0 || lenAt(c[3]) === 0) continue;
        let maxN = 0, argMax = c[0];
        for (const i of c) if (lenAt(i) > maxN) { maxN = lenAt(i); argMax = i; }
        for (let lv = 0; lv < L; lv++) {
          if (lv > 0 && maxN <= lv) break;          // 四個角都沒有這一層 → 不鋪（會跟下一層重疊）
          // 四個角都貼在軸心（實心棒的第 0 層就是這樣）→ 沒有面積，不必鋪
          if (rAt(c[0], lv) < 1e-9 && rAt(c[1], lv) < 1e-9 && rAt(c[2], lv) < 1e-9 && rAt(c[3], lv) < 1e-9) continue;
          quads.push(lv, c[0], c[1], c[2], c[3], outAt(argMax, lv) ? 1 : 0);
          for (const i of c) vid[lv * nx * ny + i] = 0;
        }
      }
    }
    // ---- 頂點 ----
    let nv = 0;
    for (let i = 0; i < vid.length; i++) if (vid[i] === 0) vid[i] = nv++;
    const nCap = ny + 1;                    // 每個端面：圓心 + 一圈
    const capBase = [nv, nv + nCap];
    nv += nCap * 2;
    const positions = new Float32Array(nv * 3);
    const normals = new Float32Array(nv * 3);
    let rMin = Infinity, rMax = -Infinity;
    const th = new Float64Array(ny), sn = new Float64Array(ny), cs = new Float64Array(ny);
    for (let iy = 0; iy < ny; iy++) {
      th[iy] = iy * cellY / R;
      sn[iy] = Math.sin(th[iy]);
      cs[iy] = Math.cos(th[iy]);
    }
    for (let lv = 0; lv < L; lv++) {
      const base = lv * nx * ny;
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const i = iy * nx + ix;
          const v = vid[base + i];
          if (v < 0) continue;
          const r = rAt(i, lv);
          if (r < rMin) rMin = r;
          if (r > rMax) rMax = r;
          const o = v * 3;
          positions[o] = sim.origin.x + ix * cellX;
          positions[o + 1] = cy + r * sn[iy];
          positions[o + 2] = cz + r * cs[iy];
          // 梯度法線：軸向與周向的半徑斜率
          const rx0 = rAt(iy * nx + Math.max(0, ix - 1), lv), rx1 = rAt(iy * nx + Math.min(nx - 1, ix + 1), lv);
          const ry0 = rAt(((iy - 1 + ny) % ny) * nx + ix, lv), ry1 = rAt(((iy + 1) % ny) * nx + ix, lv);
          const dr_dx = (rx1 - rx0) / (2 * cellX);
          const dr_ds = (ry1 - ry0) / (2 * cellY);
          const f = outAt(i, lv) ? 1 : -1;      // 內向面（孔壁、槽壁）法線要反過來
          let nxv = -dr_dx * f;
          let nyv = (sn[iy] - dr_ds * cs[iy]) * f;
          let nzv = (cs[iy] + dr_ds * sn[iy]) * f;
          const len = Math.hypot(nxv, nyv, nzv) || 1;
          normals[o] = nxv / len; normals[o + 1] = nyv / len; normals[o + 2] = nzv / len;
        }
      }
    }
    // 端面（x = 兩端）：圓心 + 一圈，法線沿 ∓X。用最外圈的邊界（看得到的輪廓）
    for (let c = 0; c < 2; c++) {
      const ix = c === 0 ? 0 : nx - 1;
      const x = sim.origin.x + ix * cellX;
      const nsign = c === 0 ? -1 : 1;
      const b = capBase[c];
      let o = b * 3;
      positions[o] = x; positions[o + 1] = cy; positions[o + 2] = cz;
      normals[o] = nsign; normals[o + 1] = 0; normals[o + 2] = 0;
      for (let iy = 0; iy < ny; iy++) {
        const bb = bounds[iy * nx + ix];
        const r = bb.length ? bb[bb.length - 1] : 0;   // 最外圈 = 看得到的輪廓
        o = (b + 1 + iy) * 3;
        positions[o] = x; positions[o + 1] = cy + r * sn[iy]; positions[o + 2] = cz + r * cs[iy];
        normals[o] = nsign; normals[o + 1] = 0; normals[o + 2] = 0;
      }
    }
    const nq = quads.length / 6;
    const triCount = nq * 2 + ny * 2;
    const Idx = nv > 65535 ? Uint32Array : Uint16Array;
    const indices = new Idx(triCount * 3);
    let t = 0;
    for (let q = 0; q < quads.length; q += 6) {
      const lv = quads[q], base = lv * nx * ny;
      const a = vid[base + quads[q + 1]], b2 = vid[base + quads[q + 2]];
      const c2 = vid[base + quads[q + 3]], d = vid[base + quads[q + 4]];
      if (quads[q + 5]) {
        indices[t++] = a; indices[t++] = b2; indices[t++] = c2;
        indices[t++] = a; indices[t++] = c2; indices[t++] = d;
      } else {                                  // 內向面：繞向反過來，正面才朝向空洞
        indices[t++] = a; indices[t++] = c2; indices[t++] = b2;
        indices[t++] = a; indices[t++] = d; indices[t++] = c2;
      }
    }
    // 端面繞向：θ 增加的方向繞出來的法線是 +X（右手定則），
    // 所以 xMax 那端照 (心, i0, i1) 走、xMin 那端要反過來，兩端的正面才都朝外。
    // 寫反的話背面剔除會把端面剃掉，從某些角度就會直接看穿進圓棒內部。
    for (let c = 0; c < 2; c++) {
      const b = capBase[c];
      for (let iy = 0; iy < ny; iy++) {
        const i0 = b + 1 + iy, i1 = b + 1 + ((iy + 1) % ny);
        if (c === 0) { indices[t++] = b; indices[t++] = i0; indices[t++] = i1; }
        else { indices[t++] = b; indices[t++] = i1; indices[t++] = i0; }
      }
    }
    return {
      positions, normals, indices: indices.subarray(0, t),
      counts: { vertices: nv, triangles: t / 3, indices: t },
      cylinder: true, nx, ny, sheets: L, downsample: k,
      zMin: cz - R, zMax: cz + R,
      rMin: Number.isFinite(rMin) ? rMin : 0, rMax: Number.isFinite(rMax) ? rMax : R, radius: R,
    };
  }

  /**
   * 第四軸取樣器：回傳 seg → 工件座標折線的函式；沒有第四軸就回 null。
   * 幾何在 geometry.rotary（core），這裡只是接線。
   */
  function rotarySampler(rotary, tol) {
    if (!rotary) return null;
    const R = NC.geometry && NC.geometry.rotary;
    if (!R || typeof R.samples !== 'function') return null;
    const center = rotary.center || { y: 0, z: 0 };
    return (seg) => R.samples(seg, { center, tol });
  }

  /**
   * 圓棒素材線框（兩個端面圓 + 幾條母線）。
   * 四軸的工件是夾在分度頭上的圓柱，用方塊線框畫會完全對不上。
   */
  function buildCylinderLines(opts) {
    const o = opts || {};
    const radius = o.radius > 0 ? o.radius : 0;
    if (!(radius > 0) || !(o.xMax > o.xMin)) return { positions: new Float32Array(0), colors: new Float32Array(0), vertexCount: 0 };
    const cy = (o.center && o.center.y) || 0, cz = (o.center && o.center.z) || 0;
    const rgb = hexRgb(o.color || C.stockLine);
    const N = 64, RIBS = 8;
    const pos = [], col = [];
    const pt = (x, t) => [x, cy + radius * Math.sin(t), cz + radius * Math.cos(t)];
    const push = (a, b) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2]); col.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]); };
    for (const x of [o.xMin, o.xMax]) {
      for (let i = 0; i < N; i++) push(pt(x, i / N * TAU), pt(x, (i + 1) / N * TAU));
    }
    for (let i = 0; i < RIBS; i++) { const t = i / RIBS * TAU; push(pt(o.xMin, t), pt(o.xMax, t)); }
    return { positions: new Float32Array(pos), colors: new Float32Array(col), vertexCount: pos.length / 3 };
  }

  /**
   * 圓棒素材的參數：半徑用推估（或設定值），軸向範圍取切削段的 X 加餘量。
   * 推估半徑落在「工件表面附近」（下刀是從表面開始的），畫出來的圓棒粗細只是示意，
   * 現場要精確的話在設定裡填實際直徑。
   */
  function cylinderOf(data) {
    const rot = (data && data.rotary) || {};
    const center = rot.center || { y: 0, z: 0 };
    const segs = (data && data.segments) || [];
    let radius = rot.radius > 0 ? rot.radius : 0;
    if (!radius) {
      const R = NC.geometry && NC.geometry.rotary;
      const est = (R && typeof R.estimateRadius === 'function') ? R.estimateRadius(segs, { center }) : null;
      radius = est ? est.radius : 0;
    }
    let x0 = Infinity, x1 = -Infinity;
    for (const s of segs) {
      if (!s || s.refReturn || s.kind === 'rapid' || !s.from || !s.to) continue;
      x0 = Math.min(x0, s.from.x, s.to.x);
      x1 = Math.max(x1, s.from.x, s.to.x);
    }
    if (!Number.isFinite(x0)) { x0 = -10; x1 = 10; }
    const pad = Math.max(5, (x1 - x0) * 0.15);
    return { radius, xMin: x0 - pad, xMax: x1 + pad, center, color: C.stockLine };
  }

  /** Stock 線框（12 稜邊切成短線做出虛線感）＋治具 */
  function buildStockLines(stock, opts) {
    if (!stock || !stock.min || !stock.max) return { positions: new Float32Array(0), colors: new Float32Array(0), vertexCount: 0 };
    const boxes = [{ min: stock.min, max: stock.max, color: C.stockLine }];
    for (const f of stock.fixtures || []) boxes.push({ min: f.min, max: f.max, color: '#8b5a2b' });
    const dash = (opts && opts.dash > 0) ? opts.dash : Math.max(1, Math.hypot(stock.max.x - stock.min.x, stock.max.y - stock.min.y) / 60);
    const pos = [], col = [];
    for (const box of boxes) {
      const rgb = hexRgb(box.color);
      const a = box.min, b = box.max;
      const cs = [[a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, b.y, a.z], [a.x, b.y, a.z], [a.x, a.y, b.z], [b.x, a.y, b.z], [b.x, b.y, b.z], [a.x, b.y, b.z]];
      const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      for (const e of edges) {
        const p = cs[e[0]], qq = cs[e[1]];
        const len = Math.hypot(qq[0] - p[0], qq[1] - p[1], qq[2] - p[2]);
        const n = Math.max(1, Math.min(200, Math.round(len / (dash * 2))));
        for (let i = 0; i < n; i++) {
          const t0 = i / n, t1 = t0 + 0.55 / n;
          for (const t of [t0, t1]) {
            pos.push(p[0] + (qq[0] - p[0]) * t, p[1] + (qq[1] - p[1]) * t, p[2] + (qq[2] - p[2]) * t);
            col.push(rgb[0], rgb[1], rgb[2]);
          }
        }
      }
    }
    return { positions: new Float32Array(pos), colors: new Float32Array(col), vertexCount: pos.length / 3 };
  }

  /** 原點 XYZ 三軸小箭頭（紅綠藍） */
  function buildAxesLines(len) {
    const L = len > 0 ? len : 10, b = L * 0.18;
    const pos = [], col = [];
    const axes = [
      { dir: [1, 0, 0], up: [0, 1, 0], side: [0, 0, 1], color: C.axisX },
      { dir: [0, 1, 0], up: [1, 0, 0], side: [0, 0, 1], color: C.axisY },
      { dir: [0, 0, 1], up: [1, 0, 0], side: [0, 1, 0], color: C.axisZ },
    ];
    for (const a of axes) {
      const rgb = hexRgb(a.color);
      const tip = [a.dir[0] * L, a.dir[1] * L, a.dir[2] * L];
      const push = (p, q) => { pos.push(p[0], p[1], p[2], q[0], q[1], q[2]); col.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]); };
      push([0, 0, 0], tip);
      for (const s of [a.up, a.side]) for (const sgn of [1, -1]) {
        push(tip, [tip[0] - a.dir[0] * b + s[0] * b * sgn * 0.5, tip[1] - a.dir[1] * b + s[1] * b * sgn * 0.5, tip[2] - a.dir[2] * b + s[2] * b * sgn * 0.5]);
      }
    }
    return { positions: new Float32Array(pos), colors: new Float32Array(col), vertexCount: pos.length / 3 };
  }

  /**
   * 場景包絡。XY：素材 ∪ 治具 ∪ 模擬格 ∪ 非 G28 段（與 view2d.topBounds 同一套）。
   * Z：素材 ∪ 模擬格 ∪ **非 rapid** 段（與 view2d.sectionBounds 同一套）——G0 常常拉到
   * Z150（G28 參考點附近），把它算進 Z 包絡的話 fit() 會把工件縮成畫面底部一條線。
   * 完全沒有切削段時才退回用 rapid 的 Z，免得 Z 包絡是空的。
   */
  function sceneBounds(data) {
    const b = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
    const extXY = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < b.min.x) b.min.x = x; if (x > b.max.x) b.max.x = x;
      if (y < b.min.y) b.min.y = y; if (y > b.max.y) b.max.y = y;
    };
    const extZ = (z) => {
      if (!Number.isFinite(z)) return;
      if (z < b.min.z) b.min.z = z; if (z > b.max.z) b.max.z = z;
    };
    const ext = (x, y, z) => { extXY(x, y); extZ(z); };
    let rz0 = Infinity, rz1 = -Infinity;
    // 第四軸：路徑要換算到工件座標；方塊素材與高度圖在四軸下是錯的模型，不列入取景
    const rotFn = rotarySampler(data && data.rotary, ARC_TOL);
    const simIn = data && data.sim;
    // 圓柱素材本身就是工件座標，可以直接用；方塊素材在四軸下是錯的模型，跳過
    const useCylSim = !!(simIn && simIn.cylinder);
    const stock = (rotFn && !useCylSim) ? null : (data && data.stock);
    const sim = (rotFn && !useCylSim) ? null : simIn;
    if (rotFn) {
      const cyl = cylinderOf(data);
      if (cyl.radius > 0) {
        const cy = cyl.center.y, cz = cyl.center.z, r = cyl.radius;
        ext(cyl.xMin, cy - r, cz - r); ext(cyl.xMax, cy + r, cz + r);
      }
    }
    if (stock) {
      ext(stock.min.x, stock.min.y, stock.min.z); ext(stock.max.x, stock.max.y, stock.max.z);
      for (const f of stock.fixtures || []) { ext(f.min.x, f.min.y, f.min.z); ext(f.max.x, f.max.y, f.max.z); }
    }
    if (sim && sim.cylinder) {
      const r = sim.radius, ccy = (sim.center && sim.center.y) || 0, ccz = (sim.center && sim.center.z) || 0;
      const x1 = sim.origin.x + (sim.nx - 1) * (sim.cellX || sim.cell);
      ext(sim.origin.x, ccy - r, ccz - r);
      ext(x1, ccy + r, ccz + r);
    } else if (sim && sim.nx > 0) {
      const h = sim.cell / 2;
      ext(sim.origin.x - h, sim.origin.y - h, sim.floorZ);
      ext(sim.origin.x + (sim.nx - 0.5) * sim.cell, sim.origin.y + (sim.ny - 0.5) * sim.cell, sim.floorZ);
    }
    for (const s of (data && data.segments) || []) {
      if (s.refReturn) continue;
      if (rotFn) {
        for (const p of rotFn(s)) {
          // 四軸的 G0：刀停在高處、工件在轉，換算到工件座標就變成一圈半徑等於刀高的大圓弧。
          // 那是真實的相對運動（也是撞刀要看的東西），但算進取景會把工件擠成一個小點。
          if (s.kind === 'rapid') { if (p.z < rz0) rz0 = p.z; if (p.z > rz1) rz1 = p.z; continue; }
          extXY(p.x, p.y); extZ(p.z);
        }
        continue;
      }
      extXY(s.from.x, s.from.y); extXY(s.to.x, s.to.y);
      if (s.arc) {
        extXY(s.arc.center.x - s.arc.r, s.arc.center.y - s.arc.r);
        extXY(s.arc.center.x + s.arc.r, s.arc.center.y + s.arc.r);
      }
      if (s.kind === 'rapid') {
        for (const z of [s.from.z, s.to.z]) { if (Number.isFinite(z)) { if (z < rz0) rz0 = z; if (z > rz1) rz1 = z; } }
      } else {
        extZ(s.from.z); extZ(s.to.z);
      }
    }
    if (!Number.isFinite(b.min.z) && Number.isFinite(rz0)) { b.min.z = rz0; b.max.z = rz1; }
    if (!(b.min.x <= b.max.x) || !(b.min.z <= b.max.z)) return null;
    return b;
  }

  /**
   * 剖面平面：在 axis = value 的位置鋪一片半透明矩形，四周加一圈外框線。
   * 這片東西的用途只有一個——讓人在 3D 上看得到「旁邊那張剖面圖是從哪裡切下去的」。
   * 尺寸取場景包絡再往外放一點，免得剛好貼齊工件邊緣看不出是一個平面。
   * @param {{min:{x,y,z},max:{x,y,z}}} b 場景包絡（sceneBounds 的回傳）
   * @param {'x'|'y'} axis
   * @returns {{fill:Object, edge:Object}|null}
   */
  function buildSectionPlane(b, axis, value, opts) {
    opts = opts || {};
    if (!b || (axis !== 'x' && axis !== 'y') || !Number.isFinite(value)) return null;
    const pad = opts.pad != null ? opts.pad : 0.08;
    const ex = Math.max((b.max.x - b.min.x) * pad, 1);
    const ey = Math.max((b.max.y - b.min.y) * pad, 1);
    const ez = Math.max((b.max.z - b.min.z) * pad, 1);
    const z0 = b.min.z - ez, z1 = b.max.z + ez;
    let q;
    if (axis === 'x') {
      const y0 = b.min.y - ey, y1 = b.max.y + ey;
      q = [[value, y0, z0], [value, y1, z0], [value, y1, z1], [value, y0, z1]];
    } else {
      const x0 = b.min.x - ex, x1 = b.max.x + ex;
      q = [[x0, value, z0], [x1, value, z0], [x1, value, z1], [x0, value, z1]];
    }
    const rgb = hexRgb(opts.color || C.section);
    const fp = [], fc = [];
    for (const i of [0, 1, 2, 0, 2, 3]) { fp.push(q[i][0], q[i][1], q[i][2]); fc.push(rgb[0], rgb[1], rgb[2]); }
    const ep = [], ec = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], c = q[(i + 1) % 4];
      ep.push(a[0], a[1], a[2], c[0], c[1], c[2]);
      ec.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    }
    return {
      fill: { positions: new Float32Array(fp), colors: new Float32Array(fc), vertexCount: 6 },
      edge: { positions: new Float32Array(ep), colors: new Float32Array(ec), vertexCount: 8 },
    };
  }

  /**
   * 實體（成品網格／素材）的包絡。剖面平面的大小與剖切的「留多少」都要用它，
   * **不能用 `sceneBounds`**——那裡面含刀具路徑（換刀點在 Z150），平面會被撐成一大片、
   * 看起來像切歪了，剖切要留多少也會算錯。
   */
  function solidBounds(data) {
    const sim = data && data.sim;
    const st = data && data.stock;
    let b = null;
    const ext = (x0, y0, z0, x1, y1, z1) => {
      if (!b) b = { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } };
      else {
        b.min.x = Math.min(b.min.x, x0); b.min.y = Math.min(b.min.y, y0); b.min.z = Math.min(b.min.z, z0);
        b.max.x = Math.max(b.max.x, x1); b.max.y = Math.max(b.max.y, y1); b.max.z = Math.max(b.max.z, z1);
      }
    };
    if (sim && sim.cylinder && sim.radius > 0) {
      const c = sim.cellX || sim.cell;
      const cy = (sim.center && sim.center.y) || 0, cz = (sim.center && sim.center.z) || 0;
      ext(sim.origin.x - c / 2, cy - sim.radius, cz - sim.radius,
        sim.origin.x + (sim.nx - 0.5) * c, cy + sim.radius, cz + sim.radius);
    } else {
      if (sim && sim.nx > 0) {
        const h = sim.cell / 2;
        ext(sim.origin.x - h, sim.origin.y - h, sim.floorZ,
          sim.origin.x + (sim.nx - 0.5) * sim.cell, sim.origin.y + (sim.ny - 0.5) * sim.cell, sim.floorZ);
      }
      // 三軸的高度圖只給得出 floorZ，頂面要靠素材
      if (st) ext(st.min.x, st.min.y, st.min.z, st.max.x, st.max.y, st.max.z);
    }
    if (!b) return sceneBounds(data);
    if (!(b.max.z - b.min.z > 1e-6)) {
      const sb = sceneBounds(data);
      if (sb) { b.min.z = sb.min.z; b.max.z = sb.max.z; }
    }
    return b;
  }

  /**
   * 剖切平面 [nx, ny, nz, d]：著色器丟掉 `dot(pos, n) > d` 的片段。
   *
   * **方向是固定的，不跟相機也不跟剖面位置走。** 早期版本兩者都跟過：
   * 跟相機的話，繞到平面另一側時整塊料會瞬間換邊（剖面靠近端面時那一換就等於整個消失）；
   * 跟「留下來夠不夠多」的話，滑桿拉過某個值也會換邊。現場兩種都回報過同一句話——
   * 換邊會讓人瞬間認不出自己在看哪一面。所以寧可讓人自己按「換一邊切」。
   *
   * @param {'x'|'y'} axis
   * @param {boolean} [flip] 使用者按過「換一邊切」
   */
  function clipPlaneFor(axis, value, flip) {
    if ((axis !== 'x' && axis !== 'y') || !Number.isFinite(value)) return null;
    const sign = CLIP_SIGN[axis] * (flip ? -1 : 1);
    return axis === 'x' ? [sign, 0, 0, sign * value] : [0, sign, 0, sign * value];
  }

  const view3dUtil = {
    TOOL_COLORS, TOP_RGB, DEEP_RGB, FIXTURE_RGB, CUT_RGB, PICK_PX, ARC_TOL, COLORS: C,
    buildSectionPlane, clipPlaneFor,
    toolColor, hexRgb, mat4, mat4Mul, mat4Perspective, mat4LookAt, projectPoint, distPointSeg2D,
    resolveDownsample, downsampleHeights, buildMesh, buildMeshAsync, planChunks,
    updateHeights, canUpdateHeights, arcSteps, arcPoints, buildPathLines, buildStockLines, buildAxesLines, sceneBounds,
    buildCylinderLines, cylinderOf, rotarySampler, buildCylinderMesh, solidBounds,
  };
  NC.ui.view3d = Object.assign(NC.ui.view3d || {}, view3dUtil);

  // ---------------------------------------------------------------------------
  // GLSL
  // ---------------------------------------------------------------------------
  const MESH_VS = [
    'attribute vec3 aPos;',
    'attribute vec3 aNor;',
    'uniform mat4 uMVP;',
    'varying vec3 vNor;',
    'varying vec3 vWorld;',
    'void main() {',
    '  vNor = aNor;',
    '  vWorld = aPos;',
    '  gl_Position = uMVP * vec4(aPos, 1.0);',
    '}',
  ].join('\n');
  const MESH_FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec3 vNor;',
    'varying vec3 vWorld;',
    'uniform vec3 uLight;',
    'uniform vec3 uTop;',
    'uniform vec3 uWall;',
    'uniform vec3 uBottom;',
    'uniform vec3 uDeep;',
    'uniform vec3 uFixture;',
    'uniform vec2 uZRange;',   // x = zTop, y = zBottom
    'uniform vec4 uClip;',     // xyz = 法線、w = 門檻；dot(pos, n) > w 的片段丟掉
    'uniform float uClipOn;',
    'uniform vec3 uCut;',      // 剖開之後看到的斷面色
    'void main() {',
    '  bool cutting = uClipOn > 0.5;',
    '  if (cutting && dot(vWorld, uClip.xyz) > uClip.w) discard;',
    '  vec3 n = normalize(vNor);',
    // 剖切時要關背面剔除才看得到內部；那些背面翻過來當成斷面打光，不然會是一層黑殼
    '  bool back = cutting && !gl_FrontFacing;',
    '  if (back) n = -n;',
    '  float up = n.z;',
    '  vec3 face = mix(uBottom, uTop, step(0.0, up));',
    '  vec3 base = mix(uWall, face, smoothstep(0.30, 0.72, abs(up)));',
    '  float span = max(uZRange.x - uZRange.y, 1e-4);',
    '  float f = clamp((uZRange.x - vWorld.z) / span, 0.0, 1.0);',
    '  f = pow(f, 0.6);',
    // 垂直壁只吃 55% 的色階，免得整塊料看起來泡在藍色裡；頂面維持與 2D 俯視相同的深淺對應
    '  float ramp = f * mix(0.48, 0.88, smoothstep(0.30, 0.72, abs(up)));',
    '  vec3 col = mix(base, uDeep, ramp);',
    // 高於素材頂面的格＝治具，換成土黃（與 view2d 的 depthColor 一致）
    '  col = mix(col, uFixture, step(uZRange.x + 1e-4, vWorld.z));',
    // 斷面（背面）偏向素色的「一塊實心料」，但保留一點深淺，還看得出哪裡切得深
    '  if (back) col = mix(col, uCut, 0.75);',
    '  float d = max(dot(n, uLight), 0.0);',
    '  float bk = max(dot(n, -uLight), 0.0);',
    '  float lit = 0.42 + 0.62 * d + 0.10 * bk;',
    '  gl_FragColor = vec4(col * lit, 1.0);',
    '}',
  ].join('\n');
  const LINE_VS = [
    'attribute vec3 aPos;',
    'attribute vec3 aColor;',
    'uniform mat4 uMVP;',
    'uniform vec2 uOffset;',
    'uniform vec2 uViewport;',
    'varying vec3 vColor;',
    'void main() {',
    '  vColor = aColor;',
    '  vec4 p = uMVP * vec4(aPos, 1.0);',
    '  p.xy += (uOffset / uViewport) * 2.0 * p.w;',
    '  gl_Position = p;',
    '}',
  ].join('\n');
  const LINE_FS = [
    'precision mediump float;',
    'varying vec3 vColor;',
    'uniform vec3 uTint;',
    'uniform float uUseTint;',
    'uniform float uAlpha;',
    'void main() {',
    '  gl_FragColor = vec4(mix(vColor, uTint, uUseTint), uAlpha);',
    '}',
  ].join('\n');

  function compile(gl, type, src, label) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      if (typeof console !== 'undefined') console.error('[view3d] ' + label + ' 著色器編譯失敗：' + gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }
  function link(gl, vsSrc, fsSrc, label) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, label + ' vertex');
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + ' fragment');
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      if (typeof console !== 'undefined') console.error('[view3d] ' + label + ' 程式連結失敗：' + gl.getProgramInfoLog(p));
      gl.deleteProgram(p);
      return null;
    }
    return p;
  }

  // ---------------------------------------------------------------------------
  // View3D
  // ---------------------------------------------------------------------------
  // 「開關關 / 開關開」差一個形近字，11px 下讀錯會做出完全相反的判斷（與 view2d.js 一致）
  const SCENARIO_LABEL = {
    off: 'Block skip：關（全部執行）',
    on: 'Block skip：開（跳過 / 節）',
    multiIgnored: 'Block skip：只跳過多斜線節',
  };

  function getGL(canvas, attrs) {
    let gl = null, gl2 = false;
    try { gl = canvas.getContext('webgl2', attrs); if (gl) gl2 = true; } catch (e) { /* 忽略 */ }
    if (!gl) { try { gl = canvas.getContext('webgl', attrs); } catch (e) { /* 忽略 */ } }
    if (!gl) { try { gl = canvas.getContext('experimental-webgl', attrs); } catch (e) { /* 忽略 */ } }
    return { gl, gl2 };
  }

  /** 這個環境能不能建立 WebGL context */
  function isSupported() {
    if (typeof document === 'undefined' || !document.createElement) return false;
    try {
      const c = document.createElement('canvas');
      const r = getGL(c, { alpha: false, depth: true });
      if (!r.gl) return false;
      const lose = r.gl.getExtension && r.gl.getExtension('WEBGL_lose_context');
      if (lose && lose.loseContext) { try { lose.loseContext(); } catch (e) { /* 忽略 */ } }
      return true;
    } catch (e) { return false; }
  }

  /**
   * 建立 3D 視圖。失敗（沒有 canvas／開不了 WebGL／著色器編不過）回傳 null。
   * @param {HTMLCanvasElement} canvas
   * @param {{preserveDrawingBuffer?:boolean, antialias?:boolean, hud?:boolean}} [options]
   */
  function createView3D(canvas, options) {
    options = options || {};
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    if (typeof document === 'undefined') return null;
    const attrs = {
      alpha: false, depth: true, stencil: false, antialias: options.antialias !== false,
      premultipliedAlpha: false, preserveDrawingBuffer: !!options.preserveDrawingBuffer,
      failIfMajorPerformanceCaveat: false,
    };
    const got = getGL(canvas, attrs);
    const gl = got.gl;
    if (!gl) return null;

    // 著色器程式與 attribute／uniform 位置。context 遺失後還原時要整組重建
    // （program、shader、buffer 在 context 遺失時全部失效，locations 也不能沿用）。
    let meshProg = null, lineProg = null, uint32 = false;
    const ML = {}, LL = {};
    function linkPrograms() {
      const mp = link(gl, MESH_VS, MESH_FS, '實體');
      const lp = link(gl, LINE_VS, LINE_FS, '線段');
      if (!mp || !lp) {
        if (mp) gl.deleteProgram(mp);
        if (lp) gl.deleteProgram(lp);
        meshProg = lineProg = null;
        return false;
      }
      meshProg = mp; lineProg = lp;
      ML.aPos = gl.getAttribLocation(mp, 'aPos'); ML.aNor = gl.getAttribLocation(mp, 'aNor');
      ML.uMVP = gl.getUniformLocation(mp, 'uMVP'); ML.uLight = gl.getUniformLocation(mp, 'uLight');
      ML.uTop = gl.getUniformLocation(mp, 'uTop'); ML.uWall = gl.getUniformLocation(mp, 'uWall');
      ML.uBottom = gl.getUniformLocation(mp, 'uBottom'); ML.uDeep = gl.getUniformLocation(mp, 'uDeep');
      ML.uFixture = gl.getUniformLocation(mp, 'uFixture'); ML.uZRange = gl.getUniformLocation(mp, 'uZRange');
      ML.uClip = gl.getUniformLocation(mp, 'uClip'); ML.uClipOn = gl.getUniformLocation(mp, 'uClipOn');
      ML.uCut = gl.getUniformLocation(mp, 'uCut');
      LL.aPos = gl.getAttribLocation(lp, 'aPos'); LL.aColor = gl.getAttribLocation(lp, 'aColor');
      LL.uMVP = gl.getUniformLocation(lp, 'uMVP'); LL.uOffset = gl.getUniformLocation(lp, 'uOffset');
      LL.uViewport = gl.getUniformLocation(lp, 'uViewport'); LL.uTint = gl.getUniformLocation(lp, 'uTint');
      LL.uUseTint = gl.getUniformLocation(lp, 'uUseTint'); LL.uAlpha = gl.getUniformLocation(lp, 'uAlpha');
      // forceUint16：測試用，模擬 WebGL1 沒有 OES_element_index_uint 的機台
      uint32 = !options.forceUint16 && (got.gl2 || !!gl.getExtension('OES_element_index_uint'));
      return true;
    }
    if (!linkPrograms()) return null;

    const reduced = (typeof window !== 'undefined' && window.matchMedia)
      ? (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } })() : false;

    const S = {
      data: { sim: null, segments: [], stock: null, toolTable: null, scenario: 'off' },
      heightArr: null,
      extraMap: null,          // 圓棒的材料區間（跟 heightArr 同一份來源）
      snapshotIndex: null,
      // rotary = 工件轉動時刀的相對軌跡（那些大弧）。預設關：現場看到會以為刀在轉彎。
      visible: { rapid: true, feed: true, stock: true, surface: true, rotary: false, tools: null },
      hlLine: null,
      hlTool: null,
      cam: { az: -60 * DEG, el: 28 * DEG, dist: 300, target: [0, 0, 0], fov: 45 * DEG },
      vel: { az: 0, el: 0 },
      size: { w: 300, h: 200 }, dpr: 1,
      mvp: mat4(), proj: mat4(), view: mat4(),
      meshChunks: [],       // {vbo, nbo, ibo, count, type, mesh}
      meshInfo: { vertices: 0, triangles: 0, downsample: 1, chunks: 0 },
      path: null, pathBuf: null,
      stockBuf: null, axesBuf: null,
      // 剖面：axis 為 null 時整組不畫。clip = 把靠相機那半邊切掉，直接看斷面。
      section: { axis: null, value: 0, clip: false, flip: false },
      sectionFillBuf: null, sectionEdgeBuf: null,
      zRange: [0, -10],
      building: false, buildToken: 0, buildProgress: 1,
      pickCb: null, progressCb: null,
      pointers: new Map(), drag: null, pinch: null,
      scheduled: false, destroyed: false,
      needFit: true,
      hud: null, hudEnabled: options.hud !== false,
      downsampleOpt: 'auto',
      lost: false,
      cssSized: null,      // canvas 尺寸是否由 CSS 決定（null = 還沒探測）
    };

    // ---- 尺寸 ------------------------------------------------------------
    /**
     * canvas 的版面尺寸是不是由 width/height **屬性**決定的（也就是沒有 CSS 尺寸）？
     * 是的話，下面把屬性乘上 devicePixelRatio 會讓版面跟著放大、下一次再乘一次…愈滾愈大，
     * 所以要把 CSS 尺寸釘成內聯樣式。有 CSS 尺寸（例如 css/view3d.css 的 width:100%）的
     * **絕對不能釘**，內聯樣式會蓋掉 CSS，拖分隔線／縮視窗時 canvas 就不會跟著縮了。
     * 只在第一次量得到尺寸時探測一次。
     */
    function detectCssSized(w, h) {
      if (S.cssSized != null) return S.cssSized;
      const old = canvas.width;
      try {
        canvas.width = old + 16;
        S.cssSized = canvas.clientWidth === w;   // 改了屬性版面沒變 → 尺寸來自 CSS
      } catch (e) { S.cssSized = true; }
      canvas.width = old;
      if (!S.cssSized && canvas.style && !canvas.style.width) {
        canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      }
      return S.cssSized;
    }
    function syncSize() {
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      let w = canvas.clientWidth, h = canvas.clientHeight;
      if (!(w > 0 && h > 0)) {
        w = canvas.width / (S.dpr || 1); h = canvas.height / (S.dpr || 1);
        if (!(w > 0 && h > 0)) return false;
      } else {
        detectCssSized(w, h);
      }
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      S.size.w = w; S.size.h = h; S.dpr = dpr;
      return true;
    }

    function requestRender() {
      if (S.scheduled || S.destroyed) return;
      S.scheduled = true;
      const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
      raf(() => { S.scheduled = false; render(); });
    }

    // ---- GPU 資源 --------------------------------------------------------
    function makeBuffer(target, data, usage) {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, usage || gl.STATIC_DRAW);
      return b;
    }
    function freeMesh() {
      for (const c of S.meshChunks) {
        gl.deleteBuffer(c.vbo); gl.deleteBuffer(c.nbo); gl.deleteBuffer(c.ibo);
      }
      S.meshChunks = [];
      S.meshInfo = { vertices: 0, triangles: 0, downsample: 1, chunks: 0 };
    }
    function uploadChunk(mesh) {
      const idx = mesh.indices;
      let arr = idx, type = gl.UNSIGNED_INT;
      if (!uint32 || idx instanceof Uint16Array) {
        if (mesh.counts.vertices <= 65536) { arr = idx instanceof Uint16Array ? idx : new Uint16Array(idx); type = gl.UNSIGNED_SHORT; }
        else if (!uint32) {
          // 沒有 OES_element_index_uint 又超過 65536 頂點：分塊計畫應該已經避開，
          // 真的發生就是有一列格自己就爆掉（格網寬到離譜）。寧可少畫一塊也不要整個掛掉，但要出聲。
          if (typeof console !== 'undefined') {
            console.warn('[view3d] 這塊網格有 ' + mesh.counts.vertices + ' 個頂點，超過 Uint16 索引上限且沒有 uint32 擴充，該區塊不顯示；請改用降採樣（setDownsample）。');
          }
          return null;
        }
      }
      const c = {
        vbo: makeBuffer(gl.ARRAY_BUFFER, mesh.positions),
        nbo: makeBuffer(gl.ARRAY_BUFFER, mesh.normals),
        ibo: makeBuffer(gl.ELEMENT_ARRAY_BUFFER, arr),
        count: mesh.counts.indices, type, mesh,
      };
      return c;
    }
    function freeLineBuf(b) { if (b) { gl.deleteBuffer(b.pos); gl.deleteBuffer(b.col); } }
    function makeLineBuf(src) {
      if (!src || !src.vertexCount) return null;
      return { pos: makeBuffer(gl.ARRAY_BUFFER, src.positions), col: makeBuffer(gl.ARRAY_BUFFER, src.colors), count: src.vertexCount };
    }

    // ---- 網格重建 --------------------------------------------------------
    function reportProgress(p) {
      S.buildProgress = p;
      if (S.progressCb) { try { S.progressCb(p); } catch (e) { /* 忽略 */ } }
      updateHud();
    }
    async function rebuildMesh() {
      const sim = S.data.sim;
      const token = ++S.buildToken;
      freeMesh();
      if (!sim || !S.heightArr) { S.building = false; reportProgress(1); requestRender(); return; }
      // 圓柱素材（第四軸）：(X, 弧長) → 半徑 的高度圖，一次建完，不用分塊
      if (sim.cylinder) {
        S.building = false;
        const mesh = buildCylinderMesh(sim, {
          height: S.heightArr, extra: S.extraMap,
          downsample: S.downsampleOpt > 1 ? S.downsampleOpt : 1,
        });
        const c = uploadChunk(mesh);
        if (c) S.meshChunks.push(c);
        S.meshInfo = { vertices: mesh.counts.vertices, triangles: mesh.counts.triangles, downsample: mesh.downsample, chunks: S.meshChunks.length };
        updateZRange(mesh.zMin, mesh.zMax);
        reportProgress(1);
        if (S.needFit) fit(false);
        requestRender();
        return;
      }
      S.building = true;
      reportProgress(0);
      requestRender();
      const res = await buildMeshAsync(sim, {
        height: S.heightArr,
        downsample: S.downsampleOpt,
        maxVertsPerChunk: uint32 ? 400000 : 65536,
        uint16: !uint32,
        onProgress: (p) => { if (token === S.buildToken) reportProgress(p * 0.98); },
        shouldCancel: () => token !== S.buildToken || S.destroyed,
      });
      if (token !== S.buildToken || S.destroyed) return;
      S.building = false;
      if (!res) { reportProgress(1); requestRender(); return; }
      for (const m of res.chunks) { const c = uploadChunk(m); if (c) S.meshChunks.push(c); }
      S.meshInfo = { vertices: res.counts.vertices, triangles: res.counts.triangles, downsample: res.downsample, chunks: S.meshChunks.length };
      updateZRange(res.zMin, res.zMax);
      reportProgress(1);
      if (S.needFit) fit(false);
      requestRender();
    }
    /** 只換高度（不重建 index buffer）；拓樸不相容時回 false */
    function fastUpdateHeights(heightArr) {
      if (!S.meshChunks.length) return false;
      const pre = downsampleHeights(heightArr, S.data.sim.nx, S.data.sim.ny, S.meshChunks[0].mesh.downsample, 'min');
      for (const c of S.meshChunks) if (!canUpdateHeightsWith(c.mesh, pre)) return false;
      let zMin = Infinity, zMax = -Infinity;
      for (const c of S.meshChunks) {
        updateHeights(c.mesh, heightArr, { _pre: pre, force: true });
        gl.bindBuffer(gl.ARRAY_BUFFER, c.vbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, c.mesh.positions);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.nbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, c.mesh.normals);
        if (c.mesh.zMin < zMin) zMin = c.mesh.zMin;
        if (c.mesh.zMax > zMax) zMax = c.mesh.zMax;
      }
      updateZRange(zMin, zMax);
      requestRender();
      return true;
    }
    function canUpdateHeightsWith(mesh, pre) {
      if (pre.nx !== mesh.nx || pre.ny !== mesh.ny) return false;
      return checkEdges(mesh, pre.z);
    }
    function updateZRange(zMin, zMax) {
      const stock = S.data.stock;
      let top = stock ? stock.max.z : zMax;
      let bot = stock ? stock.min.z : zMin;
      if (!Number.isFinite(top)) top = 0;
      if (!Number.isFinite(bot) || bot >= top) bot = top - 10;
      if (Number.isFinite(zMin) && zMin < bot) bot = zMin;
      S.zRange = [top, bot];
    }

    function rebuildPath() {
      freeLineBuf(S.pathBuf); S.pathBuf = null;
      S.path = buildPathLines(S.data.segments, { arcTol: ARC_TOL, rotary: S.data.rotary });
      S.pathBuf = makeLineBuf(S.path);
    }
    function rebuildStock() {
      freeLineBuf(S.stockBuf); S.stockBuf = null;
      // 四軸的工件是夾在分度頭上的圓棒，用方塊線框畫會完全對不上。
      // 已經有圓柱成品網格時線框就多餘了（成品本身就是那根圓棒），只在沒有成品時當佔位。
      const hasCylMesh = !!(S.data.sim && S.data.sim.cylinder && S.heightArr);
      S.stockBuf = makeLineBuf(S.data.rotary
        ? (hasCylMesh ? { positions: new Float32Array(0), colors: new Float32Array(0), vertexCount: 0 }
          : buildCylinderLines(cylinderOf(S.data)))
        : buildStockLines(S.data.stock));
    }
    function rebuildAxes() {
      freeLineBuf(S.axesBuf); S.axesBuf = null;
      const b = sceneBounds(S.data);
      const span = b ? Math.max(b.max.x - b.min.x, b.max.y - b.min.y, 10) : 50;
      S.axesBuf = makeLineBuf(buildAxesLines(Math.max(5, span * 0.14)));
    }
    function rebuildSection() {
      freeLineBuf(S.sectionFillBuf); freeLineBuf(S.sectionEdgeBuf);
      S.sectionFillBuf = S.sectionEdgeBuf = null;
      const sec = S.section;
      if (!sec.axis) return;
      // 用工件的包絡、不是整個場景：含刀具路徑的話平面會被撐成一大片，看起來像切歪了
      const b = solidBounds(S.data);
      const plane = buildSectionPlane(b, sec.axis, sec.value);
      if (!plane) return;
      S.sectionFillBuf = makeLineBuf(plane.fill);
      S.sectionEdgeBuf = makeLineBuf(plane.edge);
    }

    // ---- 相機 ------------------------------------------------------------
    function eyePos() {
      const c = S.cam, ce = Math.cos(c.el), se = Math.sin(c.el);
      return [c.target[0] + c.dist * ce * Math.cos(c.az), c.target[1] + c.dist * ce * Math.sin(c.az), c.target[2] + c.dist * se];
    }
    function computeMVP() {
      const w = Math.max(1, S.size.w), h = Math.max(1, S.size.h);
      const eye = eyePos();
      const r = Math.max(S.cam.radius || 50, 1);
      const near = Math.max(S.cam.dist * 0.005, r * 0.002, 0.01);
      const far = S.cam.dist + r * 6 + 10;
      mat4Perspective(S.proj, S.cam.fov, w / h, near, far);
      mat4LookAt(S.view, eye, S.cam.target, [0, 0, 1]);
      mat4Mul(S.mvp, S.proj, S.view);
      return S.mvp;
    }
    /**
     * 取景：把包絡的 8 個角投到目前視角，算出剛好裝得下的距離
     * （比用外接球保守值緊，畫面才不會一大片空白）。
     */
    function fit(rerender) {
      if (!(S.size.w > 0)) syncSize();
      const b = sceneBounds(S.data);
      if (!b) {
        S.cam.target = [0, 0, 0]; S.cam.dist = 200; S.cam.radius = 100;
        S.needFit = !S.data.sim && !(S.data.segments || []).length;
      } else {
        S.cam.target = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];
        const r = Math.max(1e-3, 0.5 * Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z));
        S.cam.radius = r;
        const aspect = Math.max(0.2, S.size.w / Math.max(1, S.size.h));
        const tanY = Math.tan(S.cam.fov / 2), tanX = tanY * aspect;
        const ce = Math.cos(S.cam.el), se = Math.sin(S.cam.el);
        const eyeDir = [ce * Math.cos(S.cam.az), ce * Math.sin(S.cam.az), se];   // target → eye
        const f = [-eyeDir[0], -eyeDir[1], -eyeDir[2]];                          // eye → target
        let s = cross3(f, [0, 0, 1]);
        if (Math.hypot(s[0], s[1], s[2]) < 1e-9) s = [1, 0, 0];
        s = normalize3(s);
        const u = cross3(s, f);
        let need = r * 0.2;
        for (let i = 0; i < 8; i++) {
          const q = [(i & 1 ? b.max.x : b.min.x) - S.cam.target[0], (i & 2 ? b.max.y : b.min.y) - S.cam.target[1], (i & 4 ? b.max.z : b.min.z) - S.cam.target[2]];
          const along = dot3(q, f);
          need = Math.max(need, Math.abs(dot3(q, s)) / tanX - along, Math.abs(dot3(q, u)) / tanY - along);
        }
        S.cam.dist = Math.max(need * 1.06, r * 0.05);
        S.needFit = false;
      }
      S.vel.az = 0; S.vel.el = 0;
      if (rerender !== false) requestRender();
      return api;
    }

    // ---- 繪圖 ------------------------------------------------------------
    function isVisible(seg) {
      const vis = S.visible;
      if (seg.kind === 'rapid') { if (!vis.rapid) return false; } else if (!vis.feed) return false;
      if (vis.tools && seg.tool != null && !vis.tools.has(seg.tool)) return false;
      return true;
    }
    function rangeVisible(r) {
      const vis = S.visible;
      if (r.cls === 'rotate') { if (!vis.rotary) return false; } else if (r.cls === 'rapid') {
        if (!vis.rapid) return false;
      } else if (!vis.feed) return false;
      if (vis.tools && r.tool != null && !vis.tools.has(r.tool)) return false;
      return true;
    }
    function bindLineBuf(b) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
      gl.vertexAttribPointer(LL.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(LL.aPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.col);
      gl.vertexAttribPointer(LL.aColor, 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(LL.aColor);
    }
    function drawMesh() {
      if (!S.visible.surface || !S.meshChunks.length) return;
      gl.useProgram(meshProg);
      gl.uniformMatrix4fv(ML.uMVP, false, S.mvp);
      const L = normalize3([-0.42, -0.55, 0.72]);
      gl.uniform3f(ML.uLight, L[0], L[1], L[2]);
      gl.uniform3f(ML.uTop, TOP_RGB[0] / 255, TOP_RGB[1] / 255, TOP_RGB[2] / 255);
      gl.uniform3f(ML.uWall, TOP_RGB[0] / 255 * 0.72, TOP_RGB[1] / 255 * 0.73, TOP_RGB[2] / 255 * 0.78);
      gl.uniform3f(ML.uBottom, 0.55, 0.56, 0.60);
      gl.uniform3f(ML.uDeep, DEEP_RGB[0] / 255, DEEP_RGB[1] / 255, DEEP_RGB[2] / 255);
      gl.uniform3f(ML.uFixture, FIXTURE_RGB[0] / 255, FIXTURE_RGB[1] / 255, FIXTURE_RGB[2] / 255);
      gl.uniform2f(ML.uZRange, S.zRange[0], S.zRange[1]);
      const clip = S.section.clip ? clipPlaneFor(S.section.axis, S.section.value, S.section.flip) : null;
      gl.uniform1f(ML.uClipOn, clip ? 1 : 0);
      gl.uniform4f(ML.uClip, clip ? clip[0] : 0, clip ? clip[1] : 0, clip ? clip[2] : 0, clip ? clip[3] : 1e9);
      gl.uniform3f(ML.uCut, CUT_RGB[0] / 255, CUT_RGB[1] / 255, CUT_RGB[2] / 255);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.2, 2.0);
      // 背面剔除：所有四邊形（頂面／裙邊／外壁／底面）都是逆時針朝外，見 test 的「繞向一致」那條。
      // 少畫一半的片段，貫穿孔的孔底與底面重疊時也不會 z-fighting（從上看只留朝上的那面）。
      // 剖切時例外——切開之後看到的正是內部的背面，剔掉就變成一個空殼。
      if (!clip) {
        gl.enable(gl.CULL_FACE);
        gl.frontFace(gl.CCW);
        gl.cullFace(gl.BACK);
      } else gl.disable(gl.CULL_FACE);
      for (const c of S.meshChunks) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.vbo);
        gl.vertexAttribPointer(ML.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(ML.aPos);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.nbo);
        gl.vertexAttribPointer(ML.aNor, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(ML.aNor);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, c.ibo);
        gl.drawElements(gl.TRIANGLES, c.count, c.type, 0);
      }
      gl.disableVertexAttribArray(ML.aPos);
      gl.disableVertexAttribArray(ML.aNor);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.CULL_FACE);
    }
    function drawPaths() {
      if (!S.pathBuf || !S.path) return;
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(LL.uMVP, false, S.mvp);
      gl.uniform2f(LL.uViewport, S.size.w, S.size.h);
      gl.uniform2f(LL.uOffset, 0, 0);
      gl.uniform1f(LL.uUseTint, 0);
      gl.uniform3f(LL.uTint, 1, 0, 0);
      bindLineBuf(S.pathBuf);
      for (const r of S.path.ranges) {
        if (!rangeVisible(r)) continue;
        const dim = S.hlTool != null && r.tool !== S.hlTool;
        // 淡化順序與 view2d 一致：先看「非高亮刀」，再看「同一行已有補正段的 programmed 段」
        gl.uniform1f(LL.uAlpha, dim ? 0.12 : (r.faded ? 0.35 : (r.cls === 'feed' ? 0.95 : (r.cls === 'rotate' ? 0.3 : 0.55))));
        gl.drawArrays(gl.LINES, r.first, r.count);
      }
      gl.disableVertexAttribArray(LL.aPos);
      gl.disableVertexAttribArray(LL.aColor);
    }
    function drawHighlight() {
      if (S.hlLine == null || !S.path || !S.pathBuf) return;
      const recs = S.path.byLine.get(S.hlLine);
      if (!recs || !recs.length) return;
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(LL.uMVP, false, S.mvp);
      gl.uniform2f(LL.uViewport, S.size.w, S.size.h);
      const rgb = hexRgb(C.highlight);
      gl.uniform3f(LL.uTint, rgb[0], rgb[1], rgb[2]);
      gl.uniform1f(LL.uUseTint, 1);
      gl.uniform1f(LL.uAlpha, 1);
      bindLineBuf(S.pathBuf);
      gl.disable(gl.DEPTH_TEST);
      // 加粗：同一批頂點以畫面空間微偏移多畫幾次（WebGL 的 lineWidth 多數瀏覽器只支援 1）
      const offs = [[0, 0], [1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4], [1, 1], [-1, -1], [1, -1], [-1, 1]];
      for (const o of offs) {
        gl.uniform2f(LL.uOffset, o[0], o[1]);
        for (const r of recs) gl.drawArrays(gl.LINES, r.first, r.count);
      }
      gl.uniform2f(LL.uOffset, 0, 0);
      gl.uniform1f(LL.uUseTint, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.disableVertexAttribArray(LL.aPos);
      gl.disableVertexAttribArray(LL.aColor);
    }
    /**
     * 剖面平面。畫在最後、而且不寫深度：它是一片參考用的玻璃，
     * 讓人一眼看出旁邊那張 2D 剖面是從哪一刀切下去的，不該擋住它後面的路徑。
     */
    function drawSection() {
      if (!S.sectionFillBuf || !S.sectionEdgeBuf) return;
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(LL.uMVP, false, S.mvp);
      gl.uniform2f(LL.uViewport, S.size.w, S.size.h);
      gl.uniform2f(LL.uOffset, 0, 0);
      gl.uniform1f(LL.uUseTint, 0);
      gl.depthMask(false);
      gl.uniform1f(LL.uAlpha, S.section.clip ? 0.1 : 0.16);
      bindLineBuf(S.sectionFillBuf);
      gl.drawArrays(gl.TRIANGLES, 0, S.sectionFillBuf.count);
      gl.uniform1f(LL.uAlpha, 0.9);
      bindLineBuf(S.sectionEdgeBuf);
      gl.drawArrays(gl.LINES, 0, S.sectionEdgeBuf.count);
      gl.depthMask(true);
      gl.disableVertexAttribArray(LL.aPos);
      gl.disableVertexAttribArray(LL.aColor);
    }

    function drawSimpleLines(buf, alpha) {
      if (!buf) return;
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(LL.uMVP, false, S.mvp);
      gl.uniform2f(LL.uViewport, S.size.w, S.size.h);
      gl.uniform2f(LL.uOffset, 0, 0);
      gl.uniform1f(LL.uUseTint, 0);
      gl.uniform1f(LL.uAlpha, alpha);
      bindLineBuf(buf);
      gl.drawArrays(gl.LINES, 0, buf.count);
      gl.disableVertexAttribArray(LL.aPos);
      gl.disableVertexAttribArray(LL.aColor);
    }

    function render() {
      if (S.destroyed || S.lost) return;
      if (!syncSize()) return;
      if (S.needFit) fit(false);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const bg = hexRgb(C.bg);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      computeMVP();
      drawMesh();
      if (S.visible.stock) drawSimpleLines(S.stockBuf, 0.9);
      drawSimpleLines(S.axesBuf, 1);
      drawPaths();
      drawHighlight();
      drawSection();
      stepInertia();
      updateHud();
    }

    function stepInertia() {
      if (reduced) return;
      if (S.drag) return;
      if (Math.abs(S.vel.az) < 1e-5 && Math.abs(S.vel.el) < 1e-5) { S.vel.az = 0; S.vel.el = 0; return; }
      S.cam.az += S.vel.az;
      S.cam.el = clamp(S.cam.el + S.vel.el, EL_MIN, EL_MAX);
      S.vel.az *= 0.90; S.vel.el *= 0.90;
      requestRender();
    }

    // ---- HUD 覆蓋層 ------------------------------------------------------
    function ensureHud() {
      if (!S.hudEnabled || S.hud || S.destroyed) return null;
      const parent = canvas.parentNode;
      if (!parent || !parent.appendChild || typeof document.createElement !== 'function') return null;
      const d = document.createElement('div');
      d.className = 'nc-view3d-hud';
      parent.appendChild(d);
      S.hud = d;
      return d;
    }
    function updateHud() {
      if (!S.hudEnabled) return;
      const d = S.hud || ensureHud();
      if (!d) return;
      const parts = [];
      parts.push('<span class="tag">3D 成品</span>');
      const sc = SCENARIO_LABEL[S.data.scenario];
      if (sc) parts.push('<span class="tag">' + sc + '</span>');
      if (S.building) parts.push('<span class="tag build">建網格 ' + Math.round(S.buildProgress * 100) + '%</span>');
      else if (S.meshInfo.triangles) parts.push('<span class="tag">' + (S.meshInfo.triangles / 1000).toFixed(0) + ' k 三角</span>');
      if (S.meshInfo.downsample > 1) parts.push('<span class="tag warn">已降採樣顯示（1/' + S.meshInfo.downsample + '）</span>');
      if (S.snapshotIndex != null) parts.push('<span class="tag">模擬到第 ' + (S.snapshotIndex + 1) + ' 把刀</span>');
      if (S.section.axis) {
        const at = S.section.axis.toUpperCase() + ' = ' + (Math.round(S.section.value * 100) / 100);
        parts.push('<span class="tag">' + (S.section.clip ? '剖切 ' : '剖面 ') + at + '</span>');
      }
      const html = parts.join('');
      if (d._html !== html) { d.innerHTML = html; d._html = html; }
    }

    // ---- 互動 ------------------------------------------------------------
    function eventPos(ev) {
      const r = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: S.size.w, height: S.size.h };
      const kx = r.width ? S.size.w / r.width : 1, ky = r.height ? S.size.h / r.height : 1;
      return [(ev.clientX - r.left) * kx, (ev.clientY - r.top) * ky];
    }
    function worldPerPixel() {
      return 2 * S.cam.dist * Math.tan(S.cam.fov / 2) / Math.max(1, S.size.h);
    }
    function panBy(dx, dy) {
      const eye = eyePos();
      const f = normalize3([S.cam.target[0] - eye[0], S.cam.target[1] - eye[1], S.cam.target[2] - eye[2]]);
      const s = normalize3(cross3(f, [0, 0, 1]));
      const u = cross3(s, f);
      const k = worldPerPixel();
      for (let i = 0; i < 3; i++) S.cam.target[i] += (-dx * s[i] + dy * u[i]) * k;
    }
    function zoomBy(f) {
      S.cam.dist = clamp(S.cam.dist * f, Math.max(1e-3, (S.cam.radius || 50) * 0.02), (S.cam.radius || 50) * 60);
    }
    function setDragClass(on) {
      if (canvas.classList && typeof canvas.classList.toggle === 'function') canvas.classList.toggle('is-dragging', on);
    }
    function pickAt(mx, my) {
      if (!S.path || !S.path.segRanges.length) return null;
      computeMVP();
      const m = S.mvp, w = S.size.w, h = S.size.h, P = S.path.positions;
      let best = null, bd = PICK_PX, bz = Infinity;
      for (const r of S.path.segRanges) {
        if (!isVisible(r.seg)) continue;
        for (let i = r.first; i < r.first + r.count; i += 2) {
          const a = projectPoint(m, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], w, h);
          if (!a) continue;
          const j = i + 1;
          const b = projectPoint(m, P[j * 3], P[j * 3 + 1], P[j * 3 + 2], w, h);
          if (!b) continue;
          const d = distPointSeg2D(mx, my, a.x, a.y, b.x, b.y);
          const z = (a.z + b.z) / 2;
          if (d < bd - 1e-6 || (d <= bd + 1e-6 && z < bz)) { bd = d; bz = z; best = r.seg; }
        }
      }
      if (best && S.pickCb) { try { S.pickCb(best.line, best); } catch (e) { /* 忽略 */ } }
      return best ? { seg: best, dist: bd } : null;
    }

    function onDown(ev) {
      if (ev.preventDefault && ev.pointerType !== 'mouse') ev.preventDefault();
      const [mx, my] = eventPos(ev);
      if (ev.pointerId != null) S.pointers.set(ev.pointerId, [mx, my]);
      if (S.pointers.size === 2) {
        const pts = Array.from(S.pointers.values());
        S.pinch = { d: Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]), c: [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] };
        S.drag = null;
        return;
      }
      const btn = ev.button == null ? 0 : ev.button;
      S.drag = { sx: mx, sy: my, lx: mx, ly: my, moved: false, mode: (btn === 0 ? 'orbit' : 'pan'), id: ev.pointerId };
      S.vel.az = 0; S.vel.el = 0;
      if (ev.pointerId != null && typeof canvas.setPointerCapture === 'function') { try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ } }
    }
    function onMove(ev) {
      const [mx, my] = eventPos(ev);
      if (ev.pointerId != null && S.pointers.has(ev.pointerId)) S.pointers.set(ev.pointerId, [mx, my]);
      if (S.pinch && S.pointers.size === 2) {
        const pts = Array.from(S.pointers.values());
        const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
        const c = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
        if (S.pinch.d > 1 && d > 1) zoomBy(S.pinch.d / d);
        panBy(c[0] - S.pinch.c[0], c[1] - S.pinch.c[1]);
        S.pinch = { d, c };
        requestRender();
        return;
      }
      const dr = S.drag;
      if (!dr) return;
      const dx = mx - dr.lx, dy = my - dr.ly;
      dr.lx = mx; dr.ly = my;
      if (!dr.moved && Math.hypot(mx - dr.sx, my - dr.sy) > DRAG_PX) { dr.moved = true; setDragClass(true); }
      if (!dr.moved) return;
      if (dr.mode === 'orbit') {
        const kaz = -0.0075, kel = 0.0075;
        S.cam.az += dx * kaz;
        S.cam.el = clamp(S.cam.el + dy * kel, EL_MIN, EL_MAX);
        S.vel.az = dx * kaz * 0.6; S.vel.el = dy * kel * 0.6;
      } else {
        panBy(dx, dy);
      }
      requestRender();
    }
    function onUp(ev) {
      const dr = S.drag;
      if (ev.pointerId != null) S.pointers.delete(ev.pointerId);
      if (S.pointers.size < 2) S.pinch = null;
      S.drag = null;
      setDragClass(false);
      if (ev.pointerId != null && typeof canvas.releasePointerCapture === 'function') { try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ } }
      if (dr && !dr.moved && dr.mode === 'orbit') { const [mx, my] = eventPos(ev); pickAt(mx, my); }
      requestRender();
    }
    function onCancel(ev) {
      if (ev && ev.pointerId != null) S.pointers.delete(ev.pointerId);
      S.drag = null; S.pinch = null; setDragClass(false);
    }
    function onWheel(ev) {
      if (ev.preventDefault) ev.preventDefault();
      zoomBy(Math.exp((ev.deltaY || 0) * 0.0012));
      requestRender();
    }
    function onDbl(ev) { if (ev.preventDefault) ev.preventDefault(); fit(true); }
    function onCtx(ev) { if (ev.preventDefault) ev.preventDefault(); }
    function onLost(ev) { if (ev.preventDefault) ev.preventDefault(); S.lost = true; if (typeof console !== 'undefined') console.warn('[view3d] WebGL context 遺失'); }
    function onRestored() {
      if (S.destroyed) return;
      if (typeof console !== 'undefined') console.warn('[view3d] WebGL context 已還原，重建資源');
      // context 遺失時 program／shader／buffer 全部失效，locations 也不能沿用 → 整組重建。
      S.meshChunks = []; S.pathBuf = null; S.stockBuf = null; S.axesBuf = null;
      meshProg = lineProg = null;
      if (!linkPrograms()) {
        if (typeof console !== 'undefined') console.error('[view3d] context 還原後著色器重建失敗，3D 停用');
        return;   // S.lost 維持 true，render() 直接跳出，不會畫出壞畫面
      }
      S.lost = false;
      rebuildPath(); rebuildStock(); rebuildAxes(); rebuildMesh();
    }

    const usePointer = typeof PointerEvent !== 'undefined';
    const evNames = usePointer
      ? ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave']
      : ['mousedown', 'mousemove', 'mouseup', 'mouseout', 'mouseleave'];
    const listeners = [
      ['wheel', onWheel, { passive: false }],
      [evNames[0], onDown], [evNames[1], onMove], [evNames[2], onUp],
      [evNames[3], onCancel], [evNames[4], onCancel],
      ['dblclick', onDbl], ['contextmenu', onCtx],
      ['webglcontextlost', onLost], ['webglcontextrestored', onRestored],
    ];
    if (typeof canvas.addEventListener === 'function') for (const l of listeners) canvas.addEventListener(l[0], l[1], l[2]);

    let ro = null, winResize = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { if (!S.destroyed && syncSize()) requestRender(); });
      try { ro.observe(canvas); } catch (e) { ro = null; }
    }
    if (!ro && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      winResize = () => { if (!S.destroyed && syncSize()) requestRender(); };
      window.addEventListener('resize', winResize);
    }

    // ---- 公開 API --------------------------------------------------------
    const api = {
      canvas,
      gl,
      isWebGL2: got.gl2,
      hasUint32: uint32,
      /** @param {{sim?:Object, segments?:Array, stock?:Object, toolTable?:Object, scenario?:string, onProgress?:Function}} d */
      setData(d) {
        d = d || {};
        S.data = {
          sim: d.sim || null,
          segments: Array.isArray(d.segments) ? d.segments : [],
          stock: d.stock || null,
          toolTable: d.toolTable || null,
          scenario: d.scenario || 'off',
          // 第四軸：{center:{y,z}, radius?}。有值就把路徑換算到工件座標、素材改畫圓棒、
          // 不建高度圖成品（那在四軸下是把所有角度疊在一起的錯誤模型）。
          rotary: d.rotary || null,
        };
        if (typeof d.onProgress === 'function') S.progressCb = d.onProgress;
        S.snapshotIndex = null;
        S.heightArr = S.data.sim ? S.data.sim.height : null;
        S.extraMap = S.data.sim ? S.data.sim.extra : null;
        S.needFit = true;
        rebuildPath(); rebuildStock(); rebuildAxes(); rebuildSection();
        updateZRange(S.data.sim ? S.data.sim.floorZ : NaN, NaN);
        rebuildMesh();
        fit(false);
        requestRender();
        return api;
      },
      /** 只換高度（例如改刀具表後重算）；拓樸相容時走「只更新 Z 與法線」的快路徑 */
      setHeights(heightArr) {
        if (!S.data.sim || !heightArr) return api;
        S.heightArr = heightArr;
        if (!fastUpdateHeights(heightArr)) rebuildMesh();
        return api;
      },
      /** 顯示第 i 個 snapshot 的高度（null → 最終高度） */
      setSnapshot(i) {
        const sim = S.data.sim;
        if (!sim) return api;
        const snap = (i != null && Array.isArray(sim.snapshots)) ? sim.snapshots[i] : null;
        S.snapshotIndex = snap ? i : null;
        const arr = snap ? snap.height : sim.height;
        if (arr === S.heightArr) { updateHud(); return api; }
        S.heightArr = arr;
        S.extraMap = snap ? snap.extra : sim.extra;
        if (!fastUpdateHeights(arr)) rebuildMesh();
        updateHud();
        return api;
      },
      setVisible(o) {
        o = o || {};
        if ('rapid' in o) S.visible.rapid = !!o.rapid;
        if ('feed' in o) S.visible.feed = !!o.feed;
        if ('stock' in o) S.visible.stock = !!o.stock;
        if ('surface' in o) S.visible.surface = !!o.surface;
        if ('rotary' in o) S.visible.rotary = !!o.rotary;
        if ('tools' in o) S.visible.tools = o.tools == null ? null : (o.tools instanceof Set ? o.tools : new Set(o.tools));
        requestRender();
        return api;
      },
      getVisible() {
        return { rapid: S.visible.rapid, feed: S.visible.feed, stock: S.visible.stock, surface: S.visible.surface, rotary: S.visible.rotary, tools: S.visible.tools ? new Set(S.visible.tools) : null };
      },
      /**
       * 剖面標示。`axis` 給 'x'／'y' 就在那個位置畫一片半透明的平面，
       * `clip:true` 再把其中一邊切掉——旁邊的 2D 剖面圖畫的就是這個斷面。
       * 切掉哪一邊由 `flip` 決定（見 clipPlaneFor），**不會自己換邊**。
       * `axis:null`（或不給）關掉整組。
       * @param {{axis?:'x'|'y'|null, value?:number, clip?:boolean, flip?:boolean}|null} o
       */
      setSection(o) {
        o = o || {};
        const axis = (o.axis === 'x' || o.axis === 'y') ? o.axis : null;
        const value = Number.isFinite(o.value) ? Number(o.value) : S.section.value;
        const clip = 'clip' in o ? !!o.clip : S.section.clip;
        const flip = 'flip' in o ? !!o.flip : S.section.flip;
        const changed = axis !== S.section.axis || value !== S.section.value;
        S.section = { axis, value, clip, flip };
        if (changed) rebuildSection();
        requestRender();
        return api;
      },
      getSection() { return { axis: S.section.axis, value: S.section.value, clip: S.section.clip, flip: S.section.flip }; },
      highlightLine(n) { S.hlLine = n == null ? null : Number(n); requestRender(); return api; },
      highlightTool(t) { S.hlTool = t == null ? null : Number(t); requestRender(); return api; },
      onPick(cb) { S.pickCb = typeof cb === 'function' ? cb : null; return api; },
      onProgress(cb) { S.progressCb = typeof cb === 'function' ? cb : null; return api; },
      /** 降採樣：1/2/4… 或 'auto' */
      setDownsample(k) {
        S.downsampleOpt = (k === 'auto' || k == null) ? 'auto' : Math.max(1, Math.round(k));
        rebuildMesh();
        return api;
      },
      getDownsample() { return S.meshInfo.downsample; },
      /** 相機：{az, el}（度）、dist、target */
      setCamera(o) {
        o = o || {};
        if (Number.isFinite(o.az)) S.cam.az = o.az * DEG;
        if (Number.isFinite(o.el)) S.cam.el = clamp(o.el * DEG, EL_MIN, EL_MAX);
        if (Number.isFinite(o.dist)) S.cam.dist = Math.max(1e-3, o.dist);
        if (Array.isArray(o.target)) S.cam.target = o.target.slice(0, 3);
        requestRender();
        return api;
      },
      getCamera() { return { az: S.cam.az / DEG, el: S.cam.el / DEG, dist: S.cam.dist, target: S.cam.target.slice(), fov: S.cam.fov / DEG }; },
      fit() { return fit(true); },
      resize() { if (syncSize()) requestRender(); return api; },
      render() { render(); return api; },
      requestRender() { requestRender(); return api; },
      pickAt(sx, sy) { return pickAt(sx, sy); },
      /** 世界座標 → 畫面 CSS px；在相機後方回 null（與 view2d.worldToScreen 對應） */
      worldToScreen(x, y, z) {
        computeMVP();
        const p = projectPoint(S.mvp, x, y, z, S.size.w, S.size.h);
        return p ? [p.x, p.y] : null;
      },
      getInfo() {
        return {
          webgl2: got.gl2, uint32, downsample: S.meshInfo.downsample, vertices: S.meshInfo.vertices,
          triangles: S.meshInfo.triangles, chunks: S.meshInfo.chunks, building: S.building,
          progress: S.buildProgress, pathVertices: S.path ? S.path.vertexCount : 0,
          reducedMotion: reduced, size: { w: S.size.w, h: S.size.h, dpr: S.dpr },
          snapshotIndex: S.snapshotIndex, zRange: S.zRange.slice(),
        };
      },
      getSize() { return { w: S.size.w, h: S.size.h, dpr: S.dpr }; },
      setHudEnabled(on) {
        S.hudEnabled = !!on;
        if (!on && S.hud && S.hud.parentNode) { S.hud.parentNode.removeChild(S.hud); S.hud = null; }
        else if (on) updateHud();
        return api;
      },
      dispose() {
        if (S.destroyed) return;
        S.destroyed = true;
        S.buildToken++;
        if (typeof canvas.removeEventListener === 'function') for (const l of listeners) canvas.removeEventListener(l[0], l[1], l[2]);
        if (ro) { try { ro.disconnect(); } catch (e) { /* 忽略 */ } ro = null; }
        if (winResize && typeof window !== 'undefined') { window.removeEventListener('resize', winResize); winResize = null; }
        if (S.hud && S.hud.parentNode) { S.hud.parentNode.removeChild(S.hud); }
        S.hud = null;
        freeMesh();
        freeLineBuf(S.pathBuf); freeLineBuf(S.stockBuf); freeLineBuf(S.axesBuf);
        freeLineBuf(S.sectionFillBuf); freeLineBuf(S.sectionEdgeBuf);
        S.pathBuf = S.stockBuf = S.axesBuf = S.sectionFillBuf = S.sectionEdgeBuf = null;
        S.path = null;
        try { gl.deleteProgram(meshProg); gl.deleteProgram(lineProg); } catch (e) { /* 忽略 */ }
        // 刻意不呼叫 WEBGL_lose_context.loseContext()：同一個 canvas 的 context 一旦弄丟就再也建不回來，
        // 分頁在 2D／3D 之間來回切時會直接掛掉。buffer 與 program 都刪乾淨了，其餘交給 GC。
      },
    };
    api.destroy = api.dispose;   // 與 view2d.js 的命名相容

    syncSize();
    rebuildAxes();
    requestRender();
    return api;
  }

  NC.ui.view3d.isSupported = isSupported;
  NC.ui.createView3D = createView3D;
  NC.ui.view3d.createView3D = createView3D;
})(globalThis.NC = globalThis.NC || {});
