/*
 * NC 預演台 — simulation.js：heightmap 材料模擬（NC.sim）
 *
 * 模型：素材以固定格距（cell）的高度圖（Float32Array）表示，每格記錄「該點目前的材料頂面 Z」。
 * 治具以「不可切的材料」寫進高度圖，並用 mask 記錄格子所屬治具。
 * 每個切削段（feed / arc / drill）依刀具足跡把足跡下的格子壓低（取 min）；
 * 快速移動（rapid）不改材料，只檢查足跡下是否有材料高於刀底（R27 碰撞）。
 *
 * 足跡（刀底相對刀尖的高度 dz(d)，d = 距刀心的水平距離，d < 半徑才算在足跡內）：
 *   endmill / facemill / reamer / unknown → 圓盤 dz = 0
 *   drill / spot / chamfer               → 錐形 dz = d / tan(夾角/2)（倒角刀即倒錐，尖端在下）
 *   ballmill                              → 球面 dz = r − sqrt(r² − d²)
 *   tap                                   → 不改材料（只算時間與碰撞）
 *
 * 掃描方式：不逐點蓋章，而是對每段算出「掃過區域」（線段＝膠囊、圓弧＝環帶）內每個格子到路徑的最短距離，
 * 直接算出刀底高度；Z 有變化且足跡非平面時，切成小段（每段 Z 落差 ≤ cell/2）以段內最低 Z 近似（略偏保守）。
 * 平面足跡 + 直線斜下（ramp）則用精確的膠囊公式。
 *
 * 匯出：NC.sim.create(stock, cell) → Sim；NC.sim.run(sim, scenarioResult, toolTable, settings, opts) → Promise<SimResult>
 *       NC.sim.heightAt(simOrResult, x, y)、NC.sim.profileFor(tool)、NC.sim.selectSegments(segments)
 */
