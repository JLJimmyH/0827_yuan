/*
 * NC 預演台 — 2D 視圖（Canvas 2D）。
 * NC.ui.createView2D(canvas) → View
 *   setData({segments, sim, stock, toolTable, scenario})
 *   setMode('top'|'sectionX'|'sectionY')   setSection(v)   setSnapshot(i|null)
 *   highlightLine(n)   highlightTool(t|null)   setVisible({rapid, feed, stock, tools})
 *   onPick((line, seg) => …)   fit()   render()   destroy()
 * 俯視：素材外框、heightmap 色階（頂面淺灰 → 深處深藍，離屏 canvas putImageData 後 drawImage 縮放）、
 *       路徑（rapid 灰虛線、feed 依刀具色 12 色循環、compensated 實線、programmed 細線、drill 短線＋孔標記）、
 *       目前高亮行（粗亮色）、高亮刀具（其他淡化）。
 * 剖面：sectionX / sectionY 畫該位置的高度折線、素材輪廓、投影路徑與標尺。
 * 第四軸：俯視／剖面 X／剖面 Y 三張都改畫在工件座標上（圓棒），高度圖先用 cylToCartesian
 *        從 (X, 弧長)→半徑 攤成 (X, Y)→Z 的上下包絡，三張圖與 3D／展開圖同一套座標。
 * 互動：滾輪縮放（以滑鼠為中心）、拖曳平移、雙擊 fit、hover 顯示工件座標與該格深度、點擊最近的段 → onPick。
 * 純邏輯（色階、影像、剖面、挑選、fit 變換）另掛在 NC.ui.view2dUtil，方便在 Node 測。
 */
