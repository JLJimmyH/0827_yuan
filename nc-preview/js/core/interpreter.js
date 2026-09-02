/*
 * NC 預演台 — interpreter.js
 * NC.interpret(blocks, settings, scenario) → Run
 * 逐節執行 Fanuc 模態、產生 Action、切分 Operation，並負責 CONTRACT §2 列出的診斷：
 * R02 R03 R04 R08 R09 R13 R16 R17 R18 R21 R22(部分) R23 R32。
 */
(function (NC) {
  'use strict';

  const U = NC.util;
  const EPS = NC.EPS || 1e-6;
  /**
   * R 指定圓弧的半徑誤差容許量（mm）。
   * Fanuc 是靠參數 3410（出廠常見 0.01–0.1 mm）判定，不是浮點容差；
   * CAM 把終點四捨五入到小數三位就會多／少個 0.001 mm，用 1e-6 判會把正常程式判成 PS0020。
   * settings.arcRadiusTolMm 可覆寫（現場要對 3410 時用）。
   */
  const ARC_R_TOL = 0.01;

  // ---------------------------------------------------------------------------
  // G / M 碼表
  // ---------------------------------------------------------------------------
  /** G 碼 → 群組編號（0 = 單節） */
  const G_GROUP = {
    G0: 1, G1: 1, G2: 1, G3: 1,
    G17: 2, G18: 2, G19: 2,
    G90: 3, G91: 3,
    G94: 5, G95: 5,
    G20: 6, G21: 6,
    G40: 7, G41: 7, G42: 7,
    G43: 8, G44: 8, G49: 8,
    G73: 9, G74: 9, G76: 9, G80: 9, G81: 9, G82: 9, G83: 9, G84: 9, G85: 9, G86: 9, G87: 9, G88: 9, G89: 9,
    G98: 10, G99: 10,
    G54: 12, G55: 12, G56: 12, G57: 12, G58: 12, G59: 12,
    G4: 0, G28: 0, G30: 0, G53: 0, 'G05.1': 0, G10: 0, G92: 0,
  };
  const GROUP_NAME = { 0: '單節', 1: '移動', 2: '平面', 3: '絕對／增量', 5: '進給模式', 6: '單位', 7: '刀徑補正', 8: '刀長補正', 9: '固定循環', 10: '循環回歸', 12: '工件座標系' };
  const KNOWN_M = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 19, 29, 30, 98, 99]);

  /**
   * 0i-D／30i-B 加工中心標配、但本工具不模擬的 G 碼。
   * 這些碼在實機上完全合法，不能報 PS0010 error（現場第一眼滿江紅就不會再信這個工具）。
   *   sev        info = 路徑完全不受影響；warning = 路徑會和實機不同
   *   blocksMotion  本節的座標字不是移動指令（是旋轉中心、巨集引數、比例中心…），
   *                 不可以拿去產生移動，否則會多畫一條幽靈路徑外加一堆連鎖假警報
   */
  const UNSUPPORTED_G = {
    G9:      { sev: 'info', msg: 'G09 單節精確停止：本工具不模擬，它只影響轉角減速，路徑與預演相同' },
    G61:     { sev: 'info', msg: 'G61 精確停止模式：本工具不模擬，它只影響轉角減速，路徑與預演相同' },
    G62:     { sev: 'info', msg: 'G62 自動轉角進給調整：本工具不模擬，它只影響轉角進給，路徑與預演相同' },
    G63:     { sev: 'info', msg: 'G63 攻牙模式：本工具不模擬，它只影響進給倍率鎖定，路徑與預演相同' },
    G64:     { sev: 'info', msg: 'G64 切削模式（連續切削）：本工具不模擬，它只影響轉角減速，路徑與預演相同' },
    G8:      { sev: 'info', msg: 'G08 先讀控制：本工具不模擬，它只影響加減速，路徑與預演相同' },
    G5:      { sev: 'warning', msg: 'G05 高速加工模式本工具不模擬', blocksMotion: true },
    G15:     { sev: 'info', msg: 'G15 極座標指令取消：之後的座標恢復成直角座標，預演與實機一致' },
    G16:     { sev: 'warning', msg: 'G16 極座標指令本工具不模擬：從這一行到 G15 之間的 X/Y 是「半徑／角度」，預演會照直角座標畫，路徑與實機不同' },
    G68:     { sev: 'warning', msg: 'G68 座標旋轉本工具不模擬：從這一行到 G69 之間的路徑會和實機不同（實機會整段轉一個角度）', blocksMotion: true },
    G69:     { sev: 'info', msg: 'G69 座標旋轉取消：之後的路徑恢復成預演畫得出來的樣子' },
    G65:     { sev: 'warning', msg: 'G65 巨集呼叫本工具不展開：被呼叫的那段路徑沒有預演，素材與碰撞結果不完整', blocksMotion: true },
    G66:     { sev: 'warning', msg: 'G66 巨集模態呼叫本工具不展開：之後每個移動節都會多做一次巨集，那些路徑沒有預演', blocksMotion: true },
    G67:     { sev: 'info', msg: 'G67 巨集模態呼叫取消：之後的移動節不再夾帶巨集' },
    G50:     { sev: 'info', msg: 'G50 比例縮放取消：之後的尺寸恢復成程式上的尺寸' },
    G51:     { sev: 'warning', msg: 'G51 比例縮放本工具不模擬：從這一行到 G50 之間的尺寸會和實機不同', blocksMotion: true },
    'G50.1': { sev: 'info', msg: 'G50.1 可程式鏡像取消：之後的路徑恢復成程式上的方向' },
    'G51.1': { sev: 'warning', msg: 'G51.1 可程式鏡像本工具不模擬：從這一行到 G50.1 之間的路徑左右／前後相反', blocksMotion: true },
    'G54.1': { sev: 'warning', msg: 'G54.1 附加工件座標系（P__）的偏置本工具不套用，路徑以 G54 原點顯示' },
    G52:     { sev: 'warning', msg: 'G52 局部座標系本工具不模擬：之後的座標會整體平移，路徑與實機不同', blocksMotion: true },
    'G07.1': { sev: 'warning', msg: 'G07.1 圓筒插補本工具不模擬：這一段是繞著旋轉軸展開的路徑，預演畫不出來', blocksMotion: true },
    G31:     { sev: 'warning', msg: 'G31 跳躍機能：實機會在收到訊號（碰觸感測器）時提早停止，預演一律畫到程式終點', skipMotion: 'G1' },
    'G84.2': { sev: 'warning', msg: 'G84.2 剛性攻牙（另一種格式）本工具不展開成孔動作', blocksMotion: true },
    'G84.3': { sev: 'warning', msg: 'G84.3 剛性左螺紋攻牙（另一種格式）本工具不展開成孔動作', blocksMotion: true },
  };
  const UNSUPPORTED_DETAIL = '這個 G 碼在 0i-D／30i-B 加工中心上是合法的，機台不會警報；只是本預演台不模擬它的效果。'
    + '要確認這一段的實際路徑，請以機台的圖形檢查或實際試切為準。';

  /** 取回重複次數（固定循環的 K，M 系列；部分程式寫 L） */
  function repeatCount(has, val) {
    if (has('K')) return val('K');
    if (has('L')) return val('L');
    return null;
  }
  const AXES = ['X', 'Y', 'Z'];
  const AXIS_KEY = { X: 'x', Y: 'y', Z: 'z' };
  /**
   * 第四軸（旋轉軸）。本版只做 CONTRACT §13 的「層次一」：
   * 讀進角度、標在每個動作上、供 rules 檢查，但**不做工件旋轉的座標轉換**——
   * 路徑一律照程式的 XYZ 畫。轉換要等「分度視圖」（層次二）。
   * 位址固定 A（照現場的臥式分度頭，繞 X 軸）；B／C 出現時只警告不模擬。
   */
  const ROT_AXIS = 'A';
  const OTHER_ROT = ['B', 'C'];

  /** G 字組 value → 正規化名稱：0 → 'G0'、5.1 → 'G05.1' */
  function gName(v) {
    if (Number.isInteger(v)) return 'G' + v;
    const i = Math.floor(v);
    const frac = Math.round((v - i) * 10);
    return 'G' + String(i).padStart(2, '0') + '.' + frac;
  }

  function cloneState(s) {
    return {
      motion: s.motion, distance: s.distance, plane: s.plane, units: s.units, feedMode: s.feedMode, wcs: s.wcs,
      comp: s.comp, d: s.d, lengthComp: s.lengthComp, h: s.h,
      cycle: s.cycle ? Object.assign({}, s.cycle) : null,
      retractMode: s.retractMode, feed: s.feed,
      spindle: { dir: s.spindle.dir, rpm: s.spindle.rpm },
      coolant: s.coolant, toolInSpindle: s.toolInSpindle, toolStaged: s.toolStaged,
      aicc: s.aicc, rigidTap: s.rigidTap, rigidTapS: s.rigidTapS,
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      a: s.a,
      lengthCompActive: s.lengthCompActive,
    };
  }

  function initialState(settings) {
    const ref = settings.refPosition || { x: 0, y: 0, z: 150 };
    return {
      motion: null, distance: 'G90', plane: 'G17', units: 'G21', feedMode: 'G94', wcs: 'G54',
      comp: 'G40', d: 0, lengthComp: 'G49', h: 0, cycle: null, retractMode: 'G98', feed: null,
      spindle: { dir: 'M5', rpm: null }, coolant: false, toolInSpindle: null, toolStaged: null,
      aicc: false, rigidTap: false, rigidTapS: null,
      pos: { x: ref.x, y: ref.y, z: ref.z }, a: 0, lengthCompActive: false,
    };
  }

  function newOp(index, line, tool, comment) {
    return {
      index, tool, toolComment: comment, h: null, dList: [], lineStart: line, lineEnd: line,
      zMin: null, feeds: [], rpms: [], gCodes: [], kindGuess: 'unknown',
      // 內部統計（最後會刪掉）
      _hasLinear: false, _hasHole: false, _hasComp: false, _zAtStart: 0, _r16: false,
    };
  }

  function pushUnique(arr, v) { if (arr.indexOf(v) < 0) arr.push(v); }

  /** 節的全部字組（含節中斜線之後的），程式層統計用 */
  function allWords(b) {
    return (b.tailWords && b.tailWords.length) ? b.words.concat(b.tailWords) : b.words;
  }
  /**
   * 這一節這次要執行的字組。
   * Fanuc：斜線不在節首時，只有 block skip 開關「開」才忽略斜線到 EOB 的內容；
   * 開關「關」時整節照跑（情境 off／multiIgnored 都算開關關）。
   */
  function blockWords(b, ctx) {
    if (!b.tailWords || !b.tailWords.length) return b.words;
    return ctx.scenario === 'on' ? b.words : b.words.concat(b.tailWords);
  }

  // ---------------------------------------------------------------------------
  // 主流程
  // ---------------------------------------------------------------------------
  /**
   * @param {Block[]|TokenizeResult} blocks
   * @param {MachineSettings} settings
   * @param {SkipScenario} scenario
   * @returns {Run}
   */
  function interpret(blocks, settings, scenario) {
    if (blocks && !Array.isArray(blocks) && Array.isArray(blocks.blocks)) blocks = blocks.blocks;
    blocks = blocks || [];
    settings = Object.assign(U.defaultSettings(), settings || {});
    scenario = scenario || 'off';

    const ctx = {
      settings, scenario,
      state: initialState(settings),
      diags: [],
      ops: [],
      opIndex: -1,
      op: null,
      compStartPending: false,
      compEndPending: false,
      m29Armed: false,        // R21：M29 之後、G84 之前
      m29Line: 0,
      cycleFirstCheck: false, // 循環啟動後第一個孔要檢查 Z/R
      cycleQReported: false,
      hasM30: false,
      hasO: false,
      seenMotionWithoutMode: false,
      r08Reported: false,     // R08：同一個「沒有 F」狀態只報一次（設 F 或換刀後重置）
      opClosed: false,        // 已遇到 M30/M02，之後的節不再算進最後一個作業
      midSlashLines: new Set(),
      polar: false,
      otherRotReported: false, // B／C 軸「本版不支援」整支只報一次
      sawRotWord: false,       // 程式裡真的出現過 A 字組（動作一律帶 a=0，不能拿它判斷）
    };

    const executed = new Array(blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const before = cloneState(ctx.state);
      const eb = { line: b.line, skipped: false, ignored: false, before, after: before, actions: [], opIndex: ctx.opIndex };
      executed[i] = eb;

      // 節中斜線：開關關閉時實機會執行斜線後面的內容，所以字組要依情境合併（見 blockWords）
      if (b.tailWords && b.tailWords.length && !ctx.midSlashLines.has(b.line)) {
        ctx.midSlashLines.add(b.line);
        const tailText = String(b.tailIgnored || '').replace(/^\/+/, '').trim();
        ctx.diags.push(U.diag('R02', b.line, 'info', `這節中間有斜線，斜線後面的「${tailText}」只有在 block skip 開關「關」的時候才會執行`,
          { detail: 'Fanuc 的規則：斜線不在節首時，開關「開」才忽略斜線到行尾的內容，開關「關」整節照跑。'
            + '本預演台兩種情境都照這個規則跑，情境切成「開關開」就會看到少掉這一段的結果。'
            + '這種寫法很容易被誤讀，建議把它拆成獨立的一節。' }));
      }

      // 程式層面的統計（不論是否執行）
      if (!b.isEmpty) {
        for (const w of allWords(b)) {
          if (w.addr === 'O') ctx.hasO = true;
          if (w.addr === 'M' && (w.value === 30 || w.value === 2)) {
            ctx.hasM30 = true;
            if (b.slashes > 0) {
              ctx.diags.push(U.diag('R32', b.line, 'warning', `M${w.value} 放在「/」節裡，block skip 開啟時程式不會正常結束`,
                { detail: '程式結束碼被跳過時，控制器會一路執行到檔尾並發警報或停在奇怪的地方。建議把 M30 移到沒有斜線的節。' }));
            }
          }
        }
      }

      // 情境判定
      const wasClosed = ctx.opClosed;   // M30 那一節本身仍算在最後一個作業裡
      const decision = decide(b, ctx);
      if (decision === 'skip') { eb.skipped = true; }
      else if (decision === 'ignore') { eb.ignored = true; }

      if (decision === 'run' && !b.isEmpty) {
        execBlock(b, ctx, eb);
        eb.after = cloneState(ctx.state);
      }
      eb.opIndex = ctx.opIndex;
      // 只有「真的屬於這個作業」的節才延伸行號範圍：M30 之後的空行與檔尾的 % 不算
      // （否則作業摘要的行號範圍會多吃兩行，「跳到這個作業」也會捲錯位置）
      if (ctx.op && !b.isEmpty && !wasClosed) ctx.op.lineEnd = b.line;
    }

    finishProgramChecks(blocks, ctx);
    const ops = ctx.ops.map(finalizeOp);

    return {
      scenario,
      executed,
      ops,
      diagnostics: ctx.diags,
      finalState: cloneState(ctx.state),
      rotary: summarizeRotary(executed, ctx.sawRotWord),
    };
  }

  /**
   * 第四軸摘要。UI 與 rules（R37）都靠它判斷這支程式該怎麼看待。
   * mode：
   *   'none'          沒有用到 A
   *   'index'         只有分度——轉到角度停住再切。這種可以逐面看，資訊仍然有用。
   *   'simultaneous'  有「A 與 XYZ 同時進給」的節，是真正的四軸插補（螺旋槽、凸輪）。
   *                   這種本工具連路徑都畫不出來，一定要講清楚。
   */
  function summarizeRotary(executed, used) {
    const angles = [];
    const rotateLines = [];  // 第四軸有轉動的行
    const simLines = [];     // A 與 XYZ 同時進給（真四軸）的行
    if (!used) return { used: false, axis: ROT_AXIS, mode: 'none', angles: [], rotateLines: [], simLines: [] };
    for (const eb of executed) {
      if (!eb || !eb.actions || !eb.actions.length) continue;
      for (const act of eb.actions) {
        if (act.a === undefined) continue;
        pushUnique(angles, act.a);
        if (act.aFrom === undefined) continue;
        pushUnique(rotateLines, eb.line);
        // 只有「XYZ 和 A 真的同時進給」才算四軸插補（螺旋槽、凸輪）。
        // G1 模態下單獨轉 A（G1A90.F500.）是旋轉進給，路徑上仍然是分度；
        // 危不危險由「轉動時刀尖在什麼高度」那條規則判，不必把整支標成畫不出來。
        // 固定循環的「轉到位再鑽」更是分度，不算。
        if (act.kind === 'linear' || act.kind === 'arc') pushUnique(simLines, eb.line);
      }
    }
    angles.sort((p, q) => p - q);
    return {
      used: true, axis: ROT_AXIS,
      mode: simLines.length ? 'simultaneous' : 'index',
      angles, rotateLines, simLines,
    };
  }

  /** 依情境決定節要 run / skip / ignore */
  function decide(b, ctx) {
    const { scenario, settings } = ctx;
    if (scenario === 'off') return 'run';
    if (scenario === 'multiIgnored') {
      return b.slashes >= 2 ? 'ignore' : 'run';
    }
    // on
    if (b.slashes === 0) return 'run';
    if (b.slashes >= 2) {
      const mode = settings.multiSlash || 'asSingle';
      if (mode === 'ignoreBlock') return 'ignore';
      if (mode === 'alarm') return 'run';
      // asSingle：視同 /
      return (settings.skipLevelsOn || [1]).indexOf(1) >= 0 ? 'skip' : 'run';
    }
    return (settings.skipLevelsOn || [1]).indexOf(b.skipLevel) >= 0 ? 'skip' : 'run';
  }

  // ---------------------------------------------------------------------------
  // 單節執行
  // ---------------------------------------------------------------------------
  function execBlock(b, ctx, eb) {
    const st = ctx.state;
    const diags = ctx.diags;
    const settings = ctx.settings;
    const line = b.line;
    const actions = eb.actions;

    // ---- 整理字組 ----
    const last = {};       // 位址 → 最後一個 Word
    const gNames = [];     // 本節所有 G（正規化名稱）
    const mCodes = [];     // 本節所有 M
    const commas = [];
    const words = blockWords(b, ctx);
    for (const w of words) {
      if (w.comma) { commas.push(w); continue; }
      if (w.addr === 'G') gNames.push(gName(w.value));
      else if (w.addr === 'M') mCodes.push(w.value);
      else last[w.addr] = w;
    }
    const has = (a) => Object.prototype.hasOwnProperty.call(last, a);
    const val = (a) => last[a].value;

    // ---- G 群組解析（R02 未知 G、R03 同群組重複） ----
    const groups = {};
    let blocksMotion = false;   // 本節的座標字不是移動指令（G68 旋轉中心、G65 巨集引數…）
    let forcedMotion = null;    // G31 之類要當成特定移動模式處理
    for (const name of gNames) {
      const grp = G_GROUP[name];
      if (grp === undefined) {
        const known = UNSUPPORTED_G[name];
        if (known) {
          // 合法但本工具不模擬 → warning／info，絕不報 PS0010
          diags.push(U.diag('R02', line, known.sev, known.msg,
            { detail: UNSUPPORTED_DETAIL + (known.blocksMotion ? '\n這一節的座標字是這個指令的參數（不是移動終點），預演不會產生移動。' : '') }));
          if (known.blocksMotion) blocksMotion = true;
          if (known.skipMotion) forcedMotion = known.skipMotion;
          if (name === 'G16') ctx.polar = true;
          if (name === 'G15') ctx.polar = false;
          continue;
        }
        diags.push(U.diag('R02', line, 'error', `查不到這個 G 碼「${name}」`,
          { detail: '常見的 0i／30i 加工中心 G 碼表裡沒有這個碼，多半是打錯（例如 G1 打成 G01. 或 G100）；'
            + '若真的沒有這個碼，執行到這節機台會發 PS0010 警報停機。'
            + '\n預演不知道這節的座標字代表什麼，因此不產生移動，這一段路徑等於沒有預演。'
            + '\n如果這是機台廠選配功能的指令，請忽略這一則。', fanucAlarm: 'PS0010' }));
        blocksMotion = true;
        continue;
      }
      if (groups[grp] !== undefined && groups[grp] !== name) {
        diags.push(U.diag('R03', line, 'warning', `同一節有兩個以上同群組（${GROUP_NAME[grp]}）的 G 碼：${groups[grp]} 與 ${name}，以後者 ${name} 為準`,
          { detail: 'Fanuc 同群組 G 碼同節出現時最後一個有效，前面的等於沒寫。請確認意圖，避免誤讀。' }));
      }
      groups[grp] = name;
    }
    const g01 = groups[1];
    let g09 = groups[9];
    const g00 = groups[0];
    const isG04 = g00 === 'G4';
    const isG051 = g00 === 'G05.1';

    // 群組 01 與固定循環同節 → 循環取消（R18 warning）
    if (g01 && g09 && g09 !== 'G80') {
      diags.push(U.diag('R18', line, 'warning', `${g01} 與固定循環 ${g09} 寫在同一節，循環會被取消、不會鑽孔`,
        { detail: 'Fanuc 規定群組 01（G0–G3）會取消固定循環；同節出現時循環無效，這節只做一般移動。請把循環另起一節。' }));
      g09 = undefined;
      st.cycle = null;
      ctx.m29Armed = false;
    }

    // ---- R04：無小數點（dpi=false） ----
    // 只查「值是 mm 距離」的位址。固定循環的 K／L 是重複次數、G68 的 R 是角度、
    // 巨集引數不是座標，這些加了小數點反而不對，查了就是叫現場去改本來就對的程式。
    const cycleHere = !!st.cycle || !!(g09 && g09 !== 'G80');
    const motionNow = g01 || st.motion;
    const arcHere = !cycleHere && (motionNow === 'G2' || motionNow === 'G3');
    if (!settings.dpi && !blocksMotion) {
      for (const w of words) {
        if (w.hasDecimal || w.value === 0) continue;
        const a = w.addr;
        if (w.comma) {
          // ,C1／,R2 的值也是 mm 距離：DPI=0 時 ,C1 是 0.001 mm 的倒角（等於沒倒）
          const what = a === 'C' ? '倒角' : '圓角';
          diags.push(U.diag('R04', line, 'warning', `${w.raw} 沒有小數點，機台會讀成 ${U.fmt(w.value / 1000, 3)} mm 的${what}（等於沒有${what}）`,
            { detail: '設定 3401#0 DPI=0（最小輸入單位）時，沒有小數點的數值以 0.001 為單位。請寫成 ,' + a + U.fmt(w.value) + '. 。' }));
          continue;
        }
        if (a === ROT_AXIS) {
          // 旋轉軸的最小輸入單位一樣吃 3401#0：DPI=0 時 A90 讀成 0.09 度，
          // 工件等於完全沒轉，四個分度面會全部鑽在同一個位置。
          diags.push(U.diag('R04', line, 'warning', `${w.raw} 沒有小數點，機台會讀成 ${U.fmt(w.value / 1000, 3)} 度（第四軸幾乎等於沒轉）`,
            { detail: '設定 3401#0 DPI=0（最小輸入單位）時，沒有小數點的數值以 0.001 為單位——旋轉軸也一樣。'
              + `A${U.fmt(w.value)} 會被讀成 ${U.fmt(w.value / 1000, 3)} 度，分度等於沒做，所有角度的加工會疊在同一面上。`
              + `請寫成 A${U.fmt(w.value)}. 。預演仍以 ${U.fmt(w.value, 3)} 度計算。` }));
          continue;
        }
        let hit = false;
        if (a === 'X' || a === 'Y' || a === 'Z') hit = true;
        else if (a === 'I' || a === 'J') hit = arcHere;                       // 圓心偏移只在圓弧節才是距離
        else if (a === 'K') hit = arcHere && st.plane !== 'G17';              // G17 的 K 不是距離；循環的 K 是重複次數
        else if (a === 'R') hit = arcHere || cycleHere;                       // 圓弧半徑或循環 R 點
        else if (a === 'Q' && !isG051 && cycleHere) hit = true;
        if (!hit) continue;
        if (isG04 && a === 'X') {
          diags.push(U.diag('R04', line, 'warning', `G4 的 ${w.raw} 沒有小數點，機台會讀成 ${U.fmt(w.value / 1000, 3)} 秒`,
            { detail: '設定 3401#0 DPI=0（最小輸入單位）時，沒有小數點的數值以 0.001 為單位。請加上小數點（例如 X1.）。預演也照 '
              + U.fmt(w.value / 1000, 3) + ' 秒計算。' }));
          continue;
        }
        diags.push(U.diag('R04', line, 'warning', `${w.raw} 沒有小數點，機台會讀成 ${U.fmt(w.value / 1000, 3)} mm`,
          { detail: '設定 3401#0 DPI=0（最小輸入單位）時，X65 = 0.065 mm 而不是 65 mm，路徑會完全不同。預演仍以 ' + U.fmt(w.value, 3) + ' mm 計算。請加上小數點。' }));
      }
    }

    // ---- 1. 套用非移動模態 ----
    if (groups[3]) st.distance = groups[3];
    if (groups[2] && groups[2] !== st.plane) {
      if (st.comp !== 'G40' && groups[7] !== 'G40') {
        diags.push(U.diag('R13', line, 'error', `刀徑補正（${st.comp}）生效中切換平面（${groups[2]}）`,
          { detail: '補正中不可切換平面，機台會發 PS0037 警報。請先 G40 取消補正。', fanucAlarm: 'PS0037' }));
      }
      st.plane = groups[2];
    }
    if (groups[5]) st.feedMode = groups[5];
    if (groups[6]) st.units = groups[6];
    if (groups[12]) st.wcs = groups[12];
    if (groups[10]) st.retractMode = groups[10];
    if (g01) {
      st.motion = g01;
      // G0–G3 取消固定循環（無 G8x 同節時靜默取消）
      if (st.cycle && !g09) { st.cycle = null; }
    }
    // M 碼狀態部分
    const mSet = new Set(mCodes);
    for (const m of mCodes) {
      if (!KNOWN_M.has(m)) {
        diags.push(U.diag('R02', line, 'info', `M${m} 不在常見 M 碼表中`,
          { detail: '預演不模擬這個 M 碼的效果；若是機台廠自訂功能請忽略。' }));
      }
    }
    // M98／M99：副程式呼叫。本工具不展開，但一定要講出來——
    // 一支「同樣孔群呼叫 5 次」的程式如果靜靜地被吃掉，畫面上會顯示「沒有錯誤」，
    // 但素材、最深 Z、碰撞、時間全部是錯的，這比任何誤報都危險。
    if (mSet.has(98)) {
      const pNo = has('P') ? val('P') : null;
      const rep = has('L') ? val('L') : 1;
      const name = pNo == null ? '（沒有寫 P，機台會發警報）' : 'O' + String(Math.round(pNo));
      actions.push({ kind: 'subCall', program: pNo, repeat: rep });
      diags.push(U.diag('R02', line, 'warning', `M98 呼叫副程式 ${name}${rep > 1 ? ` ${rep} 次` : ''}，本工具不展開，這一段路徑沒有預演`,
        { detail: '副程式裡的移動沒有被讀到，所以素材模型、最深 Z、碰撞檢查與時間估算都不完整——'
          + '這一支要整支確認，還是得靠機台的圖形檢查或試切。'
          + '\n若要在這裡看到完整路徑，可以把副程式的內容貼進主程式（把 M98 那一行換成副程式本體）再分析一次。' }));
    }
    if (mSet.has(99)) {
      diags.push(U.diag('R02', line, 'info', 'M99 是副程式結束（返回呼叫端），本工具不展開副程式',
        { detail: '如果這一行出現在主程式裡，代表這支檔案本身是副程式，要配合主程式才看得出完整路徑。' }));
    }
    if (mSet.has(3)) st.spindle.dir = 'M3';
    if (mSet.has(4)) st.spindle.dir = 'M4';
    if (mSet.has(5)) st.spindle.dir = 'M5';
    if (mSet.has(8) || mSet.has(7)) st.coolant = true;
    if (mSet.has(9)) st.coolant = false;

    // G05.1（AICC）
    if (isG051) {
      const q = has('Q') ? val('Q') : null;
      const on = q === 1 ? true : q === 0 ? false : null;
      if (on === null) {
        diags.push(U.diag('R02', line, 'error', 'G05.1 需要 Q1（開）或 Q0（關）',
          { detail: '沒有 Q 或 Q 值不是 0/1，機台會發 PS0010 類警報。', fanucAlarm: 'PS0010' }));
      } else {
        st.aicc = on;
        actions.push({ kind: 'aicc', on });
      }
    }

    // ---- 2./3. M6 與 T ----
    if (mSet.has(6)) {
      if (st.comp !== 'G40') {
        diags.push(U.diag('R13', line, 'error', `刀徑補正（${st.comp}）生效中換刀（M6）`,
          { detail: '補正未取消就換刀，機台可能發 PS0041／PS0037 或以錯誤補正量繼續切削。請在 M6 前先 G40。', fanucAlarm: 'PS0041' }));
      }
      const t = has('T') ? val('T') : st.toolStaged;
      st.toolInSpindle = t;
      st.toolStaged = null;
      st.lengthCompActive = false;
      actions.push({ kind: 'toolchange', tool: t });
      // 新作業
      const op = newOp(ctx.ops.length, line, t == null ? null : t, b.comment);
      op._zAtStart = st.pos.z;
      ctx.r08Reported = false;
      ctx.ops.push(op);
      ctx.op = op;
      ctx.opIndex = op.index;
    } else if (has('T')) {
      st.toolStaged = val('T');
    }
    const op = ctx.op;
    if (op) for (const n of gNames) pushUnique(op.gCodes, n);

    // F / S / D / H 模態（統計歸到目前作業）
    if (has('F')) { st.feed = val('F'); ctx.r08Reported = false; if (op) pushUnique(op.feeds, st.feed); }
    if (has('S')) { st.spindle.rpm = val('S'); if (op) pushUnique(op.rpms, st.spindle.rpm); }
    if (has('D')) { st.d = val('D'); if (op) pushUnique(op.dList, st.d); }
    if (has('H')) { st.h = val('H'); if (op) op.h = st.h; }

    // ---- 刀徑補正（群組 07） ----
    if (groups[7]) {
      const code = groups[7];
      if (code === 'G40') {
        if (st.comp !== 'G40') ctx.compEndPending = true;
        st.comp = 'G40';
      } else {
        const d = has('D') ? val('D') : st.d;
        if (!d || d <= 0) {
          diags.push(U.diag('R09', line, 'error', `${code} 啟動補正但 D 號是 0（沒有指定 D）`,
            { detail: 'D0 代表補正量 0，機台會發 PS0030 警報或以零補正走程式尺寸。請補上 D 號（如 D11）。', fanucAlarm: 'PS0030' }));
        } else if (d > settings.maxOffsets) {
          diags.push(U.diag('R09', line, 'error', `D${d} 超過補正組數上限（${settings.maxOffsets}）`,
            { detail: '機台會發 PS0030 警報。請確認 D 號或機台補正組數設定。', fanucAlarm: 'PS0030' }));
        }
        if (st.comp !== code) ctx.compStartPending = true;
        st.comp = code;
        if (op) op._hasComp = true;
      }
      if (st.motion === 'G2' || st.motion === 'G3') {
        diags.push(U.diag('R09', line, 'error', `${code} 在圓弧模式（${st.motion}）下啟動／取消補正`,
          { detail: '補正的啟動與取消只能在 G0/G1 節，機台會發 PS0034 警報。請改成直線節再啟動／取消。', fanucAlarm: 'PS0034' }));
      }
    }

    // ---- 刀長補正（群組 08） ----
    if (groups[8]) {
      const code = groups[8];
      if (code === 'G49') {
        st.lengthComp = 'G49';
        st.lengthCompActive = false;
      } else {
        st.lengthComp = code;
        st.lengthCompActive = true;
        if (!has('Z')) {
          diags.push(U.diag('R16', line, 'warning', `${code} H${st.h} 這節沒有 Z，刀長補正要到下一個 Z 移動才會真正帶入`,
            { detail: '習慣上 G43 H 與第一個 Z 同節，避免中間插入其他移動時刀長沒補到。' }));
        }
      }
    }

    // ---- 固定循環啟動／取消（群組 09） ----
    if (g09) {
      if (g09 === 'G80') {
        st.cycle = null;
        st.rigidTap = false;
        st.rigidTapS = null;
        ctx.m29Armed = false;
      } else {
        if (st.cycle) {
          // 循環中切換循環種類：沿用 R/Z/Q/P
          st.cycle.code = g09;
        } else {
          st.cycle = { code: g09, r: null, z: null, q: null, p: null, retract: st.retractMode, initialZ: st.pos.z };
          ctx.cycleFirstCheck = true;
          ctx.cycleQReported = false;
        }
        if (g09 === 'G87') {
          diags.push(U.diag('R18', line, 'warning', 'G87 背搪孔：實機是「快速下到孔底 → 主軸轉 → 進給往上搪 → 停 → 偏移退出」，本工具只近似成上下移動',
            { detail: '主軸定向停止與 Q 偏移量（刀尖讓開孔壁的量）沒有模擬，所以進退刀的橫向讓刀畫不出來，'
              + '孔口附近的素材模型會比實際多切一點。搪孔方向本身（往上搪）有畫對。' }));
        }
        if (g09 === 'G84' || g09 === 'G74') {
          ctx.m29Armed = false;
          // 主軸方向：G84 是右螺紋、開始前主軸必須正轉（M3）；G74 是左螺紋，必須反轉（M4）。
          // 方向寫反在實機上必斷絲攻（剛性攻牙還可能拉壞主軸），而且是複製 G84 段去改 G74
          // 時最容易漏掉的一步。
          const want = g09 === 'G84' ? 'M3' : 'M4';
          const dir = st.spindle.dir;
          if (dir !== want) {
            const thread = g09 === 'G84' ? '右螺紋' : '左螺紋';
            const now = dir === 'M5' ? '主軸是停止的（M5）' : `主軸是 ${dir}（反方向）`;
            diags.push(U.diag('R21', line, 'error', `${g09} ${thread}攻牙，但${now}，攻牙前必須先 ${want}`,
              { detail: `${g09} 的動作是「以 ${want} 的方向轉著攻進去、到孔底反轉退出」。`
                + '方向不對或主軸沒轉，絲攻會被硬拉斷在孔裡（剛性攻牙還可能拉壞主軸與夾頭）。'
                + `請在 ${g09} 之前加上 ${want}${st.spindle.rpm == null ? ' S___' : ' S' + U.fmt(st.spindle.rpm)}。` }));
          }
          if (!has('F')) {
            if (st.feed == null) {
              diags.push(U.diag('R21', line, 'error', `${g09} 攻牙沒有指定 F`,
                { detail: '攻牙進給必須 = 轉速 × 螺距；沒有 F 機台會發 PS0011 警報。請在 G84 節加上 F。', fanucAlarm: 'PS0011' }));
            } else {
              diags.push(U.diag('R21', line, 'warning', `${g09} 攻牙沒有指定 F，會沿用模態 F${U.fmt(st.feed)}`,
                { detail: '攻牙進給必須 = 轉速 × 螺距，沿用前面的 F 很可能不對，會斷絲攻。請在 G84 節明確寫 F。' }));
            }
          }
        }
      }
    }

    // ---- M29：剛性攻牙 ----
    if (mSet.has(29)) {
      st.rigidTap = true;
      st.rigidTapS = has('S') ? val('S') : st.spindle.rpm;
      // M29 與 G84 同節時不需監看中間節
      ctx.m29Armed = !(g09 === 'G84' || g09 === 'G74');
      ctx.m29Line = line;
    } else if (ctx.m29Armed && has('S')) {
      diags.push(U.diag('R21', line, 'error', `M29 之後、G84 之前又指定了 S`,
        { detail: 'M29 與 G84 之間不可再有 S 或軸移動，機台會發 PS0203 警報。請把 S 放在 M29 同節。', fanucAlarm: 'PS0203' }));
    }

    // ---- 主軸／冷卻／停止 動作（M3/M4 在移動前，M5 在移動後） ----
    if (mSet.has(3) || mSet.has(4)) actions.push({ kind: 'spindle', dir: st.spindle.dir, rpm: st.spindle.rpm });
    if (mSet.has(8) || mSet.has(7)) actions.push({ kind: 'coolant', on: true });

    // ---- 移動 ----
    const hasCoord = has('X') || has('Y') || has('Z');
    // G2/G3 模式下只寫 I/J（沒有 X/Y/Z）：終點＝起點，是整圓——CAM 銑孔最常見的寫法（例如 J-8.103）。
    // 只寫 R 也放行，讓 makeArc 發 R23（起終點重合用 R 無法定義圓弧）而不是整節無聲消失。
    const arcOnly = !hasCoord && arcHere && (has('I') || has('J') || has('R'));
    const hasRot = has(ROT_AXIS);
    // G65／G66 的 A 是巨集引數 #1，不是第四軸——blocksMotion 的節不算
    if (hasRot && !blocksMotion) ctx.sawRotWord = true;
    let motionAction = null;

    // B／C 軸：本版只支援 A，但不能靜靜吃掉（整支程式只報一次）
    if (!blocksMotion && !ctx.otherRotReported) {
      const other = OTHER_ROT.filter((r) => has(r));
      if (other.length) {
        ctx.otherRotReported = true;
        diags.push(U.diag('R02', line, 'warning', `本工具只認得第四軸 A，這一節的 ${other.join('、')} 軸不會被讀取`,
          { detail: '這一節在實機上是合法的，機台不會警報；只是預演不知道 ' + other.join('、') + ' 轉到哪裡，'
            + '這一段之後的路徑、素材與碰撞結果都可能和實機不同。\n'
            + '若現場真的用到第五軸，請告知，本工具再擴充。' }));
      }
    }

    if (isG04) {
      // G4 暫停：P 毫秒或 X 秒（X 在此不是座標）
      // DPI=0 且 X 沒有小數點時，機台把 X1000 讀成 1 秒——R04 的訊息就是這樣寫的，
      // 動作也要跟著算 1 秒，否則同一節裡工具會給出兩套數字（時間估算會多出 16 分鐘）。
      let sec = 0;
      if (has('P')) sec = val('P') / 1000;
      else if (has('X')) {
        const w = last['X'];
        sec = (!settings.dpi && !w.hasDecimal && w.value !== 0) ? w.value / 1000 : w.value;
      }
      actions.push({ kind: 'dwell', seconds: sec });
    } else if (blocksMotion) {
      // G68／G65／G51… 這一節的座標字是指令參數，不是移動終點，不產生任何移動
      // （診斷已在 G 碼解析時發出）
    } else if (g00 === 'G28' || g00 === 'G30') {
      motionAction = doRefReturn(b, ctx, last, has, val, g00, g09);
      if (motionAction) actions.push(motionAction);
    } else if (g00 === 'G53') {
      // G53 是機械座標一次性指令：`G53 G0 Z0.` 是「走到機械 Z 零（行程最高點）」的標準安全退刀。
      // 照工件座標畫的話會變成快速移動到工件頂面，路徑錯之外還會被 R27 判成「G0 向下撞料」。
      // 因此：不產生移動，只把位置更新到參考點（機械原點附近）的對應軸。
      const ref = settings.refPosition || { x: 0, y: 0, z: 150 };
      const axes = AXES.filter((a) => has(a));
      if (axes.length) {
        const np = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
        for (const a of axes) np[AXIS_KEY[a]] = ref[AXIS_KEY[a]];
        st.pos = np;
        diags.push(U.diag('R02', line, 'warning', `G53 機械座標移動（${axes.join('、')} 軸）本工具不模擬，這一節不畫路徑`,
          { detail: '機械座標的原點在機台的行程端點，和工件原點差多少要看機台的工件座標偏置（本工具沒有這份資料）。'
            + `
${axes.indexOf('Z') >= 0 ? 'G53 G0 Z0. 是最常見的安全退刀寫法（走到行程最高點），' : ''}`
            + '預演把位置直接視為到了參考點附近，所以這一節不會畫線、也不會拿去做碰撞檢查。'
            + '\n如果要精確預演這一段，請在設定裡填入機械座標與工件座標的偏置（本版尚未提供）。',
            pos: { x: st.pos.x, y: st.pos.y, z: st.pos.z } }));
      } else {
        diags.push(U.diag('R02', line, 'info', 'G53 這一節沒有指定任何軸，不會有移動', {}));
      }
    } else if (g00 === 'G10' || g00 === 'G92' || g00 === 'G52') {
      // 資料設定／座標系設定：不模擬移動
      if (g00 === 'G92' && hasCoord) {
        diags.push(U.diag('R02', line, 'info', 'G92 座標系設定不模擬，後續座標仍以 G54 解讀',
          { detail: '預演不套用 G92 位移；若程式依賴 G92，路徑顯示會偏移。' }));
      }
    } else if (st.cycle) {
      // 固定循環中「只寫一個 A90.」也要鑽一個孔——這是四軸分度鑽孔的標準寫法：
      //   G81 X10. Y0. Z-5. R2. F100.
      //   A90.   ← 轉 90 度後在同一個 XY 再鑽一個
      // 不把 hasRot 算進來的話，這種節會整行消失，孔數與時間全部少報。
      if (hasCoord || has('R') || hasRot) {
        const holes = doHole(b, ctx, last, has, val);
        for (const h of holes) actions.push(h);
        motionAction = holes.length ? holes[holes.length - 1] : null;
      }
    } else if (hasCoord || arcOnly) {
      motionAction = doMotion(b, ctx, last, has, val, forcedMotion);
      if (motionAction) actions.push(motionAction);
    } else if (hasRot) {
      // 只有第四軸在動的節（XYZ 都沒寫）：分度轉動
      motionAction = doRotate(b, ctx, has, val);
      if (motionAction) actions.push(motionAction);
    }

    // ,C / ,R 逗號字組
    if (commas.length) {
      const cw = commas[commas.length - 1];
      const corner = cw.addr === 'C' ? { c: cw.value } : { r: cw.value };
      if (motionAction && (motionAction.kind === 'linear' || motionAction.kind === 'arc')) {
        motionAction.corner = corner;
      } else {
        diags.push(U.diag('R22', line, 'warning', `${cw.raw} 只對 G1/G2/G3 有效，這節不是切削移動，倒角／圓角被忽略`,
          { detail: '選擇性倒角／圓角要放在直線或圓弧的切削節上；放在 G0、循環或無移動的節等於沒寫。' }));
      }
    }

    // 補正啟動／取消旗標掛到本節（或之後第一個）移動動作
    if (motionAction && motionAction.kind !== 'refReturn' && motionAction.kind !== 'hole') {
      if (ctx.compStartPending) { motionAction.compStart = true; ctx.compStartPending = false; }
      if (ctx.compEndPending) { motionAction.compEnd = true; ctx.compEndPending = false; }
    }

    // R21：M29 與 G84 之間有軸移動
    if (ctx.m29Armed && motionAction && !(g09 === 'G84' || g09 === 'G74')) {
      diags.push(U.diag('R21', line, 'error', 'M29 之後、G84 之前有軸移動',
        { detail: 'M29 與 G84 之間不可有軸移動，機台會發 PS0203 警報。請把移動放在 M29 之前。', fanucAlarm: 'PS0203' }));
    }

    if (mSet.has(5)) actions.push({ kind: 'spindle', dir: 'M5', rpm: st.spindle.rpm });
    if (mSet.has(9)) actions.push({ kind: 'coolant', on: false });
    for (const m of mCodes) {
      if (m === 0 || m === 1 || m === 2 || m === 30) {
        actions.push({ kind: 'stop', code: 'M' + m });
        if (m === 30 || m === 2) {
          ctx.opClosed = true;
          if (st.comp !== 'G40') {
            diags.push(U.diag('R13', line, 'error', `刀徑補正（${st.comp}）生效中結束程式（M${m}）`,
              { detail: '補正沒取消就結束，下一支程式或重新啟動時會帶著錯誤的補正狀態。請在 M30 前 G40。' }));
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 座標與移動
  // ---------------------------------------------------------------------------
  /** 依 G90/G91 算目標點；未指定的軸保持 */
  function targetOf(st, has, val) {
    const p = st.pos;
    const abs = st.distance === 'G90';
    const to = { x: p.x, y: p.y, z: p.z };
    for (const a of AXES) {
      if (!has(a)) continue;
      const k = AXIS_KEY[a];
      to[k] = abs ? val(a) : p[k] + val(a);
    }
    return to;
  }

  /**
   * 第四軸 A 的目標角度（度）。沒有 A 字時維持目前角度。
   * G90／G91 對旋轉軸一樣適用：G91 A90. 是「再轉 90 度」。
   */
  function targetA(st, has, val) {
    if (!has(ROT_AXIS)) return st.a;
    return st.distance === 'G90' ? val(ROT_AXIS) : st.a + val(ROT_AXIS);
  }

  function checkR16(ctx, line, from, toZ) {
    const st = ctx.state;
    const op = ctx.op;
    if (!op || op._r16 || st.lengthCompActive) return;
    if (toZ < from.z - EPS && toZ < op._zAtStart - EPS) {
      op._r16 = true;
      ctx.diags.push(U.diag('R16', line, 'error', `T${op.tool == null ? '?' : op.tool} 換刀後第一次 Z 向下（Z${U.fmt(toZ)}）之前沒有 G43 H`,
        { detail: '沒有刀長補正就下刀，刀尖實際位置與程式差一個刀長，極可能撞刀。請在下刀前加 G43 H。', fanucAlarm: null }));
    }
  }

  function doMotion(b, ctx, last, has, val, forcedMotion) {
    const st = ctx.state;
    const diags = ctx.diags;
    const line = b.line;
    const from = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
    const to = targetOf(st, has, val);
    const aFrom = st.a;
    const aTo = targetA(st, has, val);
    let motion = st.motion;
    if (forcedMotion) motion = forcedMotion;
    if (motion === null) {
      if (!ctx.seenMotionWithoutMode) {
        ctx.seenMotionWithoutMode = true;
        diags.push(U.diag('R02', line, 'warning', '尚未指定 G0/G1 就有座標移動，預演視為 G0 快速移動',
          { detail: '開機預設移動模式依參數 3402#0 而定，可能是 G0 或 G1。請在第一個移動節明確寫 G0 或 G1。' }));
      }
      motion = 'G0';
    }
    checkR16(ctx, line, from, to.z);
    let action;
    if (motion === 'G0') {
      let n = 0;
      if (!U.eq(from.x, to.x)) n++;
      if (!U.eq(from.y, to.y)) n++;
      if (!U.eq(from.z, to.z)) n++;
      if (!U.eq(aFrom, aTo)) n++;      // 第四軸同動一樣是各軸獨立速率、路徑非直線
      action = { kind: 'rapid', from, to, feed: null, nonLinear: n > 1 };
    } else if (motion === 'G1') {
      if (st.feed == null && !ctx.r08Reported) {
        ctx.r08Reported = true;
        diags.push(U.diag('R08', line, 'error', 'G1 切削移動但尚未指定 F 進給',
          { detail: '沒有 F 機台會發 PS0011 警報（無進給指令）。請在 G1 節或之前加上 F。', fanucAlarm: 'PS0011' }));
      }
      action = { kind: 'linear', from, to, feed: st.feed };
      noteCut(ctx, to.z, true);
    } else {
      action = makeArc(ctx, line, from, to, has, val, motion === 'G2');
      noteCut(ctx, to.z, true);
    }
    st.pos = { x: to.x, y: to.y, z: to.z };
    st.a = aTo;
    // 每個動作都標「做這一段時第四軸在幾度」，rules 與畫面才知道這段屬於哪一個分度面
    action.a = aTo;
    if (!U.eq(aFrom, aTo)) action.aFrom = aFrom;
    return action;
  }

  /**
   * 只有第四軸在動的節（XYZ 都沒寫）：分度轉動。
   * XYZ 不變，所以 geometry 不會產生線段，但動作要留著——
   * 「轉動時刀具在哪個高度」是四軸最會撞機的地方，rules 靠這個動作檢查。
   */
  function doRotate(b, ctx, has, val) {
    const st = ctx.state;
    const aFrom = st.a;
    const aTo = targetA(st, has, val);
    st.a = aTo;
    if (U.eq(aFrom, aTo)) return null;   // 重複寫同一個角度，實機也不會動
    const pos = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
    return {
      kind: 'rotate', axis: ROT_AXIS,
      from: pos, to: { x: pos.x, y: pos.y, z: pos.z },
      aFrom, a: aTo,
      feed: st.motion === 'G1' ? st.feed : null,
    };
  }

  function noteCut(ctx, z, linear) {
    const op = ctx.op;
    if (!op) return;
    if (linear) op._hasLinear = true; else op._hasHole = true;
    if (op.zMin === null || z < op.zMin) op.zMin = z;
  }

  /** G2/G3：由 I/J 或 R 求圓心；失敗則退化成直線 */
  function makeArc(ctx, line, from, to, has, val, cw) {
    const st = ctx.state;
    const diags = ctx.diags;
    const linear = () => ({ kind: 'linear', from, to, feed: st.feed });
    if (st.plane !== 'G17') {
      // 程式本身合法、機台跑得好好的，是本工具做不到——這種「工具限制」不能用紅字，
      // 否則現場會學會忽略紅字（同整合決議 15 的理由）。
      diags.push(U.diag('R02', line, 'warning', `本工具不模擬 ${st.plane} 平面的圓弧（${cw ? 'G2' : 'G3'}）`,
        { detail: '這一節在實機上是合法的，機台不會警報；只是本預演台只會畫 G17（XY）平面的圓弧，'
          + '這一段會以直線代替，路徑、素材與碰撞結果都會和實機不同。' }));
      return linear();
    }
    if (st.feed == null && !ctx.r08Reported) {
      ctx.r08Reported = true;
      diags.push(U.diag('R08', line, 'error', `${cw ? 'G2' : 'G3'} 切削移動但尚未指定 F 進給`,
        { detail: '沒有 F 機台會發 PS0011 警報。', fanucAlarm: 'PS0011' }));
    }
    const chord = U.dist2(from, to);
    let center, r;
    if (has('R')) {
      const R = val('R');
      const aR = Math.abs(R);
      if (chord < EPS) {
        diags.push(U.diag('R23', line, 'error', `${cw ? 'G2' : 'G3'} 用 R 指定但起點與終點重合，圓弧無法定義`,
          { detail: '整圓必須用 I/J 指定圓心；用 R 時起終點重合機台會發 PS0020/PS0021 警報。預演忽略這段。', fanucAlarm: 'PS0021' }));
        return linear();
      }
      const rTol = (ctx.settings && ctx.settings.arcRadiusTolMm > 0) ? ctx.settings.arcRadiusTolMm : ARC_R_TOL;
      if (chord > 2 * aR + rTol) {
        diags.push(U.diag('R23', line, 'error', `${cw ? 'G2' : 'G3'} 弦長 ${U.fmt(chord)} 大於直徑 2×R${U.fmt(aR)}，差 ${U.fmt(chord - 2 * aR, 3)} mm，圓弧不成立`,
          { detail: `起終點距離超過 2R 太多（超過容許量 ${U.fmt(rTol, 3)} mm，對應 Fanuc 參數 3410），圓不存在，機台會發 PS0020 警報。`
            + '預演以直線代替。請檢查 R 或終點座標。', fanucAlarm: 'PS0020' }));
        return linear();
      }
      // 容許量之內（CAM 把終點四捨五入造成的 0.001 mm 級誤差）：實機會把圓心夾到弦中點照畫，
      // 這裡的 h = sqrt(max(0, …)) 正好是同一個行為，不報錯。
      const h = Math.sqrt(Math.max(0, aR * aR - (chord / 2) * (chord / 2)));
      const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
      const dx = (to.x - from.x) / chord, dy = (to.y - from.y) / chord;
      // 左法向 (-dy, dx)；G3 小弧圓心在左、G2 在右；R<0 反向（大弧）
      const sign = (cw ? -1 : 1) * (R >= 0 ? 1 : -1);
      center = { x: mx + (-dy) * h * sign, y: my + dx * h * sign };
      r = aR;
    } else if (has('I') || has('J')) {
      const I = has('I') ? val('I') : 0;
      const J = has('J') ? val('J') : 0;
      center = { x: from.x + I, y: from.y + J };
      r = Math.hypot(I, J);
      const rEnd = U.dist2(center, to);
      if (Math.abs(rEnd - r) > 0.01) {
        diags.push(U.diag('R23', line, 'warning', `${cw ? 'G2' : 'G3'} 起點半徑 ${U.fmt(r)} 與終點半徑 ${U.fmt(rEnd)} 不一致`,
          { detail: '圓心 I/J 與終點不在同一個圓上；差異超過參數 3410 時機台會發 PS0020 警報。預演以起點半徑畫弧。', fanucAlarm: 'PS0020' }));
      }
    } else {
      diags.push(U.diag('R23', line, 'error', `${cw ? 'G2' : 'G3'} 沒有 I/J 也沒有 R，無法決定圓心`,
        { detail: '圓弧需要 I/J（圓心相對起點）或 R（半徑）。機台會發 PS0022 警報。預演以直線代替。', fanucAlarm: 'PS0022' }));
      return linear();
    }
    return { kind: 'arc', from, to, feed: st.feed, center, cw, r };
  }

  /** G28/G30 參考點回歸 */
  function doRefReturn(b, ctx, last, has, val, code, g09) {
    const st = ctx.state;
    const diags = ctx.diags;
    const settings = ctx.settings;
    const line = b.line;
    if (st.cycle && g09 !== 'G80') {
      diags.push(U.diag('R18', line, 'error', `固定循環（${st.cycle.code}）生效中執行 ${code}，同節沒有 G80`,
        { detail: '循環中不可 G28/G30，機台會發 PS0044 警報。請在同節或前一節加 G80。', fanucAlarm: 'PS0044' }));
      st.cycle = null;
    }
    if (st.comp !== 'G40') {
      diags.push(U.diag('R13', line, 'error', `刀徑補正（${st.comp}）生效中執行 ${code} 參考點回歸`,
        { detail: '補正中回原點，中間點會被補正偏移、且可能發 PS0041 警報。請先 G40。', fanucAlarm: 'PS0041' }));
    }
    const axes = AXES.filter((a) => has(a));
    const rotHere = has(ROT_AXIS);
    // 訊息與多軸判定用「含第四軸」的清單；座標運算只用 XYZ（A 不在 pos 裡）
    const allAxes = rotHere ? axes.concat([ROT_AXIS]) : axes;
    if (allAxes.length === 0) {
      diags.push(U.diag('R17', line, 'warning', `${code} 沒有指定任何軸，不會有軸回歸`,
        { detail: 'Fanuc 的 G28 只回歸有寫出來的軸（如 G28 Z0.）。請確認是否漏寫軸字。' }));
      return null;
    }
    const from = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
    const via = targetOf(st, has, val);
    if (st.distance === 'G90' && !U.eq3(via, from)) {
      diags.push(U.diag('R17', line, 'error', `${code} 在 G90 絕對模式下，中間點（${fmtVec(via)}）不是目前位置，回歸前會先移到中間點`,
        { detail: 'G90 G28 Z0. 會先快速移到工件座標 Z0 再回原點，極可能撞到工件。慣例寫法是 G91 G28 Z0.。', pos: via }));
    }
    if (allAxes.length >= 2) {
      // pos = 執行這一節之前的位置；analyze 會用它與素材頂面比對，Z 已經拉高就降成 info（整合決議 17）。
      diags.push(U.diag('R17', line, 'warning', `${code} 同時回歸 ${allAxes.join('、')} 軸，各軸同時動作路徑不是直線`,
        { detail: '多軸同時回歸時 Z 若還在低處，XY 先動可能撞夾具。建議先 G28 Z0. 再回 XY。', pos: { x: from.x, y: from.y, z: from.z }, multiAxis: true }));
    }
    const ref = settings.refPosition || { x: 0, y: 0, z: 150 };
    const to = { x: via.x, y: via.y, z: via.z };
    for (const a of axes) to[AXIS_KEY[a]] = ref[AXIS_KEY[a]];
    st.pos = { x: to.x, y: to.y, z: to.z };
    // 第四軸的參考點一律視為 A0（分度頭的原點）
    const aFrom = st.a;
    if (rotHere) st.a = 0;
    const act = { kind: 'refReturn', from, via, to, axes: allAxes, a: st.a };
    if (!U.eq(aFrom, st.a)) act.aFrom = aFrom;
    return act;
  }

  /** 固定循環的一節（可能不只一個孔：K／L 是重複次數） @returns {Action[]} */
  function doHole(b, ctx, last, has, val) {
    const st = ctx.state;
    const c = st.cycle;
    const diags = ctx.diags;
    const line = b.line;
    const abs = st.distance === 'G90';
    const from = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
    const aFrom = st.a;
    const aTo = targetA(st, has, val);
    let x = st.pos.x, y = st.pos.y;
    if (has('X')) x = abs ? val('X') : st.pos.x + val('X');
    if (has('Y')) y = abs ? val('Y') : st.pos.y + val('Y');
    if (has('R')) c.r = abs ? val('R') : c.initialZ + val('R');
    if (has('Z')) c.z = abs ? val('Z') : (c.r == null ? c.initialZ : c.r) + val('Z');
    if (has('Q')) c.q = val('Q');
    if (has('P')) c.p = val('P');
    c.retract = st.retractMode;

    if (ctx.cycleFirstCheck) {
      ctx.cycleFirstCheck = false;
      if (c.z == null || c.r == null) {
        const missing = [c.r == null ? 'R' : null, c.z == null ? 'Z' : null].filter(Boolean).join('、');
        diags.push(U.diag('R18', line, 'error', `固定循環 ${c.code} 的第一個孔沒有指定 ${missing}`,
          { detail: 'G80 之後 R 點與孔底 Z 會被清除，重新進入循環必須重新給。缺少時機台會發 PS0045 類警報或用錯誤深度鑽孔。', fanucAlarm: 'PS0045' }));
      }
    }
    if ((c.code === 'G73' || c.code === 'G83') && c.q == null && !ctx.cycleQReported) {
      ctx.cycleQReported = true;
      diags.push(U.diag('R18', line, 'error', `${c.code} 啄鑽沒有指定 Q（每次進刀量）`,
        { detail: 'G73/G83 必須有 Q，機台會發 PS0045 警報。請加上 Q（如 Q0.5）。', fanucAlarm: 'PS0045' }));
    }
    const r = c.r == null ? c.initialZ : c.r;
    const z = c.z == null ? r : c.z;
    const rigid = st.rigidTap && (c.code === 'G84' || c.code === 'G74');
    checkR16(ctx, line, from, z);

    // ---- 重複次數 K（M 系列；部分程式寫 L）----
    // 沒有實作的話，`G91G99G81X10.Y0.Z-5.R-8.K3` 只會畫 1 個孔而實機鑽 3 個：
    // 孔數少、素材少挖、時間偏低，而畫面上一片綠。這是漏報，一定要展開或至少講清楚。
    let reps = repeatCount(has, val);
    let repeatNote = null;
    if (reps != null && reps !== 1) {
      const addr = has('K') ? 'K' : 'L';
      if (reps === 0) {
        repeatNote = () => diags.push(U.diag('R18', line, 'warning', `${addr}0 在部分控制器代表「只記住循環資料、這一節不鑽孔」`,
          { detail: '不同機型對 ' + addr + '0 的處理不一樣（有的不鑽、有的鑽一次）。'
            + '預演保守起見照樣畫一個孔；請確認這是不是本意，或直接把 ' + addr + '0 拿掉。' }));
        reps = 1;
      } else if (reps < 0 || !Number.isFinite(reps)) {
        repeatNote = () => diags.push(U.diag('R18', line, 'warning', `${addr}${U.fmt(reps)} 的重複次數不合理，預演只畫 1 個孔`, {}));
        reps = 1;
      } else if (!abs) {
        reps = Math.floor(reps);
      } else {
        // G90 絕對模式：Fanuc 會在同一個位置重複鑽 reps 次（多半是誤用）
        const n = Math.floor(reps);
        repeatNote = () => diags.push(U.diag('R18', line, 'warning', `${addr}${n} 在 G90（絕對）模式下會在同一個位置重複鑽 ${n} 次`,
          { detail: '重複鑽陣列孔要搭配 G91（增量）才會每次往旁邊移一格；G90 時每一次的 XY 都一樣，等於原地重鑽。'
            + `
預演只畫 1 個孔（重複的部分不影響形狀，但時間估算會少 ${n - 1} 次）。請確認是不是漏了 G91。` }));
        reps = 1;
      }
    } else if (reps === 1) {
      reps = 1;
    } else {
      reps = 1;
    }
    const dx = (!abs && has('X')) ? val('X') : 0;
    const dy = (!abs && has('Y')) ? val('Y') : 0;
    // 第四軸也是循環裡可以定位的軸：`G91 A45. K7` 每重複一次再轉 45°（分度鑽孔的標準寫法）。
    // 只累加 X/Y 的話 7 個孔全疊在同一個角度：畫面只剩兩個孔、R19 誤報「同一個孔鑽兩次」、少算 6 次分度時間。
    const dA = !abs ? (aTo - aFrom) : 0;
    if (repeatNote) repeatNote();

    const out = [];
    let aPrev = aFrom;
    for (let i = 0; i < reps; i++) {
      const hx = x + dx * i, hy = y + dy * i;
      const hA = aTo + dA * i;
      const hFrom = i === 0 ? from : { x: st.pos.x, y: st.pos.y, z: st.pos.z };
      const to = { x: hx, y: hy, z: c.retract === 'G98' ? c.initialZ : r };
      const h = {
        kind: 'hole', from: hFrom, to, x: hx, y: hy, z, r,
        initialZ: c.initialZ, q: c.q == null ? undefined : c.q, p: c.p == null ? undefined : c.p,
        cycle: c.code, retract: c.retract, rigid, feed: st.feed,
        a: hA,
      };
      // 每個孔都帶自己的轉動起點：K/L 重複的後續孔各自再轉一次（Fanuc 是先定位到位含旋轉，再鑽）
      if (!U.eq(aPrev, hA)) h.aFrom = aPrev;
      out.push(h);
      st.pos = { x: to.x, y: to.y, z: to.z };
      aPrev = hA;
    }
    st.a = aPrev;
    noteCut(ctx, z, false);
    return out;
  }

  function fmtVec(v) { return `X${U.fmt(v.x)} Y${U.fmt(v.y)} Z${U.fmt(v.z)}`; }

  // ---------------------------------------------------------------------------
  // 程式層檢查（R32）與 Operation 收尾
  // ---------------------------------------------------------------------------
  function finishProgramChecks(blocks, ctx) {
    const diags = ctx.diags;
    if (!ctx.hasO) {
      diags.push(U.diag('R32', 0, 'warning', '程式沒有 O 號',
        { detail: '沒有 O 號的程式傳進機台時無法登錄／會覆蓋目前程式。請在第一行（% 之後）加上 Oxxxx。' }));
    }
    if (!ctx.hasM30) {
      diags.push(U.diag('R32', 0, 'error', '程式沒有 M30（或 M02）結束碼',
        { detail: '執行到檔尾機台會發 PS0005 類警報或停在不明狀態。請在最後加 M30。', fanucAlarm: 'PS0005' }));
    }
    // % 開頭／結尾
    let first = null, lastB = null;
    for (const b of blocks) { if (b.isPercent || !b.isEmpty || b.raw.trim() !== '') { first = b; break; } }
    for (let i = blocks.length - 1; i >= 0; i--) { const b = blocks[i]; if (b.isPercent || !b.isEmpty || b.raw.trim() !== '') { lastB = b; break; } }
    if (blocks.length && !(first && first.isPercent)) {
      diags.push(U.diag('R32', first ? first.line : 1, 'info', '程式開頭缺少「%」',
        { detail: '透過 RS232/DNC 傳輸時需要 % 作為起始標記；用記憶卡或網路傳可忽略。' }));
    }
    if (blocks.length && !(lastB && lastB.isPercent && (first !== lastB))) {
      diags.push(U.diag('R32', lastB ? lastB.line : blocks.length, 'info', '程式結尾缺少「%」',
        { detail: '透過 RS232/DNC 傳輸時需要 % 作為結束標記；用記憶卡或網路傳可忽略。' }));
    }
  }

  function finalizeOp(op) {
    const hasLinear = op._hasLinear;
    const hasHole = op._hasHole;
    const comment = (op.toolComment || '').toUpperCase();
    let kind = 'unknown';
    if (hasHole && !hasLinear) {
      if (op.gCodes.indexOf('G84') >= 0 || op.gCodes.indexOf('G74') >= 0) kind = 'tap';
      else if (op.gCodes.indexOf('G85') >= 0) kind = 'ream';
      else kind = 'drill';
    } else if (/\d\s*V\b/.test(comment) && hasLinear) {
      kind = 'chamfer';
    } else if (op._hasComp) {
      kind = 'contour';
    } else if (hasLinear && op.zMin !== null && op.zMin < 0 && op.zMin < -0.1) {
      kind = 'pocket';
    } else if (hasLinear && op.zMin !== null && op.zMin >= -0.1) {
      kind = 'face';
    }
    op.kindGuess = kind;
    delete op._hasLinear; delete op._hasHole; delete op._hasComp; delete op._zAtStart; delete op._r16;
    return op;
  }

  NC.interpret = interpret;
  NC.interpreter = { gName, cloneState };
})(globalThis.NC = globalThis.NC || {});