(function (NC) {
  'use strict';
  const U = NC.util;

  const FLAT = 0, CONE = 1, SPHERE = 2;
  const TWO_PI = Math.PI * 2;
  const Z_TOL = 0.01;        // 幾何比較的浮點容差（不是碰撞的判定門檻，見下面兩個常數）
  /**
   * 碰撞（R27）的判定門檻與嚴重度分級。
   * 0.01 mm 是「浮點容差」等級，但高度圖的量化誤差與粗銑留量本來就在 0.05–0.2 mm，
   * 用它當門檻的話，任何一支粗／精分刀的程式都會拿到「干涉 0.05 mm」的紅字
   * ——例如前一刀面銑到 Z0.05、這一刀 G0 到 Z0。填了真實素材反而多一筆紅字，
   * 現場只會學會不要填。所以：門檻和嚴重度分開，而且都可以在設定裡調。
   */
  const COLLIDE_IGNORE_MM = 0.2;   // 小於這個深度不報（量化誤差、粗銑留量）
  const COLLIDE_ERROR_MM = 2;      // 「路徑掃過」的紅字門檻；中間是黃字
  const PLUNGE_ERROR_MM = 0.5;     // 「下刀終點停在材料裡」比較沒有模糊空間，門檻低一些
  const XY_TOL = 1e-6;       // 足跡邊緣剛好相切（d == r）不算切到
  const DEFAULT_DIAMETER = 10;
  const MAX_SNAPSHOTS = 25;
  // 所有快照加起來的記憶體預算（位元組）。格距 0.1 mm 時 樣本 A 一份就 17 MB，
  // 固定存 25 份會變成 750 MB；瀏覽器分頁重新分析時峰值還要再乘二。
  const SNAPSHOT_BUDGET_BYTES = 64 * 1024 * 1024;
  // 會在孔底停留 P 的固定循環（時間估算要把 P 算進去）
  const DWELL_CYCLES = new Set(['G82', 'G88', 'G89', 'G76', 'G87']);

  const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? () => performance.now()
    : () => Date.now();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  /**
   * 建立模擬狀態。
   * @param {Stock} stock
   * @param {number} cell 格距 mm
   * @returns {Sim}
   */
  function create(stock, cell) {
    if (!stock || !stock.min || !stock.max) throw new Error('NC.sim.create：需要 stock.min / stock.max');
    cell = (cell > 0) ? cell : 0.5;
    const nx = Math.ceil((stock.max.x - stock.min.x) / cell - 1e-9) + 1;
    const ny = Math.ceil((stock.max.y - stock.min.y) / cell - 1e-9) + 1;
    if (!(nx > 0 && ny > 0)) throw new Error('NC.sim.create：素材尺寸不合法');
    const origin = { x: stock.min.x, y: stock.min.y };
    const height = new Float32Array(nx * ny).fill(stock.max.z);
    const mask = new Uint8Array(nx * ny);
    let topZ = stock.max.z;
    const fixtures = Array.isArray(stock.fixtures) ? stock.fixtures : [];
    fixtures.forEach((f, fi) => {
      if (!f || !f.min || !f.max) return;
      const ix0 = Math.max(0, Math.ceil((f.min.x - origin.x) / cell - 1e-9));
      const ix1 = Math.min(nx - 1, Math.floor((f.max.x - origin.x) / cell + 1e-9));
      const iy0 = Math.max(0, Math.ceil((f.min.y - origin.y) / cell - 1e-9));
      const iy1 = Math.min(ny - 1, Math.floor((f.max.y - origin.y) / cell + 1e-9));
      if (ix0 > ix1 || iy0 > iy1) return; // 治具完全在素材範圍外：本版格子只涵蓋素材，略過（見提案）
      const top = Math.max(f.max.z, stock.max.z);
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const idx = iy * nx + ix;
          height[idx] = Math.max(height[idx], f.max.z);
          mask[idx] = Math.min(255, fi + 1);
        }
      }
      if (top > topZ) topZ = top;
    });
    return {
      cell, nx, ny, origin, height,
      initial: height.slice(),
      floorZ: stock.min.z,
      topZ,
      mask,
      stock,
      scenario: null,
      snapshots: [],
      events: [],
      time: { perOp: [], total: 0, pre: 0 },
    };
  }

  // ---------------------------------------------------------------------------
  // 刀具足跡剖面
  // ---------------------------------------------------------------------------
  /**
   * 由刀具資料算出足跡剖面。
   * @param {Tool|null|undefined} tool
   * @returns {{r:number, dia:number, kind:number, tanHalf:number, cuts:boolean, type:string, t:number|null}}
   */
  function profileFor(tool) {
    const type = tool && tool.type ? tool.type : 'unknown';
    const dia = (tool && tool.diameter > 0) ? tool.diameter : DEFAULT_DIAMETER;
    let kind = FLAT, tanHalf = 0, cuts = true;
    switch (type) {
      case 'drill':
      case 'spot':
      case 'chamfer': {
        const def = type === 'drill' ? 118 : 90;
        const ang = (tool && tool.angle > 0 && tool.angle < 180) ? tool.angle : def;
        kind = CONE;
        tanHalf = Math.tan((ang / 2) * Math.PI / 180);
        break;
      }
      case 'ballmill':
        kind = SPHERE;
        break;
      case 'tap':
        cuts = false;
        break;
      default:
        break; // endmill / facemill / reamer / unknown → 圓盤
    }
    return { r: dia / 2, dia, kind, tanHalf, cuts, type, t: tool ? tool.t : null };
  }

  /** 刀底相對刀尖的高度 */
  function dzOf(prof, d) {
    if (prof.kind === CONE) return d / prof.tanHalf;
    if (prof.kind === SPHERE) {
      const r = prof.r;
      return r - Math.sqrt(Math.max(0, r * r - d * d));
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // 段落挑選：同一行若有 compensated 段，programmed 段不用
  // ---------------------------------------------------------------------------
  function selectSegments(segments) {
    const compLines = new Set();
    for (const s of segments) if (s && s.path === 'compensated') compLines.add(s.line);
    return segments.filter((s) => s && s.from && s.to && (s.path === 'compensated' || !compLines.has(s.line)));
  }

  // ---------------------------------------------------------------------------
  // 幾何小工具
  // ---------------------------------------------------------------------------
  function normAngle(a) { // → [0, 2π)
    a = a % TWO_PI;
    if (a < 0) a += TWO_PI;
    return a;
  }
  /** 圓弧掃過角度（0, 2π]；起終點重合 → 整圓 */
  function arcSweep(th0, th1, cw, coincident) {
    if (coincident) return TWO_PI;
    const s = normAngle(cw ? th0 - th1 : th1 - th0);
    return s < 1e-9 ? TWO_PI : s;
  }
  function arcBounds(cx, cy, R, th0, sweep, cw) {
    const dir = cw ? -1 : 1;
    const th1 = th0 + dir * sweep;
    let xmin = Math.min(cx + R * Math.cos(th0), cx + R * Math.cos(th1));
    let xmax = Math.max(cx + R * Math.cos(th0), cx + R * Math.cos(th1));
    let ymin = Math.min(cy + R * Math.sin(th0), cy + R * Math.sin(th1));
    let ymax = Math.max(cy + R * Math.sin(th0), cy + R * Math.sin(th1));
    for (let k = 0; k < 4; k++) {
      const ang = k * Math.PI / 2;
      if (normAngle(dir * (ang - th0)) <= sweep + 1e-9) {
        const px = cx + R * Math.cos(ang), py = cy + R * Math.sin(ang);
        if (px < xmin) xmin = px; if (px > xmax) xmax = px;
        if (py < ymin) ymin = py; if (py > ymax) ymax = py;
      }
    }
    return { xmin, xmax, ymin, ymax };
  }
  function segLength(seg) {
    const a = seg.from, b = seg.to;
    if (seg.kind === 'arc' && seg.arc && seg.arc.center) {
      const c = seg.arc.center;
      const th0 = Math.atan2(a.y - c.y, a.x - c.x), th1 = Math.atan2(b.y - c.y, b.x - c.x);
      const coincident = Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
      const sweep = arcSweep(th0, th1, !!seg.arc.cw, coincident);
      const R = (Math.hypot(a.x - c.x, a.y - c.y) + Math.hypot(b.x - c.x, b.y - c.y)) / 2;
      return Math.hypot(sweep * R, b.z - a.z);
    }
    return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }

  // ---------------------------------------------------------------------------
  // 切削：線段（膠囊）
  // 前提：za === zb，或足跡為平面（此時用精確膠囊公式），或呼叫端已把垂直段壓成 za === zb
  // ---------------------------------------------------------------------------
  function cutLine(sim, ax, ay, bx, by, za, zb, prof, acc) {
    const { cell, nx, ny, origin, height, mask, floorZ } = sim;
    const r = prof.r - XY_TOL, r2 = r * r;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
    const constZ = (za === zb) || L < XY_TOL;
    const zLo = Math.min(za, zb);
    const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - prof.r - origin.x) / cell));
    const ix1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + prof.r - origin.x) / cell));
    const iy0 = Math.max(0, Math.floor((Math.min(ay, by) - prof.r - origin.y) / cell));
    const iy1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + prof.r - origin.y) / cell));
    if (ix0 > ix1 || iy0 > iy1) return;
    let removed = 0;
    for (let iy = iy0; iy <= iy1; iy++) {
      const cy = origin.y + iy * cell;
      const py = cy - ay;
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = origin.x + ix * cell;
        const px = cx - ax;
        let t = L2 > 0 ? (px * dx + py * dy) / L2 : 0;
        const tc = t < 0 ? 0 : (t > 1 ? 1 : t);
        const ex = px - tc * dx, ey = py - tc * dy;
        const d2 = ex * ex + ey * ey;
        if (d2 >= r2) continue;
        let h;
        if (constZ) {
          h = prof.kind === FLAT ? zLo : zLo + dzOf(prof, Math.sqrt(d2));
        } else {
          // 平面足跡、Z 沿線變化：格子被圓盤蓋到的參數區間 [t−w, t+w] ∩ [0,1]，取區間內最低 Z
          const qx = px - t * dx, qy = py - t * dy;
          const w = Math.sqrt(Math.max(0, r2 - (qx * qx + qy * qy))) / L;
          const s = zb < za ? Math.min(1, t + w) : Math.max(0, t - w);
          h = za + (zb - za) * s;
        }
        if (h < floorZ) h = floorZ;
        const idx = iy * nx + ix;
        const old = height[idx];
        if (h < old - 1e-7) {
          if (mask[idx]) { acc.fixtureHit = mask[idx]; acc.fixturePos = { x: cx, y: cy, z: old }; continue; }
          removed += old - h;
          height[idx] = h;
        }
      }
    }
    acc.removed += removed * cell * cell;
  }

  // ---------------------------------------------------------------------------
  // 切削：圓弧（環帶，固定 Z）
  // ---------------------------------------------------------------------------
  function cutArc(sim, cx0, cy0, R, th0, sweep, cw, z, prof, acc) {
    const { cell, nx, ny, origin, height, mask, floorZ } = sim;
    const r = prof.r - XY_TOL;
    const dir = cw ? -1 : 1;
    const th1 = th0 + dir * sweep;
    const ax = cx0 + R * Math.cos(th0), ay = cy0 + R * Math.sin(th0);
    const bx = cx0 + R * Math.cos(th1), by = cy0 + R * Math.sin(th1);
    const bb = arcBounds(cx0, cy0, R, th0, sweep, cw);
    const ix0 = Math.max(0, Math.floor((bb.xmin - prof.r - origin.x) / cell));
    const ix1 = Math.min(nx - 1, Math.ceil((bb.xmax + prof.r - origin.x) / cell));
    const iy0 = Math.max(0, Math.floor((bb.ymin - prof.r - origin.y) / cell));
    const iy1 = Math.min(ny - 1, Math.ceil((bb.ymax + prof.r - origin.y) / cell));
    if (ix0 > ix1 || iy0 > iy1) return;
    let removed = 0;
    for (let iy = iy0; iy <= iy1; iy++) {
      const cy = origin.y + iy * cell;
      const vy = cy - cy0;
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = origin.x + ix * cell;
        const vx = cx - cx0;
        const rho = Math.sqrt(vx * vx + vy * vy);
        // 先用環帶粗篩：離圓周太遠就不可能在足跡內
        if (Math.abs(rho - R) >= r) continue;
        const delta = normAngle(dir * (Math.atan2(vy, vx) - th0));
        let d;
        if (delta <= sweep + 1e-9) d = Math.abs(rho - R);
        else d = Math.min(Math.hypot(cx - ax, cy - ay), Math.hypot(cx - bx, cy - by));
        if (d >= r) continue;
        let h = prof.kind === FLAT ? z : z + dzOf(prof, d);
        if (h < floorZ) h = floorZ;
        const idx = iy * nx + ix;
        const old = height[idx];
        if (h < old - 1e-7) {
          if (mask[idx]) { acc.fixtureHit = mask[idx]; acc.fixturePos = { x: cx, y: cy, z: old }; continue; }
          removed += old - h;
          height[idx] = h;
        }
      }
    }
    acc.removed += removed * cell * cell;
  }

  /** 對一個切削段蓋章；回傳累積資訊 */
  function cutSegment(sim, seg, prof) {
    const acc = { removed: 0, fixtureHit: 0, fixturePos: null };
    const a = seg.from, b = seg.to;
    const dz = b.z - a.z;
    const sub = sim.cell / 2;
    if (seg.kind === 'arc' && seg.arc && seg.arc.center) {
      const c = seg.arc.center, cw = !!seg.arc.cw;
      const th0 = Math.atan2(a.y - c.y, a.x - c.x), th1 = Math.atan2(b.y - c.y, b.x - c.x);
      const coincident = Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
      const sweep = arcSweep(th0, th1, cw, coincident);
      const R = (Math.hypot(a.x - c.x, a.y - c.y) + Math.hypot(b.x - c.x, b.y - c.y)) / 2;
      if (Math.abs(dz) < 1e-9) {
        cutArc(sim, c.x, c.y, R, th0, sweep, cw, a.z, prof, acc);
      } else {
        // 螺旋：切成小段，每段用段內最低 Z
        const n = Math.max(1, Math.ceil(Math.abs(dz) / sub));
        const dir = cw ? -1 : 1;
        for (let i = 0; i < n; i++) {
          const z0 = a.z + dz * (i / n), z1 = a.z + dz * ((i + 1) / n);
          cutArc(sim, c.x, c.y, R, th0 + dir * sweep * (i / n), sweep / n, cw, Math.min(z0, z1), prof, acc);
        }
      }
      return acc;
    }
    const Lxy = Math.hypot(b.x - a.x, b.y - a.y);
    if (Lxy < XY_TOL) {
      // 垂直下刀（鑽孔）：刀心對齊最近的格點，讓孔心那格剛好等於孔底 Z（否則錐尖落在格與格之間，孔心永遠差一點）
      const z = Math.min(a.z, b.z);
      const sx = sim.origin.x + Math.round((a.x - sim.origin.x) / sim.cell) * sim.cell;
      const sy = sim.origin.y + Math.round((a.y - sim.origin.y) / sim.cell) * sim.cell;
      cutLine(sim, sx, sy, sx, sy, z, z, prof, acc);
    } else if (Math.abs(dz) < 1e-9 || prof.kind === FLAT) {
      cutLine(sim, a.x, a.y, b.x, b.y, a.z, b.z, prof, acc);
    } else {
      const n = Math.max(1, Math.ceil(Math.abs(dz) / sub));
      for (let i = 0; i < n; i++) {
        const s0 = i / n, s1 = (i + 1) / n;
        const z = Math.min(a.z + dz * s0, a.z + dz * s1);
        cutLine(sim, a.x + (b.x - a.x) * s0, a.y + (b.y - a.y) * s0, a.x + (b.x - a.x) * s1, a.y + (b.y - a.y) * s1, z, z, prof, acc);
      }
    }
    return acc;
  }

  // ---------------------------------------------------------------------------
  // 快速移動碰撞檢查：整段用最低 Z（多軸 G0 各軸獨立速率，路徑不確定 → 保守）
  // ---------------------------------------------------------------------------
  function checkRapid(sim, seg, prof) {
    const a = seg.from, b = seg.to;
    const minZ = Math.min(a.z, b.z);
    if (minZ + Z_TOL >= sim.topZ) return null; // 高於所有材料／治具，不可能撞
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    if (L2 < XY_TOL * XY_TOL && b.z >= a.z) return null; // 純垂直上升：只會離開材料
    const { cell, nx, ny, origin, height, mask } = sim;
    const r = prof.r - XY_TOL, r2 = r * r;
    const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - prof.r - origin.x) / cell));
    const ix1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + prof.r - origin.x) / cell));
    const iy0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - prof.r - origin.y) / cell));
    const iy1 = Math.min(ny - 1, Math.ceil((Math.max(a.y, b.y) + prof.r - origin.y) / cell));
    if (ix0 > ix1 || iy0 > iy1) return null;
    let worst = null;
    for (let iy = iy0; iy <= iy1; iy++) {
      const cy = origin.y + iy * cell;
      const py = cy - a.y;
      for (let ix = ix0; ix <= ix1; ix++) {
        const idx = iy * nx + ix;
        const hc = height[idx];
        if (hc <= minZ + Z_TOL) continue; // 這格材料比刀底低，連算距離都免了
        const cx = origin.x + ix * cell;
        const px = cx - a.x;
        let t = L2 > 0 ? (px * dx + py * dy) / L2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const ex = px - t * dx, ey = py - t * dy;
        const d2 = ex * ex + ey * ey;
        if (d2 >= r2) continue;
        const h = prof.kind === FLAT ? minZ : minZ + dzOf(prof, Math.sqrt(d2));
        const excess = hc - h;
        if (excess > Z_TOL && (!worst || excess > worst.excess)) {
          worst = { x: cx, y: cy, z: hc, toolZ: h, tipZ: minZ, cone: prof.kind !== FLAT, excess, fixture: mask[idx] };
        }
      }
    }
    return worst;
  }

  // ---------------------------------------------------------------------------
  // run
  // ---------------------------------------------------------------------------
  function fmtVec(p) { return `X${U.fmt(p.x)} Y${U.fmt(p.y)} Z${U.fmt(p.z)}`; }
  function toolLabel(prof) { return (prof.t != null ? `T${prof.t} ` : '') + `Ø${U.fmt(prof.dia)}`; }

  /**
   * 執行模擬。
   * @param {Sim} sim  由 create() 建立；會被就地修改（height、snapshots、events、time）
   * @param {ScenarioResult} scenarioResult {run, geometry}
   * @param {ToolTable|null} toolTable
   * @param {MachineSettings} settings
   * @param {{fromOpIndex?:number, onProgress?:(p:number)=>void, yieldEveryMs?:number}} [opts]
   * @returns {Promise<SimResult>}
   */
  async function run(sim, scenarioResult, toolTable, settings, opts) {
    opts = opts || {};
    settings = settings || U.defaultSettings();
    const runR = (scenarioResult && scenarioResult.run) || { scenario: 'off', executed: [], ops: [] };
    const geom = (scenarioResult && scenarioResult.geometry) || { segments: [] };
    const scenario = runR.scenario || 'off';
    const ops = runR.ops || [];
    const nOps = ops.length;
    const segs = selectSegments(geom.segments || []);
    const yieldEveryMs = (opts.yieldEveryMs == null) ? 16 : opts.yieldEveryMs;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const rapidRate = settings.rapidRate > 0 ? settings.rapidRate : 20000;
    const plungeFeedMax = settings.plungeFeedMax > 0 ? settings.plungeFeedMax : 300;
    // 碰撞門檻：不小於一個格距（格距 0.5 mm 時，0.2 mm 的高度差本來就分不出來）
    const ignoreMm = Math.max(
      settings.collisionIgnoreMm > 0 ? settings.collisionIgnoreMm : COLLIDE_IGNORE_MM, sim.cell);
    const errorMm = Math.max(ignoreMm,
      settings.collisionErrorMm > 0 ? settings.collisionErrorMm : COLLIDE_ERROR_MM);
    const plungeErrorMm = Math.max(ignoreMm, PLUNGE_ERROR_MM);
    // 快照上限改成「位元組預算」而不是固定份數：格距選 0.1 mm 時
    // 一份 heightmap 就有十幾 MB，25 份會吃掉幾百 MB 把瀏覽器分頁打爆。
    const bytesPerSnap = sim.nx * sim.ny * 4;
    const budgetBytes = settings.snapshotBudgetBytes > 0 ? settings.snapshotBudgetBytes : SNAPSHOT_BUDGET_BYTES;
    const maxSnaps = Math.max(1, Math.min(MAX_SNAPSHOTS, Math.floor(budgetBytes / Math.max(1, bytesPerSnap))));
    const stride = nOps > maxSnaps ? Math.ceil(nOps / maxSnaps) : 1;

    // 刀具查表（同一把刀只算一次足跡剖面）
    const toolMap = new Map();
    if (toolTable && Array.isArray(toolTable.tools)) for (const t of toolTable.tools) if (t) toolMap.set(t.t, t);
    const profCache = new Map();
    const profileOf = (t) => {
      const key = t == null ? '__none' : t;
      let p = profCache.get(key);
      if (!p) { p = profileFor(toolMap.get(t) || null); if (p.t == null) p.t = t; profCache.set(key, p); }
      return p;
    };

    // 起點：fromOpIndex → 用最近的較早 snapshot
    const fromOp = Number.isInteger(opts.fromOpIndex) ? opts.fromOpIndex : 0;
    let base = null;
    if (fromOp > 0 && Array.isArray(sim.snapshots)) {
      for (const s of sim.snapshots) {
        if (s.afterOpIndex < fromOp && s.afterOpIndex < nOps && (!base || s.afterOpIndex > base.afterOpIndex)) base = s;
      }
    }
    const height = sim.height;
    const perOp = new Array(nOps).fill(0);
    let pre = 0;
    let events = [];
    let snapshots = [];
    let closed = -1; // 已結束（已存 snapshot 或不需再跑）的最大 op 索引
    if (base) {
      height.set(base.height);
      closed = base.afterOpIndex;
      snapshots = sim.snapshots.filter((s) => s.afterOpIndex <= closed);
      events = (sim.events || []).filter((e) => e.opIndex == null || e.opIndex <= closed);
      for (let i = 0; i <= closed && i < nOps; i++) perOp[i] = (sim.time.perOp && sim.time.perOp[i]) || 0;
      pre = (sim.time && sim.time.pre) || 0;
    } else {
      height.set(sim.initial);
    }
    sim.scenario = scenario;

    const closeOpsBefore = (o) => {
      for (let i = closed + 1; i < o && i < nOps; i++) {
        if ((i + 1) % stride === 0 || i === nOps - 1) {
          snapshots.push({ afterOpIndex: i, tool: ops[i] ? ops[i].tool : null, height: height.slice() });
        }
        closed = i;
      }
    };
    const seen = new Set(); // 去重：同 rule + line + 類型 只報一次
    const addEvent = (ruleId, line, severity, message, extra) => {
      const key = `${ruleId}|${line}|${extra && extra.kindKey}`;
      if (seen.has(key)) return;
      seen.add(key);
      events.push(U.diag(ruleId, line, severity, message, extra));
    };
    for (const e of events) seen.add(`${e.ruleId}|${e.line}|${e.kindKey || ''}`);

    // 停留時間：G4 的 dwell 動作，以及固定循環孔底的 P 停留（G82／G88／G89／G76／G87）
    for (const blk of runR.executed || []) {
      if (!blk || !Array.isArray(blk.actions) || blk.skipped || blk.ignored) continue;
      for (const act of blk.actions) {
        if (!act) continue;
        let sec = 0;
        if (act.kind === 'dwell' && act.seconds > 0) sec = act.seconds;
        else if (act.kind === 'hole' && act.p > 0 && DWELL_CYCLES.has(act.cycle)) sec = act.p / 1000;
        if (!(sec > 0)) continue;
        const o = blk.opIndex;
        if (base && o <= closed) continue;
        if (o >= 0 && o < nOps) perOp[o] += sec; else pre += sec;
      }
    }

    const total = segs.length || 1;
    let processed = 0;
    let lastYield = now();
    let removedVolume = 0;

    for (const seg of segs) {
      const o = seg.opIndex == null ? -1 : seg.opIndex;
      if (base && o <= closed) { processed++; continue; }
      if (o >= 0) closeOpsBefore(o);
      const prof = profileOf(seg.tool);
      const len = segLength(seg);
      const a = seg.from, b = seg.to;

      // 時間
      let sec = 0;
      if (seg.kind === 'rapid') {
        const dist = seg.nonLinear ? Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z)) : len;
        sec = dist / rapidRate * 60;
      } else if (seg.feed > 0) {
        sec = len / seg.feed * 60;
      }
      if (o >= 0 && o < nOps) perOp[o] += sec; else pre += sec;

      if (seg.kind === 'rapid') {
        // 固定循環內部的快速段（G83 退刀／再進入、G81 回 R…）是刀具在自己剛鑽出的孔內
        // 上下移動，XY 不變；材料模型上孔壁仍高於刀底（鑽尖錐面未切到的部分），
        // 若照一般規則判定會誤報 R27。Fanuc 實機亦以此方式運作，故略過檢查。
        const inHoleRetract = !!seg.sub &&
          Math.abs(b.x - a.x) < 1e-6 && Math.abs(b.y - a.y) < 1e-6;
        if (!seg.refReturn && !inHoleRetract) {
          const hit = checkRapid(sim, seg, prof);
          if (hit && hit.excess > ignoreMm) {
            const pos = { x: hit.x, y: hit.y, z: hit.z };
            const goingDown = b.z < a.z - 1e-9;
            // 錐形刀（鑽頭／倒角刀）比的是「該點下方的刀刃高度」，不是刀尖 Z；
            // 訊息只寫「刀底 Z-0.197」的話，使用者在程式裡找不到這個數字，會以為工具算錯。
            const zWord = hit.cone
              ? `刀刃在 X${U.fmt(hit.x)} Y${U.fmt(hit.y)} 這一點的高度 Z${U.fmt(hit.toolZ)}（刀尖 Z${U.fmt(hit.tipZ)}）`
              : `刀底 Z${U.fmt(hit.toolZ)}`;
            let message, kindKey;
            if (hit.fixture) {
              const fx = sim.stock.fixtures && sim.stock.fixtures[hit.fixture - 1];
              const name = fx && fx.name ? `「${fx.name}」` : `#${hit.fixture}`;
              message = `G0 快速移動撞到治具${name}（${zWord}，治具頂 Z${U.fmt(hit.z)}）`;
              kindKey = 'fixture';
            } else if (goingDown && Math.abs(hit.x - b.x) <= prof.r + sim.cell && Math.abs(hit.y - b.y) <= prof.r + sim.cell) {
              message = `G0 下刀終點在材料內：${zWord}，該處材料高 Z${U.fmt(hit.z)}（干涉 ${U.fmt(hit.excess, 2)} mm）`;
              kindKey = 'plunge';
            } else {
              message = `G0 快速移動路徑穿過材料：${zWord}，路徑上材料最高 Z${U.fmt(hit.z)}（干涉 ${U.fmt(hit.excess, 2)} mm）`;
              kindKey = 'path';
            }
            // 「下刀終點停在材料裡」是刀具真的埋進去，模糊空間小；
            // 「路徑掃過」有可能只是自己剛粗完的底面留量，門檻放寬。
            const lim = kindKey === 'plunge' ? plungeErrorMm : errorMm;
            const sev = (hit.fixture || hit.excess >= lim) ? 'error' : 'warning';
            addEvent('R27', seg.line, sev, message, {
              scenario, pos, opIndex: o, kindKey, magnitude: hit.excess,
              detail: `${toolLabel(prof)}，${fmtVec(a)} → ${fmtVec(b)}；干涉位置 X${U.fmt(hit.x)} Y${U.fmt(hit.y)}。` +
                '快速移動撞到材料或治具會斷刀、撞壞主軸；請先把 Z 抬到安全高度，或改用 G1 進給切入。' +
                (sev === 'warning'
                  ? `\n干涉只有 ${U.fmt(hit.excess, 2)} mm（未達 ${U.fmt(lim)} mm 的紅字門檻）：粗銑留量或素材模型的格距誤差就有這個等級，多半不是真的會撞，但還是看一眼比較保險。`
                  : ''),
            });
          }
        }
      } else if (prof.cuts) {
        const acc = cutSegment(sim, seg, prof);
        removedVolume += acc.removed;
        if (acc.fixtureHit) {
          const fx = sim.stock.fixtures && sim.stock.fixtures[acc.fixtureHit - 1];
          const name = fx && fx.name ? `「${fx.name}」` : `#${acc.fixtureHit}`;
          addEvent('R27', seg.line, 'error', `進給路徑切到治具${name}`, {
            scenario, pos: acc.fixturePos, opIndex: o, kindKey: 'fixtureFeed', magnitude: Infinity,
            detail: `${toolLabel(prof)}，${fmtVec(a)} → ${fmtVec(b)}。刀具會切到治具（夾具、壓板），請確認治具位置或路徑。`,
          });
        }
        if (seg.kind === 'feed' || seg.kind === 'arc') {
          // 重切削：平均切削斷面 = 移除體積 / 段長；門檻 = 全刃寬 × 1.5 倍刀徑深
          if (len > 1e-6) {
            const area = acc.removed / len;
            const limit = prof.dia * 1.5 * prof.dia;
            if (area > limit) {
              addEvent('R28', seg.line, 'warning',
                `重切削：平均切削斷面 ${U.fmt(area, 1)} mm²，相當於全刃寬 × ${U.fmt(area / prof.dia, 1)} mm 深，超過 ${toolLabel(prof)} 的建議上限（1.5 倍刀徑深）`, {
                  scenario, pos: U.clone3(b), opIndex: o, kindKey: 'heavy', magnitude: area,
                  detail: `${fmtVec(a)} → ${fmtVec(b)}，F${U.fmt(seg.feed)}。切削負荷過大可能斷刀或讓主軸過載；請分層或減少每刀切寬。`,
                });
            }
          }
          // 高速下刀：G1 陡降（≥45°）且在材料內、F 超過 plungeFeedMax
          const dz = b.z - a.z, lxy = Math.hypot(b.x - a.x, b.y - a.y);
          if (dz < -1e-6 && lxy <= -dz + 1e-9 && acc.removed > 1e-9 && seg.feed > plungeFeedMax) {
            addEvent('R28', seg.line, 'warning',
              `高速下刀：G1 在材料內下刀 F${U.fmt(seg.feed)}，超過設定上限 F${U.fmt(plungeFeedMax)}`, {
                scenario, pos: U.clone3(b), opIndex: o, kindKey: 'plunge', magnitude: seg.feed,
                detail: `${toolLabel(prof)}，${fmtVec(a)} → ${fmtVec(b)}。平銑刀中心切削能力差，垂直下刀太快容易崩刃；請降低 F 或改用斜下刀／預鑽孔。`,
              });
          }
        }
      }

      processed++;
      if (yieldEveryMs !== Infinity && now() - lastYield >= yieldEveryMs) {
        if (onProgress) onProgress(processed / total);
        await tick();
        lastYield = now();
      }
    }
    closeOpsBefore(nOps);
    if (onProgress) onProgress(1);

    const time = { perOp, total: pre + perOp.reduce((s, v) => s + v, 0), pre };
    sim.snapshots = snapshots;
    sim.events = events;
    sim.time = time;
    sim.removedVolume = removedVolume;
    return {
      scenario,
      cell: sim.cell, nx: sim.nx, ny: sim.ny, origin: { x: sim.origin.x, y: sim.origin.y },
      height: height.slice(),
      floorZ: sim.floorZ,
      snapshots: snapshots.slice(),
      events: events.slice(),
      time,
      mask: sim.mask,
      stock: sim.stock,
      removedVolume,
    };
  }

  // ---------------------------------------------------------------------------
  // 查詢工具
  // ---------------------------------------------------------------------------
  /** 把工件座標換成格索引；超出範圍回 -1 */
  function cellIndex(s, x, y) {
    const ix = Math.round((x - s.origin.x) / s.cell), iy = Math.round((y - s.origin.y) / s.cell);
    if (ix < 0 || iy < 0 || ix >= s.nx || iy >= s.ny) return -1;
    return iy * s.nx + ix;
  }
  /** 讀某點目前高度；超出素材範圍回 null */
  function heightAt(s, x, y) {
    const idx = cellIndex(s, x, y);
    return idx < 0 ? null : s.height[idx];
  }

  NC.sim = { create, run, profileFor, selectSegments, heightAt, cellIndex, segLength };
})(globalThis.NC = globalThis.NC || {});
