/*
 * NC 預演台 — tools.js：刀具推測、補正、素材推估、刀具表儲存與 CSV 匯入匯出。
 * 依 docs/CONTRACT.md §4 實作，掛在 NC.tools。
 * 核心模組不碰 DOM；只有 save/load 會碰 localStorage，而且一律 try/catch（Node 下沒有 localStorage 也安全）。
 */
(function (NC) {
  'use strict';

  const STORAGE_PREFIX = 'ncPreview.tools.';
  const FACEMILL_MIN_DIAMETER = 40;      // 直徑 ≥ 40 → 面銑刀
  const FACEMILL_MIN_TRAVEL = 80;        // 無註解時：zMin ≥ -0.1 且 X 行程 ≥ 80 mm → 面銑刀
  const FACE_Z_LIMIT = -0.1;
  const DEFAULT_DIAMETER = 10;
  const STOCK_Z_MARGIN = 5;

  /**
   * 刀具型式總表。每一項的欄位：
   *   name     CSV「推測型式／請填_型式確認」欄用的中文名（= TYPE_NAMES 的值）
   *   ui       刀具表下拉選單顯示的名稱；沒寫就用 name
   *   group    分類：mill 銑削／hole 鑽孔／thread 攻牙／other 其他
   *   profile  3D 模擬的足跡形狀：flat 圓盤／cone 錐尖／sphere 球端／none 不移除材料
   *   angle    刀尖角或倒角夾角的預設值（度）；null = 沒有通用預設，要現場填
   *   extra    直徑以外還要現場補的欄位：cornerRad 角R／neckDia 頸徑
   *   undercut 會切到上方被蓋住的材料（底切）。simulation 用的是高度圖，表達不出底切，
   *            只能用最大直徑的圓盤近似 —— 這件事要讓使用者知道，不能假裝有模擬到。
   *   desc     一句話說明，UI 的 tooltip 用
   */
  const TYPE_INFO = {
    // ---- 銑削類 ----
    endmill: { name: '平銑刀', ui: '平刀（端銑刀）', group: 'mill', profile: 'flat', angle: null, extra: [],
      desc: '底面平的立銑刀。粗銑、輪廓、挖槽最常用的一把。' },
    ballmill: { name: '球刀', group: 'mill', profile: 'sphere', angle: null, extra: [],
      desc: '刀尖是半球。曲面精修用；銑直壁時牆角會留下球半徑的 R。' },
    bullnose: { name: '圓鼻刀', group: 'mill', profile: 'flat', angle: null, extra: ['cornerRad'],
      desc: '平底、底邊帶 R 角（牛鼻刀）。比平刀耐用，硬料粗銑常用；角 R 要另外填。' },
    facemill: { name: '面銑刀', group: 'mill', profile: 'flat', angle: null, extra: [],
      desc: '大直徑刀盤，專銑大平面。註解直徑 ≥ 40 mm 會自動判成這一型。' },
    radiusmill: { name: '外R成型刀', group: 'mill', profile: 'flat', angle: null, extra: ['cornerRad'],
      desc: '刀刃是凹圓弧，把工件外角一次修成 R 角。成型半徑要另外填。' },
    chamfer: { name: 'V型倒角刀', ui: '倒角刀', group: 'mill', profile: 'cone', angle: 90, extra: [],
      desc: 'V 型刀尖，倒角、去毛邊、孔口倒角。實際切削直徑看下刀多深。' },
    slotmill: { name: 'T型刀', group: 'mill', profile: 'flat', angle: null, extra: ['neckDia'], undercut: true,
      desc: '刀盤比刀桿大，銑 T 型槽或側向凹槽。頸徑要另外填。' },
    tapermill: { name: '錐度刀', group: 'mill', profile: 'flat', angle: null, extra: [],
      desc: '刀身帶錐度，做拔模斜面。直徑填刀尖直徑、單邊錐角填「角度」欄。' },
    dovetail: { name: '鳩尾槽刀', group: 'mill', profile: 'flat', angle: 45, extra: ['neckDia'], undercut: true,
      desc: '倒錐的燕尾刀，銑鳩尾槽或倒扣定位面。錐角常見 45°／60°。' },
    lollipop: { name: '糖球形銑刀', group: 'mill', profile: 'sphere', angle: null, extra: ['neckDia'], undercut: true,
      desc: '球徑比刀頸大的棒棒糖刀，專做底切與背面去毛邊。' },
    engrave: { name: '雕刻刀', group: 'mill', profile: 'cone', angle: 30, extra: [],
      desc: '細尖錐形刀，刻字刻線用。尖角常見 15°／30°／60°。' },
    // ---- 鑽孔類 ----
    drill: { name: '鑽頭', group: 'hole', profile: 'cone', angle: 118, extra: [],
      desc: '一般麻花鑽。刀尖角常見 118°（HSS）／135°（碳化鎢）。' },
    reamer: { name: '鉸刀', group: 'hole', profile: 'flat', angle: null, extra: [],
      desc: '把預鑽孔鉸到公差內。配 G85／G89，退刀也要進給、不能快退。' },
    boring: { name: '搪孔刀', group: 'hole', profile: 'flat', angle: null, extra: [],
      desc: '單刃可調徑，把孔搪到精確尺寸與真圓度。直徑填調好的實際孔徑。' },
    centerdrill: { name: '中心鑽', group: 'hole', profile: 'cone', angle: 60, extra: ['neckDia'],
      desc: 'DIN 333 複合鑽：前端小鑽 + 60° 錐面，車床頂針孔用。頸徑填前端小鑽直徑。' },
    spot: { name: '點鑽', ui: '點鑽（NC 定位鑽）', group: 'hole', profile: 'cone', angle: 90, extra: [],
      desc: '短、剛性好的定位鑽，先點窩讓後面的鑽頭不走位。角度常見 90°／120°／142°，要比後面那支鑽頭的尖角大。' },
    countersink: { name: '沉頭孔鑽', ui: '沉頭孔鑽（錐孔）', group: 'hole', profile: 'cone', angle: 90, extra: [],
      desc: '把孔口擴成錐形給平頭螺絲埋入。常見 82°／90°／100°。' },
    counterbore: { name: '魚眼孔鑽', ui: '魚眼孔鑽（平底沉孔）', group: 'hole', profile: 'flat', angle: null, extra: ['neckDia'],
      desc: '平底階梯孔，讓內六角螺絲頭沉下去。前端導柱直徑填頸徑欄。' },
    wooddrill: { name: '木工鑽頭', group: 'hole', profile: 'flat', angle: null, extra: [],
      desc: '中心尖加兩側切刀（brad point），孔底幾乎是平的，鑽木頭不走位。' },
    // ---- 攻牙類 ----
    tap: { name: '絲攻', ui: '右牙刀（絲攻）', group: 'thread', profile: 'none', angle: null, extra: [],
      desc: '右旋螺紋，配 G84。模擬不移除材料，只檢查進給 = 螺距 × 轉速。' },
    taplh: { name: '左牙刀', ui: '左牙刀（左旋絲攻）', group: 'thread', profile: 'none', angle: null, extra: [],
      desc: '左旋螺紋，配 G74 反向攻牙。一樣要檢查進給 = 螺距 × 轉速。' },
    // ---- 其他 ----
    unknown: { name: '?', ui: '未定義', group: 'other', profile: 'flat', angle: null, extra: [],
      desc: '看不出是哪一型。3D 模擬當成 Ø10 平刀處理，結果只能參考。' },
  };
  const TOOL_TYPES = Object.keys(TYPE_INFO);
  /** 型式 ↔ CSV 中文名稱（由 TYPE_INFO 導出，避免兩份名稱不同步） */
  const TYPE_NAMES = {};
  for (const k of TOOL_TYPES) TYPE_NAMES[k] = TYPE_INFO[k].name;

  /** CSV 型式名稱（含常見別名）→ ToolType。key 一律小寫比對。 */
  const TYPE_ALIASES = {
    // 銑削
    '銑刀': 'endmill', '立銑刀': 'endmill', '端銑刀': 'endmill', '平刀': 'endmill', '平底刀': 'endmill',
    'end mill': 'endmill', 'flat end mill': 'endmill',
    '球銑刀': 'ballmill', '球頭刀': 'ballmill', 'r刀': 'ballmill', 'ball mill': 'ballmill', 'ball end mill': 'ballmill',
    '牛鼻刀': 'bullnose', '圓角刀': 'bullnose', '圓鼻銑刀': 'bullnose',
    'bull nose': 'bullnose', 'bullnose end mill': 'bullnose', 'torus': 'bullnose', 'corner radius end mill': 'bullnose',
    '面銑': 'facemill', '刀盤': 'facemill', 'face mill': 'facemill',
    '外r刀': 'radiusmill', '外r成型': 'radiusmill', '成型刀': 'radiusmill', '圓角成型刀': 'radiusmill',
    'radius mill': 'radiusmill', 'corner rounding end mill': 'radiusmill', 'corner rounder': 'radiusmill',
    '倒角': 'chamfer', 'v刀': 'chamfer', 'v型刀': 'chamfer', 'chamfer mill': 'chamfer',
    't槽刀': 'slotmill', 't型銑刀': 'slotmill', 't-slot': 'slotmill', 't slot cutter': 'slotmill', 'slot mill': 'slotmill',
    '斜度刀': 'tapermill', '拔模刀': 'tapermill', '錐度銑刀': 'tapermill', 'taper mill': 'tapermill', 'tapered end mill': 'tapermill',
    '燕尾刀': 'dovetail', '鳩尾刀': 'dovetail', 'dovetail mill': 'dovetail', 'dovetail cutter': 'dovetail',
    '棒棒糖刀': 'lollipop', '糖球刀': 'lollipop', '球形底切刀': 'lollipop',
    'lollipop mill': 'lollipop', 'lollipop cutter': 'lollipop', 'undercut mill': 'lollipop',
    '雕刻': 'engrave', '刻字刀': 'engrave', 'engraving tool': 'engrave', 'engraver': 'engrave',
    // 鑽孔
    '鑽': 'drill', '麻花鑽': 'drill', 'twist drill': 'drill',
    '搪刀': 'boring', '搪孔': 'boring', '鏜刀': 'boring', 'boring bar': 'boring', 'bore bar': 'boring',
    '中心鑚': 'centerdrill', 'center drill': 'centerdrill', 'centre drill': 'centerdrill',
    '定點鑽': 'spot', 'nc鑽': 'spot', 'nc點鑽': 'spot', 'spot drill': 'spot', 'spotting drill': 'spot',
    '埋頭孔鑽': 'countersink', '埋頭鑽': 'countersink', '錐坑鑽': 'countersink',
    'counter sink': 'countersink', 'csk': 'countersink',
    '沉孔鑽': 'counterbore', '魚眼': 'counterbore', '魚眼鑽': 'counterbore',
    'counter bore': 'counterbore', 'cbore': 'counterbore',
    '木工鑽': 'wooddrill', 'wood drill': 'wooddrill', 'brad point drill': 'wooddrill',
    // 攻牙
    '牙刀': 'tap', '螺絲攻': 'tap', '右牙刀': 'tap', '右旋絲攻': 'tap', 'right hand tap': 'tap', 'rh tap': 'tap',
    '左旋絲攻': 'taplh', '左牙': 'taplh', 'left hand tap': 'taplh', 'lh tap': 'taplh',
    // 其他
    '未知': 'unknown', 'undefined': 'unknown',
  };
  // 型式 id、CSV 中文名、UI 名稱本身也算別名（手寫的優先，不覆蓋）
  for (const k of TOOL_TYPES) {
    for (const n of [k, TYPE_INFO[k].name, TYPE_INFO[k].ui]) {
      if (!n) continue;
      const key = String(n).toLowerCase();
      if (!(key in TYPE_ALIASES)) TYPE_ALIASES[key] = k;
    }
  }
  // 角R／頸徑排在「請填_」那一段的最後：CSV 是給現場填的，同一類欄位放一起才好填。
  // 匯出一定帶表頭、fromCSV 也以欄名對應，所以插欄不會影響既有檔案的讀取。
  const CSV_HEADER = ['程式', 'T', '程式註解', '推測型式', '推測直徑mm', '用途', '最深Z',
    '請填_型式確認', '請填_直徑mm', '請填_刀尖或倒角角度', '請填_刃長mm', '請填_伸出長mm',
    '請填_角R半徑mm', '請填_頸徑mm', '用到的D號', '請填_各D補正值', '備註'];
  const USER_FIELDS = ['label', 'type', 'diameter', 'angle', 'fluteLen', 'stickout', 'pitch',
    'cornerRad', 'neckDia', 'resident', 'probe'];
  /** 每欄都要有 source 標記的數值欄位 */
  const SOURCE_FIELDS = ['type', 'diameter', 'angle', 'fluteLen', 'stickout', 'pitch', 'cornerRad', 'neckDia'];
  const HOLE_TAP = new Set(['G84', 'G74']);
  const HOLE_REAM = new Set(['G85', 'G89']);

  /**
   * 註解關鍵字 → 型式，由上往下比，先命中先用。順序有意義：
   * TAPER 要排在 TAP 前面（TAPER 裡面就有 TAP）、CENTER DRILL 要排在 SPOT 前面、
   * 左牙刀要排在絲攻前面（「左牙刀」裡面就有「牙刀」）。
   */
  const COMMENT_KEYWORDS = [
    [/DOVETAIL|鳩尾|燕尾/, 'dovetail'],
    [/LOLLIPOP|LOLLI|棒棒糖|糖球/, 'lollipop'],
    [/T-?SLOT|T型刀|T槽/, 'slotmill'],
    [/TAPER|錐度|拔模|斜度/, 'tapermill'],
    [/ENGRAV|雕刻|刻字/, 'engrave'],
    [/C-?BORE|COUNTER\s*-?BORE|魚眼|沉孔/, 'counterbore'],
    [/CSK|C-?SINK|COUNTER\s*-?SINK|沉頭|埋頭/, 'countersink'],
    [/CENTER\s*-?DRILL|CENTRE\s*-?DRILL|中心鑽|中心鑚/, 'centerdrill'],
    [/SPOT|定點鑽|點鑽|NC\s*鑽/, 'spot'],
    [/CENTER|CENTRE/, 'centerdrill'],
    [/BORING|BORE\s*BAR|搪孔|搪刀|鏜/, 'boring'],
    [/WOOD|木工/, 'wooddrill'],
    [/BULL\s*-?NOSE|牛鼻|圓鼻/, 'bullnose'],
    [/CORNER\s*R|外R|圓角成型/, 'radiusmill'],
    [/BALL/, 'ballmill'],
    [/LH\s*TAP|TAP\s*LH|左牙|左旋/, 'taplh'],
    [/\bTAP\b|絲攻|牙刀/, 'tap'],
    [/REAM|鉸刀/, 'reamer'],
    [/\bDRILL\b|麻花鑽/, 'drill'],
  ];

  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const round4 = (v) => Math.round(v * 10000) / 10000;

  // ---------------------------------------------------------------------------
  // parseComment
  // ---------------------------------------------------------------------------
  /**
   * 解析 M6 行註解，推測刀具型式與直徑。
   * @param {string|null|undefined} str
   * @returns {{type:string, diameter:number|null, angle?:number, pitch?:number, cornerRad?:number, source:'comment'|'default'}}
   */
  /** 註解裡的直徑：先找寫了 MM／M/M 的，沒有就取第一個數字 */
  function commentDiameter(up) {
    let m = /(\d+(?:\.\d+)?)\s*(?:MM|M\/M)/.exec(up);
    if (m) return parseFloat(m[1]);
    // 角度（30DEG）和角R（R2）都不是直徑，先拿掉再找，免得把 'ENGRAVE 30DEG' 讀成 Ø30
    const rest = up.replace(/(\d+(?:\.\d+)?)\s*(?:DEG|°|度)/g, ' ').replace(/R\s*=?\s*\d+(?:\.\d+)?/g, ' ');
    m = /(?:^|[^\d.])(\d+(?:\.\d+)?)/.exec(rest);
    return m ? parseFloat(m[1]) : null;
  }
  /** 註解裡明寫的角度：45DEG / 60° / 90度 */
  function commentAngle(up) {
    const m = /(\d+(?:\.\d+)?)\s*(?:DEG|°|度)/.exec(up);
    return m ? parseFloat(m[1]) : null;
  }
  /** 註解裡明寫的角R／成型半徑：R0.5 / R=2 */
  function commentRadius(up) {
    const m = /R\s*=?\s*(\d+(?:\.\d+)?)/.exec(up);
    return m ? parseFloat(m[1]) : null;
  }

  function parseComment(str) {
    const s = String(str == null ? '' : str).trim();
    const up = s.toUpperCase();
    let m;
    if (!s) return { type: 'unknown', diameter: null, source: 'default' };
    // 絲攻：M4*P0.7（也容許 M4X0.7 / M4*0.7）；註解另外標了 LH／左牙 → 左牙刀
    if ((m = /M(\d+(?:\.\d+)?)\s*[*X×]\s*P?(\d+\.?\d*)/.exec(up))) {
      const lh = /(?:^|[^A-Z])LH(?:[^A-Z]|$)|左牙|左旋/.test(up);
      return { type: lh ? 'taplh' : 'tap', diameter: parseFloat(m[1]), pitch: parseFloat(m[2]), source: 'comment' };
    }
    // 鉸刀：6+0.014（相加）
    if ((m = /(\d+(?:\.\d+)?)\s*\+\s*(\d+\.\d+)/.exec(up))) {
      return { type: 'reamer', diameter: round4(parseFloat(m[1]) + parseFloat(m[2])), source: 'comment' };
    }
    // 鑽頭：SG-12.
    if ((m = /SG-?\s*(\d+\.?\d*)/.exec(up))) {
      return { type: 'drill', diameter: parseFloat(m[1]), angle: 118, source: 'comment' };
    }
    // 關鍵字型式：球刀、點鑽、鳩尾槽刀……（額外容錯，不在契約範例內）
    for (const [re, type] of COMMENT_KEYWORDS) {
      if (!re.test(up)) continue;
      const info = TYPE_INFO[type];
      const out = { type, diameter: commentDiameter(up), source: 'comment' };
      const ang = commentAngle(up);
      if (ang != null) out.angle = ang;
      else if (num(info.angle) != null) out.angle = info.angle;
      if (info.extra.includes('cornerRad')) {
        const r = commentRadius(up);
        if (r != null) out.cornerRad = r;
      }
      return out;
    }
    // 圓鼻刀：12R0.5 / 10MM R1（直徑 + 角R）
    if ((m = /(\d+(?:\.\d+)?)\s*(?:MM|M\/M)?\s*R\s*=?\s*(\d+(?:\.\d+)?)/.exec(up))) {
      return { type: 'bullnose', diameter: parseFloat(m[1]), cornerRad: parseFloat(m[2]), source: 'comment' };
    }
    // 倒角刀：10V
    if ((m = /(\d+(?:\.\d+)?)\s*V\b/.exec(up)) || (m = /(\d+(?:\.\d+)?)\s*V(?![A-Z])/.exec(up))) {
      return { type: 'chamfer', diameter: parseFloat(m[1]), angle: 90, source: 'comment' };
    }
    // 銑刀：12MM / 10M/M / 100MM（≥ 40 → 面銑刀）
    if ((m = /(\d+(?:\.\d+)?)\s*(?:MM|M\/M)/.exec(up))) {
      const d = parseFloat(m[1]);
      return { type: d >= FACEMILL_MIN_DIAMETER ? 'facemill' : 'endmill', diameter: d, source: 'comment' };
    }
    return { type: 'unknown', diameter: null, source: 'default' };
  }

  // ---------------------------------------------------------------------------
  // 作業側寫（由 Run 的動作統計）
  // ---------------------------------------------------------------------------
  function emptyProfile() {
    return {
      hasCut: false, hasXYFeed: false, hasVerticalFeed: false, hasComp: false,
      holeCycles: new Set(), zMin: null, xMin: Infinity, xMax: -Infinity,
    };
  }
  function noteZ(p, z) { if (num(z) != null && (p.zMin == null || z < p.zMin)) p.zMin = z; }
  function noteX(p, x) { if (num(x) != null) { if (x < p.xMin) p.xMin = x; if (x > p.xMax) p.xMax = x; } }

  /** 從 Run 的 executed 動作彙整一個作業的切削特徵 */
  function profileFromRun(run, op) {
    const p = emptyProfile();
    if (!run || !Array.isArray(run.executed)) return p;
    const gCodes = Array.isArray(op.gCodes) ? op.gCodes : [];
    if (gCodes.includes('G41') || gCodes.includes('G42')) p.hasComp = true;
    for (const eb of run.executed) {
      if (!eb || eb.opIndex !== op.index || eb.skipped || eb.ignored) continue;
      if (eb.after && eb.after.comp && eb.after.comp !== 'G40') p.hasComp = true;
      for (const a of (eb.actions || [])) {
        if (!a) continue;
        if (a.compStart) p.hasComp = true;
        if (a.kind === 'linear' || a.kind === 'arc') {
          p.hasCut = true;
          const f = a.from || {}, t = a.to || {};
          const dxy = Math.hypot((t.x || 0) - (f.x || 0), (t.y || 0) - (f.y || 0));
          if (a.kind === 'arc' || dxy > NC.EPS) p.hasXYFeed = true; else p.hasVerticalFeed = true;
          noteZ(p, t.z); noteX(p, f.x); noteX(p, t.x);
        } else if (a.kind === 'hole') {
          p.hasCut = true;
          if (a.cycle) p.holeCycles.add(a.cycle);
          noteZ(p, a.z != null ? a.z : (a.to && a.to.z)); noteX(p, a.x);
        }
      }
    }
    if (p.zMin == null && num(op.zMin) != null) p.zMin = op.zMin;
    return p;
  }

  /** 沒有 Run 時，從 tokenizer 的節粗略統計（只看字組，不做語意） */
  function profileFromBlocks(blocks) {
    const p = emptyProfile();
    let cycle = null, motion = 0; // motion：群組 01 模態（0–3）
    for (const b of blocks) {
      if (!b || b.isEmpty) continue;
      const words = b.words || [];
      const has = (addr) => words.some((w) => w.addr === addr);
      for (const w of words) {
        if (w.addr !== 'G') continue;
        const g = 'G' + w.value;
        if (g === 'G41' || g === 'G42') p.hasComp = true;
        if (w.value >= 73 && w.value <= 89 && w.value !== 80) cycle = g;
        if (w.value === 80 || (w.value >= 0 && w.value <= 3)) cycle = null;
        if (w.value >= 0 && w.value <= 3) motion = w.value;
      }
      const hasXY = has('X') || has('Y');
      const hasZ = has('Z');
      if (!cycle && motion >= 1 && (hasXY || hasZ)) {
        p.hasCut = true;
        if (hasXY) p.hasXYFeed = true; else p.hasVerticalFeed = true;
      }
      if (cycle && (hasXY || hasZ || has('R'))) { p.hasCut = true; p.holeCycles.add(cycle); }
      for (const w of words) {
        if (w.addr === 'X') noteX(p, w.value);
        if (w.addr === 'Z' && p.hasCut) noteZ(p, w.value);
      }
    }
    return p;
  }

  /** 由動作特徵推測型式；沒有切削 → null */
  function motionTypeOf(p, diameter) {
    if (!p.hasCut) return null;
    if (!p.hasXYFeed) {
      // 只有孔（或只有 Z 向進給）
      for (const c of p.holeCycles) if (HOLE_TAP.has(c)) return 'tap';
      for (const c of p.holeCycles) if (HOLE_REAM.has(c)) return 'reamer';
      return 'drill';
    }
    if (p.hasComp) return 'endmill';
    const travel = (p.xMax > p.xMin) ? (p.xMax - p.xMin) : 0;
    if ((num(diameter) != null && diameter >= FACEMILL_MIN_DIAMETER) ||
        (p.zMin != null && p.zMin >= FACE_Z_LIMIT && travel >= FACEMILL_MIN_TRAVEL)) return 'facemill';
    return 'endmill';
  }

  /** 註解型式與動作型式是否相容 */
  function compatible(commentType, motionType) {
    if (!motionType || commentType === 'unknown') return true;
    const MILL = ['endmill', 'facemill', 'drill'];         // 銑刀可鑽孔（G81 銑孔底）
    const ok = {
      endmill: MILL,
      facemill: ['facemill', 'endmill'],
      ballmill: MILL,
      bullnose: MILL,
      radiusmill: MILL,
      chamfer: MILL,                                        // 倒角刀常用 G81 倒孔口，`75-3(316)` T3 就是
      slotmill: ['endmill', 'facemill'],                    // 側向進刀，不會拿來鑽孔
      tapermill: MILL,
      dovetail: ['endmill', 'facemill'],
      lollipop: ['endmill', 'facemill'],
      engrave: MILL,
      drill: ['drill'],
      reamer: ['reamer', 'drill'],
      boring: ['reamer', 'drill', 'endmill'],               // G85／G86 搪孔，也有人用螺旋銑
      centerdrill: ['drill'],
      spot: ['drill'],
      countersink: ['drill', 'endmill'],                    // 錐孔多半 G81／G82，也可能用銑的
      counterbore: ['drill', 'endmill'],
      wooddrill: ['drill'],
      tap: ['tap'],
      taplh: ['tap'],
    };
    return (ok[commentType] || []).includes(motionType);
  }

  // ---------------------------------------------------------------------------
  // inferTools
  // ---------------------------------------------------------------------------
  /** 蒐集每把刀的作業清單（依第一次出現排序） */
  function collectToolOps(tok, run) {
    const blocks = (tok && Array.isArray(tok.blocks)) ? tok.blocks : [];
    const map = new Map();
    const ensure = (t) => {
      if (!map.has(t)) map.set(t, { t, comments: [], profiles: [], dList: [], firstLine: null, opIndices: [] });
      return map.get(t);
    };
    if (run && Array.isArray(run.ops) && run.ops.length) {
      for (const op of run.ops) {
        if (op == null || num(op.tool) == null) continue;
        const e = ensure(op.tool);
        let c = op.toolComment;
        if (c == null && blocks[op.lineStart - 1]) c = blocks[op.lineStart - 1].comment;
        if (c != null && String(c).trim()) e.comments.push(String(c).trim());
        e.profiles.push(profileFromRun(run, op));
        for (const d of (op.dList || [])) if (num(d) != null && !e.dList.includes(d)) e.dList.push(d);
        if (e.firstLine == null) e.firstLine = op.lineStart;
        e.opIndices.push(op.index);
      }
      return map;
    }
    // 退路：只有 tokenizer 結果時，從 M6 節切分
    let staged = null, cur = null, curBlocks = [];
    const flush = () => { if (cur) cur.profiles.push(profileFromBlocks(curBlocks)); curBlocks = []; };
    for (const b of blocks) {
      if (!b || b.isEmpty) continue;
      const words = b.words || [];
      const tw = words.find((w) => w.addr === 'T');
      const isM6 = words.some((w) => w.addr === 'M' && w.value === 6);
      if (isM6) {
        flush();
        const t = tw ? tw.value : staged;
        cur = (num(t) != null) ? ensure(t) : null;
        if (cur) {
          if (b.comment && b.comment.trim()) cur.comments.push(b.comment.trim());
          if (cur.firstLine == null) cur.firstLine = b.line;
          cur.opIndices.push(cur.opIndices.length);
        }
        staged = null;
        continue;
      }
      if (tw) staged = tw.value;
      if (cur) {
        curBlocks.push(b);
        for (const w of words) if (w.addr === 'D' && w.value > 0 && !cur.dList.includes(w.value)) cur.dList.push(w.value);
      }
    }
    flush();
    return map;
  }

  /**
   * 推測細節（給 rules R31 與 CSV 用）：每把刀的註解型式、動作型式、是否矛盾、切削特徵。
   * @returns {{t:number, label:string, comment:string|null, commentType:string, motionType:string|null,
   *   conflict:boolean, hasCut:boolean, hasComp:boolean, zMin:number|null, dList:number[], line:number|null, opIndices:number[]}[]}
   */
  function inferDetails(tok, run) {
    const out = [];
    for (const e of collectToolOps(tok, run).values()) {
      const comment = e.comments.length ? e.comments[0] : null;
      const parsed = parseComment(comment);
      const merged = emptyProfile();
      for (const p of e.profiles) {
        merged.hasCut = merged.hasCut || p.hasCut;
        merged.hasXYFeed = merged.hasXYFeed || p.hasXYFeed;
        merged.hasVerticalFeed = merged.hasVerticalFeed || p.hasVerticalFeed;
        merged.hasComp = merged.hasComp || p.hasComp;
        for (const c of p.holeCycles) merged.holeCycles.add(c);
        noteZ(merged, p.zMin); noteX(merged, p.xMin); noteX(merged, p.xMax);
      }
      const motionType = motionTypeOf(merged, parsed.diameter);
      out.push({
        t: e.t, label: comment || `T${e.t}`, comment, parsed,
        commentType: parsed.type, motionType,
        conflict: !compatible(parsed.type, motionType),
        hasCut: merged.hasCut, hasComp: merged.hasComp, zMin: merged.zMin,
        dList: e.dList.slice(), line: e.firstLine, opIndices: e.opIndices.slice(),
      });
    }
    return out;
  }

  /** 型式的預設刀尖角／倒角夾角；沒有通用值就回 null（要現場填） */
  function defaultAngleOf(type) {
    const info = TYPE_INFO[type];
    return (info && num(info.angle) != null) ? info.angle : null;
  }

  /** 依型式與直徑補預設值（角度、刃長）；角R／頸徑沒有通用預設，一律留 null 讓現場填 */
  function applyDefaults(tool) {
    tool.source = tool.source || {};
    if (num(tool.angle) == null) {
      tool.angle = defaultAngleOf(tool.type);
      tool.source.angle = 'default';
    }
    if (num(tool.fluteLen) == null) {
      tool.fluteLen = (num(tool.diameter) != null) ? round4(tool.diameter * 3) : null;
      tool.source.fluteLen = 'default';
    }
    if (tool.stickout === undefined) tool.stickout = null;
    if (tool.pitch === undefined) tool.pitch = null;
    if (tool.cornerRad === undefined) tool.cornerRad = null;
    if (tool.neckDia === undefined) tool.neckDia = null;
    for (const f of SOURCE_FIELDS) if (!tool.source[f]) tool.source[f] = 'default';
    return tool;
  }

  /**
   * 推測刀具清單：每個 M6 T（去重），型式由註解 + 動作交叉驗證。
   * @param {TokenizeResult|null} tok
   * @param {Run|null} run
   * @returns {Tool[]}
   */
  function inferTools(tok, run) {
    return inferDetails(tok, run).map((d) => {
      const parsed = d.parsed;
      const tool = {
        t: d.t, label: d.label, type: 'unknown', diameter: DEFAULT_DIAMETER, angle: null,
        fluteLen: null, stickout: null, pitch: null, cornerRad: null, neckDia: null,
        resident: false, probe: false,
        source: { type: 'default', diameter: 'default' },
      };
      if (parsed.type !== 'unknown') {
        tool.type = parsed.type; tool.source.type = 'comment';
      } else if (d.motionType) {
        tool.type = d.motionType; tool.source.type = 'motion';
      }
      if (num(parsed.diameter) != null) { tool.diameter = parsed.diameter; tool.source.diameter = 'comment'; }
      if (num(parsed.angle) != null) { tool.angle = parsed.angle; tool.source.angle = 'default'; }
      if (num(parsed.pitch) != null) { tool.pitch = parsed.pitch; tool.source.pitch = 'comment'; }
      if (num(parsed.cornerRad) != null) { tool.cornerRad = parsed.cornerRad; tool.source.cornerRad = 'comment'; }
      if (!d.comment && !d.hasCut) {
        tool.probe = true; tool.type = 'unknown'; tool.diameter = DEFAULT_DIAMETER; tool.label = `T${d.t}`;
        tool.source.type = 'default'; tool.source.diameter = 'default';
      }
      tool.resident = (d.t === 20 || tool.type === 'facemill');
      tool.source.resident = 'default';
      tool.source.probe = 'default';
      tool.source.label = d.comment ? 'comment' : 'default';
      return applyDefaults(tool);
    });
  }

  // ---------------------------------------------------------------------------
  // 補正
  // ---------------------------------------------------------------------------
  function toolsOf(x) {
    if (!x) return [];
    if (Array.isArray(x)) return x;
    if (Array.isArray(x.tools)) return x.tools;
    return [];
  }
  function offsetsOf(x) { return (x && Array.isArray(x.offsets)) ? x.offsets : []; }
  function findTool(tools, t) { return toolsOf(tools).find((tool) => tool && tool.t === t) || null; }

  /**
   * 有效刀徑補正半徑：offsets 有 n=d 且 (radGeom+radWear)≠0 → 用它；否則 tool.diameter/2；皆無 → null。
   */
  function effectiveRadius(toolTable, t, d) {
    if (num(d) != null && d > 0) {
      const o = offsetsOf(toolTable).find((e) => e && e.n === d);
      if (o) {
        const r = (num(o.radGeom) || 0) + (num(o.radWear) || 0);
        if (Math.abs(r) > NC.EPS) return r;
      }
    }
    const tool = findTool(toolTable, t);
    // 倒角刀／中心鑽（V 型）：程式指定的深度決定實際切削直徑，補正量必須由 D 值輸入，
    // 用「公稱直徑/2」會嚴重高估（10V 會變成 r=5），造成內圓角被誤判成干涉（PS0041）。
    // 沒有 D 值時回傳 null，讓 geometry 出 R10「需輸入 D 值」而不是猜一個錯的值。
    if (tool && (tool.type === 'chamfer' || tool.type === 'spot')) return null;
    if (tool && num(tool.diameter) != null && tool.diameter > 0) return tool.diameter / 2;
    return null;
  }

  /**
   * 預設補正：每個用到的 D 號，radGeom = 對應刀直徑/2（source 'default'）。
   * dList 可為：number[]（D 對應刀 = 同號 T，找不到則 0）、{d,tool}[]、或 Run（用 ops 的 dList 與 tool）。
   */
  function defaultOffsets(tools, dList) {
    const list = toolsOf(tools);
    const pairs = [];
    const push = (d, t) => { if (num(d) != null && d > 0 && !pairs.some((p) => p.d === d)) pairs.push({ d, t }); };
    if (dList && !Array.isArray(dList) && Array.isArray(dList.ops)) {
      for (const op of dList.ops) for (const d of (op.dList || [])) push(d, op.tool);
    } else if (Array.isArray(dList)) {
      for (const item of dList) {
        if (typeof item === 'number') push(item, null);
        else if (item && typeof item === 'object') push(num(item.d) != null ? item.d : item.n, num(item.tool) != null ? item.tool : item.t);
      }
    }
    return pairs.map(({ d, t }) => {
      const tool = findTool(list, num(t) != null ? t : d);
      const dia = tool ? num(tool.diameter) : null;
      // 倒角刀／中心鑽的補正量取決於切削深度（刀尖處直徑），不能用公稱直徑/2 當預設，
      // 否則 10V 會變成 r=5，把 ,R2. 之類的內圓角全部誤判成干涉。留 0 表示「需輸入」。
      const isV = tool && (tool.type === 'chamfer' || tool.type === 'spot');
      const rad = (!isV && dia != null) ? round4(dia / 2) : 0;
      return { n: d, lenGeom: 0, lenWear: 0, radGeom: rad, radWear: 0, source: 'default' };
    }).sort((a, b) => a.n - b.n);
  }

  /** 合併補正：override 中 source='user' 的項目蓋掉 base 同號；其餘保留 base。 */
  function mergeOffsets(base, override) {
    const out = (base || []).map((o) => Object.assign({}, o));
    for (const o of (override || [])) {
      if (!o || num(o.n) == null || o.source !== 'user') continue;
      const i = out.findIndex((e) => e.n === o.n);
      const entry = normalizeOffset(o);
      if (i >= 0) out[i] = entry; else out.push(entry);
    }
    return out.sort((a, b) => a.n - b.n);
  }

  // ---------------------------------------------------------------------------
  // 素材推估
  // ---------------------------------------------------------------------------
  const CUT_KINDS = new Set(['feed', 'arc', 'drill']);
  function arr(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

  /**
   * 以 feed/arc/drill 包絡 + 刀半徑外擴推估素材；Z max = max(0, 最高切削 Z)，Z min = 最深切削 Z − 5；取整到 1 mm。
   * @param {Run|Run[]} runs
   * @param {GeometryResult|GeometryResult[]|null} geometry
   * @param {Tool[]|ToolTable|null} tools
   * @returns {Stock}
   */
  const STOCK_XY_MARGIN = 5;      // 成品輪廓外多留的毛胚餘量（單邊 mm）
  const SURFACE_SKIM_MM = 2;      // 距頂面這麼淺的切削視為面銑／刮面，範圍不代表毛胚大小

  /**
   * 「深度切削」的 XY 範圍：只看明顯低於頂面的切削段（含刀半徑）。
   * 面銑／刮面（Z 接近頂面）不算——刀盤掃過空氣不代表那裡有料。
   * 回傳 null 表示這支程式沒有深度切削（例如純面銑），此時不做收斂。
   */
  function deepCutRegion(geometry, radiusOf, zTop) {
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    let any = false;
    const put = (x, y, r) => {
      if (num(x) == null || num(y) == null) return;
      any = true;
      b.minX = Math.min(b.minX, x - r); b.maxX = Math.max(b.maxX, x + r);
      b.minY = Math.min(b.minY, y - r); b.maxY = Math.max(b.maxY, y + r);
    };
    for (const g of arr(geometry)) {
      if (!g || !Array.isArray(g.segments)) continue;
      for (const s of g.segments) {
        if (!s || !CUT_KINDS.has(s.kind) || s.refReturn || !s.from || !s.to) continue;
        if (Math.min(s.from.z, s.to.z) > zTop - SURFACE_SKIM_MM) continue;
        const r = radiusOf(s.tool);
        put(s.from.x, s.from.y, r); put(s.to.x, s.to.y, r);
        if (s.arc && s.arc.center) {
          const rr = (num(s.arc.r) || 0) + r;
          put(s.arc.center.x - rr, s.arc.center.y - rr, 0); put(s.arc.center.x + rr, s.arc.center.y + rr, 0);
        }
      }
    }
    return any && b.maxX > b.minX && b.maxY > b.minY ? b : null;
  }

  function estimateStock(runs, geometry, tools) {
    const list = toolsOf(tools);
    const radiusOf = (t) => { const tool = findTool(list, t); return (tool && num(tool.diameter) != null) ? tool.diameter / 2 : 0; };
    const box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    let found = false;
    const add = (x, y, z, r) => {
      if (num(x) == null || num(y) == null) return;
      found = true;
      box.minX = Math.min(box.minX, x - r); box.maxX = Math.max(box.maxX, x + r);
      box.minY = Math.min(box.minY, y - r); box.maxY = Math.max(box.maxY, y + r);
      if (num(z) != null) { box.minZ = Math.min(box.minZ, z); }
    };
    const addTop = (z) => { if (num(z) != null) box.maxZ = Math.max(box.maxZ, z); };
    const isPureLift = (f, t) => f && t && Math.hypot(t.x - f.x, t.y - f.y) <= NC.EPS && t.z > f.z;

    let usedSegments = false;
    for (const g of arr(geometry)) {
      if (!g || !Array.isArray(g.segments)) continue;
      for (const s of g.segments) {
        if (!s || !CUT_KINDS.has(s.kind) || s.refReturn) continue;
        if (isPureLift(s.from, s.to)) continue;
        usedSegments = true;
        const r = radiusOf(s.tool);
        add(s.from.x, s.from.y, s.from.z, r); add(s.to.x, s.to.y, s.to.z, r);
        // 素材頂面只能由「真正在切材料」的段決定。固定循環展開出來的段（sub 有值：
        // peck／retract／tapUp／boreUp／plunge）是刀具在自己剛鑽出的孔內上下移動，
        // 拿它的 to.z 去墊高頂面，會讓推估素材比實際高 1～2 mm，
        // 然後面銑的第一刀（Z0.05）就變成一筆純誤報的 R27「G0 下刀撞料」。
        if (!s.sub) addTop(s.to.z);
        if (s.arc && s.arc.center) {
          const rr = (num(s.arc.r) || 0) + r;
          add(s.arc.center.x - rr, s.arc.center.y - rr, null, 0); add(s.arc.center.x + rr, s.arc.center.y + rr, null, 0);
        }
      }
    }
    if (!usedSegments) {
      for (const run of arr(runs)) {
        if (!run || !Array.isArray(run.executed)) continue;
        const toolOfOp = (i) => { const op = (run.ops || [])[i]; return op ? op.tool : null; };
        for (const eb of run.executed) {
          if (!eb || eb.skipped || eb.ignored) continue;
          const r = radiusOf(toolOfOp(eb.opIndex));
          for (const a of (eb.actions || [])) {
            if (!a) continue;
            if (a.kind === 'linear' || a.kind === 'arc') {
              if (isPureLift(a.from, a.to)) continue;
              add(a.from.x, a.from.y, a.from.z, r); add(a.to.x, a.to.y, a.to.z, r); addTop(a.to.z);
              if (a.kind === 'arc' && a.center) {
                const rr = (num(a.r) || 0) + r;
                add(a.center.x - rr, a.center.y - rr, null, 0); add(a.center.x + rr, a.center.y + rr, null, 0);
              }
            } else if (a.kind === 'hole') {
              add(a.x, a.y, a.z, r); addTop(a.z);
            }
          }
        }
      }
    }
    if (!found) {
      return { min: { x: -50, y: -50, z: -20 }, max: { x: 50, y: 50, z: 0 }, source: 'estimated', fixtures: [] };
    }
    const zTop = Math.max(0, box.maxZ === -Infinity ? 0 : box.maxZ);
    const zBottom = (box.minZ === Infinity ? 0 : Math.min(box.minZ, zTop)) - STOCK_Z_MARGIN;
    // XY 以「成品輪廓區 + 邊界餘量」為準，不用整個刀具掃掠包絡。
    // 面銑刀掃到哪裡跟毛胚多大無關：Ø100 面銑刀走 X±118 的話，
    // 外擴刀半徑後推出 X±168，而工件輪廓只到 X±58——多出來的一圈假材料
    // 會讓工件外的合法 G0 全部變成「撞料」。深度切削的範圍才反映真實毛胚。
    const deep = deepCutRegion(geometry, radiusOf, zTop);
    if (deep) {
      box.minX = Math.max(box.minX, deep.minX - STOCK_XY_MARGIN);
      box.maxX = Math.min(box.maxX, deep.maxX + STOCK_XY_MARGIN);
      box.minY = Math.max(box.minY, deep.minY - STOCK_XY_MARGIN);
      box.maxY = Math.min(box.maxY, deep.maxY + STOCK_XY_MARGIN);
    }
    // X/Y 外擴與底面往下取整到 1 mm（保守）；頂面則用實際值不再往上取整——
    // 面銑第一刀常寫 Z0.05，往上取整成 Z1 會讓素材比實際高快 1 mm，
    // 接著每一支這樣寫的程式都會拿到一筆「G0 下刀撞料 0.95 mm」的純誤報。
    return {
      min: { x: Math.floor(box.minX), y: Math.floor(box.minY), z: Math.floor(zBottom) },
      max: { x: Math.ceil(box.maxX), y: Math.ceil(box.maxY), z: zTop },
      source: 'estimated', fixtures: [],
    };
  }

  // ---------------------------------------------------------------------------
  // 正規化與合併
  // ---------------------------------------------------------------------------
  function normalizeType(v) {
    if (v == null) return 'unknown';
    const s = String(v).trim();
    if (TOOL_TYPES.includes(s)) return s;
    return TYPE_ALIASES[s.toLowerCase()] || TYPE_ALIASES[s] || 'unknown';
  }
  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v == null) return null;
    const s = String(v).trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    return parseFloat(s);
  }
  function normalizeTool(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const t = toNum(raw.t != null ? raw.t : String(raw.T || '').replace(/^T/i, ''));
    if (t == null) return null;
    const src = (raw.source && typeof raw.source === 'object') ? Object.assign({}, raw.source) : {};
    const tool = {
      t, label: (raw.label != null && String(raw.label).trim()) ? String(raw.label).trim() : `T${t}`,
      type: normalizeType(raw.type),
      diameter: toNum(raw.diameter) != null ? toNum(raw.diameter) : DEFAULT_DIAMETER,
      angle: toNum(raw.angle), fluteLen: toNum(raw.fluteLen), stickout: toNum(raw.stickout), pitch: toNum(raw.pitch),
      cornerRad: toNum(raw.cornerRad), neckDia: toNum(raw.neckDia),
      resident: !!raw.resident, probe: !!raw.probe, source: src,
    };
    for (const f of SOURCE_FIELDS) if (!src[f]) src[f] = 'default';
    return tool;
  }
  function normalizeOffset(raw) {
    const n = toNum(raw.n);
    if (n == null) return null;
    return {
      n, lenGeom: toNum(raw.lenGeom) || 0, lenWear: toNum(raw.lenWear) || 0,
      radGeom: toNum(raw.radGeom) || 0, radWear: toNum(raw.radWear) || 0,
      source: ['comment', 'motion', 'default', 'user'].includes(raw.source) ? raw.source : 'user',
    };
  }
  function normalizeTable(raw, fallbackKey) {
    if (!raw || typeof raw !== 'object') return null;
    const tools = toolsOf(raw).map(normalizeTool).filter(Boolean);
    const offsets = offsetsOf(raw).map((o) => o && normalizeOffset(o)).filter(Boolean).sort((a, b) => a.n - b.n);
    return {
      programKey: String(raw.programKey || fallbackKey || ''),
      tools, offsets,
      updatedAt: (typeof raw.updatedAt === 'string' && raw.updatedAt) ? raw.updatedAt : new Date().toISOString(),
    };
  }

  /**
   * 合併：saved 中 source[欄位]='user' 的值覆蓋推測；saved 的 user 補正也覆蓋。
   * @param {Tool[]|ToolTable} inferred
   * @param {ToolTable|null} saved
   * @returns {ToolTable}
   */
  function mergeUserTable(inferred, saved) {
    const base = Array.isArray(inferred) ? { tools: inferred, offsets: [], programKey: '' } : (inferred || { tools: [], offsets: [], programKey: '' });
    const savedTable = saved ? normalizeTable(saved) : null;
    const tools = toolsOf(base).map((tool) => {
      const out = Object.assign({}, tool, { source: Object.assign({}, tool.source || {}) });
      const s = savedTable ? findTool(savedTable.tools, tool.t) : null;
      if (s) {
        for (const f of USER_FIELDS) {
          if (s.source && s.source[f] === 'user') { out[f] = s[f]; out.source[f] = 'user'; }
        }
      }
      return out;
    });
    return {
      programKey: base.programKey || (savedTable && savedTable.programKey) || '',
      tools,
      offsets: mergeOffsets(offsetsOf(base), savedTable ? savedTable.offsets : []),
      updatedAt: new Date().toISOString(),
    };
  }

  /** 便利函式：推測 + 預設補正 + 合併使用者資料，一次做完。 */
  function buildTable(tok, run, saved, programKey) {
    const tools = inferTools(tok, run);
    const details = inferDetails(tok, run);
    const pairs = [];
    for (const d of details) for (const n of d.dList) pairs.push({ d: n, tool: d.t });
    const key = programKey || (tok && tok.programNumber != null ? 'O' + String(tok.programNumber).padStart(4, '0') : '');
    return mergeUserTable({ programKey: key, tools, offsets: defaultOffsets(tools, pairs) }, saved);
  }

  // ---------------------------------------------------------------------------
  // 儲存（localStorage，try/catch）
  // ---------------------------------------------------------------------------
  let storageOverride = null;
  function getStorage() {
    if (storageOverride) return storageOverride;
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (_) { return null; }
  }
  /** 測試或特殊環境可注入 {getItem,setItem,removeItem} */
  function setStorage(s) { storageOverride = s || null; }

  function exportJSON(table) {
    return JSON.stringify(normalizeTable(table) || { programKey: '', tools: [], offsets: [], updatedAt: new Date().toISOString() }, null, 2);
  }
  /** 解析 JSON → ToolTable；格式不對會丟出 Error（訊息繁中）。 */
  function importJSON(str) {
    let raw;
    try { raw = JSON.parse(String(str).replace(/^﻿/, '')); } catch (e) { throw new Error('匯入失敗：不是有效的 JSON（' + e.message + '）'); }
    if (!raw || typeof raw !== 'object' || (!Array.isArray(raw.tools) && !Array.isArray(raw))) throw new Error('匯入失敗：找不到 tools 陣列');
    if (Array.isArray(raw)) raw = { tools: raw };
    return normalizeTable(raw);
  }
  function save(key, table) {
    try {
      const s = getStorage();
      if (!s) return false;
      s.setItem(STORAGE_PREFIX + key, exportJSON(Object.assign({}, table, { updatedAt: new Date().toISOString() })));
      return true;
    } catch (_) { return false; }
  }
  function load(key) {
    try {
      const s = getStorage();
      if (!s) return null;
      const str = s.getItem(STORAGE_PREFIX + key);
      if (!str) return null;
      return importJSON(str);
    } catch (_) { return null; }
  }
  function remove(key) {
    try { const s = getStorage(); if (!s) return false; s.removeItem(STORAGE_PREFIX + key); return true; } catch (_) { return false; }
  }
  function listSaved() {
    try {
      const s = getStorage();
      if (!s) return [];
      const keys = [];
      if (typeof s.length === 'number' && typeof s.key === 'function') {
        for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k.slice(STORAGE_PREFIX.length)); }
      } else if (typeof s.keys === 'function') {
        for (const k of s.keys()) if (k.startsWith(STORAGE_PREFIX)) keys.push(k.slice(STORAGE_PREFIX.length));
      }
      return keys;
    } catch (_) { return []; }
  }

  // ---------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------
  function csvEscape(v) {
    const s = (v == null) ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvParse(text) {
    const src = String(text).replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', q = false, i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (q) {
        if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"') { q = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }
  const fmtNum = (v) => (num(v) == null) ? '' : String(round4(v));
  const fmtZ = (v) => (num(v) == null) ? '' : v.toFixed(1);

  /**
   * 輸出與「刀具資料 CSV」相容的 CSV（含 BOM）。
   * @param {ToolTable} table
   * @param {{details?:ReturnType<inferDetails>, run?:Run, tok?:TokenizeResult, notes?:Object<number,string>}} [opts]
   *   details 或 run+tok 提供時可填「用途 / 最深Z / 用到的D號」；否則留空。
   */
  function toCSV(table, opts) {
    opts = opts || {};
    const details = opts.details || ((opts.run || opts.tok) ? inferDetails(opts.tok || null, opts.run || null) : []);
    const detailOf = (t) => details.find((d) => d.t === t) || null;
    const offsets = offsetsOf(table);
    const lines = [CSV_HEADER.join(',')];
    for (const tool of toolsOf(table)) {
      const d = detailOf(tool.t);
      const comment = (d && d.comment) ? d.comment : (tool.label !== `T${tool.t}` ? tool.label : '');
      const dList = d ? d.dList : [];
      const usage = d ? (d.hasComp ? 'G41' : '面銑/一般切削') : '';
      const userVal = (f) => (tool.source && tool.source[f] === 'user') ? tool[f] : null;
      const userType = (tool.source && tool.source.type === 'user') ? TYPE_NAMES[tool.type] || tool.type : '';
      const compVals = dList.map((n) => {
        const o = offsets.find((e) => e.n === n);
        if (!o || o.source !== 'user') return null;
        return `D${n}=${round4(o.radGeom)}` + (o.radWear ? `/${round4(o.radWear)}` : '');
      }).filter(Boolean).join('；');
      const guessType = (tool.source && tool.source.type === 'user') ? '' : (TYPE_NAMES[tool.type] || '?');
      const guessDia = (tool.source && tool.source.diameter === 'user') ? '' : fmtNum(tool.diameter);
      const note = (opts.notes && opts.notes[tool.t] != null) ? opts.notes[tool.t] : (tool.probe ? '無註解且無切削，可能是定位器刀位' : '');
      lines.push([
        table.programKey || '', `T${tool.t}`, comment, guessType, guessDia, usage, fmtZ(d ? d.zMin : null),
        userType, fmtNum(userVal('diameter')), fmtNum(userVal('angle')), fmtNum(userVal('fluteLen')), fmtNum(userVal('stickout')),
        fmtNum(userVal('cornerRad')), fmtNum(userVal('neckDia')),
        dList.map((n) => `D${n}`).join(','), compVals, note,
      ].map(csvEscape).join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /**
   * 讀入 CSV → ToolTable。programKey 指定時只取該程式的列；否則取全部（programKey = 第一列的程式）。
   * 「請填_」欄位有值 → 該欄位 source='user'；否則用推測欄位。
   */
  function fromCSV(str, programKey) {
    const rows = csvParse(str);
    if (!rows.length) return { programKey: programKey || '', tools: [], offsets: [], updatedAt: new Date().toISOString() };
    const header = rows[0].map((h) => h.trim());
    const col = {};
    header.forEach((h, i) => { col[h] = i; });
    const get = (r, name) => { const i = col[name]; return (i == null || r[i] == null) ? '' : String(r[i]).trim(); };
    const hasHeader = col['T'] != null;
    const dataRows = hasHeader ? rows.slice(1) : rows;
    if (!hasHeader) CSV_HEADER.forEach((h, i) => { col[h] = i; });
    const tools = [], offsets = [];
    let key = programKey || '';
    for (const r of dataRows) {
      const prog = get(r, '程式');
      if (programKey && prog && prog !== programKey) continue;
      if (!key) key = prog;
      const t = toNum(get(r, 'T').replace(/^T/i, ''));
      if (t == null) continue;
      const comment = get(r, '程式註解');
      const parsed = parseComment(comment);
      const tool = {
        t, label: comment || `T${t}`, type: 'unknown', diameter: DEFAULT_DIAMETER,
        angle: null, fluteLen: null, stickout: null, pitch: null, cornerRad: null, neckDia: null,
        resident: false, probe: false,
        source: { label: comment ? 'comment' : 'default', type: 'default', diameter: 'default' },
      };
      const guessType = normalizeType(get(r, '推測型式'));
      if (parsed.type !== 'unknown') { tool.type = parsed.type; tool.source.type = 'comment'; }
      else if (guessType !== 'unknown') { tool.type = guessType; tool.source.type = 'comment'; }
      const guessDia = toNum(get(r, '推測直徑mm'));
      if (num(parsed.diameter) != null) { tool.diameter = parsed.diameter; tool.source.diameter = 'comment'; }
      else if (guessDia != null) { tool.diameter = guessDia; tool.source.diameter = 'comment'; }
      if (num(parsed.pitch) != null) { tool.pitch = parsed.pitch; tool.source.pitch = 'comment'; }
      if (num(parsed.cornerRad) != null) { tool.cornerRad = parsed.cornerRad; tool.source.cornerRad = 'comment'; }
      const uType = get(r, '請填_型式確認');
      if (uType && normalizeType(uType) !== 'unknown') { tool.type = normalizeType(uType); tool.source.type = 'user'; }
      const uFields = [['請填_直徑mm', 'diameter'], ['請填_刀尖或倒角角度', 'angle'], ['請填_刃長mm', 'fluteLen'],
        ['請填_伸出長mm', 'stickout'], ['請填_角R半徑mm', 'cornerRad'], ['請填_頸徑mm', 'neckDia']];
      for (const [name, f] of uFields) {
        const v = toNum(get(r, name));
        if (v != null) { tool[f] = v; tool.source[f] = 'user'; }
      }
      if (!comment && get(r, '推測型式') === '?' && guessDia == null) tool.probe = true;
      tool.resident = (t === 20 || tool.type === 'facemill');
      tool.source.resident = 'default'; tool.source.probe = 'default';
      applyDefaults(tool);
      if (tool.source.type === 'user' && tool.source.angle !== 'user') {
        // 型式由使用者改過 → 角度預設重算
        tool.angle = defaultAngleOf(tool.type);
      }
      tools.push(tool);
      // 補正值：D2=5.0000（只有形狀）／D3=4.985/0.01（形狀/摩耗）
      const comp = get(r, '請填_各D補正值');
      const re = /D\s*(\d+)\s*=\s*([+-]?\d+\.?\d*)(?:\s*\/\s*([+-]?\d+\.?\d*))?/gi;
      let m;
      while ((m = re.exec(comp))) {
        const n = parseInt(m[1], 10);
        const entry = { n, lenGeom: 0, lenWear: 0, radGeom: parseFloat(m[2]), radWear: m[3] ? parseFloat(m[3]) : 0, source: 'user' };
        const i = offsets.findIndex((e) => e.n === n);
        if (i >= 0) offsets[i] = entry; else offsets.push(entry);
      }
      // 用到的 D 號但沒填補正值 → 預設半徑
      for (const dm of get(r, '用到的D號').matchAll(/D\s*(\d+)/gi)) {
        const n = parseInt(dm[1], 10);
        if (!offsets.some((e) => e.n === n)) offsets.push({ n, lenGeom: 0, lenWear: 0, radGeom: round4(tool.diameter / 2), radWear: 0, source: 'default' });
      }
    }
    // 同 T 只留第一列
    const seen = new Set();
    const uniq = tools.filter((x) => (seen.has(x.t) ? false : (seen.add(x.t), true)));
    return { programKey: key, tools: uniq, offsets: offsets.sort((a, b) => a.n - b.n), updatedAt: new Date().toISOString() };
  }

  NC.tools = {
    STORAGE_PREFIX, TYPE_INFO, TYPE_NAMES, TYPE_ALIASES, TOOL_TYPES, CSV_HEADER, defaultAngleOf,
    parseComment, inferTools, inferDetails, effectiveRadius, defaultOffsets, mergeOffsets,
    estimateStock, mergeUserTable, buildTable, normalizeTable,
    save, load, remove, listSaved, setStorage, exportJSON, importJSON, toCSV, fromCSV,
  };
})(globalThis.NC = globalThis.NC || {});