(function (NC) {
  'use strict';
  NC.ui = NC.ui || {};

  const util = NC.util || {};
  const clamp = util.clamp || ((v, lo, hi) => Math.min(hi, Math.max(lo, v)));
  const fmt = util.fmt || ((v, d = 3) => (v == null ? '—' : String(Math.round(v * 1000) / 1000)));
  const TAU = Math.PI * 2;

  // 刀具色（12 色循環，T1 → 第 0 色）
  const TOOL_COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#e377c2', '#8c564b', '#bcbd22', '#0b8f8f', '#c05a00', '#5b3fd6'];
  // 色階端點：頂面暖灰 → 深處深藍；高於頂面（治具）用土黃。
  // 頂面色一定要和畫布背景（C.bg #fbfbfb）分得開——「哪裡還是實心」是這個工具的核心資訊，
  // 舊值 [236,236,236] 對背景只有 1.13:1，整片素材看起來像什麼都沒有。
  const TOP_RGB = [222, 216, 206];
  const DEEP_RGB = [14, 34, 104];
  const FIXTURE_RGB = [196, 160, 120];
  const C = {
    bg: '#fbfbfb',
    stockFill: 'rgba(214,214,214,0.55)',
    stockFillOut: 'rgba(214,214,214,0.2)',
    stockLine: '#4a4a4a',
    fixtureFill: 'rgba(196,160,120,0.5)',
    fixtureLine: '#8b5a2b',
    rapid: '#9a9a9a',
    highlight: '#ff2d55',
    halo: 'rgba(255,255,255,0.95)',
    text: '#222',
    hudBg: 'rgba(255,255,255,0.86)',
    hudAlertBg: 'rgba(255,214,140,0.95)',
    ruler: '#8a8a8a',
    rulerText: '#555',
    grid: 'rgba(0,0,0,0.05)',
    axis: 'rgba(0,0,0,0.35)',
    section: '#ff9500',
    profileFill: 'rgba(70,120,210,0.28)',
    profileLine: '#1d4ed8',
    zero: 'rgba(0,0,0,0.3)',
  };
  const PICK_PX = 6;           // 點選距離門檻（CSS px）
  const DRAG_PX = 3;           // 超過此位移視為拖曳而非點擊
  const PAD = { l: 46, r: 14, t: 30, b: 28 };  // 標尺／抬頭顯示留白（CSS px）
  const FONT = '11px system-ui, "Segoe UI", "Microsoft JhengHei", sans-serif';
  const FONT_HUD = '12px system-ui, "Segoe UI", "Microsoft JhengHei", sans-serif';

  // ---------------------------------------------------------------------------
  // 純函式（可在 Node 測）
  // ---------------------------------------------------------------------------
  /** 刀具色：T 號 12 色循環；null → 灰藍 */
  function toolColor(t) {
    if (t == null || !Number.isFinite(t)) return '#607d8b';
    const i = (((Math.round(t) - 1) % TOOL_COLORS.length) + TOOL_COLORS.length) % TOOL_COLORS.length;
    return TOOL_COLORS[i];
  }

  /** 高度 → 色階 [r,g,b]。h ≥ zTop 淺灰；h ≤ zBottom 深藍；高於頂面（治具）土黃。 */
  function depthColor(h, zTop, zBottom) {
    if (h > zTop + 1e-6) return FIXTURE_RGB.slice();
    const span = zTop - zBottom;
    let f = span > 1e-9 ? (zTop - h) / span : (h < zTop ? 1 : 0);
    f = Math.pow(clamp(f, 0, 1), 0.6);   // 讓淺切也看得出來
    return [0, 1, 2].map((k) => Math.round(TOP_RGB[k] + (DEEP_RGB[k] - TOP_RGB[k]) * f));
  }

  /**
   * 把 heightmap 轉成 RGBA 影像資料（列已上下翻轉：影像第 0 列 = 工件 Y 最大那列）。
   * 高度是 NaN 的格 = 這裡沒有材料（圓棒攤成直角座標之後，四個角就是空的），畫成全透明；
   * 填 floorZ 會變成一片最深的藍，看起來像被挖穿。
   * @returns {{width:number,height:number,data:Uint8ClampedArray}}
   */
  function buildHeightImage(sim, heightArr, zTop, zBottom) {
    const nx = sim.nx, ny = sim.ny;
    const arr = heightArr || sim.height;
    const data = new Uint8ClampedArray(nx * ny * 4);
    const span = zTop - zBottom;
    // 256 階查表
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const rgb = depthColor(zTop - (span * i) / 255, zTop, zBottom);
      lut[i * 3] = rgb[0]; lut[i * 3 + 1] = rgb[1]; lut[i * 3 + 2] = rgb[2];
    }
    for (let iy = 0; iy < ny; iy++) {
      const row = ny - 1 - iy;
      for (let ix = 0; ix < nx; ix++) {
        const h = arr[iy * nx + ix];
        const o = (row * nx + ix) * 4;
        if (!Number.isFinite(h)) continue;   // 沒有材料 → alpha 維持 0
        if (h > zTop + 1e-6) {
          data[o] = FIXTURE_RGB[0]; data[o + 1] = FIXTURE_RGB[1]; data[o + 2] = FIXTURE_RGB[2];
        } else {
          const k = span > 1e-9 ? clamp(Math.round(((zTop - h) / span) * 255), 0, 255) : 0;
          data[o] = lut[k * 3]; data[o + 1] = lut[k * 3 + 1]; data[o + 2] = lut[k * 3 + 2];
        }
        data[o + 3] = 255;
      }
    }
    return { width: nx, height: ny, data };
  }

  /*
   * 格子解讀（與 simulation.js 一致）：格 (ix,iy) 的中心在 origin + (ix·cell, iy·cell)，
   * 即節點式格網，覆蓋範圍為 origin − cell/2 … origin + (n − 0.5)·cell；查表用四捨五入。
   */
  /** 模擬格覆蓋的工件座標範圍 {minX,minY,maxX,maxY} */
  function simExtent(sim) {
    const h = sim.cell / 2;
    return { minX: sim.origin.x - h, minY: sim.origin.y - h, maxX: sim.origin.x + (sim.nx - 0.5) * sim.cell, maxY: sim.origin.y + (sim.ny - 0.5) * sim.cell };
  }

  /** 該工件座標所在格的高度；在格外 → null */
  function heightAt(sim, heightArr, x, y) {
    if (!sim) return null;
    const arr = heightArr || sim.height;
    const ix = Math.round((x - sim.origin.x) / sim.cell);
    const iy = Math.round((y - sim.origin.y) / sim.cell);
    if (ix < 0 || iy < 0 || ix >= sim.nx || iy >= sim.ny) return null;
    const h = arr[iy * sim.nx + ix];
    return Number.isFinite(h) ? h : null;
  }

  /**
   * 圓棒高度圖 → 直角座標的上下包絡（俯視與剖面 Y 用）。
   *
   * 圓棒模擬記的是 `(X, 弧長) → 半徑`；俯視要的是 `(X, Y) → Z`、剖面 Y 要的是某個 Y 上的
   * 材料高低。兩者其實是同一件事：每一個 X 欄的橫截面就是一圈點 `(y, z)` 圍成的封閉多邊形，
   * 把相鄰兩點連成的邊沿 Y 掃描一次，每個 Y 格記下**最高**與**最低**的 Z，就同時得到
   * 「從上面看是什麼」與「這一刀切下去的斷面」。沒有掃到的格 = 這裡沒有材料 → NaN。
   *
   * 只取上下包絡（不是每一段材料）：分度銑槽、鑽孔這些用包絡畫出來就是對的；
   * 貫穿孔在模擬裡兩側都會被挖到軸心，包絡自然收成很薄的一片，讀起來也對。
   * 真正表現不了的還是側凹——那是高度圖本身的限制（見 CONTRACT §13.10）。
   *
   * @param {Object} sim  cylinder=true 的 SimResult
   * @param {Float32Array} [heightArr] 要用的高度（預設 sim.height）
   * 另外附一份 `radius`＝上表面那一點離軸心多遠。圓棒的「深」是**離軸心多近**，不是 Z 低——
   * 拿 Z 當色階的話，整根棒子會因為本身是圓的而被畫成一大片漸層，切出來的槽反而看不見。
   *
   * @returns {{nx:number,ny:number,cell:number,origin:{x:number,y:number},
   *            height:Float32Array,bottom:Float32Array,radius:Float32Array,
   *            floorZ:number,topZ:number}|null}
   */
  function cylToCartesian(sim, heightArr) {
    if (!sim || !sim.cylinder || !(sim.radius > 0)) return null;
    const arr = heightArr || sim.height;
    if (!arr) return null;
    const R = sim.radius;
    const cy = (sim.center && sim.center.y) || 0;
    const cz = (sim.center && sim.center.z) || 0;
    const cell = sim.cellX || sim.cell;
    const nx = sim.nx, nSeg = sim.ny, cellY = sim.cellY;
    const ny = Math.max(2, Math.ceil((2 * R) / cell) + 1);
    const originY = cy - ((ny - 1) * cell) / 2;
    const top = new Float32Array(nx * ny).fill(NaN);
    const bottom = new Float32Array(nx * ny).fill(NaN);
    for (let ix = 0; ix < nx; ix++) {
      let ay = 0, az = 0;
      for (let j = 0; j <= nSeg; j++) {
        const jj = j === nSeg ? 0 : j;            // 繞回第 0 圈，封閉多邊形
        let rr = arr[jj * nx + ix];
        if (!(rr > 0)) rr = 0;                    // r ≤ 0 = 鑽穿了，收到軸心
        const th = (j * cellY) / R;
        const by = cy + rr * Math.sin(th);
        const bz = cz + rr * Math.cos(th);
        if (j > 0) {
          // 把這條邊掃進 Y 格。**只填 y 真的落在這條邊上的格**（ceil/floor，不是 round）：
          // 四捨五入會把邊拉到格心，圓周最上／最下那一排（邊幾乎平行 Z）會被拉出圓外，
          // 算出來的半徑就大於外圓，整片被當成治具塗成土黃色。
          let i0 = Math.ceil((Math.min(ay, by) - originY) / cell - 1e-9);
          let i1 = Math.floor((Math.max(ay, by) - originY) / cell + 1e-9);
          if (i0 < 0) i0 = 0;
          if (i1 > ny - 1) i1 = ny - 1;
          const dy = by - ay;
          const flat = Math.abs(dy) <= 1e-9;
          for (let iy = i0; iy <= i1; iy++) {
            const yy = originY + iy * cell;
            let zHi, zLo;
            if (flat) { zHi = Math.max(az, bz); zLo = Math.min(az, bz); }   // 邊平行 Z：整段落在同一格
            else { zHi = zLo = az + (bz - az) * clamp((yy - ay) / dy, 0, 1); }
            const o = iy * nx + ix;
            if (!(top[o] >= zHi)) top[o] = zHi;   // NaN >= z 為 false → 第一次直接寫入
            if (!(bottom[o] <= zLo)) bottom[o] = zLo;
          }
        }
        ay = by; az = bz;
      }
    }
    const radius = new Float32Array(nx * ny).fill(NaN);
    for (let iy = 0; iy < ny; iy++) {
      const dy = originY + iy * cell - cy;
      for (let ix = 0; ix < nx; ix++) {
        const o = iy * nx + ix;
        if (Number.isFinite(top[o])) radius[o] = Math.hypot(dy, top[o] - cz);
      }
    }
    return { nx, ny, cell, origin: { x: sim.origin.x, y: originY }, height: top, bottom, radius, floorZ: cz - R, topZ: cz + R };
  }

  /**
   * 剖面折線。cutAxis='x' → 在 X=v 切，回傳沿 Y 的 (pos, z)；cutAxis='y' → 在 Y=v 切，沿 X。
   * @returns {{pos:number[], z:number[]}|null}
   */
  function sectionProfile(sim, heightArr, cutAxis, v) {
    if (!sim) return null;
    const arr = heightArr || sim.height;
    const { nx, ny, cell, origin } = sim;
    const pos = [], z = [];
    if (cutAxis === 'x') {
      const ix = Math.round((v - origin.x) / cell);
      if (ix < 0 || ix >= nx) return null;
      for (let iy = 0; iy < ny; iy++) { pos.push(origin.y + iy * cell); z.push(arr[iy * nx + ix]); }
    } else {
      const iy = Math.round((v - origin.y) / cell);
      if (iy < 0 || iy >= ny) return null;
      for (let ix = 0; ix < nx; ix++) { pos.push(origin.x + ix * cell); z.push(arr[iy * nx + ix]); }
    }
    return { pos, z };
  }

  /**
   * 逐欄取樣的剖面折線 → 畫圖用的點列。相鄰欄的值跳超過**兩格**視為鉛直牆，
   * 在兩欄的中線插兩個點畫成真正的階梯——直接連線會把鉛直牆畫成一格寬的斜線
   * （平底刀的孔壁 17→10 跳變在螢幕上斜 3~4°，「直上直下的刀」看起來就不直了）。
   * 緩坡不動（鑽尖錐面每欄只差 0.3 格、球刀弧面同理），不會被畫成樓梯。
   */
  function steppedProfile(xs, vs, cell) {
    const out = [];
    for (let i = 0; i < xs.length; i++) {
      if (i > 0 && Math.abs(vs[i] - vs[i - 1]) > 2 * cell) {
        const xm = (xs[i - 1] + xs[i]) / 2;
        out.push({ x: xm, v: vs[i - 1] }, { x: xm, v: vs[i] });
      }
      out.push({ x: xs[i], v: vs[i] });
    }
    return out;
  }

  /** 標尺刻度：≥ raw 的 1/2/5×10^n */
  function niceStep(raw) {
    if (!(raw > 0) || !Number.isFinite(raw)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    const k = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
    return k * p;
  }

  function distPointSeg2D(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = 0;
    if (l2 > 1e-18) t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }

  function normAngle(a) { a %= TAU; if (a < 0) a += TAU; return a; }

  /** 點到圓弧段的距離（XY 平面、工件單位） */
  function arcDistance(seg, px, py) {
    const c = seg.arc.center, r = seg.arc.r;
    const a0 = Math.atan2(seg.from.y - c.y, seg.from.x - c.x);
    const a1 = Math.atan2(seg.to.y - c.y, seg.to.x - c.x);
    const ap = Math.atan2(py - c.y, px - c.x);
    let sweep, off;
    if (seg.arc.cw) { sweep = normAngle(a0 - a1); off = normAngle(a0 - ap); }
    else { sweep = normAngle(a1 - a0); off = normAngle(ap - a0); }
    if (sweep < 1e-9 && Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) < 1e-6) sweep = TAU; // 整圓
    if (off <= sweep) return Math.abs(Math.hypot(px - c.x, py - c.y) - r);
    return Math.min(Math.hypot(px - seg.from.x, py - seg.from.y), Math.hypot(px - seg.to.x, py - seg.to.y));
  }

  /** 點到段的距離（XY 平面、工件單位）；直線或圓弧 */
  function segDistance2D(seg, px, py) {
    if (seg.arc) return arcDistance(seg, px, py);
    return distPointSeg2D(px, py, seg.from.x, seg.from.y, seg.to.x, seg.to.y);
  }

  /**
   * 找最近的段：距離（乘上 scale 變成 px）≤ thresholdPx 才算命中；同距離時偏好 compensated。
   * @returns {{seg:Object, dist:number}|null}
   */
  function pickSegment(segments, px, py, scale, thresholdPx, filter) {
    let best = null, bd = Infinity;
    for (const seg of segments) {
      if (filter && !filter(seg)) continue;
      const d = segDistance2D(seg, px, py) * scale;
      if (d < bd - 1e-9 || (d <= bd + 1e-9 && best && best.path !== 'compensated' && seg.path === 'compensated')) { bd = d; best = seg; }
    }
    return best && bd <= thresholdPx ? { seg: best, dist: bd } : null;
  }

  function newBounds() { return { minH: Infinity, maxH: -Infinity, minV: Infinity, maxV: -Infinity }; }
  function extend(b, h, v) {
    if (!Number.isFinite(h) || !Number.isFinite(v)) return;
    if (h < b.minH) b.minH = h; if (h > b.maxH) b.maxH = h;
    if (v < b.minV) b.minV = v; if (v > b.maxV) b.maxV = v;
  }
  function validBounds(b) { return b.minH <= b.maxH && b.minV <= b.maxV ? b : null; }

  /** 俯視包絡（XY）：素材、治具、模擬格、所有非 G28 段 */
  function topBounds(data) {
    const b = newBounds();
    const { stock, sim, segments } = data;
    if (stock) {
      extend(b, stock.min.x, stock.min.y); extend(b, stock.max.x, stock.max.y);
      for (const f of stock.fixtures || []) { extend(b, f.min.x, f.min.y); extend(b, f.max.x, f.max.y); }
    }
    if (sim) { const e = simExtent(sim); extend(b, e.minX, e.minY); extend(b, e.maxX, e.maxY); }
    for (const s of segments || []) {
      if (s.refReturn) continue;
      extend(b, s.from.x, s.from.y); extend(b, s.to.x, s.to.y);
      if (s.arc) { extend(b, s.arc.center.x - s.arc.r, s.arc.center.y - s.arc.r); extend(b, s.arc.center.x + s.arc.r, s.arc.center.y + s.arc.r); }
    }
    return validBounds(b);
  }

  /** 剖面包絡：水平軸 hAxis（'x'|'y'）、垂直軸 Z（不含 rapid） */
  function sectionBounds(data, hAxis) {
    const b = newBounds();
    const { stock, sim, segments } = data;
    if (stock) {
      extend(b, stock.min[hAxis], stock.min.z); extend(b, stock.max[hAxis], stock.max.z);
      for (const f of stock.fixtures || []) { extend(b, f.min[hAxis], f.min.z); extend(b, f.max[hAxis], f.max.z); }
    }
    if (sim) {
      const e = simExtent(sim);
      extend(b, hAxis === 'x' ? e.minX : e.minY, sim.floorZ); extend(b, hAxis === 'x' ? e.maxX : e.maxY, sim.floorZ);
    }
    for (const s of segments || []) {
      if (s.kind === 'rapid') continue;
      extend(b, s.from[hAxis], s.from.z); extend(b, s.to[hAxis], s.to.z);
    }
    const v = validBounds(b);
    if (!v) return null;
    v.maxV = Math.max(v.maxV, 0) + 2;   // 頂面上方留一點空
    v.minV -= 1;
    return v;
  }

  /** 由包絡算出 fit 變換 {scale, ox, oy}（螢幕 = ox + h·scale, oy − v·scale） */
  function fitTransform(b, w, h, pad) {
    pad = pad || PAD;
    const aw = Math.max(1, w - pad.l - pad.r), ah = Math.max(1, h - pad.t - pad.b);
    const spanH = Math.max(b.maxH - b.minH, 1e-3), spanV = Math.max(b.maxV - b.minV, 1e-3);
    const scale = Math.min(aw / spanH, ah / spanV) * 0.94;
    const cx = pad.l + aw / 2, cy = pad.t + ah / 2;
    return { scale, ox: cx - ((b.minH + b.maxH) / 2) * scale, oy: cy + ((b.minV + b.maxV) / 2) * scale };
  }

  NC.ui.view2dUtil = {
    TOOL_COLORS, PAD, PICK_PX, toolColor, depthColor, buildHeightImage, simExtent, heightAt, sectionProfile, niceStep,
    steppedProfile, distPointSeg2D, arcDistance, segDistance2D, pickSegment, topBounds, sectionBounds, fitTransform,
    cylToCartesian,
  };

  // ---------------------------------------------------------------------------
  // View
  // ---------------------------------------------------------------------------
  // 「開關關 / 開關開」在 11px 下差一個形近字，讀錯會做出完全相反的判斷。
  const SCENARIO_LABEL = {
    off: 'Block skip：關（全部執行）',
    on: 'Block skip：開（跳過 / 節）',
    multiIgnored: 'Block skip：只跳過多斜線節',
  };
  const MODES = ['top', 'sectionX', 'sectionY', 'unroll'];

  /** 角度格線的級距（展開圖的縱軸是度，不是 mm，不能跟 niceStep 共用） */
  function niceAngleStep(raw) {
    for (const c of [1, 2, 5, 10, 15, 30, 45, 60, 90, 180]) if (c >= raw) return c;
    return 360;
  }

  function createView2D(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new Error('createView2D 需要 canvas 元素');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('取不到 2D context');

    const S = {
      data: { segments: [], sim: null, stock: null, toolTable: null, scenario: 'off' },
      heightArr: null,          // 目前顯示的高度陣列（sim.height 或某個 snapshot）
      extraMap: null,           // 同一份的材料區間（圓棒才有）
      snapshotIndex: null,
      mode: 'top',
      section: 0,
      hlLine: null,
      hlTool: null,
      // rotary = 工件轉動時刀的相對軌跡。預設關（見 view3d 的同名開關）。
      visible: { rapid: true, feed: true, refReturn: false, stock: true, rotary: false, tools: null },
      view: { top: null, sectionX: null, sectionY: null, unroll: null },   // 各模式獨立的 {scale, ox, oy}
      unrollCache: null,        // 展開圖資料（段或迴轉中心變了才重算）
      size: { w: 0, h: 0 },
      dpr: 1,
      hover: null,
      drag: null,
      needFit: true,
      imageCache: null,
      cylCache: null,           // 圓棒高度圖攤成直角座標的結果（俯視／剖面 Y 用）
      secCache: null,           // 圓棒某個 X 的橫截面輪廓（剖面 X 用）
      workCache: null,          // 段換算到工件座標的取樣（四軸的俯視／剖面共用）
      cssSized: null,           // canvas 尺寸是否由 CSS 決定（null = 還沒探測）
      toolRadius: new Map(),
      compLines: new Set(),
      byLine: new Map(),
      pickCb: null,
      scheduled: false,
      destroyed: false,
    };

    // ---- 基本換算 ----------------------------------------------------------
    const curView = () => S.view[S.mode];
    const hAxis = () => (S.mode === 'sectionX' ? 'y' : 'x');   // 剖面水平軸
    const cutAxis = () => (S.mode === 'sectionX' ? 'x' : 'y');
    function toScreen(h, v) { const V = curView(); return [V.ox + h * V.scale, V.oy - v * V.scale]; }
    function toWorld(sx, sy) { const V = curView(); return [(sx - V.ox) / V.scale, (V.oy - sy) / V.scale]; }
    function plotRect() { const { w, h } = S.size; return [PAD.l, PAD.t, Math.max(1, w - PAD.l - PAD.r), Math.max(1, h - PAD.t - PAD.b)]; }

    function makeCanvas(w, h) {
      const doc = canvas.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (doc && typeof doc.createElement === 'function') {
        const c = doc.createElement('canvas'); c.width = w; c.height = h; return c;
      }
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
      return null;
    }

    /**
     * canvas 的版面尺寸是不是由 width/height **屬性**決定的（也就是沒有 CSS 尺寸）？
     * 是的話，下面把屬性乘上 devicePixelRatio 會讓版面跟著放大、下一次再乘一次…愈滾愈大，
     * 所以要把 CSS 尺寸釘成內聯樣式。有 CSS 尺寸（css/view2d.css 的 width:100%）的
     * **絕對不能釘**：內聯樣式會蓋掉 CSS，拖分隔線／縮視窗時 canvas 就永遠停在第一次量到的大小。
     * 與 view3d.js 的同名函式同一套做法，只在第一次量得到尺寸時探測一次。
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

    /** 同步 canvas 像素尺寸與 devicePixelRatio；回傳是否有有效尺寸 */
    function syncSize() {
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      let w = canvas.clientWidth, h = canvas.clientHeight;
      if (!(w > 0 && h > 0)) {
        // 尚未排版：退而用既有像素尺寸
        w = canvas.width / (S.dpr || 1); h = canvas.height / (S.dpr || 1);
        if (!(w > 0 && h > 0)) return false;
      } else {
        detectCssSized(w, h);
      }
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      S.size.w = w; S.size.h = h; S.dpr = dpr;
      return true;
    }

    function requestRender() {
      if (S.scheduled || S.destroyed) return;
      S.scheduled = true;
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
      raf(() => { S.scheduled = false; render(); });
    }

    function rebuildIndex() {
      S.toolRadius = new Map();
      const tt = S.data.toolTable;
      if (tt && Array.isArray(tt.tools)) for (const t of tt.tools) if (t && t.diameter > 0) S.toolRadius.set(t.t, t.diameter / 2);
      S.compLines = new Set();
      S.byLine = new Map();
      S.unrollCache = null;
      S.workCache = null;
      for (const s of S.data.segments) {
        if (s.path === 'compensated') S.compLines.add(s.line);
        let arr = S.byLine.get(s.line);
        if (!arr) { arr = []; S.byLine.set(s.line, arr); }
        arr.push(s);
      }
    }

    function isVisible(seg) {
      const vis = S.visible;
      // G28／G30 回原點：中間點與參考點都在 Z150 的空中，畫成一般 G0 就是兩條橫跨整個
      // 工件的大對角線，把版面切成兩半（15 把刀的程式會變成一團看不懂的線）。預設不畫。
      if (seg.refReturn) return !!vis.refReturn;
      // 工件座標的視圖（展開圖、四軸剖面 X）裡，轉動期間的移動是繞著工件的弧，
      // 那不是刀走過的路——刀只走直線，是工件在轉。預設不畫。
      if (seg.aFrom !== undefined && (S.mode === 'unroll' || rotaryOn()) && !vis.rotary) return false;
      if (seg.kind === 'rapid') { if (!vis.rapid) return false; } else if (!vis.feed) return false;
      if (vis.tools && seg.tool != null && !vis.tools.has(seg.tool)) return false;
      return true;
    }

    /** 色階範圍 [zTop, zBottom] */
    function depthRange() {
      const { sim, stock } = S.data;
      // 圓棒：頂＝表面（軸心 + 半徑）、底＝軸心。用方料的 stock.min/max.z 會把整根棒子
      // 壓進一個對不上的色階（那個包絡盒是給下游規則用的，不是給色階用的）。
      if (rotaryOn() && sim && sim.cylinder && sim.radius > 0) {
        const cz = (sim.center && sim.center.z) || 0;
        return [cz + sim.radius, cz - sim.radius];
      }
      let zTop = stock ? stock.max.z : null;
      let zBottom = stock ? stock.min.z : null;
      if (sim) {
        if (zBottom == null || sim.floorZ < zBottom) zBottom = sim.floorZ;
        if (zTop == null && S.heightArr) { zTop = -Infinity; for (let i = 0; i < S.heightArr.length; i++) if (S.heightArr[i] > zTop) zTop = S.heightArr[i]; if (!Number.isFinite(zTop)) zTop = 0; }
      }
      if (zTop == null) zTop = 0;
      if (zBottom == null || zBottom >= zTop) zBottom = zTop - 10;
      return [zTop, zBottom];
    }

    /**
     * 取得（快取的）heightmap 離屏 canvas。
     * `grid`/`arr` 不給就用目前的模擬格與高度；四軸俯視傳的是 `cylToCartesian()` 攤好的那一份。
     */
    function heightImage(grid, arr, range) {
      grid = grid || S.data.sim;
      arr = arr || S.heightArr;
      if (!grid || !arr) return null;
      const [zTop, zBottom] = range || depthRange();
      const c = S.imageCache;
      if (c && c.arr === arr && c.zTop === zTop && c.zBottom === zBottom) return c.canvas;
      const img = buildHeightImage(grid, arr, zTop, zBottom);
      const off = makeCanvas(img.width, img.height);
      if (!off) return null;
      const octx = off.getContext('2d');
      const id = octx.createImageData(img.width, img.height);
      id.data.set(img.data);
      octx.putImageData(id, 0, 0);
      S.imageCache = { arr, zTop, zBottom, canvas: off };
      return off;
    }

    // ---- 繪圖：共用 ----------------------------------------------------------
    function rectW(h0, v0, h1, v1) {
      const [ax, ay] = toScreen(h0, v0), [bx, by] = toScreen(h1, v1);
      return [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
    }

    /** 沿目前 view 畫一段（已 beginPath）；俯視用 */
    function tracePathTop(seg, ax, ay, bx, by) {
      const V = curView();
      if (seg.arc) {
        const c = seg.arc.center;
        const [cx, cy] = toScreen(c.x, c.y);
        const a0 = Math.atan2(seg.from.y - c.y, seg.from.x - c.x);
        let a1 = Math.atan2(seg.to.y - c.y, seg.to.x - c.x);
        const full = Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) < 1e-6;
        if (full) a1 = a0 + (seg.arc.cw ? -TAU : TAU);
        // 螢幕 Y 朝下 → 角度取負；世界 CW（G2）在螢幕上為角度遞增（anticlockwise=false）
        ctx.arc(cx, cy, seg.arc.r * V.scale, -a0, -a1, !seg.arc.cw);
      } else {
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
    }

    function drawGrid() {
      const V = curView();
      const [px, py, pw, ph] = plotRect();
      const step = niceStep(70 / V.scale);
      const [h0] = toWorld(px, 0), [h1] = toWorld(px + pw, 0);
      const [, v1] = toWorld(0, py), [, v0] = toWorld(0, py + ph);
      ctx.save();
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath();
      for (let k = Math.ceil(h0 / step); k * step <= h1; k++) { const [sx] = toScreen(k * step, 0); ctx.moveTo(sx, py); ctx.lineTo(sx, py + ph); }
      for (let k = Math.ceil(v0 / step); k * step <= v1; k++) { const [, sy] = toScreen(0, k * step); ctx.moveTo(px, sy); ctx.lineTo(px + pw, sy); }
      ctx.stroke();
      ctx.restore();
    }

    function drawRulers(hLabel, vLabel) {
      const V = curView();
      const { w, h } = S.size;
      const [px, py, pw, ph] = plotRect();
      const step = niceStep(70 / V.scale);
      const [h0] = toWorld(px, 0), [h1] = toWorld(px + pw, 0);
      const [, v1] = toWorld(0, py), [, v0] = toWorld(0, py + ph);
      ctx.save();
      ctx.font = FONT; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.strokeStyle = C.ruler; ctx.fillStyle = C.rulerText;
      ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
      // 水平軸（底）
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.beginPath();
      for (let k = Math.ceil(h0 / step); k * step <= h1; k++) {
        const t = k * step; const [sx] = toScreen(t, 0);
        ctx.moveTo(sx, py + ph); ctx.lineTo(sx, py + ph + 5);
        ctx.fillText(fmt(t, 3), sx, py + ph + 7);
      }
      ctx.stroke();
      // 垂直軸（左）
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.beginPath();
      for (let k = Math.ceil(v0 / step); k * step <= v1; k++) {
        const t = k * step; const [, sy] = toScreen(0, t);
        ctx.moveTo(px - 5, sy); ctx.lineTo(px, sy);
        ctx.fillText(fmt(t, 3), px - 7, sy);
      }
      ctx.stroke();
      // 軸名
      ctx.fillStyle = C.text;
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(hLabel, w - 4, h - 4);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(vLabel, 4, py - 14);
      ctx.restore();
    }

    function labelBox(text, x, y, align, bg) {
      ctx.font = FONT_HUD;
      const tw = ctx.measureText(text).width;
      const bw = tw + 10, bh = 18;
      const bx = align === 'right' ? x - bw : x;
      ctx.fillStyle = bg || C.hudBg; ctx.fillRect(bx, y, bw, bh);
      ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + 5, y + bh / 2);
    }

    function hoverText() {
      const [hh, vv] = toWorld(S.hover.sx, S.hover.sy);
      const { sim } = S.data;
      const [zTop] = depthRange();
      let t, wx, wy;
      if (S.mode === 'unroll') {
        // 展開圖沒有第三個維度可以查高度圖（同一個 XY 在不同角度是工件的不同部位）
        return `X ${fmt(hh)}  A ${fmt(vv / angK())}°`;
      }
      if (rotaryOn()) {
        // 圓棒上真正有意義的量是「離軸心多遠、切進去多深」，不是 Z 面高度
        const c = S.data.rotaryCenter || { y: 0, z: 0 };
        const rad = rotaryRadius();
        const depth = (rr) => `　離中心 ${fmt(rr)}` + (rad > 0 ? `　（表面 R${fmt(rad)}，深 ${fmt(rad - rr)}）` : '');
        if (S.mode === 'sectionX') return `Y ${fmt(hh)}  Z ${fmt(vv)}` + depth(Math.hypot(hh - (c.y || 0), vv - (c.z || 0)));
        if (S.mode === 'sectionY') return `X ${fmt(hh)}  Z ${fmt(vv)}` + depth(Math.hypot(S.section - (c.y || 0), vv - (c.z || 0)));
        // 俯視：查攤平後那一點的表面 Z 與離軸心多遠
        const cart = cylCart();
        const zs = cart ? heightAt(cart, cart.height, hh, vv) : null;
        const rr = cart ? heightAt(cart, cart.radius, hh, vv) : null;
        return `X ${fmt(hh)}  Y ${fmt(vv)}`
          + (zs == null ? '' : `　表面 Z ${fmt(zs)}`) + (rr == null ? '' : depth(rr));
      }
      if (S.mode === 'top') { t = `X ${fmt(hh)}  Y ${fmt(vv)}`; wx = hh; wy = vv; }
      else {
        t = `${hAxis().toUpperCase()} ${fmt(hh)}  Z ${fmt(vv)}`;
        wx = hAxis() === 'x' ? hh : S.section; wy = hAxis() === 'y' ? hh : S.section;
      }
      const z = heightAt(sim, S.heightArr, wx, wy);
      if (z != null) t += `  Z面 ${fmt(z)}（深 ${fmt(zTop - z)}）`;
      return t;
    }

    function drawHud() {
      const { w, h } = S.size;
      const [px, py, , ph] = plotRect();
      const scen = SCENARIO_LABEL[S.data.scenario] || S.data.scenario;
      let modeText;
      if (S.mode === 'unroll') {
        const u = unrollData();
        let rad = '';
        if (u && u.radius) rad = `　工件半徑 R${fmt(u.radius.radius)}${u.radius.source === 'user' ? '' : '（推估）'}`;
        const c = S.data.rotaryCenter || { y: 0, z: 0 };
        const ctr = (c.y || c.z) ? `　迴轉中心 Y${fmt(c.y)} Z${fmt(c.z)}` : '';
        modeText = `展開圖（圓柱表面攤平）${rad}${ctr}`;
      } else if (rotaryOn()) {
        const r = rotaryRadius();
        const rad = r > 0 ? `　（外圓 R${fmt(r)}）` : '';
        modeText = S.mode === 'sectionX' ? `圓棒橫截面　X = ${fmt(S.section)}${rad}`
          : S.mode === 'sectionY' ? `圓棒縱剖面　Y = ${fmt(S.section)}${rad}`
            : `圓棒俯視（工件座標）${rad}`;
      } else if (S.mode === 'top') modeText = '俯視';
      else modeText = `剖面 ${cutAxis().toUpperCase()} = ${fmt(S.section)}`;
      let head = `${modeText} · ${scen}`;
      if (S.snapshotIndex != null) head += ` · 快照 ${S.snapshotIndex}`;
      if (S.hlTool != null) head += ` · 只看 T${S.hlTool}`;
      if (S.data.simStale) head += ' · 成品圖更新中';
      // 不是預設情境（開關關）時給 HUD 一個琥珀底，讓人一眼看出現在不是平常那一種
      const alert = S.data.scenario && S.data.scenario !== 'off';
      labelBox(head, px + 4, 6, 'left', alert ? C.hudAlertBg : null);
      if (S.hover && curView()) labelBox(hoverText(), w - PAD.r - 4, py + ph - 22, 'right');
      if (!S.data.segments.length && !S.data.stock && !S.data.sim) {
        ctx.font = FONT_HUD; ctx.fillStyle = C.rulerText; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('尚無資料', w / 2, h / 2);
      }
    }

    // ---- 俯視 --------------------------------------------------------------
    /**
     * 四軸的俯視：從上方看那根圓棒（工件座標）。
     * 圓棒的高度圖是 (X, 弧長) → 半徑，先用 cylToCartesian 攤成 (X, Y) → Z 再照一般色階畫；
     * 攤不出材料的格是透明的，所以四個角看得到底色，一眼分得出哪裡是棒身、哪裡是空的。
     */
    function drawStockTopRotary() {
      const V = curView();
      const cart = cylCart();
      const c = S.data.rotaryCenter || { y: 0, z: 0 };
      const cy = c.y || 0;
      const r = rotaryRadius();
      let x0, x1;
      if (cart) {
        const e = simExtent(cart);
        x0 = e.minX; x1 = e.maxX;
        // 色階吃的是「離軸心多遠」：沒切過的地方一律是表面色，切下去才變深
        const img = heightImage(cart, cart.radius, [r, 0]);
        if (img) {
          const [sx, sy] = toScreen(e.minX, e.maxY);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, sx, sy, cart.nx * cart.cell * V.scale, cart.ny * cart.cell * V.scale);
          ctx.imageSmoothingEnabled = true;
        }
      } else if (S.data.stock) {
        x0 = S.data.stock.min.x; x1 = S.data.stock.max.x;
        const rr0 = rectW(x0, cy - r, x1, cy + r);
        ctx.fillStyle = C.stockFill; ctx.fillRect(rr0[0], rr0[1], rr0[2], rr0[3]);
      } else return;
      if (!(r > 0)) return;
      ctx.lineWidth = 1.5; ctx.setLineDash([]);
      const rr = rectW(x0, cy - r, x1, cy + r);
      ctx.strokeStyle = C.stockLine; ctx.strokeRect(rr[0], rr[1], rr[2], rr[3]);
      // 母線（軸心在俯視上的投影）：分度孔排不排得齊，看這條線
      const [, my] = toScreen(0, cy);
      ctx.strokeStyle = C.zero; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(rr[0], my); ctx.lineTo(rr[0] + rr[2], my); ctx.stroke();
      ctx.setLineDash([]);
    }

    function drawStockTop() {
      const { sim, stock } = S.data;
      const V = curView();
      if (stock) {
        const r = rectW(stock.min.x, stock.min.y, stock.max.x, stock.max.y);
        ctx.fillStyle = C.stockFill; ctx.fillRect(r[0], r[1], r[2], r[3]);
      }
      if (sim && S.heightArr) {
        const img = heightImage();
        if (img) {
          const e = simExtent(sim);
          const [sx, sy] = toScreen(e.minX, e.maxY);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, sx, sy, sim.nx * sim.cell * V.scale, sim.ny * sim.cell * V.scale);
          ctx.imageSmoothingEnabled = true;
        }
      }
      ctx.lineWidth = 1.5; ctx.setLineDash([]);
      if (stock) {
        const r = rectW(stock.min.x, stock.min.y, stock.max.x, stock.max.y);
        ctx.strokeStyle = C.stockLine; ctx.strokeRect(r[0], r[1], r[2], r[3]);
        for (const f of stock.fixtures || []) {
          const fr = rectW(f.min.x, f.min.y, f.max.x, f.max.y);
          ctx.fillStyle = C.fixtureFill; ctx.fillRect(fr[0], fr[1], fr[2], fr[3]);
          ctx.strokeStyle = C.fixtureLine; ctx.strokeRect(fr[0], fr[1], fr[2], fr[3]);
        }
      } else if (sim) {
        const e = simExtent(sim);
        const r = rectW(e.minX, e.minY, e.maxX, e.maxY);
        ctx.strokeStyle = C.stockLine; ctx.strokeRect(r[0], r[1], r[2], r[3]);
      }
    }

    function drawOriginTop() {
      const [ox, oy] = toScreen(0, 0);
      ctx.strokeStyle = C.axis; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ox - 10, oy); ctx.lineTo(ox + 10, oy);
      ctx.moveTo(ox, oy - 10); ctx.lineTo(ox, oy + 10);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(ox, oy, 3, 0, TAU); ctx.stroke();
    }

    function drawHoleMarker(seg, ax, ay, drawn) {
      const key = `${seg.line}:${Math.round(seg.from.x * 1000)},${Math.round(seg.from.y * 1000)}`;
      if (drawn.has(key)) return;
      drawn.add(key);
      const V = curView();
      const r = S.toolRadius.get(seg.tool);
      const rp = Math.max(r ? r * V.scale : 0, 3);
      ctx.strokeStyle = toolColor(seg.tool); ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(ax, ay, rp, 0, TAU); ctx.stroke();
      // 短線（十字）
      const t = rp + 3;
      ctx.beginPath();
      ctx.moveTo(ax - t, ay); ctx.lineTo(ax + t, ay);
      ctx.moveTo(ax, ay - t); ctx.lineTo(ax, ay + t);
      ctx.stroke();
    }

    function drawSegmentsTop() {
      const drawn = new Set();
      for (const seg of S.data.segments) {
        if (!isVisible(seg)) continue;
        const isRapid = seg.kind === 'rapid';
        const dim = S.hlTool != null && seg.tool !== S.hlTool;
        const [ax, ay] = toScreen(seg.from.x, seg.from.y);
        const [bx, by] = toScreen(seg.to.x, seg.to.y);
        const flat = !seg.arc && Math.hypot(bx - ax, by - ay) < 0.75;   // 純 Z 向移動
        ctx.globalAlpha = dim ? 0.12 : (seg.path === 'programmed' && S.compLines.has(seg.line) ? 0.55 : 1);
        if (flat) {
          if (seg.kind === 'drill') drawHoleMarker(seg, ax, ay, drawn);
          else if (!isRapid) { ctx.fillStyle = toolColor(seg.tool); ctx.beginPath(); ctx.arc(ax, ay, 2.5, 0, TAU); ctx.fill(); }
          continue;
        }
        ctx.strokeStyle = isRapid ? C.rapid : toolColor(seg.tool);
        ctx.lineWidth = isRapid ? 1 : (seg.path === 'compensated' ? 2 : (seg.kind === 'drill' ? 1.5 : 1));
        ctx.setLineDash(isRapid ? [4, 3] : []);
        if (seg.refReturn) { ctx.globalAlpha *= 0.35; ctx.setLineDash([2, 6]); }
        ctx.beginPath(); tracePathTop(seg, ax, ay, bx, by); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    }

    function drawHighlightTop() {
      if (S.hlLine == null) return;
      const segs = S.byLine.get(S.hlLine);
      if (!segs || !segs.length) return;
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      for (const pass of [{ w: 7, color: C.halo }, { w: 3, color: C.highlight }]) {
        ctx.strokeStyle = pass.color; ctx.fillStyle = pass.color; ctx.lineWidth = pass.w;
        for (const seg of segs) {
          const [ax, ay] = toScreen(seg.from.x, seg.from.y);
          const [bx, by] = toScreen(seg.to.x, seg.to.y);
          ctx.beginPath();
          if (!seg.arc && Math.hypot(bx - ax, by - ay) < 0.75) { ctx.arc(ax, ay, pass.w * 0.9, 0, TAU); ctx.fill(); }
          else { tracePathTop(seg, ax, ay, bx, by); ctx.stroke(); }
        }
      }
      // 終點
      const last = segs[segs.length - 1];
      const [ex, ey] = toScreen(last.to.x, last.to.y);
      ctx.fillStyle = C.highlight; ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, TAU); ctx.fill();
    }

    /** 俯視（四軸）：段換算到工件座標之後畫成折線；A0 的孔仍然是一個點，照樣畫孔標記 */
    function drawSegmentsTopRotary() {
      const drawn = new Set();
      for (const w of workSamples()) {
        const seg = w.seg;
        if (!isVisible(seg)) continue;
        const pw = w.pts;
        if (!pw || pw.length < 2) continue;
        const isRapid = seg.kind === 'rapid';
        const dim = S.hlTool != null && seg.tool !== S.hlTool;
        const [ax, ay] = toScreen(pw[0].x, pw[0].y);
        const [bx, by] = toScreen(pw[pw.length - 1].x, pw[pw.length - 1].y);
        ctx.globalAlpha = dim ? 0.12 : (seg.path === 'programmed' && S.compLines.has(seg.line) ? 0.55 : 1);
        if (pw.length === 2 && Math.hypot(bx - ax, by - ay) < 0.75) {
          if (seg.kind === 'drill') drawHoleMarker(seg, ax, ay, drawn);
          else if (!isRapid) { ctx.fillStyle = toolColor(seg.tool); ctx.beginPath(); ctx.arc(ax, ay, 2.5, 0, TAU); ctx.fill(); }
          continue;
        }
        ctx.strokeStyle = isRapid ? C.rapid : toolColor(seg.tool);
        ctx.lineWidth = isRapid ? 1 : (seg.path === 'compensated' ? 2 : (seg.kind === 'drill' ? 1.5 : 1));
        ctx.setLineDash(isRapid ? [4, 3] : []);
        ctx.beginPath();
        for (let i = 0; i < pw.length; i++) { const [sx, sy] = toScreen(pw[i].x, pw[i].y); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); }
        ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    }

    function drawHighlightTopRotary() {
      if (S.hlLine == null) return;
      const hits = workSamples().filter((w) => w.seg.line === S.hlLine && w.pts && w.pts.length >= 2);
      if (!hits.length) return;
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      for (const pass of [{ w: 7, color: C.halo }, { w: 3, color: C.highlight }]) {
        ctx.strokeStyle = pass.color; ctx.fillStyle = pass.color; ctx.lineWidth = pass.w;
        for (const w of hits) {
          const pw = w.pts;
          const [ax, ay] = toScreen(pw[0].x, pw[0].y);
          const [bx, by] = toScreen(pw[pw.length - 1].x, pw[pw.length - 1].y);
          ctx.beginPath();
          if (pw.length === 2 && Math.hypot(bx - ax, by - ay) < 0.75) { ctx.arc(ax, ay, pass.w * 0.9, 0, TAU); ctx.fill(); }
          else {
            for (let i = 0; i < pw.length; i++) { const [sx, sy] = toScreen(pw[i].x, pw[i].y); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); }
            ctx.stroke();
          }
        }
      }
      const last = hits[hits.length - 1].pts;
      const [ex, ey] = toScreen(last[last.length - 1].x, last[last.length - 1].y);
      ctx.fillStyle = C.highlight; ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, TAU); ctx.fill();
    }

    function renderTop() {
      const rot = rotaryOn();
      if (S.visible.stock) { if (rot) drawStockTopRotary(); else drawStockTop(); }
      drawGrid();
      drawOriginTop();
      if (rot) { drawSegmentsTopRotary(); drawHighlightTopRotary(); }
      else { drawSegmentsTop(); drawHighlightTop(); }
    }

    // ---- 展開圖（第四軸）----------------------------------------------------
    // 把圓柱工件的表面攤平成一張紙：橫軸 = X（軸向位置），縱軸 = 繞一圈的角度。
    // 這是分度加工唯一看得懂的視圖——俯視圖會把四個角度的加工疊在一起。
    // 幾何在 geometry.rotary（段的 XYZ 沒有被改動，那仍然是程式座標）。

    /** 展開資料（段或迴轉中心變了才重算） */
    function unrollData() {
      const R = NC.geometry && NC.geometry.rotary;
      if (!R || typeof R.unrollSegments !== 'function') return null;
      const segs = S.data.segments || [];
      const c = S.data.rotaryCenter || { y: 0, z: 0 };
      const cy = c.y || 0, cz = c.z || 0;
      const rad = S.data.rotaryRadius || 0;
      const cache = S.unrollCache;
      if (cache && cache.segs === segs && cache.cy === cy && cache.cz === cz && cache.rad === rad) return cache.val;
      const val = R.unrollSegments(segs, { center: { y: cy, z: cz } });
      val.radius = rad > 0
        ? { radius: rad, source: 'user' }
        : R.estimateRadius(segs, { center: { y: cy, z: cz } });
      S.unrollCache = { segs, cy, cz, rad, val };
      return val;
    }

    /**
     * 展開圖的縱軸單位：**弧長（mm）**，不是角度。
     * 兩軸都是 mm 才能沿用整個視圖的等比例縮放——直接拿「度」當縱座標的話，
     * 50 mm 對上 270 度會被壓成一條線。用弧長也比較貼近實物：
     * 圓周上兩個孔差幾 mm，圖上量得出來。刻度標籤仍然標角度（程式寫的是角度）。
     */
    function angK() {
      const u = unrollData();
      const r = (u && u.radius && u.radius.radius > 0) ? u.radius.radius : 10;
      return r * Math.PI / 180;
    }

    /** 展開圖包絡：h = X（mm）、v = 弧長（mm） */
    function unrollBounds() {
      const u = unrollData();
      if (!u || !u.bounds) return null;
      const k = angK();
      const b = newBounds();
      extend(b, u.bounds.minX, u.bounds.minT * k);
      extend(b, u.bounds.maxX, u.bounds.maxT * k);
      const v = validBounds(b);
      if (!v) return null;
      // 只有一個角度時（例如整支只在 A0 加工）縱軸會是一條線，補一點高度才看得出來
      const minSpan = 30 * k;
      if (v.maxV - v.minV < minSpan) { const c = (v.minV + v.maxV) / 2; v.minV = c - minSpan / 2; v.maxV = c + minSpan / 2; }
      if (v.maxH - v.minH < 1) { const c = (v.minH + v.maxH) / 2; v.minH = c - 5; v.maxH = c + 5; }
      return v;
    }

    /** 展開圖的點選項目（折線拆成小段餵給 pickSegment） */
    function unrollPickItems() {
      const u = unrollData();
      if (!u) return [];
      const out = [];
      const k = angK();
      for (const pl of u.polylines) {
        if (!isVisible(pl)) continue;
        if (pl.pts.length === 1) {
          const p = pl.pts[0];
          out.push({ from: { x: p.x, y: p.theta * k }, to: { x: p.x, y: p.theta * k }, seg: pl });
          continue;
        }
        for (let i = 0; i + 1 < pl.pts.length; i++) {
          out.push({
            from: { x: pl.pts[i].x, y: pl.pts[i].theta * k },
            to: { x: pl.pts[i + 1].x, y: pl.pts[i + 1].theta * k },
            seg: pl,
          });
        }
      }
      return out;
    }

    /** 角度格線：每 90 度加粗，一眼看出分度是不是等分 */
    function drawGridUnroll() {
      const V = curView();
      const [px, py, pw, ph] = plotRect();
      const k = angK();
      const stepH = niceStep(70 / V.scale);
      const stepV = niceAngleStep(40 / (V.scale * k));
      const [h0] = toWorld(px, 0), [h1] = toWorld(px + pw, 0);
      const [, av1] = toWorld(0, py), [, av0] = toWorld(0, py + ph);
      const v1 = av1 / k, v0 = av0 / k;   // 螢幕範圍換算成角度
      ctx.save();
      ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      for (let k = Math.ceil(h0 / stepH); k * stepH <= h1; k++) { const [sx] = toScreen(k * stepH, 0); ctx.moveTo(sx, py); ctx.lineTo(sx, py + ph); }
      for (let k = Math.ceil(v0 / stepV); k * stepV <= v1; k++) {
        const t = k * stepV;
        if (t % 90 === 0) continue;
        const [, sy] = toScreen(0, t * k); ctx.moveTo(px, sy); ctx.lineTo(px + pw, sy);
      }
      ctx.stroke();
      // 每 90 度（正上／正側／正下）用實線標出來
      ctx.strokeStyle = C.zero;
      ctx.beginPath();
      for (let q = Math.ceil(v0 / 90); q * 90 <= v1; q++) { const [, sy] = toScreen(0, q * 90 * k); ctx.moveTo(px, sy); ctx.lineTo(px + pw, sy); }
      ctx.stroke();
      ctx.restore();
    }

    function drawSegmentsUnroll() {
      const u = unrollData();
      if (!u) return;
      const drawn = new Set();
      const k = angK();
      for (const pl of u.polylines) {
        if (!isVisible(pl)) continue;
        const isRapid = pl.kind === 'rapid';
        const dim = S.hlTool != null && pl.tool !== S.hlTool;
        ctx.globalAlpha = dim ? 0.12 : (pl.path === 'programmed' && S.compLines.has(pl.line) ? 0.55 : 1);
        const p0 = pl.pts[0], pN = pl.pts[pl.pts.length - 1];
        const [ax, ay] = toScreen(p0.x, p0.theta * k);
        const [bx, by] = toScreen(pN.x, pN.theta * k);
        // 原地下刀在展開圖上是一個點（X 與角度都不動，只有深度在變）
        if (Math.hypot(bx - ax, by - ay) < 0.75) {
          if (pl.kind === 'drill') drawHoleMarkerUnroll(pl, ax, ay, drawn);
          else if (!isRapid) { ctx.fillStyle = toolColor(pl.tool); ctx.beginPath(); ctx.arc(ax, ay, 2.5, 0, TAU); ctx.fill(); }
          continue;
        }
        ctx.strokeStyle = isRapid ? C.rapid : toolColor(pl.tool);
        ctx.lineWidth = isRapid ? 1 : (pl.path === 'compensated' ? 2 : (pl.kind === 'drill' ? 1.5 : 1));
        ctx.setLineDash(isRapid ? [4, 3] : []);
        if (pl.refReturn) { ctx.globalAlpha *= 0.35; ctx.setLineDash([2, 6]); }
        ctx.beginPath();
        for (let i = 0; i < pl.pts.length; i++) {
          const [sx, sy] = toScreen(pl.pts[i].x, pl.pts[i].theta * k);
          if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    }

    function drawHoleMarkerUnroll(pl, ax, ay, drawn) {
      const key = `${pl.line}:${Math.round(pl.pts[0].x * 100)},${Math.round(pl.pts[0].theta * 100)}`;
      if (drawn.has(key)) return;
      drawn.add(key);
      const V = curView();
      const r = S.toolRadius.get(pl.tool);
      // 縱軸是弧長、橫軸是 mm，兩軸同單位，所以刀徑可以照真實比例畫成正圓
      const rp = Math.max(r ? r * V.scale : 0, 3);
      ctx.strokeStyle = toolColor(pl.tool); ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(ax, ay, rp, 0, TAU); ctx.stroke();
      const t = rp + 3;
      ctx.beginPath();
      ctx.moveTo(ax - t, ay); ctx.lineTo(ax + t, ay);
      ctx.moveTo(ax, ay - t); ctx.lineTo(ax, ay + t);
      ctx.stroke();
    }

    function drawHighlightUnroll() {
      if (S.hlLine == null) return;
      const u = unrollData();
      if (!u) return;
      const hits = u.polylines.filter((p) => p.line === S.hlLine);
      if (!hits.length) return;
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      const k = angK();
      for (const pass of [{ w: 7, color: C.halo }, { w: 3, color: C.highlight }]) {
        ctx.strokeStyle = pass.color; ctx.fillStyle = pass.color; ctx.lineWidth = pass.w;
        for (const pl of hits) {
          const p0 = pl.pts[0], pN = pl.pts[pl.pts.length - 1];
          const [ax, ay] = toScreen(p0.x, p0.theta * k);
          const [bx, by] = toScreen(pN.x, pN.theta * k);
          ctx.beginPath();
          if (Math.hypot(bx - ax, by - ay) < 0.75) { ctx.arc(ax, ay, pass.w * 0.9, 0, TAU); ctx.fill(); }
          else {
            for (let i = 0; i < pl.pts.length; i++) {
              const [sx, sy] = toScreen(pl.pts[i].x, pl.pts[i].theta * k);
              if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
            }
            ctx.stroke();
          }
        }
      }
    }

    /** 展開圖的標尺：縱軸座標是弧長，但刻度一律標角度（程式寫的是角度） */
    function drawRulersUnroll() {
      const V = curView();
      const k = angK();
      const { w, h } = S.size;
      const [px, py, pw, ph] = plotRect();
      const stepH = niceStep(70 / V.scale);
      const stepV = niceAngleStep(40 / (V.scale * k));
      const [h0] = toWorld(px, 0), [h1] = toWorld(px + pw, 0);
      const [, av1] = toWorld(0, py), [, av0] = toWorld(0, py + ph);
      const v1 = av1 / k, v0 = av0 / k;
      ctx.save();
      ctx.font = FONT; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.strokeStyle = C.ruler; ctx.fillStyle = C.rulerText;
      ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.beginPath();
      for (let q = Math.ceil(h0 / stepH); q * stepH <= h1; q++) {
        const t = q * stepH; const [sx] = toScreen(t, 0);
        ctx.moveTo(sx, py + ph); ctx.lineTo(sx, py + ph + 5);
        ctx.fillText(fmt(t, 3), sx, py + ph + 7);
      }
      ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.beginPath();
      for (let q = Math.ceil(v0 / stepV); q * stepV <= v1; q++) {
        const t = q * stepV; const [, sy] = toScreen(0, t * k);
        ctx.moveTo(px - 5, sy); ctx.lineTo(px, sy);
        ctx.fillText(fmt(t, 3) + '°', px - 7, sy);
      }
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('X 軸向', w - 4, h - 4);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('A 角度', 4, py - 14);
      ctx.restore();
    }

    function renderUnroll() {
      drawGridUnroll();
      drawSegmentsUnroll();
      drawHighlightUnroll();
    }

    // ---- 剖面 --------------------------------------------------------------
    /** 落在剖面帶內的段，投影成 (h, z) 的假段 {from:{x,y}, to:{x,y}, seg} */
    /**
     * 剖面 X 在第四軸下的意義：**圓棒的橫截面**。
     * A 繞 X 轉，所以 X 不受旋轉影響——「哪些段落在這個 X 位置」的判斷完全不用改，
     * 只要把 (Y, Z) 換成轉到工件座標的值，孔就會從圓周指向中心。
     * 這樣剖面 X、3D、展開圖三張圖用的是同一套座標，不會互相矛盾。
     * 剖面 Y 與俯視在四軸下沒有意義（工件轉了，那兩個投影面跟著工件跑），由 app 停用。
     */
    /** 這支程式是四軸，而且 geometry.rotary 可用 → 工件座標的視圖要換算 */
    function rotaryData() {
      const R = NC.geometry && NC.geometry.rotary;
      return !!(S.data.rotaryOn && R && typeof R.samples === 'function');
    }
    /**
     * 目前這張圖畫在工件座標上嗎？
     * 四軸的俯視、剖面 X、剖面 Y 都是——素材是圓棒、段要繞軸心轉回工件上，
     * 三張圖與 3D／展開圖用同一套座標，不會互相矛盾（CONTRACT §13.7）。
     */
    function rotaryOn() {
      return rotaryData() && (S.mode === 'top' || S.mode === 'sectionX' || S.mode === 'sectionY');
    }
    function rotaryRadius() {
      const sim = S.data.sim;
      if (sim && sim.cylinder && sim.radius > 0) return sim.radius;
      const u = unrollData();
      return (u && u.radius && u.radius.radius > 0) ? u.radius.radius : 0;
    }

    /** 段換算到工件座標的取樣折線（四軸的俯視／剖面共用；段或迴轉中心變了才重算） */
    function workSamples() {
      const R = NC.geometry && NC.geometry.rotary;
      if (!R || typeof R.samples !== 'function') return [];
      const segs = S.data.segments || [];
      const c = S.data.rotaryCenter || { y: 0, z: 0 };
      const cy = c.y || 0, cz = c.z || 0;
      const cache = S.workCache;
      if (cache && cache.segs === segs && cache.cy === cy && cache.cz === cz) return cache.val;
      const val = [];
      for (const seg of segs) {
        if (seg.refReturn) continue;
        val.push({ seg, pts: R.samples(seg, { center: { y: cy, z: cz } }) });
      }
      S.workCache = { segs, cy, cz, val };
      return val;
    }

    /** 圓棒攤成直角座標的上下包絡（四軸的俯視／剖面 Y 用），依高度陣列快取 */
    function cylCart() {
      const sim = S.data.sim;
      if (!sim || !sim.cylinder || !S.heightArr) return null;
      const c = S.cylCache;
      if (c && c.arr === S.heightArr) return c.val;
      const val = cylToCartesian(sim, S.heightArr);
      S.cylCache = { arr: S.heightArr, val };
      return val;
    }

    function projectedSegments() {
      const ha = hAxis(), ca = cutAxis(), v = S.section;
      const sim = S.data.sim;
      const cell = sim ? (sim.cellX || sim.cell) : 0.5;
      const rot = rotaryOn();
      const out = [];
      if (rot) {
        for (const w of workSamples()) {
          const seg = w.seg;
          const band = Math.max(cell, 0.25) / 2 + (S.toolRadius.get(seg.tool) || 0) + 1e-6;
          // X 不受 A 旋轉影響 → 剖面 X 可以先用整段的端點篩掉，省一堆逐點比較。
          // 剖面 Y 的 Y 是轉過的，只能逐取樣點判斷。
          if (ca === 'x' && (Math.abs(seg.from.x - v) > band || Math.abs(seg.to.x - v) > band)) continue;
          const pw = w.pts;
          for (let i = 0; i + 1 < pw.length; i++) {
            const a = pw[i], b = pw[i + 1];
            if (ca !== 'x' && (Math.abs(a[ca] - v) > band || Math.abs(b[ca] - v) > band)) continue;
            out.push({ from: { x: a[ha], y: a.z }, to: { x: b[ha], y: b.z }, seg });
          }
        }
        return out;
      }
      for (const seg of S.data.segments) {
        if (seg.refReturn) continue;
        if (seg.arc) continue;
        const band = Math.max(cell, 0.25) / 2 + (S.toolRadius.get(seg.tool) || 0) + 1e-6;
        if (Math.abs(seg.from[ca] - v) > band || Math.abs(seg.to[ca] - v) > band) continue;
        out.push({ from: { x: seg.from[ha], y: seg.from.z }, to: { x: seg.to[ha], y: seg.to.z }, seg });
      }
      return out;
    }

    /**
     * 圓柱素材在某個 X 位置的截面 → 一組封閉輪廓（工件座標）。
     * 走 core 的 `NC.sim.cylSection`：每格記的是一串材料區間，
     * 相鄰射線的材料段配對之後，槽壁與孔壁是真的鉛直的（見 CONTRACT §13.10）。
     * 內部空洞會自成一圈，用 evenodd 填就會變成洞。
     */
    function cylProfile(sim, x) {
      if (!(NC.sim && typeof NC.sim.cylSection === 'function')) return null;
      const c = S.secCache;
      if (c && c.arr === S.heightArr && c.x === x) return c.val;
      const val = NC.sim.cylSection(sim, x, { height: S.heightArr, extra: S.extraMap });
      S.secCache = { arr: S.heightArr, x, val };
      return val;
    }

    /**
     * 第四軸的剖面素材：圓棒的橫截面。
     * 有模擬結果時畫「這個 X 位置實際被挖成什麼樣」（同三軸剖面用 sectionProfile 的做法），
     * 沒有就退回一個完美圓當佔位。
     */
    function drawStockSectionRotary() {
      const r = rotaryRadius();
      if (!(r > 0)) return;
      const c = S.data.rotaryCenter || { y: 0, z: 0 };
      const V = curView();
      const [cx, cy] = toScreen(c.y || 0, c.z || 0);
      ctx.setLineDash([]);
      const sim = S.data.sim;
      const prof = (sim && sim.cylinder && S.heightArr) ? cylProfile(sim, S.section) : null;
      if (prof && prof.loops.length) {
        ctx.beginPath();
        for (const loop of prof.loops) {
          for (let i = 0; i < loop.length; i++) {
            const [sx, sy] = toScreen(loop[i].y, loop[i].z);
            if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
          }
          ctx.closePath();
        }
        // evenodd：內部空洞（孔道、槽壁下的那一小塊）自成一圈，填出來就是洞
        ctx.fillStyle = C.stockFill; ctx.fill('evenodd');
        ctx.strokeStyle = C.profileLine; ctx.lineWidth = 1.5; ctx.stroke();
        // 原始外圓用虛線當參考，一眼看出切掉多少
        ctx.beginPath(); ctx.arc(cx, cy, sim.radius * V.scale, 0, TAU);
        ctx.strokeStyle = C.stockLine; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.beginPath(); ctx.arc(cx, cy, r * V.scale, 0, TAU);
        ctx.fillStyle = C.stockFill; ctx.fill();
        ctx.strokeStyle = C.stockLine; ctx.lineWidth = 1.5; ctx.stroke();
      }
      // 迴轉中心的十字：分度加工的一切都繞著它
      ctx.strokeStyle = C.zero; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      const t = Math.min(r * V.scale, 40) + 8;
      ctx.beginPath();
      ctx.moveTo(cx - t, cy); ctx.lineTo(cx + t, cy);
      ctx.moveTo(cx, cy - t); ctx.lineTo(cx, cy + t);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /**
     * 第四軸的剖面 Y：沿軸向切一刀，看這個 Y 上圓棒被削成什麼厚度。
     * 資料同樣來自 cylToCartesian 的上下包絡；材料不連續的地方（切穿了）自動斷開成好幾塊，
     * 不會把兩段之間的空氣也塗成材料。虛線是原始圓棒在這個 Y 上本來的厚度，用來比對切掉多少。
     */
    function drawStockSectionRotaryY() {
      const c = S.data.rotaryCenter || { y: 0, z: 0 };
      const cy = c.y || 0, cz = c.z || 0;
      const r = rotaryRadius();
      const cart = cylCart();
      let x0 = null, x1 = null;
      if (cart) { const e = simExtent(cart); x0 = e.minX; x1 = e.maxX; }
      else if (S.data.stock) { x0 = S.data.stock.min.x; x1 = S.data.stock.max.x; }
      // 原始外形（這個 Y 上圓棒的半厚 = √(R² − d²)）
      const d = Math.abs(S.section - cy);
      if (r > 0 && x0 != null && d <= r) {
        const t = Math.sqrt(Math.max(0, r * r - d * d));
        const rr = rectW(x0, cz - t, x1, cz + t);
        if (!cart) { ctx.fillStyle = C.stockFill; ctx.fillRect(rr[0], rr[1], rr[2], rr[3]); }
        ctx.strokeStyle = C.stockLine; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.strokeRect(rr[0], rr[1], rr[2], rr[3]);
        ctx.setLineDash([]);
      }
      if (cart) {
        const iy = Math.round((S.section - cart.origin.y) / cart.cell);
        if (iy >= 0 && iy < cart.ny) {
          let run = [];
          const flush = () => {
            if (run.length >= 2) {
              // 鉛直牆（孔壁、槽壁）用 steppedProfile 畫成真正的階梯，
              // 逐欄直連會把它畫成一格寬的斜線，直上直下的刀看起來會歪
              const hiPts = steppedProfile(run.map((p) => p.x), run.map((p) => p.hi), cart.cell);
              const loPts = steppedProfile(run.map((p) => p.x), run.map((p) => p.lo), cart.cell);
              ctx.beginPath();
              for (let i = 0; i < hiPts.length; i++) { const [sx, sy] = toScreen(hiPts[i].x, hiPts[i].v); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); }
              for (let i = loPts.length - 1; i >= 0; i--) { const [sx, sy] = toScreen(loPts[i].x, loPts[i].v); ctx.lineTo(sx, sy); }
              ctx.closePath();
              ctx.fillStyle = C.profileFill; ctx.fill();
              ctx.strokeStyle = C.profileLine; ctx.lineWidth = 1.5; ctx.stroke();
            }
            run = [];
          };
          for (let ix = 0; ix < cart.nx; ix++) {
            const o = iy * cart.nx + ix;
            const hi = cart.height[o], lo = cart.bottom[o];
            if (!Number.isFinite(hi) || !Number.isFinite(lo)) { flush(); continue; }
            run.push({ x: cart.origin.x + ix * cart.cell, hi, lo });
          }
          flush();
        }
      }
      // 軸心線：四軸的一切都繞著它，Z0 在這裡沒有意義
      if (x0 != null) {
        const [sx0] = toScreen(x0, 0), [sx1] = toScreen(x1, 0), [, sy] = toScreen(0, cz);
        ctx.strokeStyle = C.zero; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(sx0, sy); ctx.lineTo(sx1, sy); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    function drawStockSection() {
      const { sim, stock } = S.data;
      const ha = hAxis(), ca = cutAxis(), v = S.section;
      ctx.lineWidth = 1.5; ctx.setLineDash([]);
      if (rotaryOn()) { if (S.mode === 'sectionX') drawStockSectionRotary(); else drawStockSectionRotaryY(); return; }
      if (stock) {
        const inside = v >= stock.min[ca] - 1e-9 && v <= stock.max[ca] + 1e-9;
        const r = rectW(stock.min[ha], stock.min.z, stock.max[ha], stock.max.z);
        ctx.fillStyle = inside ? C.stockFill : C.stockFillOut; ctx.fillRect(r[0], r[1], r[2], r[3]);
        ctx.strokeStyle = C.stockLine; ctx.setLineDash(inside ? [] : [4, 4]); ctx.strokeRect(r[0], r[1], r[2], r[3]);
        ctx.setLineDash([]);
        for (const f of stock.fixtures || []) {
          if (v < f.min[ca] - 1e-9 || v > f.max[ca] + 1e-9) continue;
          const fr = rectW(f.min[ha], f.min.z, f.max[ha], f.max.z);
          ctx.fillStyle = C.fixtureFill; ctx.fillRect(fr[0], fr[1], fr[2], fr[3]);
          ctx.strokeStyle = C.fixtureLine; ctx.strokeRect(fr[0], fr[1], fr[2], fr[3]);
        }
      }
      if (sim && S.heightArr) {
        const prof = sectionProfile(sim, S.heightArr, ca, v);
        if (prof) {
          const floor = sim.floorZ;
          // 鉛直牆（口袋壁、孔壁）畫成真正的階梯，理由同剖面 Y（見 steppedProfile）
          const pts = steppedProfile(prof.pos, prof.z, sim.cell);
          ctx.beginPath();
          let [sx, sy] = toScreen(pts[0].x, floor);
          ctx.moveTo(sx, sy);
          for (const p of pts) { [sx, sy] = toScreen(p.x, p.v); ctx.lineTo(sx, sy); }
          [sx, sy] = toScreen(pts[pts.length - 1].x, floor);
          ctx.lineTo(sx, sy); ctx.closePath();
          ctx.fillStyle = C.profileFill; ctx.fill();
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) { [sx, sy] = toScreen(pts[i].x, pts[i].v); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); }
          ctx.strokeStyle = C.profileLine; ctx.lineWidth = 1.5; ctx.stroke();
        }
      }
    }

    function drawSegmentsSection(items) {
      for (const it of items) {
        const seg = it.seg;
        if (!isVisible(seg)) continue;
        const isRapid = seg.kind === 'rapid';
        const dim = S.hlTool != null && seg.tool !== S.hlTool;
        const [ax, ay] = toScreen(it.from.x, it.from.y);
        const [bx, by] = toScreen(it.to.x, it.to.y);
        ctx.globalAlpha = dim ? 0.12 : (seg.path === 'programmed' && S.compLines.has(seg.line) ? 0.55 : 1);
        ctx.strokeStyle = isRapid ? C.rapid : toolColor(seg.tool);
        ctx.lineWidth = isRapid ? 1 : (seg.path === 'compensated' ? 2 : (seg.kind === 'drill' ? 1.5 : 1));
        ctx.setLineDash(isRapid ? [4, 3] : []);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        if (Math.hypot(bx - ax, by - ay) < 0.75) { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(ax, ay, 2, 0, TAU); ctx.fill(); }
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    }

    function drawHighlightSection(items) {
      if (S.hlLine == null) return;
      const hits = items.filter((it) => it.seg.line === S.hlLine);
      if (!hits.length) return;
      for (const pass of [{ w: 7, color: C.halo }, { w: 3, color: C.highlight }]) {
        ctx.strokeStyle = pass.color; ctx.lineWidth = pass.w;
        ctx.beginPath();
        for (const it of hits) {
          const [ax, ay] = toScreen(it.from.x, it.from.y);
          const [bx, by] = toScreen(it.to.x, it.to.y);
          ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        }
        ctx.stroke();
      }
    }

    /** 圓棒的軸向範圍（有模擬格就用格網，沒有就用素材包絡盒） */
    function rotaryXRange() {
      const sim = S.data.sim;
      if (sim && sim.cylinder) {
        const cell = sim.cellX || sim.cell;
        return [sim.origin.x - cell / 2, sim.origin.x + (sim.nx - 0.5) * cell];
      }
      if (S.data.stock) return [S.data.stock.min.x, S.data.stock.max.x];
      return null;
    }

    /** 四軸剖面的包絡：圓棒外形 + 切削段（rapid 在工件座標下是繞著工件的大弧，不算） */
    function rotarySectionBounds() {
      const b = newBounds();
      const r = rotaryRadius();
      const c = S.data.rotaryCenter || { y: 0, z: 0 };
      const cy = c.y || 0, cz = c.z || 0;
      if (r > 0) {
        if (S.mode === 'sectionX') { extend(b, cy - r, cz - r); extend(b, cy + r, cz + r); }
        else {
          const xr = rotaryXRange();
          if (xr) { extend(b, xr[0], cz - r); extend(b, xr[1], cz + r); }
        }
      }
      for (const it of projectedSegments()) {
        if (it.seg.kind === 'rapid') continue;
        extend(b, it.from.x, it.from.y); extend(b, it.to.x, it.to.y);
      }
      return validBounds(b);
    }

    /** 四軸俯視的包絡：圓棒的投影矩形 + 切削段（同上，不含 rapid） */
    function rotaryTopBounds() {
      const b = newBounds();
      const r = rotaryRadius();
      const cy = (S.data.rotaryCenter && S.data.rotaryCenter.y) || 0;
      const xr = rotaryXRange();
      if (r > 0 && xr) { extend(b, xr[0], cy - r); extend(b, xr[1], cy + r); }
      for (const w of workSamples()) {
        if (w.seg.kind === 'rapid') continue;
        for (const p of w.pts) extend(b, p.x, p.y);
      }
      return validBounds(b);
    }

    function renderSection() {
      if (S.visible.stock) drawStockSection();
      drawGrid();
      // Z = 0 基準線；四軸的基準是迴轉中心（drawStockSectionRotary 已經畫了十字），不是 Z0
      if (!rotaryOn()) {
        const [px, , pw] = plotRect();
        const [, zy] = toScreen(0, 0);
        ctx.strokeStyle = C.zero; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(px, zy); ctx.lineTo(px + pw, zy); ctx.stroke();
        ctx.setLineDash([]);
      }
      const items = projectedSegments();
      drawSegmentsSection(items);
      drawHighlightSection(items);
    }

    // ---- 主繪圖 ------------------------------------------------------------
    function render() {
      if (S.destroyed) return;
      if (!syncSize()) return;
      if (S.needFit) fit(false);
      const { w, h } = S.size;
      ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      if (!curView()) { drawHud(); return; }
      const [px, py, pw, ph] = plotRect();
      ctx.save();
      ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
      if (S.mode === 'top') renderTop();
      else if (S.mode === 'unroll') renderUnroll();
      else renderSection();
      ctx.restore();
      if (S.mode === 'unroll') drawRulersUnroll();
      else if (S.mode === 'top') drawRulers('X', rotaryOn() ? 'Y（工件）' : 'Y');
      else if (rotaryOn()) drawRulers(S.mode === 'sectionX' ? 'Y（工件）' : 'X', 'Z（工件）');
      else drawRulers(hAxis().toUpperCase(), 'Z');
      drawHud();
    }

    function fit(rerender = true) {
      if (!(S.size.w > 0)) syncSize();
      const { w, h } = S.size;
      if (!(w > 0 && h > 0)) { S.needFit = true; return api; }
      const b = S.mode === 'unroll' ? unrollBounds()
        : S.mode === 'top' ? (rotaryOn() ? rotaryTopBounds() : topBounds(S.data))
          : rotaryOn() ? rotarySectionBounds()
            : sectionBounds(S.data, hAxis());
      let V;
      if (b) V = fitTransform(b, w, h, PAD);
      else { const [px, py, pw, ph] = plotRect(); V = { scale: 2, ox: px + pw / 2, oy: py + ph / 2, empty: true }; }
      S.view[S.mode] = V;
      S.needFit = false;
      if (rerender) requestRender();
      return api;
    }

    // ---- 互動 --------------------------------------------------------------
    function eventPos(ev) {
      const r = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: S.size.w, height: S.size.h };
      const kx = r.width ? S.size.w / r.width : 1, ky = r.height ? S.size.h / r.height : 1;
      return [(ev.clientX - r.left) * kx, (ev.clientY - r.top) * ky];
    }

    function zoomAt(mx, my, f) {
      const V = curView();
      if (!V) return;
      const ns = clamp(V.scale * f, 0.01, 5000);
      f = ns / V.scale;
      V.ox = mx - (mx - V.ox) * f;
      V.oy = my - (my - V.oy) * f;
      V.scale = ns;
      requestRender();
    }

    function pickAt(mx, my) {
      const V = curView();
      if (!V) return null;
      const [wx, wy] = toWorld(mx, my);
      let hit = null;
      if (S.mode === 'top' && rotaryOn()) {
        // 俯視在四軸下畫的是工件座標的折線，挑選也要用同一份，否則點得到的位置對不上
        const items = [];
        for (const w of workSamples()) {
          if (!isVisible(w.seg) || !w.pts) continue;
          for (let i = 0; i + 1 < w.pts.length; i++) items.push({ from: { x: w.pts[i].x, y: w.pts[i].y }, to: { x: w.pts[i + 1].x, y: w.pts[i + 1].y }, seg: w.seg });
        }
        const r = pickSegment(items, wx, wy, V.scale, PICK_PX, null);
        hit = r ? { seg: r.seg.seg, dist: r.dist } : null;
      } else if (S.mode === 'top') hit = pickSegment(S.data.segments, wx, wy, V.scale, PICK_PX, isVisible);
      else if (S.mode === 'unroll') {
        const r = pickSegment(unrollPickItems(), wx, wy, V.scale, PICK_PX, null);
        // 點到的是展開折線，換回真正的 Segment（下游要 from/to 的程式座標）
        if (r) {
          const real = S.byLine.get(r.seg.seg.line);
          hit = { seg: (real && real.length) ? real[0] : r.seg.seg, dist: r.dist };
        }
      } else {
        const items = projectedSegments().filter((it) => isVisible(it.seg));
        const r = pickSegment(items, wx, wy, V.scale, PICK_PX, null);
        hit = r ? { seg: r.seg.seg, dist: r.dist } : null;
      }
      if (hit && S.pickCb) S.pickCb(hit.seg.line, hit.seg);
      return hit;
    }

    function setDragClass(on) {
      if (canvas.classList && typeof canvas.classList.toggle === 'function') canvas.classList.toggle('is-dragging', on);
    }

    function onWheel(ev) {
      if (ev.preventDefault) ev.preventDefault();
      const [mx, my] = eventPos(ev);
      const f = Math.exp(-(ev.deltaY || 0) * 0.0015);
      zoomAt(mx, my, f);
    }
    function onDown(ev) {
      if (ev.button != null && ev.button !== 0) return;
      const [mx, my] = eventPos(ev);
      const V = curView();
      S.drag = { sx: mx, sy: my, ox: V ? V.ox : 0, oy: V ? V.oy : 0, moved: false };
      if (ev.pointerId != null && typeof canvas.setPointerCapture === 'function') { try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ } }
    }
    function onMove(ev) {
      const [mx, my] = eventPos(ev);
      const d = S.drag, V = curView();
      if (d) {
        const dx = mx - d.sx, dy = my - d.sy;
        if (!d.moved && Math.hypot(dx, dy) > DRAG_PX) { d.moved = true; setDragClass(true); }
        if (d.moved && V) { V.ox = d.ox + dx; V.oy = d.oy + dy; }
      }
      S.hover = { sx: mx, sy: my };
      requestRender();
    }
    function onUp(ev) {
      const d = S.drag;
      S.drag = null;
      setDragClass(false);
      if (ev.pointerId != null && typeof canvas.releasePointerCapture === 'function') { try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ } }
      if (d && !d.moved) { const [mx, my] = eventPos(ev); pickAt(mx, my); }
      requestRender();
    }
    function onLeave() {
      S.hover = null;
      S.drag = null;
      setDragClass(false);
      requestRender();
    }
    function onDbl(ev) { if (ev.preventDefault) ev.preventDefault(); fit(); }
    function onCtx(ev) { if (ev.preventDefault) ev.preventDefault(); }

    const usePointer = typeof PointerEvent !== 'undefined';
    const evNames = usePointer ? ['pointerdown', 'pointermove', 'pointerup', 'pointerleave'] : ['mousedown', 'mousemove', 'mouseup', 'mouseleave'];
    const listeners = [
      ['wheel', onWheel, { passive: false }],
      [evNames[0], onDown], [evNames[1], onMove], [evNames[2], onUp], [evNames[3], onLeave],
      ['dblclick', onDbl], ['contextmenu', onCtx],
    ];
    if (typeof canvas.addEventListener === 'function') for (const l of listeners) canvas.addEventListener(l[0], l[1], l[2]);

    let ro = null, winResize = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { if (!S.destroyed && syncSize()) requestRender(); });
      ro.observe(canvas);
    } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      winResize = () => { if (!S.destroyed && syncSize()) requestRender(); };
      window.addEventListener('resize', winResize);
    }

    // ---- 公開 API ----------------------------------------------------------
    const api = {
      canvas,
      setData(d) {
        d = d || {};
        S.data = {
          segments: Array.isArray(d.segments) ? d.segments : [],
          sim: d.sim || null,
          stock: d.stock || null,
          toolTable: d.toolTable || null,
          scenario: d.scenario || 'off',
          simStale: !!d.simStale,
          // 第四軸（展開圖用）。中心預設 (0,0)：四軸裝夾慣例是 Y0/Z0 對到夾頭中心線。
          // 半徑 0 = 由程式推估；使用者在設定填了直徑就以他填的為準。
          rotaryCenter: d.rotaryCenter || (d.rotary && d.rotary.center) || { y: 0, z: 0 },
          rotaryRadius: (d.rotary && d.rotary.radius > 0) ? d.rotary.radius : 0,
          // 有第四軸時剖面 X 改畫圓棒橫截面（與 3D／展開圖同一套工件座標，不互相矛盾）
          rotaryOn: !!d.rotary,
        };
        S.snapshotIndex = null;
        S.heightArr = S.data.sim ? S.data.sim.height : null;
        S.extraMap = S.data.sim ? S.data.sim.extra : null;   // 圓棒的材料區間（見 CONTRACT §13.10）
        S.imageCache = null;
        S.cylCache = null;
        S.secCache = null;
        rebuildIndex();
        const V = curView();
        if (!V || V.empty) S.needFit = true;
        requestRender();
        return api;
      },
      setMode(m) {
        if (!MODES.includes(m)) throw new Error(`未知的視圖模式：${m}`);
        S.mode = m;
        const V = curView();
        if (!V || V.empty) S.needFit = true;
        requestRender();
        return api;
      },
      getMode() { return S.mode; },
      setSection(v) { S.section = Number(v) || 0; requestRender(); return api; },
      getSection() { return S.section; },
      /** 顯示第 i 個 snapshot 的高度（null → 最終高度） */
      setSnapshot(i) {
        const sim = S.data.sim;
        if (!sim) return api;
        const snap = i != null && Array.isArray(sim.snapshots) ? sim.snapshots[i] : null;
        S.snapshotIndex = snap ? i : null;
        S.heightArr = snap ? snap.height : sim.height;
        S.extraMap = snap ? snap.extra : sim.extra;
        S.imageCache = null;
        S.cylCache = null;
        S.secCache = null;
        requestRender();
        return api;
      },
      highlightLine(n) { S.hlLine = n == null ? null : Number(n); requestRender(); return api; },
      highlightTool(t) { S.hlTool = t == null ? null : Number(t); requestRender(); return api; },
      setVisible(o) {
        o = o || {};
        if ('rapid' in o) S.visible.rapid = !!o.rapid;
        if ('feed' in o) S.visible.feed = !!o.feed;
        if ('refReturn' in o) S.visible.refReturn = !!o.refReturn;
        if ('stock' in o) S.visible.stock = !!o.stock;
        if ('rotary' in o) S.visible.rotary = !!o.rotary;
        if ('tools' in o) S.visible.tools = o.tools == null ? null : (o.tools instanceof Set ? o.tools : new Set(o.tools));
        requestRender();
        return api;
      },
      getVisible() { return { rapid: S.visible.rapid, feed: S.visible.feed, refReturn: S.visible.refReturn, stock: S.visible.stock, rotary: S.visible.rotary, tools: S.visible.tools ? new Set(S.visible.tools) : null }; },
      onPick(cb) { S.pickCb = typeof cb === 'function' ? cb : null; return api; },
      fit() { return fit(true); },
      render() { render(); return api; },
      requestRender() { requestRender(); return api; },
      /** 目前模式的變換 {scale, ox, oy} */
      getTransform() { const V = curView(); return V ? { scale: V.scale, ox: V.ox, oy: V.oy } : null; },
      worldToScreen(h, v) { return curView() ? toScreen(h, v) : null; },
      screenToWorld(sx, sy) { return curView() ? toWorld(sx, sy) : null; },
      pickAt(sx, sy) { return pickAt(sx, sy); },
      getSize() { return { w: S.size.w, h: S.size.h, dpr: S.dpr }; },
      destroy() {
        S.destroyed = true;
        if (typeof canvas.removeEventListener === 'function') for (const l of listeners) canvas.removeEventListener(l[0], l[1], l[2]);
        if (ro) { try { ro.disconnect(); } catch (e) { /* 忽略 */ } ro = null; }
        if (winResize) { window.removeEventListener('resize', winResize); winResize = null; }
        S.imageCache = null;
        S.cylCache = null;
        S.secCache = null;
      },
    };

    syncSize();
    requestRender();
    return api;
  }

  NC.ui.createView2D = createView2D;
})(globalThis.NC = globalThis.NC || {});
