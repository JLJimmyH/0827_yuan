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
 *       廢料判定：NC.sim.chunks(simOrResult, heightArr?, scrap?) → ChunkResult、NC.sim.chunkHeights(arr, labels, chunks, floorZ, which)、
 *                 NC.sim.defaultScrap()、NC.sim.normalizeScrap(o)、NC.sim.SCRAP_MAX（見檔尾「廢料判定（chunks）」一節）
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
    if (stock && stock.kind === 'cylinder') return createCylinder(stock, cell);
    if (!stock || !stock.min || !stock.max) throw new Error('NC.sim.create：需要 stock.min / stock.max');
    cell = (cell > 0) ? cell : 0.5;
    const nx = Math.ceil((stock.max.x - stock.min.x) / cell - 1e-9) + 1;
    const ny = Math.ceil((stock.max.y - stock.min.y) / cell - 1e-9) + 1;
    if (!(nx > 0 && ny > 0)) throw new Error('NC.sim.create：素材尺寸不合法');
    const origin = { x: stock.min.x, y: stock.min.y };
    const height = new Float32Array(nx * ny).fill(stock.max.z);
    // 立圓柱素材：圓外根本沒有料。高度圖仍是方格，把圓外的格子直接設到底
    // （＝材料已不存在），碰撞與殘料才不會把外切方框的四個角當成實料。
    if (stock.shape === 'cylZ') {
      const r = Math.min(stock.max.x - stock.min.x, stock.max.y - stock.min.y) / 2;
      const cx = (stock.min.x + stock.max.x) / 2;
      const cy = (stock.min.y + stock.max.y) / 2;
      for (let iy = 0; iy < ny; iy++) {
        const dy = origin.y + iy * cell - cy;
        for (let ix = 0; ix < nx; ix++) {
          const dx = origin.x + ix * cell - cx;
          if (dx * dx + dy * dy > r * r + 1e-9) height[iy * nx + ix] = stock.min.z;
        }
      }
    }
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
      cell, cellX: cell, cellY: cell, wrapY: false,
      nx, ny, origin, height,
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

  /**
   * 圓柱素材（第四軸）。
   *
   * 平面加工用 (X, Y) → Z 的高度圖；圓棒加工用 (X, 弧長) 的格網，每一格記的是
   * **沿著射線的一串材料區間** [lo, hi]（離軸心的距離）——徑向的 dexel。
   * 一格只記一個半徑的話，鉛直的槽壁／孔壁記不下來，只會塌成指向軸心的放射線
   * （見 CONTRACT §13.10）。格網本身與高度圖同構，所以：
   *   - 兩個方向的格距不同（周向格距 = 圓周 / 格數），所以有 cellX／cellY
   *   - 周向是循環的（wrapY），索引要繞回來
   *
   * height 保留＝最外層材料的外緣（下游照舊讀它），空洞放在稀疏的 extra 裡。
   *
   * @param {{kind:'cylinder', radius:number, xMin:number, xMax:number, center?:{y:number,z:number}}} stock
   */
  function createCylinder(stock, cell) {
    const radius = Number(stock.radius);
    if (!(radius > 0)) throw new Error('NC.sim.create：圓柱素材需要 radius > 0');
    const xMin = Number(stock.xMin), xMax = Number(stock.xMax);
    if (!(xMax > xMin)) throw new Error('NC.sim.create：圓柱素材的 xMin/xMax 不合法');
    cell = (cell > 0) ? cell : 0.5;
    const center = { y: (stock.center && Number(stock.center.y)) || 0, z: (stock.center && Number(stock.center.z)) || 0 };
    const nx = Math.ceil((xMax - xMin) / cell - 1e-9) + 1;
    const circumference = 2 * Math.PI * radius;
    // 周向格數取整，格距跟著微調成圓周的等分——這樣繞一圈剛好接回原點，不會有半格接縫
    const ny = Math.max(16, Math.round(circumference / cell));
    const cellY = circumference / ny;
    const height = new Float32Array(nx * ny).fill(radius);
    return {
      cylinder: true,
      cell, cellX: cell, cellY, wrapY: true,
      nx, ny,
      origin: { x: xMin, y: 0 },
      height,
      initial: height.slice(),
      // 每格的材料區間；只有被挖出空洞的格才進來（見「圓柱素材：每格的材料區間」）
      extra: new Map(),
      floorZ: 0,          // 軸心
      topZ: radius,       // 圓棒表面
      radius, center, circumference,
      mask: new Uint8Array(nx * ny),
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
  /** tools.js 沒載入時的最小對照（正常情形一律以 NC.tools.TYPE_INFO 為準） */
  const FALLBACK_SHAPE = {
    drill: 'cone', spot: 'cone', chamfer: 'cone', centerdrill: 'cone', countersink: 'cone', engrave: 'cone',
    ballmill: 'sphere', lollipop: 'sphere', tap: 'none', taplh: 'none',
  };
  function typeInfoOf(type) {
    return (NC.tools && NC.tools.TYPE_INFO) ? NC.tools.TYPE_INFO[type] : null;
  }
  function shapeOf(type) {
    const info = typeInfoOf(type);
    if (info && info.profile) return info.profile;
    return FALLBACK_SHAPE[type] || 'flat';
  }
  function defaultAngleOf(type) {
    if (NC.tools && NC.tools.defaultAngleOf) {
      const a = NC.tools.defaultAngleOf(type);
      if (a > 0) return a;
    }
    return type === 'drill' ? 118 : 90;
  }

  /**
   * 由刀具資料算出足跡剖面。形狀來自 tools.js 的型式表：
   * flat 圓盤（平刀、面銑刀、鉸刀、圓鼻刀……）／cone 錐尖（鑽頭、倒角刀、點鑽……）／
   * sphere 球端（球刀、糖球形銑刀）／none 不移除材料（絲攻、左牙刀）。
   * undercut=true 的刀（T型刀、鳩尾槽刀、糖球形銑刀）會切到上方蓋住的材料，
   * 高度圖模擬做不出底切，只能用最大直徑的圓盤／球端近似 —— 旗標往外傳，讓 UI 有機會講清楚。
   * @param {Tool|null|undefined} tool
   * @returns {{r:number, dia:number, kind:number, tanHalf:number, cuts:boolean, type:string, t:number|null, undercut:boolean}}
   */
  function profileFor(tool) {
    const type = tool && tool.type ? tool.type : 'unknown';
    const dia = (tool && tool.diameter > 0) ? tool.diameter : DEFAULT_DIAMETER;
    const info = typeInfoOf(type);
    let kind = FLAT, tanHalf = 0, cuts = true;
    switch (shapeOf(type)) {
      case 'cone': {
        const ang = (tool && tool.angle > 0 && tool.angle < 180) ? tool.angle : defaultAngleOf(type);
        kind = CONE;
        tanHalf = Math.tan((ang / 2) * Math.PI / 180);
        break;
      }
      case 'sphere':
        kind = SPHERE;
        break;
      case 'none':
        cuts = false;
        break;
      default:
        break; // flat → 圓盤
    }
    return { r: dia / 2, dia, kind, tanHalf, cuts, type, t: tool ? tool.t : null, undercut: !!(info && info.undercut) };
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
  /**
   * 周向（Y／弧長）方向的格索引範圍。
   * 圓柱素材的 Y 是「繞一圈的弧長」，會循環——所以不夾在 [0, ny-1]，
   * 讓索引超出去，由呼叫端取模繞回來。整圈以上就直接夾成一圈（再多也是重複蓋同一格）。
   */
  function yRange(sim, y0, y1) {
    const { cellY, ny, origin, wrapY } = sim;
    let i0 = Math.floor((y0 - origin.y) / cellY);
    let i1 = Math.ceil((y1 - origin.y) / cellY);
    if (!wrapY) return [Math.max(0, i0), Math.min(ny - 1, i1)];
    if (i1 - i0 >= ny) { i0 = 0; i1 = ny - 1; }
    return [i0, i1];
  }

  /** 平面高度圖的線段蓋章（膠囊）。圓柱素材走 scanCyl，不進這裡。 */
  function cutLine(sim, ax, ay, bx, by, za, zb, prof, acc) {
    const { cellX, cellY, nx, origin, height, mask, floorZ } = sim;
    const r = prof.r - XY_TOL, r2 = r * r;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
    const constZ = (za === zb) || L < XY_TOL;
    const zLo = Math.min(za, zb);
    const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - prof.r - origin.x) / cellX));
    const ix1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + prof.r - origin.x) / cellX));
    const yr = yRange(sim, Math.min(ay, by) - prof.r, Math.max(ay, by) + prof.r);
    const iy0 = yr[0], iy1 = yr[1];
    if (ix0 > ix1 || iy0 > iy1) return;
    let removed = 0;
    for (let iy = iy0; iy <= iy1; iy++) {
      const cy = origin.y + iy * cellY;
      const py = cy - ay;
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = origin.x + ix * cellX;
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
        // 鑽穿素材底＝這格沒料了，跟 cutArc 一樣停在 floorZ——
        // 低於底的值會讓剖面把孔底畫成掛在素材下面的料
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
    acc.removed += removed * cellX * cellY;
  }

  // ---------------------------------------------------------------------------
  // 圓柱素材：每格的材料區間（徑向 dexel）
  //
  // 平面高度圖每格只記一個數字，鉛直側壁在徑向射線上會變成「表面有料 → 中間空 →
  // 下面又有料」，記不下來就只能塌成一條指向軸心的放射線——那不是物理事實。
  // 所以圓柱素材每格記的是**一串材料區間** [lo, hi]（離軸心的距離）。
  //
  // 存法是稀疏的：絕大多數格都是實心的 [0, height]，那種格不進 extra，
  // height[idx] 自己就講完了。只有真的被挖出空洞的格才在 extra 裡放完整的區間表
  // （升冪、不重疊、最後一段的 hi 一定等於 height[idx]）。
  // 這樣 height 的語意不變（= 最外層材料的外緣），俯視、剖面 Y、碰撞、R20／R33
  // 這些既有的下游一行都不用改。
  // ---------------------------------------------------------------------------
  const MAX_SPANS = 3;        // 每格最多幾段材料；超過就把最薄的空洞填掉

  /** 複製一份 extra（快照與回傳結果都要獨立的一份，不然會被後續切削改掉） */
  function cloneExtra(extra) {
    const out = new Map();
    if (extra) for (const [k, v] of extra) out.set(k, v.slice());
    return out;
  }

  /** 這一格的材料區間 → [lo0,hi0,lo1,hi1,…]（升冪）。實心格不佔 extra 的位子 */
  function spansOf(sim, idx) {
    const e = sim.extra && sim.extra.get(idx);
    if (e) return e;
    const h = sim.height[idx];
    return h > 0 ? [0, h] : [];
  }

  /** 寫回一格的材料區間；順便維持 height ＝ 最外層的外緣 */
  function setSpans(sim, idx, sp) {
    const n = sp.length;
    sim.height[idx] = n ? sp[n - 1] : sim.floorZ;
    if (n === 0 || (n === 2 && sp[0] <= 0)) sim.extra.delete(idx);   // 實心格：height 就講完了
    else sim.extra.set(idx, sp);
  }

  /**
   * 從一格的材料裡挖掉 [lo, hi]。
   * 回傳挖掉的**面積矩** Σ(hi²−lo²)/2 —— 乘上 Δx·Δθ 就是體積
   * （圓柱格的斷面積隨半徑變，拿長度乘格距會高估外圈、低估內圈）。
   */
  function spanSubtract(sim, idx, lo, hi) {
    if (!(hi > lo)) return 0;
    const cur = spansOf(sim, idx);
    if (!cur.length) return 0;
    const out = [];
    let m2 = 0;
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i], b = cur[i + 1];
      if (hi <= a || lo >= b) { out.push(a, b); continue; }
      const ca = Math.max(a, lo), cb = Math.min(b, hi);
      m2 += (cb * cb - ca * ca) / 2;
      if (a < lo - 1e-9) out.push(a, lo);
      if (hi + 1e-9 < b) out.push(hi, b);
    }
    if (m2 <= 1e-12) return 0;
    // 段數上限：超過就把最薄的那個空洞填回去（一格記不了無限層，寧可少一個內部空洞）
    while (out.length > MAX_SPANS * 2) {
      let best = 1, bestGap = Infinity;
      for (let i = 1; i + 1 < out.length; i += 2) {
        const gap = out[i + 1] - out[i];
        if (gap < bestGap) { bestGap = gap; best = i; }
      }
      out.splice(best, 2);
    }
    setSpans(sim, idx, out);
    return m2;
  }

  /** 這一格的材料與 [lo, hi] 有沒有交集；有的話回傳交集最外緣的半徑，沒有回 -1 */
  function spanHit(sim, idx, lo, hi) {
    const cur = spansOf(sim, idx);
    let best = -1;
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i], b = cur[i + 1];
      if (hi <= a || lo >= b) continue;
      const cb = Math.min(b, hi);
      if (cb > best) best = cb;
    }
    return best;
  }

  /**
   * 兩條相鄰射線的材料配對（兩邊都是升冪、不重疊的 `[lo,hi]` 串）。
   *
   * 先把在 r 上互相重疊的段收成一「群」，再對每一群接：
   *   - 群最內側的 lo 對 lo、群最外側的 hi 對 hi（那是同一塊材料延續過去）
   *   - 群裡其他邊界**就地封口**（`hi_k` 接 `lo_{k+1}`）——封口的那一面就是**鉛直側壁**
   *   - 整群只有一邊有（隔壁完全沒有）→ 這一群自己收口（最內的 lo 接最外的 hi）
   *
   * 為什麼要分群，不能一段對一段：一邊是完整的 `[0,30]`、隔壁被挖成
   * `[0,1.8]` + `[3.3,30]` 時，一段對一段會把 30 接到 1.8，剖面上就多一條
   * 橫貫整根棒子的假面。分群之後 0 接 0、30 接 30，中間的 1.8→3.3 自己封口＝孔壁。
   *
   * 每個端點在這一側剛好一條連線，輪廓才串得成封閉圈。
   *
   * @param {number[]} A 這一側的材料區間
   * @param {number[]} B 隔壁那一側
   * @param {(ka:number, kb:number)=>void} onPair  A 的第 ka 個端點接 B 的第 kb 個
   * @param {(k0:number, k1:number)=>void} onCapA  A 自己的兩個端點就地接起來
   * @param {(k0:number, k1:number)=>void} onCapB
   */
  function matchSpans(A, B, onPair, onCapA, onCapB) {
    const nA = A.length / 2, nB = B.length / 2;
    let i = 0, j = 0;
    while (i < nA || j < nB) {
      const i0 = i, j0 = j;
      let end;
      if (i < nA && (j >= nB || A[2 * i] <= B[2 * j])) { end = A[2 * i + 1]; i++; }
      else { end = B[2 * j + 1]; j++; }
      for (let grew = true; grew;) {          // 把所有跟這一群重疊的段拉進來
        grew = false;
        while (i < nA && A[2 * i] < end) { if (A[2 * i + 1] > end) end = A[2 * i + 1]; i++; grew = true; }
        while (j < nB && B[2 * j] < end) { if (B[2 * j + 1] > end) end = B[2 * j + 1]; j++; grew = true; }
      }
      if (i > i0 && j > j0) {
        onPair(2 * i0, 2 * j0);                       // 群最內側的 lo
        onPair(2 * (i - 1) + 1, 2 * (j - 1) + 1);     // 群最外側的 hi
      } else if (i > i0) {
        onCapA(2 * i0, 2 * (i - 1) + 1);              // 這一群在隔壁整個不見了
      } else {
        onCapB(2 * j0, 2 * (j - 1) + 1);
      }
      for (let k = i0; k + 1 < i; k++) onCapA(2 * k + 1, 2 * (k + 1));   // 群裡的空洞各自封口
      for (let k = j0; k + 1 < j; k++) onCapB(2 * k + 1, 2 * (k + 1));
    }
  }

  /**
   * 某個 X 位置的橫截面 → 一組封閉輪廓（工件座標的 {y, z}）。
   * 剖面 X 直接畫這個：外圈是圓棒表面，槽與孔的內壁自成一圈或接在外圈上，
   * 側壁是真的鉛直的（相鄰射線的內側邊界連起來就是那面牆）。
   * @param {Object} [src] 要讀的來源（`{height, extra}`，例如某個 snapshot）；不給就用 sim 本身
   * @returns {{loops: Array<Array<{y:number,z:number}>>}|null}
   */
  function cylSection(sim, x, src) {
    if (!sim || !sim.cylinder) return null;
    const ix = Math.round((x - sim.origin.x) / (sim.cellX || sim.cell));
    if (!(ix >= 0 && ix < sim.nx)) return null;
    const ny = sim.ny, R = sim.radius;
    const cy = (sim.center && sim.center.y) || 0, cz = (sim.center && sim.center.z) || 0;
    const SP = new Array(ny), link = new Array(ny), seen = new Array(ny);
    for (let i = 0; i < ny; i++) {
      SP[i] = spansOf(src || sim, i * sim.nx + ix);
      link[i] = new Int32Array(SP[i].length * 4).fill(-1);   // 每個端點兩個鄰居：[左ray,左k, 右ray,右k]
      seen[i] = new Uint8Array(SP[i].length);
    }
    const set = (i, k, side, i2, k2) => { const o = k * 4 + (side ? 2 : 0); link[i][o] = i2; link[i][o + 1] = k2; };
    for (let i = 0; i < ny; i++) {
      const j = (i + 1) % ny;
      matchSpans(SP[i], SP[j],
        (ka, kb) => { set(i, ka, 1, j, kb); set(j, kb, 0, i, ka); },
        (k0, k1) => { set(i, k0, 1, i, k1); set(i, k1, 1, i, k0); },
        (k0, k1) => { set(j, k0, 0, j, k1); set(j, k1, 0, j, k0); });
    }
    const pt = (i, k) => {
      const th = i * sim.cellY / R, r = SP[i][k];
      return { y: cy + r * Math.sin(th), z: cz + r * Math.cos(th), r };
    };
    /**
     * 封口邊的**轉角補點**。兩個面的交角幾乎都落在兩條射線**之間**，
     * 封口照射線畫的話，角落會被斜切掉（格距 0.5 時是一條窄而深的斜口：
     * 槽口外角缺一塊、槽底內角則讓牆「懸空」一大截才落地，看起來底部歪掉）。
     *
     * 補法：封口兩端各抓一條「表面走向」（端點在封口**另一側**的鄰居 → 端點），
     * 兩條走向的**交點**就是轉角——槽口外角（牆 × 外圓）與槽底內角（牆 × 槽底）
     * 同一條式子都補得到。外側走向抓不到時退回舊解法（把內側走向外插回 k1 的
     * 半徑圓，只有外角在外圓上時有效）。交點跑太遠（t ∉ (1,4)）代表走向不可靠，
     * 一律退回原本的直線封口。
     * @returns {{y,z}|null}
     */
    function tangentOf(i, k, side) {
      const oo = k * 4 + (side ? 0 : 2);                    // 端點在封口另一側的鄰居
      const i2 = link[i][oo], k2 = link[i][oo + 1];
      if (i2 < 0 || i2 === i) return null;                  // 沒有走向可抓（孤立的封口）
      const p = pt(i, k), pn = pt(i2, k2);
      const dy = p.y - pn.y, dz = p.z - pn.z;
      if (!(dy * dy + dz * dz > 1e-12)) return null;
      return { pn, dy, dz };
    }
    function capCorner(i, k0, k1, side) {
      const r1 = SP[i][k1];
      if (!(r1 - SP[i][k0] > sim.cellY)) return null;       // 缺口太淺，不值得補
      const tIn = tangentOf(i, k0, side);
      if (!tIn) return null;
      const tOut = tangentOf(i, k1, side);
      if (tOut) {
        // 兩條走向的交點：pnI + t·dI = pnO + s·dO（Cramer）
        const det = tIn.dy * tOut.dz - tIn.dz * tOut.dy;
        if (Math.abs(det) > 1e-12) {
          const wy = tOut.pn.y - tIn.pn.y, wz = tOut.pn.z - tIn.pn.z;
          const t = (wy * tOut.dz - wz * tOut.dy) / det;
          const s = (wy * tIn.dz - wz * tIn.dy) / det;
          if (t > 1 && t < 4 && s > 1 && s < 4) {
            return { y: tIn.pn.y + t * tIn.dy, z: tIn.pn.z + t * tIn.dz };
          }
        }
      }
      // 後備：內側走向外插回 k1 的半徑（解 |pn + t·d| = r1，取 t > 1 的根）
      const a = tIn.dy * tIn.dy + tIn.dz * tIn.dz;
      const b = 2 * ((tIn.pn.y - cy) * tIn.dy + (tIn.pn.z - cz) * tIn.dz);
      const c = (tIn.pn.y - cy) * (tIn.pn.y - cy) + (tIn.pn.z - cz) * (tIn.pn.z - cz) - r1 * r1;
      const disc = b * b - 4 * a * c;
      if (disc <= 0) return null;
      const t = (-b + Math.sqrt(disc)) / (2 * a);
      if (!(t > 1 && t < 4)) return null;
      return { y: tIn.pn.y + t * tIn.dy, z: tIn.pn.z + t * tIn.dz };
    }
    const loops = [];
    for (let i0 = 0; i0 < ny; i0++) {
      for (let k0 = 0; k0 < SP[i0].length; k0++) {
        if (seen[i0][k0]) continue;
        const loop = [];
        let i = i0, k = k0, side = 1, rMax = 0;      // side=1 往右走
        while (i >= 0 && !seen[i][k]) {
          seen[i][k] = 1;
          const p = pt(i, k);
          if (p.r > rMax) rMax = p.r;
          loop.push({ y: p.y, z: p.z });
          const o = k * 4 + (side ? 2 : 0);
          const i2 = link[i][o], k2 = link[i][o + 1];
          if (i2 < 0) break;
          if (i2 === i) {                            // 同一條射線 = 封口邊 → 試著補轉角點
            const lo = SP[i][k] < SP[i][k2] ? k : k2;
            const hi = lo === k ? k2 : k;
            const corner = capCorner(i, lo, hi, side);
            if (corner) loop.push(corner);
          }
          // 到了下一個點是從哪一側進來的：它的右鄰指回我們就是右側
          side = (link[i2][k2 * 4 + 2] === i && link[i2][k2 * 4 + 3] === k) ? 0 : 1;
          i = i2; k = k2;
        }
        // 實心軸心那一圈全部落在軸心上（每段的 lo 都是 0），不是輪廓
        if (loop.length > 1 && rMax > 1e-6) loops.push(loop);
      }
    }
    return { loops };
  }

  /**
   * 沿軸向的**真剖面**：平面 y = v 切下去的材料區域 → 封閉輪廓（{x, z}，工件座標）。
   *
   * 剖面 Y 以前畫的是上下包絡（每欄取外表面掃過的最高／最低）：在孔的正中心
   * 剛好等於真剖面，但偏離孔軸之後，徑向射線「看得到」的孔口越來越窄，
   * Ø8.5 的直壁孔會被畫成尖刺（現場問過「某些剖面下是歪斜的」就是這個）。
   * 多段 dexel 其實裝得下正確答案，所以這裡直接做平面剖切：
   *
   * 1. 每個 X 欄沿直線 y=v 掃 z（半格步），點 (v,z) → (θ, r) → 查最近射線的
   *    材料區間判斷裡外；裡外轉換處用**二分法收斂**——槽底 z=17、外圓
   *    z=√(R²−v²) 這類邊界的條件跟射線離散無關，收斂到的是準確值。
   * 2. 相鄰欄用與剖面 X 同一套 matchSpans 配對、配不到就地封口、
   *    封口邊補轉角點（兩條表面走向的交點，同 capCorner）。
   * 3. 鉛直牆（孔壁、槽壁）落在兩欄**之間**：配對邊跳超過兩格就在兩欄的
   *    中線踩一格階梯——直連會把鉛直牆畫成一格寬的斜線（理由同 steppedProfile）。
   *
   * @param {Object} sim  cylinder 模式的 sim
   * @param {number} v    剖面的 Y（工件座標）
   * @param {Object} [src] 要讀的來源（`{height, extra}`，例如某個 snapshot）
   * @returns {{loops: Array<Array<{x:number,z:number}>>}|null}
   */
  function cylSectionY(sim, v, src) {
    if (!sim || !sim.cylinder) return null;
    const R = sim.radius, ny = sim.ny, nx = sim.nx;
    const cy = (sim.center && sim.center.y) || 0, cz = (sim.center && sim.center.z) || 0;
    const dv = v - cy;
    if (!(Math.abs(dv) < R)) return { loops: [] };
    const s = src || sim;
    const cellY = sim.cellY, cellX = sim.cellX || sim.cell, x0 = sim.origin.x;
    const PI2 = Math.PI * 2;
    const insideAt = (ix, z) => {
      const r = Math.hypot(dv, z);
      let th = Math.atan2(dv, z);
      if (th < 0) th += PI2;
      const iy = Math.round(th * R / cellY) % ny;
      const sp = spansOf(s, iy * nx + ix);
      for (let k = 0; k < sp.length; k += 2) if (r >= sp[k] && r <= sp[k + 1]) return true;
      return false;
    };
    const zMax = Math.sqrt(R * R - dv * dv);
    const step = Math.max(cellY / 2, 1e-3);
    const SP = new Array(nx);
    for (let ix = 0; ix < nx; ix++) {
      const iv = [];
      let prevIn = false, prevZ = -zMax - step;
      /** 這一列裡離 r 最近的區間端點（同型內插用；parity 0=lo、1=hi） */
      const nearestEdge = (iyRaw, r, par) => {
        const sp = spansOf(s, (((iyRaw % ny) + ny) % ny) * nx + ix);
        let best = null;
        for (let k = par == null ? 0 : par; k < sp.length; k += par == null ? 1 : 2) {
          if (best == null || Math.abs(sp[k] - r) < Math.abs(best.v - r)) best = { v: sp[k], par: k % 2 };
        }
        return best;
      };
      const refine = (zOut, zIn) => {
        const zo0 = zOut, zi0 = zIn;   // 原始括號（半格寬）：第二階段要用它，收斂後的針孔會兩端同號
        for (let it = 0; it < 20; it++) {
          const zm = (zOut + zIn) / 2;
          if (insideAt(ix, zm)) zIn = zm; else zOut = zm;
        }
        // 「最近射線」判裡外會把 r(θ) 有斜率的面（槽底 r=14/cosθ）拉出 ~Δθ·tanθ 的偏差：
        // 邊界值再用相鄰兩條射線的**同型端點**線性內插解一次，槽底就回到準確的 z=14。
        // 端點差太多（牆那種近徑向的陡面）或括不住就維持第一階段的值。
        const zb = (zOut + zIn) / 2;
        const r0 = Math.hypot(dv, zb);
        let th = Math.atan2(dv, zb);
        if (th < 0) th += PI2;
        const f = th * R / cellY;
        const k0 = Math.floor(f);
        const e0 = nearestEdge(k0, r0, null);
        const e1 = e0 && nearestEdge(k0 + 1, r0, e0.par);
        if (!e0 || !e1 || Math.abs(e0.v - e1.v) > 4 * cellY) return zb;
        const g = (z) => {
          let t2 = Math.atan2(dv, z);
          if (t2 < 0) t2 += PI2;
          const f2 = Math.max(0, Math.min(1, t2 * R / cellY - k0));
          return Math.hypot(dv, z) - (e0.v + (e1.v - e0.v) * f2);
        };
        let a2 = zo0, b2 = zi0;
        const ga = g(a2);
        if (!(ga * g(b2) < 0)) return zb;
        for (let it = 0; it < 20; it++) {
          const zm = (a2 + b2) / 2;
          if (g(zm) * ga > 0) a2 = zm; else b2 = zm;
        }
        return (a2 + b2) / 2;
      };
      for (let z = -zMax - step; z <= zMax + step + 1e-9; z += step) {
        const now = insideAt(ix, z);
        if (now && !prevIn) iv.push(refine(prevZ, z));
        else if (!now && prevIn) iv.push(refine(z, prevZ));
        prevIn = now; prevZ = z;
      }
      if (prevIn) iv.push(zMax);   // 掃出圓外必為外，理論到不了；保險而已
      SP[ix] = iv;
    }
    // 相鄰欄配對 + 封口 + 轉角——跟 cylSection 同一套（站＝X 欄、不繞圈、無外圓後備）
    const link = new Array(nx), seen = new Array(nx);
    for (let i = 0; i < nx; i++) {
      link[i] = new Int32Array(SP[i].length * 4).fill(-1);
      seen[i] = new Uint8Array(SP[i].length);
    }
    const set = (i, k, side, i2, k2) => { const o = k * 4 + (side ? 2 : 0); link[i][o] = i2; link[i][o + 1] = k2; };
    for (let i = 0; i + 1 < nx; i++) {
      matchSpans(SP[i], SP[i + 1],
        (ka, kb) => { set(i, ka, 1, i + 1, kb); set(i + 1, kb, 0, i, ka); },
        (k0, k1) => { set(i, k0, 1, i, k1); set(i, k1, 1, i, k0); },
        (k0, k1) => { set(i + 1, k0, 0, i + 1, k1); set(i + 1, k1, 0, i + 1, k0); });
    }
    // 站不繞圈（跟剖面 X 不同）：第 0 欄與最後一欄的外側要補「端面封口」，
    // 否則端點少一側的連線，輪廓在棒料兩端閉不起來，evenodd 填色整個亂掉。
    // 用「對空鄰居做 matchSpans」表達：每一段材料自己收口，跟其他封口同一套規則。
    if (nx > 0) {
      matchSpans([], SP[0], () => {}, () => {},
        (k0, k1) => { set(0, k0, 0, 0, k1); set(0, k1, 0, 0, k0); });
      matchSpans(SP[nx - 1], [], () => {},
        (k0, k1) => { set(nx - 1, k0, 1, nx - 1, k1); set(nx - 1, k1, 1, nx - 1, k0); }, () => {});
    }
    const pt = (i, k) => ({ x: x0 + i * cellX, z: cz + SP[i][k] });
    function tangentOf(i, k, side) {
      const oo = k * 4 + (side ? 0 : 2);
      const i2 = link[i][oo], k2 = link[i][oo + 1];
      if (i2 < 0 || i2 === i) return null;
      const p = pt(i, k), pn = pt(i2, k2);
      const dx = p.x - pn.x, dz = p.z - pn.z;
      if (!(dx * dx + dz * dz > 1e-12)) return null;
      return { pn, dx, dz };
    }
    function capCorner(i, k0, k1, side) {
      if (!(SP[i][k1] - SP[i][k0] > cellY)) return null;
      const tIn = tangentOf(i, k0, side), tOut = tangentOf(i, k1, side);
      if (!tIn || !tOut) return null;
      const det = tIn.dx * tOut.dz - tIn.dz * tOut.dx;
      if (!(Math.abs(det) > 1e-12)) return null;
      const wx = tOut.pn.x - tIn.pn.x, wz = tOut.pn.z - tIn.pn.z;
      const t = (wx * tOut.dz - wz * tOut.dx) / det;
      const sPar = (wx * tIn.dz - wz * tIn.dx) / det;
      if (!(t > 1 && t < 4 && sPar > 1 && sPar < 4)) return null;
      return { x: tIn.pn.x + t * tIn.dx, z: tIn.pn.z + t * tIn.dz };
    }
    const loops = [];
    for (let i0 = 0; i0 < nx; i0++) {
      for (let k0 = 0; k0 < SP[i0].length; k0++) {
        if (seen[i0][k0]) continue;
        const loop = [];
        let i = i0, k = k0, side = 1;
        while (i >= 0 && !seen[i][k]) {
          seen[i][k] = 1;
          loop.push(pt(i, k));
          const o = k * 4 + (side ? 2 : 0);
          const i2 = link[i][o], k2 = link[i][o + 1];
          if (i2 < 0) break;
          if (i2 === i) {
            const lo = SP[i][k] < SP[i][k2] ? k : k2;
            const hi = lo === k ? k2 : k;
            const corner = capCorner(i, lo, hi, side);
            if (corner) loop.push(corner);
          }
          side = (link[i2][k2 * 4 + 2] === i && link[i2][k2 * 4 + 3] === k) ? 0 : 1;
          i = i2; k = k2;
        }
        if (loop.length > 1) loops.push(loop);
      }
    }
    // 鉛直牆踩階梯：跨欄且跳超過兩格的邊，在兩欄的中線插兩個點
    const stepped = loops.map((L) => {
      const out = [];
      for (let i = 0; i < L.length; i++) {
        const p = L[i], q = L[(i + 1) % L.length];
        out.push(p);
        if (Math.abs(q.x - p.x) > 1e-9 && Math.abs(q.z - p.z) > 2 * cellY) {
          const xm = (p.x + q.x) / 2;
          out.push({ x: xm, z: p.z }, { x: xm, z: q.z });
        }
      }
      return out;
    });
    return { loops: stepped };
  }

  /**
   * 圓柱模式的核心：**這一格的射線 ∩ 刀具實體** → 離軸心的距離區間 [lo, hi]，沒交集回 null。
   *
   * 全部在機台座標算（相對迴轉中心）。刀是平行機台 Z 的旋轉體，
   * 射線從軸心往角度 φ 射出去，半徑 r 的點在機台座標是 (x, r·sinφ, r·cosφ)：
   *   側面（圓柱）：|r·sinφ − y刀| ≤ √(刀半徑² − Δx²)   → r 的一段區間
   *   刀底（平底）：r·cosφ ≥ z刀                        → r 的半直線
   * 刀具實體是凸的 ⇒ 與射線的交集一定是**單一區間**，不會有第二段。
   *
   * 錐尖（鑽頭）與球端（球刀）的底不是平面，各自多解一個二次式，一樣是封閉解。
   * cosφ < 0 的格是對面那半圈：只有刀尖越過軸心（z刀 < 0）才有交集——
   * 貫穿孔的孔道與對面的開口因此是自然算出來的，不必再另外補一刀。
   *
   * @param {{r:number,kind:number,tanHalf:number}} prof 刀具足跡剖面
   * @param {number} sinC 這一格射線角度 φ（相對刀軸方向）的 sin
   * @param {number} cosC 同上的 cos
   * @param {number} eX   這一格與刀軸的軸向距離
   * @param {number} yT   刀軸的機台 y（相對迴轉中心）
   * @param {number} zT   刀底的機台 z（相對迴轉中心）
   * @returns {{lo:number, hi:number}|null}
   */
  function toolRayInterval(prof, sinC, cosC, eX, yT, zT) {
    const Rt = prof.r - XY_TOL;
    const q = Rt * Rt - eX * eX;
    if (q <= 0) return null;
    const Rp = Math.sqrt(q);            // 這個軸向位置上刀的半徑
    let lo = 0, hi = Infinity;
    // 側面
    if (Math.abs(sinC) < 1e-12) {
      if (Math.abs(yT) >= Rp) return null;
    } else {
      const r1 = (yT - Rp) / sinC, r2 = (yT + Rp) / sinC;
      lo = Math.max(lo, Math.min(r1, r2));
      hi = Math.min(hi, Math.max(r1, r2));
    }
    // 刀底（先當平底；錐／球再往上抬）
    if (Math.abs(cosC) < 1e-12) { if (zT > 0) return null; }
    else if (cosC > 0) lo = Math.max(lo, zT / cosC);
    else hi = Math.min(hi, zT / cosC);
    if (!(hi > lo)) return null;

    if (prof.kind === CONE) {
      // ζ = r·cosφ − z刀 ≥ 0 之下，「在錐面之上」是 ζ·T ≥ ρ，平方之後對 r 是二次式
      const T = prof.tanHalf;
      if (!(T > 0)) return null;
      const a = T * T * cosC * cosC - sinC * sinC;
      const b = -2 * T * T * cosC * zT + 2 * sinC * yT;
      const k = T * T * zT * zT - yT * yT - eX * eX;
      const res = quadRange(a, b, k, cosC > 0);
      if (!res) return null;
      lo = Math.max(lo, res.lo); hi = Math.min(hi, res.hi);
    } else if (prof.kind === SPHERE) {
      // 球端 ＝（圓柱 ∩ ζ ≥ 刀半徑）∪ 球心在刀軸上、離刀尖一個刀半徑的球。兩塊相接，取聯集
      const zc = zT + Rt;
      let sLo = Infinity, sHi = -Infinity;
      if (Math.abs(cosC) > 1e-12) {
        const rc = zc / cosC;
        if (cosC > 0) { if (hi > rc) { sLo = Math.max(lo, rc); sHi = hi; } }
        else if (lo < rc) { sLo = lo; sHi = Math.min(hi, rc); }
      } else if (zc <= 0) { sLo = lo; sHi = hi; }
      // 球：r² − 2r(sinφ·y刀 + cosφ·zc) + (y刀² + zc² + Δx² − 刀半徑²) ≤ 0
      const bb = -2 * (sinC * yT + cosC * zc);
      const kk = yT * yT + zc * zc + eX * eX - Rt * Rt;
      const disc = bb * bb - 4 * kk;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        const q0 = (-bb - sq) / 2, q1 = (-bb + sq) / 2;
        if (q1 > lo && q0 < hi) {
          sLo = Math.min(sLo, Math.max(lo, q0));
          sHi = Math.max(sHi, Math.min(hi, q1));
        }
      }
      if (!(sHi > sLo)) return null;
      lo = sLo; hi = sHi;
    }
    if (lo < 0) lo = 0;
    return (hi > lo) ? { lo, hi } : null;
  }

  /**
   * a·r² + b·r + k ≥ 0 的解集合。
   * 刀具實體是凸的 ⇒ 最後交出來一定是單一區間，所以 a > 0（解在兩根之外）時
   * 只會取到其中一支：射線往外走 ζ 增加的那一支（outward）。
   */
  function quadRange(a, b, k, outward) {
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) < 1e-12) return (k >= 0) ? { lo: -Infinity, hi: Infinity } : null;
      const r = -k / b;
      return b > 0 ? { lo: r, hi: Infinity } : { lo: -Infinity, hi: r };
    }
    const disc = b * b - 4 * a * k;
    if (disc < 0) return a > 0 ? { lo: -Infinity, hi: Infinity } : null;
    const sq = Math.sqrt(disc);
    const r0 = (-b - sq) / (2 * a), r1 = (-b + sq) / (2 * a);
    const lo = Math.min(r0, r1), hi = Math.max(r0, r1);
    if (a < 0) return { lo, hi };
    return outward ? { lo: hi, hi: Infinity } : { lo: -Infinity, hi: lo };
  }

  // ---------------------------------------------------------------------------
  // 切削：圓弧（環帶，固定 Z）
  // ---------------------------------------------------------------------------
  function cutArc(sim, cx0, cy0, R, th0, sweep, cw, z, prof, acc) {
    const { cellX, cellY, nx, origin, height, mask, floorZ } = sim;
    const r = prof.r - XY_TOL;
    const dir = cw ? -1 : 1;
    const th1 = th0 + dir * sweep;
    const ax = cx0 + R * Math.cos(th0), ay = cy0 + R * Math.sin(th0);
    const bx = cx0 + R * Math.cos(th1), by = cy0 + R * Math.sin(th1);
    const bb = arcBounds(cx0, cy0, R, th0, sweep, cw);
    const ix0 = Math.max(0, Math.floor((bb.xmin - prof.r - origin.x) / cellX));
    const ix1 = Math.min(nx - 1, Math.ceil((bb.xmax + prof.r - origin.x) / cellX));
    const yr = yRange(sim, bb.ymin - prof.r, bb.ymax + prof.r);
    const iy0 = yr[0], iy1 = yr[1];
    if (ix0 > ix1 || iy0 > iy1) return;
    let removed = 0;
    for (let iy = iy0; iy <= iy1; iy++) {
      const cy = origin.y + iy * cellY;
      const vy = cy - cy0;
      const rowY = sim.wrapY ? (((iy % sim.ny) + sim.ny) % sim.ny) : iy;
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = origin.x + ix * cellX;
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
        const idx = rowY * nx + ix;
        const old = height[idx];
        if (h < old - 1e-7) {
          if (mask[idx]) { acc.fixtureHit = mask[idx]; acc.fixturePos = { x: cx, y: cy, z: old }; continue; }
          removed += old - h;
          height[idx] = h;
        }
      }
    }
    acc.removed += removed * cellX * cellY;
  }

  /**
   * 3D 直線在展開座標可能是**曲線**——偏離中心線的下鑽最典型：刀尖直直往下走，
   * 展開角 θ 卻從表面的角度一路掃向 90°、r 一路縮。forEachCylStep 拿取樣點之間的
   * 展開座標**線性內插**當一步步的刀位，點太疏的話刀就沿著一條實際沒走過的假曲線
   * 切過去，把空洞上方的外殼整片削掉（check-4axis 的偏心鑽），碰撞檢查也跟著失準。
   * 所以展開影像會彎的段先在 3D 弦上加密：遞迴比較「展開線性內插的中點」與
   * 「真實 3D 中點」，偏差超過半格才細分，收斂就停（旋轉段 r 不變，一步就收斂）。
   * 幾乎通過軸心的弦（離軸心 < 半格）不加密——那是 unrollPath「角度不變、半徑變號」
   * 表示法的地盤，而且徑向鑽孔是最常見的段，加密會把它的單步快路徑拖慢幾百倍。
   */
  function densifyForUnroll(pw, ts, sim) {
    const sub = Math.max(sim.cell / 2, 1e-6);
    const cy = (sim.center && sim.center.y) || 0, cz = (sim.center && sim.center.z) || 0;
    const pts = [], outT = [];
    function refine(p0, t0, p1, t1, depth) {
      if (depth <= 0) return;
      const y0 = p0.y - cy, z0 = p0.z - cz, y1 = p1.y - cy, z1 = p1.z - cz;
      const r0 = Math.hypot(y0, z0), r1 = Math.hypot(y1, z1);
      if (r0 < 1e-9 || r1 < 1e-9) return;
      // 展開線性內插的中點：角度走一半、半徑取平均
      const dth = Math.atan2(y1 * z0 - z1 * y0, y0 * y1 + z0 * z1);
      const c = Math.cos(dth / 2), s = Math.sin(dth / 2);
      const uy = y0 / r0, uz = z0 / r0;
      const rm = (r0 + r1) / 2;
      const my = (p0.y + p1.y) / 2, mz = (p0.z + p1.z) / 2;
      const dev = Math.hypot((my - cy) - rm * (uy * c + uz * s), (mz - cz) - rm * (uz * c - uy * s));
      if (dev <= sub / 2) return;
      const m = { x: (p0.x + p1.x) / 2, y: my, z: mz };
      const tm = (t0 + t1) / 2;
      refine(p0, t0, m, tm, depth - 1);
      pts.push(m); outT.push(tm);
      refine(m, tm, p1, t1, depth - 1);
    }
    for (let i = 0; i < pw.length; i++) {
      if (i > 0) {
        const p0 = pw[i - 1], p1 = pw[i];
        const y0 = p0.y - cy, z0 = p0.z - cz, y1 = p1.y - cy, z1 = p1.z - cz;
        const chord = Math.hypot(y1 - y0, z1 - z0);
        if (chord > 1e-9 && Math.abs(y0 * z1 - z0 * y1) / chord >= sub) {
          refine(p0, ts[i - 1], p1, ts[i], 9);
        }
      }
      pts.push(pw[i]); outT.push(ts[i]);
    }
    return { pts, ts: outT };
  }

  /**
   * 圓柱模式：把一段（機台座標）映射成展開座標的折線 [{x, s, r, a}]。
   *   機台 (x,y,z) + A 角度 → 繞軸心反轉 A → (x, θ, r) → (x, s = θ·R, r)
   * A 在轉的段映射後是曲線，rotary.samples 已經依角度細分過；
   * 直線段的展開影像也可能是曲線，densifyForUnroll 再補一層加密。
   */
  function unrollPoints(sim, seg) {
    const RG = NC.geometry && NC.geometry.rotary;
    if (!RG || typeof RG.samples !== 'function' || typeof RG.unrollPath !== 'function') return [];
    const pw0 = RG.samples(seg, { center: sim.center, tol: sim.cell / 2 });
    const t0 = pw0.map((_, i) => (pw0.length > 1 ? i / (pw0.length - 1) : 1));
    const { pts: pw, ts } = densifyForUnroll(pw0, t0, sim);
    const k = Math.PI / 180 * sim.radius;
    // unrollPath 已經處理跨 ±180 與穿過軸心（r 變號），這裡只換算成弧長。
    // 每個點也帶上當下的 A：刀軸方向要靠它才算得出來（rotarySamples 是等分內插
    // aFrom→a，照原始取樣的參數比例還原，加密插進來的點用內插的參數）。
    const up = RG.unrollPath(pw, sim.center);
    const a1 = Number(seg.a) || 0;
    const a0 = seg.aFrom === undefined ? a1 : (Number(seg.aFrom) || 0);
    return up.map((u, i) => ({ x: u.x, s: u.theta * k, r: u.r, a: a0 + (a1 - a0) * ts[i] }));
  }

  /**
   * 圓柱模式：掃過一步的刀（刀尖半徑 r、刀軸方向 axisS）會碰到的格。
   *
   * `cut` 為真就把「射線 ∩ 刀具」從材料區間裡挖掉；為假只檢查有沒有撞到還在的材料
   * （快速移動的碰撞檢查與切削共用同一套幾何，兩邊不會各算各的）。
   */
  function scanCyl(sim, ax, as, bx, bs, r, axisS, prof, cut, acc) {
    const { cellX, cellY, nx, ny, origin, mask } = sim;
    const R = sim.radius;
    const dx = bx - ax, ds = bs - as, L2 = dx * dx + ds * ds;
    const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - prof.r - origin.x) / cellX));
    const ix1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + prof.r - origin.x) / cellX));
    if (ix0 > ix1) return;
    // 周向範圍：射線要同時滿足側面與刀底才有交集。刀底在 z刀 > 0 時
    // tanφ ≤ (|y刀| + 刀半徑) / z刀 就是角度上限；刀尖越過軸心（z刀 ≤ 0）時整圈都可能被挖到。
    const phi0 = (as - axisS) / R, phi1 = (bs - axisS) / R;
    const zT0 = Math.min(r * Math.cos(phi0), r * Math.cos(phi1));
    const yT0 = Math.max(Math.abs(r * Math.sin(phi0)), Math.abs(r * Math.sin(phi1)));
    const phiMax = zT0 > 1e-6 ? Math.atan((yT0 + prof.r) / zT0) : Math.PI;
    const yr = yRange(sim, axisS - R * phiMax, axisS + R * phiMax);
    let m2 = 0;
    for (let iy = yr[0]; iy <= yr[1]; iy++) {
      const cs = origin.y + iy * cellY;
      const phi = (cs - axisS) / R;
      const sinC = Math.sin(phi), cosC = Math.cos(phi);
      const rowY = ((iy % ny) + ny) % ny;
      const py = cs - as;
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = origin.x + ix * cellX;
        const px = cx - ax;
        let t = L2 > 0 ? (px * dx + py * ds) / L2 : 0;
        const tc = t < 0 ? 0 : (t > 1 ? 1 : t);
        const phiT = (as + tc * ds - axisS) / R;
        const iv = toolRayInterval(prof, sinC, cosC, px - tc * dx, r * Math.sin(phiT), r * Math.cos(phiT));
        if (!iv) continue;
        const idx = rowY * nx + ix;
        if (cut) {
          if (mask[idx]) {
            if (spanHit(sim, idx, iv.lo, iv.hi) >= 0) {
              acc.fixtureHit = mask[idx];
              acc.fixturePos = { x: cx, y: cs, z: sim.height[idx] };
            }
            continue;
          }
          m2 += spanSubtract(sim, idx, iv.lo, iv.hi);
        } else {
          const hitR = spanHit(sim, idx, iv.lo, iv.hi);
          if (hitR < 0) continue;
          const excess = hitR - iv.lo;
          if (excess > Z_TOL && (!acc.worst || excess > acc.worst.excess)) {
            acc.worst = {
              x: cx, y: cs, z: hitR, toolZ: iv.lo, tipZ: r,
              cone: prof.kind !== FLAT, excess, fixture: mask[idx],
            };
          }
        }
      }
    }
    // 圓柱格的斷面積隨半徑變，所以體積用面積矩 × Δx × Δθ，不是長度 × 格距
    if (cut) acc.removed += m2 * cellX * (cellY / R);
  }

  /**
   * 圓柱模式的切削。
   * 映射到展開座標之後把路徑細分成小步（每步的周向與徑向位移都 ≤ 半格），
   * 每一步當成一個靜止的刀位。純軸向的走刀（分度銑槽最常見）Δs = Δr = 0，
   * 一步就走完，不會被細分拖慢；原地下扎也是一步——刀軸不動時只有最深的那個刀位算數。
   */
  function cutSegmentCyl(sim, seg, prof) {
    const acc = { removed: 0, fixtureHit: 0, fixturePos: null };
    forEachCylStep(sim, seg, (ax, as, bx, bs, r, axisS) => {
      scanCyl(sim, ax, as, bx, bs, r, axisS, prof, true, acc);
    });
    return acc;
  }

  /**
   * 圓柱模式的快速移動碰撞檢查：跟切削同一套幾何，只是不挖，只看有沒有撞到還在的材料。
   * 回傳的 z／toolZ／tipZ 都是「離軸心多遠」，現場看到的才是熟悉的數字。
   */
  function checkRapidCyl(sim, seg, prof) {
    const acc = { worst: null };
    let minR = Infinity;
    for (const p of unrollPoints(sim, seg)) minR = Math.min(minR, p.r);
    if (minR >= sim.topZ) return null;    // 整段都在圓棒外面，不可能撞
    forEachCylStep(sim, seg, (ax, as, bx, bs, r, axisS) => {
      scanCyl(sim, ax, as, bx, bs, r, axisS, prof, false, acc);
    });
    return acc.worst;
  }

  /**
   * 一段 → 一連串「靜止刀位」的小步：(ax, as) → (bx, bs)、刀尖半徑 r、刀軸方向 axisS（弧長）。
   * 刀軸方向與刀尖半徑在一步之內當成固定，所以周向與徑向的位移都切到半格以內；
   * 軸向（X）不必切——同一個刀軸掃過去，逐格取最近的刀位就是精確解。
   */
  function forEachCylStep(sim, seg, fn) {
    const pts = unrollPoints(sim, seg);
    const sub = Math.max(sim.cell / 2, 1e-6);
    const k = Math.PI / 180 * sim.radius;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dsAbs = Math.abs(b.s - a.s);
      if (Math.hypot(b.x - a.x, b.s - a.s) < XY_TOL) {
        // 原地往中心扎（分度鑽孔）：刀軸不動，只有最深的刀位算數。
        // 對齊格點，孔心那格才會剛好等於孔底（不然錐尖落在格與格之間，孔心永遠差一點）
        const sx = sim.origin.x + Math.round((a.x - sim.origin.x) / sim.cellX) * sim.cellX;
        const sy = sim.origin.y + Math.round((a.s - sim.origin.y) / sim.cellY) * sim.cellY;
        fn(sx, sy, sx, sy, Math.min(a.r, b.r), (a.a + b.a) / 2 * k);
        continue;
      }
      const n = Math.max(1, Math.ceil(Math.max(dsAbs, Math.abs(b.r - a.r)) / sub));
      for (let j = 0; j < n; j++) {
        const t0 = j / n, t1 = (j + 1) / n;
        const lerp = (u, v, t) => u + (v - u) * t;
        fn(lerp(a.x, b.x, t0), lerp(a.s, b.s, t0), lerp(a.x, b.x, t1), lerp(a.s, b.s, t1),
          Math.min(lerp(a.r, b.r, t0), lerp(a.r, b.r, t1)),
          lerp(a.a, b.a, (t0 + t1) / 2) * k);
      }
    }
  }

  /** 對一個切削段蓋章；回傳累積資訊 */
  function cutSegment(sim, seg, prof) {
    if (sim.cylinder) return cutSegmentCyl(sim, seg, prof);
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
    if (sim.cylinder) return checkRapidCyl(sim, seg, prof);
    return checkRapidPlanar(sim, seg, prof);
  }

  function checkRapidPlanar(sim, seg, prof) {
    const a = seg.from, b = seg.to;
    const minZ = Math.min(a.z, b.z);
    if (minZ + Z_TOL >= sim.topZ) return null; // 高於所有材料／治具，不可能撞
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    if (L2 < XY_TOL * XY_TOL && b.z >= a.z) return null; // 純垂直上升：只會離開材料
    const { cellX, cellY, nx, ny, origin, height, mask, wrapY } = sim;
    const r = prof.r - XY_TOL, r2 = r * r;
    const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - prof.r - origin.x) / cellX));
    const ix1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + prof.r - origin.x) / cellX));
    const yr = yRange(sim, Math.min(a.y, b.y) - prof.r, Math.max(a.y, b.y) + prof.r);
    const iy0 = yr[0], iy1 = yr[1];
    if (ix0 > ix1 || iy0 > iy1) return null;
    let worst = null;
    for (let iy = iy0; iy <= iy1; iy++) {
      const cy = origin.y + iy * cellY;
      const py = cy - a.y;
      const rowY = wrapY ? (((iy % ny) + ny) % ny) : iy;
      for (let ix = ix0; ix <= ix1; ix++) {
        const idx = rowY * nx + ix;
        const hc = height[idx];
        if (hc <= minZ + Z_TOL) continue; // 這格材料比刀底低，連算距離都免了
        const cx = origin.x + ix * cellX;
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
      if (sim.extra) sim.extra = cloneExtra(base.extra);
      closed = base.afterOpIndex;
      snapshots = sim.snapshots.filter((s) => s.afterOpIndex <= closed);
      events = (sim.events || []).filter((e) => e.opIndex == null || e.opIndex <= closed);
      for (let i = 0; i <= closed && i < nOps; i++) perOp[i] = (sim.time.perOp && sim.time.perOp[i]) || 0;
      pre = (sim.time && sim.time.pre) || 0;
    } else {
      height.set(sim.initial);
      if (sim.extra) sim.extra.clear();
    }
    sim.scenario = scenario;

    const closeOpsBefore = (o) => {
      for (let i = closed + 1; i < o && i < nOps; i++) {
        if ((i + 1) % stride === 0 || i === nOps - 1) {
          snapshots.push({
            afterOpIndex: i, tool: ops[i] ? ops[i].tool : null,
            height: height.slice(), extra: cloneExtra(sim.extra),
          });
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
      cell: sim.cell, cellX: sim.cellX, cellY: sim.cellY, wrapY: sim.wrapY,
      nx: sim.nx, ny: sim.ny, origin: { x: sim.origin.x, y: sim.origin.y },
      cylinder: !!sim.cylinder,
      radius: sim.radius, center: sim.center, circumference: sim.circumference,
      height: height.slice(),
      extra: cloneExtra(sim.extra),
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
    // cellX/cellY 是圓柱素材才會不同的兩軸格距；舊呼叫端只給 cell，退回去用它
    const ix = Math.round((x - s.origin.x) / (s.cellX || s.cell));
    let iy = Math.round((y - s.origin.y) / (s.cellY || s.cell));
    if (s.wrapY) iy = ((iy % s.ny) + s.ny) % s.ny;   // 圓柱周向是循環的
    if (ix < 0 || iy < 0 || ix >= s.nx || iy >= s.ny) return -1;
    return iy * s.nx + ix;
  }
  /** 讀某點目前高度；超出素材範圍回 null */
  function heightAt(s, x, y) {
    const idx = cellIndex(s, x, y);
    return idx < 0 ? null : s.height[idx];
  }

  // ---------------------------------------------------------------------------
  // 廢料判定（chunks）
  //
  // 輪廓整圈切穿、鋸斷之後，素材會分成幾塊互不相連的料：要留下來的那塊是「工件」，
  // 其餘是「廢料」。視圖要把廢料標成橘色或乾脆不畫、素材子頁要報「廢料 N 塊」，
  // 所以這裡把高度圖切成「四鄰連通的實料區域」（塊），再依設定決定哪幾塊是工件。
  //
  // 為什麼放 core 而不是 UI：2D／3D／素材子頁三邊要同一份答案，而且要能在 Node 測。
  // 為什麼不進 analyze 的 request：判定只看高度圖，改設定不必重跑模擬（第一版）。
  //
  // 「沒有料」＝高度夾在 floorZ（cutLine／cutArc 把切穿夾在 floorZ；cylZ 圓外一開始就是 floorZ）。
  // 夾具格（mask ≠ 0）是不可切材料，不算料；但記下來給 anchor 'fixture' 與 touchesFixture 用。
  // 全部用 typed array 與自己的堆疊（不遞迴）：0.17 M 格要在 30 ms 內做完，
  // 而且遞迴的 flood fill 在大格網會把呼叫堆疊撐爆。
  // ---------------------------------------------------------------------------
  /** anchor 的合法值（素材子頁的 radio 與 normalizeScrap 共用） */
  const SCRAP_ANCHORS = Object.freeze(['auto', 'origin', 'largest', 'fixture', 'marks']);

  /** 廢料判定的預設設定（跟程式一起存在素材項目裡；欄位見 ns.js 的 Scrap） */
  function defaultScrap() {
    return { anchor: 'auto', marks: [], skinMm: 0, bridgeMm: 0, minAreaMm2: 2 };
  }

  /**
   * 三個門檻的上限（normalizeScrap 夾範圍用；素材子頁的輸入框可拿去當 max）。
   * bridgeMm 的上限是效能問題、不是幾何問題：侵蝕是 O(k·n)，k = bridgeMm/(2·cell)，手滑打 5000 在
   * 0.25 mm 格距下是一萬輪、主執行緒直接凍住；50 mm 已經比任何留耳都寬得多。
   * skinMm／minAreaMm2 只是擋荒謬值（比整塊素材還厚／比整張圖還大）。
   */
  const SCRAP_MAX = Object.freeze({ skinMm: 1000, bridgeMm: 50, minAreaMm2: 1e6 });

  /**
   * 補預設、夾範圍。localStorage 回來的可能是舊版或被手改過，所以每個欄位都自己驗：
   * 三個門檻負值沒有意義 → 夾成 0、超過 SCRAP_MAX → 夾到上限、空值／非數字 → 用預設；anchor 不認得 → 'auto'；
   * marks 只留 x/y 都是有限數字且 kind 合法的（壞掉的記號留著只會讓判定莫名其妙）。
   * @param {Partial<Scrap>|null|undefined} o
   * @returns {Scrap}
   */
  function normalizeScrap(o) {
    const d = defaultScrap();
    if (!o || typeof o !== 'object') return d;
    // null／undefined／空字串／布林都不是數字：Number(null) 會變 0，JSON 往返後的 NaN 記號就會偷偷變成 (0, y)。
    // 字串先 trim：Number('   ') 也是 0，輸入框只剩空白時要當成「沒填」用預設，不是門檻 0。
    const finite = (v) => {
      if (v == null || typeof v === 'boolean') return null;
      if (typeof v === 'string') { v = v.trim(); if (v === '') return null; }
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const clamp = (v, dflt, hi) => { const n = finite(v); return n == null ? dflt : Math.min(hi, Math.max(0, n)); };
    const marks = [];
    if (Array.isArray(o.marks)) {
      for (const m of o.marks) {
        if (!m || typeof m !== 'object') continue;
        const x = finite(m.x), y = finite(m.y);
        if (x == null || y == null) continue;
        if (m.kind !== 'part' && m.kind !== 'scrap') continue;
        marks.push({ x, y, kind: m.kind });
      }
    }
    return {
      anchor: SCRAP_ANCHORS.includes(o.anchor) ? o.anchor : 'auto',
      marks,
      skinMm: clamp(o.skinMm, d.skinMm, SCRAP_MAX.skinMm),
      bridgeMm: clamp(o.bridgeMm, d.bridgeMm, SCRAP_MAX.bridgeMm),
      minAreaMm2: clamp(o.minAreaMm2, d.minAreaMm2, SCRAP_MAX.minAreaMm2),
    };
  }

  /** 不支援（四軸圓棒）或沒有格網時的空結果：欄位齊全，呼叫端不必每個欄位都判 null */
  function noChunks() {
    return { supported: false, labels: null, chunks: [], partCount: 0, scrapCount: 0, scrapAreaMm2: 0, partTouchesFixture: null, hasFixture: false };
  }

  /**
   * 把高度圖切成塊並分類。
   *
   * 步驟：實料格 → （細橋：侵蝕 k 格）→ 四鄰 flood fill 標號 → （長回來：多源 BFS → 沒核心的孤立塊補標號）→
   *       每塊統計 → 丟掉太小的 → 依 anchor 與記號決定哪幾塊是工件。
   *
   * @param {Sim|SimResult} sim         只用 nx, ny, cellX, cellY, cell, origin, floorZ, mask, cylinder, wrapY
   * @param {Float32Array} [heightArr]  預設 sim.height；傳快照的 height 就能看「某一刀之後」的狀況
   * @param {Partial<Scrap>} [scrap]    會先 normalizeScrap
   * @param {Object} [opts]             保留給日後（目前沒有選項，傳了也不看）
   * @returns {ChunkResult}
   */
  function chunks(sim, heightArr, scrap, opts) { // eslint-disable-line no-unused-vars
    // 圓棒的「料」是每格一串徑向區間（extra），不是高度圖的連通問題：本版不做
    if (!sim || sim.cylinder || !(sim.nx > 0 && sim.ny > 0)) return noChunks();
    const s = normalizeScrap(scrap);
    const h = heightArr || sim.height;
    const nx = sim.nx, ny = sim.ny, n = nx * ny;
    if (!h || h.length !== n) return noChunks();
    const cellX = sim.cellX || sim.cell, cellY = sim.cellY || sim.cell;
    const fix = (sim.mask && sim.mask.length === n) ? sim.mask : null;

    // 1. 實料格：剩餘厚度 > 底皮門檻才算有料。
    //    floorZ 先過 Math.fround：高度圖是 Float32Array，夾在 floorZ 的格存的是 fround(floorZ)，
    //    直接跟 float64 的 floorZ 相減會剩 1e-6 等級的殘差（|Z| 越大越大），深一點的素材整圈切穿會被當成還有料。
    //    1e-6 是浮點容差；skinMm 讓「現場留 0.3 薄皮再敲掉」的程式也能判成切斷。
    const floor32 = Math.fround(sim.floorZ);
    const thr = Math.max(s.skinMm, 1e-6);
    const solid = new Uint8Array(n);
    let hasFixture = false;
    for (let i = 0; i < n; i++) {
      if (fix && fix[i]) { hasFixture = true; continue; }
      if (h[i] - floor32 > thr) solid[i] = 1;
    }

    // 2. 細橋：侵蝕 k 次。橋從兩側各被吃掉 k 格，寬 ≤ 2k 格的連接就斷 → k = round(bridgeMm / (2·cell))。
    //    格網外面當成沒料（素材邊緣本來就是空氣），所以貼著素材邊的橋只從一側被吃、等於算寬了一倍——
    //    可接受：使用者調 bridgeMm 本來就是「大概」，猜錯了點記號更快。
    //    每一輪都掃整張圖：bridgeMm 在 normalizeScrap 夾到 SCRAP_MAX.bridgeMm，但格距細時 k 仍可上百；
    //    素材比 2k 格還窄的話幾輪就吃光了，之後每輪都在掃全 0 的圖——數一下剩幾格、0 就停。
    const k = Math.round(s.bridgeMm / (2 * cellX));
    let core = solid;
    if (k > 0) {
      const bufA = new Uint8Array(n), bufB = new Uint8Array(n);
      let src = solid, dst = bufA;
      for (let it = 0; it < k; it++) {
        let left = 0;
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const i = iy * nx + ix;
            const v = (src[i]
              && ix > 0 && src[i - 1] && ix < nx - 1 && src[i + 1]
              && iy > 0 && src[i - nx] && iy < ny - 1 && src[i + nx]) ? 1 : 0;
            dst[i] = v; left += v;
          }
        }
        src = dst; dst = (src === bufA) ? bufB : bufA;   // 第一輪的來源是 solid（第 4 步還要用），不能寫回去
        if (left === 0) break;   // 整張吃光了，再侵蝕也是 0
      }
      core = src;
    }

    // 3. 四鄰 flood fill 標號。自己的堆疊：每格最多進去一次（進去時就標號），所以 n 個位子夠。
    //    fill(grid)：grid 裡是 1 且還沒標號的格，每個連通區域給一個新號。先對 core 跑；第 4b 步再對 solid 跑一次。
    const labels = new Int32Array(n);
    const stack = new Int32Array(n);
    let nLabels = 0;
    const fill = (grid) => {
      for (let seed = 0; seed < n; seed++) {
        if (!grid[seed] || labels[seed]) continue;
        const lab = ++nLabels;
        let sp = 0;
        labels[seed] = lab; stack[sp++] = seed;
        while (sp > 0) {
          const i = stack[--sp];
          const ix = i % nx;
          const l = i - 1, r = i + 1, u = i - nx, d = i + nx;
          if (ix > 0 && grid[l] && !labels[l]) { labels[l] = lab; stack[sp++] = l; }
          if (ix < nx - 1 && grid[r] && !labels[r]) { labels[r] = lab; stack[sp++] = r; }
          if (u >= 0 && grid[u] && !labels[u]) { labels[u] = lab; stack[sp++] = u; }
          if (d < n && grid[d] && !labels[d]) { labels[d] = lab; stack[sp++] = d; }
        }
      }
    };
    fill(core);

    // 4. 侵蝕掉的格長回來：從已標號的格做多源 BFS，只走 solid 格，先到先得＝離哪塊近就跟誰。
    //    橋因此會從中間分給兩邊（不是 0）。
    if (k > 0) {
      const queue = stack;   // flood fill 做完了，重用這塊記憶體
      let head = 0, tail = 0;
      for (let i = 0; i < n; i++) if (labels[i]) queue[tail++] = i;
      while (head < tail) {
        const i = queue[head++];
        const lab = labels[i];
        const ix = i % nx;
        const l = i - 1, r = i + 1, u = i - nx, d = i + nx;
        if (ix > 0 && solid[l] && !labels[l]) { labels[l] = lab; queue[tail++] = l; }
        if (ix < nx - 1 && solid[r] && !labels[r]) { labels[r] = lab; queue[tail++] = r; }
        if (u >= 0 && solid[u] && !labels[u]) { labels[u] = lab; queue[tail++] = u; }
        if (d < n && solid[d] && !labels[d]) { labels[d] = lab; queue[tail++] = d; }
      }
      // 4b. 長回來之後仍是 solid 但沒標號的格：那一塊每個方向都 ≤ 2k 格、核心整個被吃光，
      //     旁邊又沒有塊可以長過來（被切穿的溝圍住的孤立小塊，或整張素材都比 2k 格窄）。
      //     維持 0 的話它既不是工件也不是廢料、畫成一般材料，面積遠大於 minAreaMm2 也一樣——
      //     使用者看到的是一塊「沒被判定」的料，什麼都不會提示。所以再對 solid 標號一次、把它們當成獨立的塊，
      //     之後照常過 minAreaMm2 與分類（多半會成為廢料）。這一步之後每個 solid 格都有標號：
      //     「細橋」只改變塊怎麼切，不會讓任何實料格消失。
      fill(solid);
    }

    // 5. 每塊統計。bbox 用格中心的工件座標（跟 heightAt 的節點式格網一致，不外擴半格）。
    const cnt = new Int32Array(nLabels + 1);
    const bx0 = new Int32Array(nLabels + 1).fill(nx), bx1 = new Int32Array(nLabels + 1).fill(-1);
    const by0 = new Int32Array(nLabels + 1).fill(ny), by1 = new Int32Array(nLabels + 1).fill(-1);
    const zlo = new Float64Array(nLabels + 1).fill(Infinity), zhi = new Float64Array(nLabels + 1).fill(-Infinity);
    const touch = new Uint8Array(nLabels + 1);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iy * nx + ix;
        const lab = labels[i];
        if (!lab) continue;
        cnt[lab]++;
        if (ix < bx0[lab]) bx0[lab] = ix;
        if (ix > bx1[lab]) bx1[lab] = ix;
        if (iy < by0[lab]) by0[lab] = iy;
        if (iy > by1[lab]) by1[lab] = iy;
        const z = h[i];
        if (z < zlo[lab]) zlo[lab] = z;
        if (z > zhi[lab]) zhi[lab] = z;
        if (fix && !touch[lab]
          && ((ix > 0 && fix[i - 1]) || (ix < nx - 1 && fix[i + 1]) || (iy > 0 && fix[i - nx]) || (iy < ny - 1 && fix[i + nx]))) touch[lab] = 1;
      }
    }

    // 6. 太小的塊不分類：格改回 0、清單不列。剩下的重新編成 1..N（chunks[i].label === i + 1），
    //    下游做 scrapByLabel 之類的查表才不用管編號有洞。
    const areaCell = cellX * cellY;
    const remap = new Int32Array(nLabels + 1);
    const list = [];
    for (let lab = 1; lab <= nLabels; lab++) {
      const areaMm2 = cnt[lab] * areaCell;
      if (areaMm2 < s.minAreaMm2) continue;
      const label = list.length + 1;
      remap[lab] = label;
      list.push({
        label, cells: cnt[lab], areaMm2,
        bbox: {
          x0: sim.origin.x + bx0[lab] * cellX, y0: sim.origin.y + by0[lab] * cellY,
          x1: sim.origin.x + bx1[lab] * cellX, y1: sim.origin.y + by1[lab] * cellY,
        },
        zMin: zlo[lab], zMax: zhi[lab],
        part: false, touchesFixture: touch[lab] === 1, why: 'other',
      });
    }
    if (list.length !== nLabels) for (let i = 0; i < n; i++) if (labels[i]) labels[i] = remap[labels[i]];
    const L = list.length;

    // 7. 分類。先看記號落在哪一塊（落在空氣／夾具／太小的塊上的記號沒有作用）。
    const partMark = new Uint8Array(L + 1), scrapMark = new Uint8Array(L + 1);
    let anyPart = false, anyScrap = false;
    for (const m of s.marks) {
      const idx = cellIndex(sim, m.x, m.y);
      const lab = idx < 0 ? 0 : labels[idx];
      if (!lab) continue;
      if (m.kind === 'part') { partMark[lab] = 1; anyPart = true; } else { scrapMark[lab] = 1; anyScrap = true; }
    }
    // 原點與最大塊都只在「沒被 ✕ 的塊」裡挑：使用者在猜錯的那塊點了 ✕，下一個候選要自動補上，
    // 否則 auto 下 ✕ 了原點那塊之後會變成一塊工件都沒有，等於要使用者再點一次 ⊙。
    const oi = cellIndex(sim, 0, 0);
    let originLabel = oi < 0 ? 0 : labels[oi];
    if (originLabel && scrapMark[originLabel]) originLabel = 0;
    let largest = null;
    for (const c of list) if (!scrapMark[c.label] && (!largest || c.cells > largest.cells)) largest = c;   // 同大 → 編號小的
    const largestLabel = largest ? largest.label : 0;
    const anyTouch = list.some((c) => c.touchesFixture && !scrapMark[c.label]);

    let mode = s.anchor;
    if (mode === 'fixture' && !anyTouch) mode = 'auto';            // 一塊也沒碰到夾具（或根本沒夾具）→ 退回 auto
    if (mode === 'marks' && !anyPart && !anyScrap) mode = 'auto';  // 完全沒有落在塊上的記號 → 退回 auto
    const baseLabel = originLabel || largestLabel;
    const baseWhy = originLabel ? 'origin' : 'largest';
    for (const c of list) {
      // 記號在每一種 anchor 下都優先；同一塊兩種都有 → ⊙ 贏（使用者最後多半是想留它）
      if (partMark[c.label]) { c.part = true; c.why = 'mark'; continue; }
      if (scrapMark[c.label]) { c.part = false; c.why = 'scrapMark'; continue; }
      switch (mode) {
        case 'largest': c.part = c.label === largestLabel; c.why = c.part ? 'largest' : 'other'; break;
        case 'fixture': c.part = c.touchesFixture; c.why = c.part ? 'fixture' : 'other'; break;
        // 有任何 ⊙ → 沒標的都是廢料；只有 ✕ → 沒標的都是工件
        case 'marks': c.part = !anyPart; c.why = 'unmarked'; break;
        default: c.part = c.label === baseLabel; c.why = c.part ? baseWhy : 'other';   // auto／origin
      }
    }

    // 8. 彙總。partTouchesFixture 在「沒有夾具格」與「一塊工件都沒有」時都是 null：
    //    後者（例如每一塊都被 ✕ 掉）回 false 的話 UI 會警告「工件沒碰到夾具，切斷後會掉落」，可是根本沒有工件。
    let partCount = 0, scrapCount = 0, scrapAreaMm2 = 0, partTouches = false;
    for (const c of list) {
      if (c.part) { partCount++; if (c.touchesFixture) partTouches = true; } else { scrapCount++; scrapAreaMm2 += c.areaMm2; }
    }
    return {
      supported: true, labels, chunks: list, partCount, scrapCount, scrapAreaMm2,
      partTouchesFixture: (hasFixture && partCount > 0) ? partTouches : null,
      hasFixture,
    };
  }

  /**
   * 依分類導出給 3D 用的高度陣列（不改原陣列）。
   *   which 'part'  → 廢料格壓到 floorZ、其餘照抄：主 mesh 只畫工件（「隱藏」模式就是它）
   *   which 'scrap' → 非廢料格全部壓到 floorZ、廢料格照抄：另一份 mesh 當廢料層淡橘疊上去
   * labels 為 null（不支援）時 'part' 就是照抄、'scrap' 全是 floorZ——呼叫端不用另外判。
   * @param {Float32Array} heightArr
   * @param {Int32Array|null} labels
   * @param {Chunk[]} chunks
   * @param {number} floorZ
   * @param {'part'|'scrap'} which
   * @returns {Float32Array}
   */
  function chunkHeights(heightArr, labels, chunks, floorZ, which) {
    const n = heightArr.length;
    const out = new Float32Array(n);
    const list = Array.isArray(chunks) ? chunks : [];
    let maxLabel = 0;
    for (const c of list) if (c.label > maxLabel) maxLabel = c.label;
    const isScrap = new Uint8Array(maxLabel + 1);
    for (const c of list) if (!c.part && c.label > 0) isScrap[c.label] = 1;
    const hasLabels = !!labels && labels.length === n;
    if (which === 'scrap') {
      out.fill(floorZ);
      if (hasLabels) for (let i = 0; i < n; i++) { const l = labels[i]; if (l && isScrap[l]) out[i] = heightArr[i]; }
    } else {
      out.set(heightArr);
      if (hasLabels) for (let i = 0; i < n; i++) { const l = labels[i]; if (l && isScrap[l]) out[i] = floorZ; }
    }
    return out;
  }

  NC.sim = {
    create, run, profileFor, selectSegments, heightAt, cellIndex, segLength,
    spansOf, matchSpans, cylSection, cylSectionY,
    // 廢料判定
    defaultScrap, normalizeScrap, chunks, chunkHeights, SCRAP_ANCHORS, SCRAP_MAX,
  };
})(globalThis.NC = globalThis.NC || {});
