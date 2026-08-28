/*
 * NC 預演台 — analyze.js
 * 把各模組串成一次完整分析：tokenize → interpret（每個情境）→ 刀具表 → buildSegments → 素材推估
 * → rules（無 sim）→ 模擬（每個情境）→ rules（sim/cross 階段）→ 診斷合併去重排序。
 *
 * 對外：
 *   NC.analyze(request, onStage?) → Promise<AnalysisResult>   完整（可含模擬）
 *   NC.analyzeSync(request)       → AnalysisResult            不含模擬（給編輯中即時更新用）
 *   NC.analysis.*                 → 幾個共用的小工具（排序、去重、預設 request、中止判斷）
 *
 * onStage(stage, scenario?, progress?)：
 *   'tokenize' → 'interpret'(sc) → 'tools' → 'geometry'(sc) → 'stock' → 'rules'
 *   → 'sim'(sc, 0..1) → 'rulesSim' → 'done'
 *   onStage 自己丟出的例外會被吞掉，不影響分析。
 *
 * request.signal（{aborted:boolean}，AbortSignal 也可）在每個階段之間與模擬進度回呼時檢查；
 * 已中止 → 丟出 name==='AbortError' 的 Error（NC.analysis.isAbortError(e) 可判斷）。
 */
(function (NC) {
  'use strict';

  const U = NC.util;
  const ALL_SCENARIOS = ['off', 'on', 'multiIgnored'];
  const DEFAULT_SCENARIOS = ['off', 'on'];
  const SEVERITY_RANK = { error: 0, warning: 1, needsInput: 2, info: 3 };
  const SIM_PHASES = { sim: true, cross: true };
  const SEP = String.fromCharCode(1); // 診斷鍵的欄位分隔（不會出現在訊息裡）

  // ---------------------------------------------------------------------------
  // 中止（signal）
  // ---------------------------------------------------------------------------
  /** 產生一個中止用的 Error（與 DOM 的 AbortError 同名，方便 UI 統一處理） */
  function abortError() {
    const e = new Error('分析已取消');
    e.name = 'AbortError';
    e.aborted = true;
    return e;
  }
  function isAbortError(e) {
    return !!(e && (e.name === 'AbortError' || e.aborted === true));
  }
  function aborted(signal) {
    return !!(signal && signal.aborted);
  }
  function throwIfAborted(signal) {
    if (aborted(signal)) throw abortError();
  }

  // ---------------------------------------------------------------------------
  // request 正規化
  // ---------------------------------------------------------------------------
  /** 預設的 AnalysisRequest（UI 可以拿去改） */
  function defaultRequest(text) {
    return {
      text: text == null ? '' : String(text),
      settings: U.defaultSettings(),
      toolTable: null,
      stock: null,
      scenarios: DEFAULT_SCENARIOS.slice(),
      sim: { enabled: false, cell: 0.5 },
    };
  }

  function normalizeRequest(request) {
    const r = request || {};
    const list = [];
    const wanted = Array.isArray(r.scenarios) && r.scenarios.length ? r.scenarios : DEFAULT_SCENARIOS;
    // 'off' 是所有比較的基準（rules 的 ctx.scenarios.off 為必要欄位），一定放第一個。
    for (const sc of ['off'].concat(wanted)) {
      if (ALL_SCENARIOS.indexOf(sc) >= 0 && list.indexOf(sc) < 0) list.push(sc);
    }
    const simIn = r.sim || {};
    return {
      text: r.text == null ? '' : String(r.text),
      settings: Object.assign(U.defaultSettings(), r.settings || {}),
      toolTable: r.toolTable || null,
      stock: r.stock || null,
      scenarios: list,
      sim: { enabled: !!simIn.enabled, cell: simIn.cell > 0 ? simIn.cell : 0.5 },
      signal: r.signal || null,
      programKey: r.programKey || r.fileName || null,
    };
  }

  /** onStage 包一層：不存在或自己丟例外都不影響分析 */
  function stageReporter(onStage) {
    if (typeof onStage !== 'function') return function () {};
    return function (stage, scenario, progress) {
      try { onStage(stage, scenario, progress); } catch (_) { /* UI 的錯不能中斷分析 */ }
    };
  }

  // ---------------------------------------------------------------------------
  // 刀具表與素材
  // ---------------------------------------------------------------------------
  function programKeyOf(tok, req) {
    if (req.programKey) return String(req.programKey);
    if (tok && tok.programNumber != null) return 'O' + String(tok.programNumber).padStart(4, '0');
    if (req.toolTable && req.toolTable.programKey) return String(req.toolTable.programKey);
    return '';
  }

  /** 蒐集「D 號 → 使用該 D 的刀」對照（跨所有情境，同 D 只留第一個） */
  function collectDPairs(scenarios, order) {
    const pairs = [];
    for (const sc of order) {
      const sr = scenarios[sc];
      if (!sr || !sr.run || !Array.isArray(sr.run.ops)) continue;
      for (const op of sr.run.ops) {
        for (const d of (op && op.dList) || []) {
          if (!(d > 0) || pairs.some((p) => p.d === d)) continue;
          pairs.push({ d, tool: op.tool == null ? null : op.tool });
        }
      }
    }
    return pairs;
  }

  /** inferTools → mergeUserTable（使用者值覆蓋）→ defaultOffsets（用合併後的直徑）→ 再併使用者補正 */
  function buildToolTable(tok, scenarios, order, req) {
    const T = NC.tools;
    const key = programKeyOf(tok, req);
    const stamp = new Date().toISOString();
    if (!T || typeof T.inferTools !== 'function') {
      // tools.js 未載入：給一個空表，讓其他模組還能跑（不猜刀徑）。
      const saved = req.toolTable;
      return {
        programKey: key,
        tools: (saved && Array.isArray(saved.tools)) ? saved.tools.slice() : [],
        offsets: (saved && Array.isArray(saved.offsets)) ? saved.offsets.slice() : [],
        updatedAt: stamp,
      };
    }
    const primary = scenarios[order[0]] && scenarios[order[0]].run;
    const inferred = T.inferTools(tok, primary);
    const merged = T.mergeUserTable({ programKey: key, tools: inferred, offsets: [], updatedAt: stamp }, req.toolTable);
    merged.programKey = key || merged.programKey || '';
    const base = typeof T.defaultOffsets === 'function' ? T.defaultOffsets(merged.tools, collectDPairs(scenarios, order)) : [];
    const savedOffsets = (req.toolTable && Array.isArray(req.toolTable.offsets)) ? req.toolTable.offsets : [];
    merged.offsets = typeof T.mergeOffsets === 'function' ? T.mergeOffsets(base, savedOffsets) : base;
    return merged;
  }

  function normalizeStock(stock) {
    const s = Object.assign({}, stock);
    s.min = U.clone3(stock.min);
    s.max = U.clone3(stock.max);
    s.source = stock.source === 'estimated' ? 'estimated' : 'user';
    s.fixtures = Array.isArray(stock.fixtures) ? stock.fixtures : [];
    return s;
  }

  function fallbackStock() {
    return { min: { x: -50, y: -50, z: -20 }, max: { x: 50, y: 50, z: 0 }, source: 'estimated', fixtures: [] };
  }

  /**
   * 第四軸的素材是**圓棒**，不是方塊。
   * 用 (X, 弧長) → 半徑 的圓柱高度圖（見 simulation.createCylinder），
   * 那是唯一能表達「圓棒側面被鑽了幾個孔」的 2.5D 模型。
   * 半徑：使用者填過就用他的，否則推估（取切削段離軸心最遠的距離，落在表面附近）。
   * 軸向範圍：切削段的 X 加餘量。
   * @returns {Object|null} 圓柱 stock；不是四軸（或算不出半徑）回 null
   */
  function cylinderStock(req, scenarios, order) {
    const off = scenarios.off;
    const rot = off && off.run && off.run.rotary;
    if (!rot || !rot.used || !rot.rotateLines.length) return null;
    const RG = NC.geometry && NC.geometry.rotary;
    if (!RG || typeof RG.estimateRadius !== 'function') return null;
    const cfg = (req.settings && req.settings.rotary) || {};
    const center = {
      y: (cfg.center && Number(cfg.center.y)) || 0,
      z: (cfg.center && Number(cfg.center.z)) || 0,
    };
    let radius = Number(cfg.radius) || 0;
    let source = 'user';
    if (!(radius > 0)) {
      const segs = [];
      for (const sc of order) {
        const g = scenarios[sc] && scenarios[sc].geometry;
        if (g && g.segments) segs.push.apply(segs, g.segments);
      }
      const est = RG.estimateRadius(segs, { center });
      if (!est || !(est.radius > 0)) return null;
      radius = est.radius;
      source = 'estimated';
    }
    let x0 = Infinity, x1 = -Infinity;
    for (const sc of order) {
      const g = scenarios[sc] && scenarios[sc].geometry;
      for (const seg of (g && g.segments) || []) {
        if (!seg || seg.refReturn || seg.kind === 'rapid') continue;
        x0 = Math.min(x0, seg.from.x, seg.to.x);
        x1 = Math.max(x1, seg.from.x, seg.to.x);
      }
    }
    if (!Number.isFinite(x0)) return null;
    const pad = Math.max(5, (x1 - x0) * 0.15);
    return {
      kind: 'cylinder', radius, center,
      xMin: x0 - pad, xMax: x1 + pad,
      source,
      // 讓依賴 min/max 的下游（bounds、素材面板、R20/R33…）仍然拿得到一個包絡盒
      min: { x: x0 - pad, y: center.y - radius, z: center.z - radius },
      max: { x: x1 + pad, y: center.y + radius, z: center.z + radius },
      fixtures: [],
    };
  }

  function resolveStock(req, scenarios, order, toolTable) {
    const cyl = cylinderStock(req, scenarios, order);
    if (cyl) return cyl;
    if (req.stock && req.stock.min && req.stock.max) return normalizeStock(req.stock);
    if (!NC.tools || typeof NC.tools.estimateStock !== 'function') return fallbackStock();
    const runs = order.map((sc) => scenarios[sc] && scenarios[sc].run).filter(Boolean);
    const geos = order.map((sc) => scenarios[sc] && scenarios[sc].geometry).filter(Boolean);
    return normalizeStock(NC.tools.estimateStock(runs, geos, toolTable));
  }

  // ---------------------------------------------------------------------------
  // rules（可能尚未載入 → 略過）
  // ---------------------------------------------------------------------------
  function rulesLoaded() {
    return !!(NC.rules && typeof NC.rules.run === 'function');
  }
  function ruleRegistry() {
    const reg = NC.rules && NC.rules.registry;
    return Array.isArray(reg) && reg.length ? reg : null;
  }
  function phaseOf(ruleId) {
    const reg = ruleRegistry();
    if (!reg) return null;
    for (const r of reg) if (r && r.id === ruleId) return r.phase || null;
    return null;
  }
  function isSimPhase(ruleId) {
    return !!SIM_PHASES[phaseOf(ruleId)];
  }

  /** 跑 rules.run；rules.js 未載入回 []；rules.js 自己爆掉也不讓整份分析陪葬（錯誤記在 result.rulesError） */
  function runRules(ctx, phases, errors) {
    if (!rulesLoaded()) return [];
    // rules.run 的簽章是 run(ctx, opts)，phases 要放在第二個參數；
    // 之前塞在 ctx 裡等於沒有過濾，第二趟會把全部規則再跑一次。
    let out;
    try {
      out = NC.rules.run(ctx, phases ? { phases: phases.slice() } : undefined);
    } catch (e) {
      errors.push({ phase: phases ? phases.join('/') : 'all', message: (e && e.message) || String(e) });
      return [];
    }
    return Array.isArray(out) ? out.filter(Boolean) : [];
  }

  /**
   * 合併兩趟 rules：第一趟（無 sim）取非 sim/cross 的規則，第二趟（有 sim）取 sim/cross 的規則。
   * 沒有 registry 可查階段時，兩趟全收，交給後面的去重處理。
   */
  function combineRules(pass1, pass2) {
    if (!pass2 || !pass2.length) return pass1;
    if (!ruleRegistry()) return pass1.concat(pass2);
    return pass1.filter((d) => !isSimPhase(d.ruleId)).concat(pass2.filter((d) => isSimPhase(d.ruleId)));
  }

  // ---------------------------------------------------------------------------
  // 診斷合併／去重／排序
  // ---------------------------------------------------------------------------
  function sevRank(d) {
    const r = SEVERITY_RANK[d && d.severity];
    return r == null ? 4 : r;
  }
  /** 同一則診斷的識別（不含 scenario）：ruleId + 行號 + 嚴重度 + 訊息 */
  function contentKey(d) {
    return [d.ruleId, d.line, d.severity, d.message].join(SEP);
  }
  /** 契約的去重鍵：ruleId + line + scenario + message */
  function dedupeKey(d) {
    return [d.ruleId, d.line, d.scenario || '', d.message].join(SEP);
  }

  /**
   * 分組鍵：把「同一個原因、只是發生在很多行」的診斷歸成一類，UI 才能摺疊顯示。
   * 例如分層外形銑削，每一層的 G0 下刀都會產生同一則 R27，一支程式就 79 則；
   * 全部攤平列出會把真正該看的問題淹沒。訊息中的數字（座標、深度、行號）先正規化再比對。
   * 診斷本身仍逐行保留，編輯器 gutter 才能每行標記。
   */
  /** 這一則診斷的「嚴重程度數值」：規則自己填的 magnitude 優先，沒有就退回 -1（維持原順序） */
  function magnitudeOf(d) {
    const v = d && d.magnitude;
    return (typeof v === 'number' && !Number.isNaN(v)) ? v : -1;
  }

  function groupKeyOf(d) {
    const shape = String(d.message || '')
      .replace(/-?\d+(\.\d+)?/g, '#')   // 數值 → #
      .replace(/\s+/g, ' ').trim();
    return [d.ruleId, d.severity, d.scenario || '', shape].join(SEP);
  }

  function scenarioDiagnostics(sr) {
    const out = [];
    if (!sr) return out;
    if (sr.run && Array.isArray(sr.run.diagnostics)) for (const d of sr.run.diagnostics) if (d) out.push(d);
    if (sr.geometry && Array.isArray(sr.geometry.diagnostics)) for (const d of sr.geometry.diagnostics) if (d) out.push(d);
    if (sr.sim && Array.isArray(sr.sim.events)) for (const d of sr.sim.events) if (d) out.push(d);
    return out;
  }

  function sortDiagnostics(list) {
    return list.slice().sort((a, b) =>
      sevRank(a) - sevRank(b) ||
      (a.line || 0) - (b.line || 0) ||
      String(a.ruleId).localeCompare(String(b.ruleId)) ||
      String(a.scenario || '').localeCompare(String(b.scenario || '')) ||
      String(a.message).localeCompare(String(b.message)));
  }

  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const d of list) {
      const k = dedupeKey(d);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
    }
    return out;
  }

  /** 排序後重編 id（ruleId:line:序號），確保唯一且不隨機 */
  function reindex(list) {
    const n = new Map();
    for (const d of list) {
      const base = d.ruleId + ':' + d.line;
      const i = (n.get(base) || 0) + 1;
      n.set(base, i);
      d.id = base + ':' + i;
    }
    // 標上分組資訊：groupKey 相同者為同一原因；groupCount 為該組總數、
    // groupFirst 標記該組的第一則（UI 可只列這則、其餘摺疊）。
    const groups = new Map();
    for (const d of list) {
      const k = groupKeyOf(d);
      d.groupKey = k;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
    for (const [, arr] of groups) {
      // 摺疊列的代表要挑「組內最嚴重的那一筆」，不是排序後的第一筆。
      // 訊息裡的數字在 groupKeyOf 已經正規化成 #，所以「干涉 0.05 mm」和「干涉 46.5 mm」
      // 會同一組；挑第一筆（行號最小）等於固定挑到最輕微的，摺疊列會寫成
      // 「L6 … 干涉 1.95 mm ×25」而真正要看的 46.5 mm 被蓋在底下。
      let lead = 0;
      for (let i = 1; i < arr.length; i++) {
        if (magnitudeOf(arr[i]) > magnitudeOf(arr[lead])) lead = i;
      }
      const mags = arr.map(magnitudeOf).filter((v) => v != null && Number.isFinite(v));
      for (let i = 0; i < arr.length; i++) {
        arr[i].groupCount = arr.length;
        arr[i].groupFirst = i === lead;
        if (i === lead && arr.length > 1) {
          arr[i].groupLines = arr.map((x) => x.line);
          if (mags.length === arr.length && mags.length > 1) {
            const lo = Math.min.apply(null, mags), hi = Math.max.apply(null, mags);
            if (hi - lo > 1e-9) arr[i].groupRange = { min: lo, max: hi };
          }
        }
      }
    }
    return list;
  }

  /**
   * 合併所有來源的診斷。
   * - tokenizer 的診斷與情境無關 → 不帶 scenario。
   * - 每個情境的 run/geometry/sim 診斷：所有情境都出現的（內容完全相同）→ 收成一則、不帶 scenario；
   *   只在部分情境出現 → 每個情境各留一則並標上 scenario（ns.js：scenario「只在某情境發生時填」）。
   * - rules 的診斷本來就自己決定要不要標 scenario，原樣收下。
   * 最後依契約的鍵去重、依嚴重度（error > warning > needsInput > info）與行號排序。
   */
  function mergeDiagnostics(tok, scenarios, order, ruleDiags) {
    const out = [];
    const push = (d, scenario) => {
      const copy = Object.assign({}, d);
      if (scenario) copy.scenario = scenario; else delete copy.scenario;
      out.push(copy);
    };
    for (const d of (tok && tok.diagnostics) || []) if (d) push(d, null);

    scenarios = scenarios || {};
    const present = (order && order.length ? order : Object.keys(scenarios)).filter((sc) => !!scenarios[sc]);
    const groups = new Map();
    for (const sc of present) {
      for (const d of scenarioDiagnostics(scenarios[sc])) {
        const k = contentKey(d);
        let g = groups.get(k);
        if (!g) { g = new Map(); groups.set(k, g); }
        if (!g.has(sc)) g.set(sc, d);
      }
    }
    for (const g of groups.values()) {
      if (g.size >= present.length) { push(g.values().next().value, null); continue; }
      for (const [sc, d] of g) push(d, sc);
    }

    for (const d of ruleDiags || []) if (d) push(d, d.scenario || null);
    return reindex(sortDiagnostics(dedupe(out)));
  }

  // ---------------------------------------------------------------------------
  // 主流程（同步部分）
  // ---------------------------------------------------------------------------
  function runPipeline(req, stage, signal) {
    if (typeof NC.tokenize !== 'function') throw new Error('analyze：tokenizer.js 未載入');
    if (typeof NC.interpret !== 'function') throw new Error('analyze：interpreter.js 未載入');

    stage('tokenize');
    const tok = NC.tokenize(req.text);
    throwIfAborted(signal);

    const order = req.scenarios;
    const scenarios = {};
    for (const sc of order) {
      stage('interpret', sc);
      scenarios[sc] = { run: NC.interpret(tok.blocks, req.settings, sc), geometry: null, sim: null };
      throwIfAborted(signal);
    }

    // 刀具表要在 buildSegments 之前算好：刀徑補正需要有效半徑（契約 §3）。
    stage('tools');
    const toolTable = buildToolTable(tok, scenarios, order, req);
    throwIfAborted(signal);

    for (const sc of order) {
      stage('geometry', sc);
      scenarios[sc].geometry = typeof NC.buildSegments === 'function'
        ? NC.buildSegments(scenarios[sc].run, toolTable, req.settings)
        : { segments: [], diagnostics: [], bounds: null };
      throwIfAborted(signal);
    }

    stage('stock');
    const stock = resolveStock(req, scenarios, order, toolTable);
    throwIfAborted(signal);

    return { tok, scenarios, order, toolTable, stock };
  }

  function rulesContext(base, req) {
    return {
      tok: base.tok,
      scenarios: base.scenarios,
      toolTable: base.toolTable,
      stock: base.stock,
      settings: req.settings,
    };
  }

  // 依賴素材模型的規則：素材若是推估來的，這些判定要看「干涉位置在不在切削包絡裡」再決定顏色。
  // R06 也算——它的 error 判定同樣是拿 sim 的高度圖比出來的（rules.js checkR06）。
  const STOCK_DEPENDENT_RULES = new Set(['R06', 'R20', 'R27', 'R28', 'R36']);

  const ESTIMATED_NOTE = '此判定依據「推估素材」（由切削範圍外推，不是實際毛胚），請在「素材與設定」填入真實素材尺寸後再確認。';

  const OUTSIDE_NOTE = '干涉位置落在「程式有切到的範圍」之外，也就是推估素材往外多擴的那一圈——'
    + '那一圈料實際上多半不存在（程式本來就不清那裡），所以這一則降成提醒。填入真實素材尺寸後會重算。';
  const INSIDE_NOTE = '干涉位置落在「程式有切到的範圍」之內，這一塊料不論毛胚多大都一定存在，'
    + '所以即使素材是推估的，這一則仍然算數。';
  const UNCUT_NOTE = '干涉位置的材料是「未加工的毛胚頂面」——程式從頭到尾沒有在那裡切過，'
    + '代表這塊料完全是推估出來的（推估素材會依刀具掃掠範圍往外擴，面銑刀尤其誇張）。'
    + '真機上那裡有沒有料，取決於毛胚實際尺寸與前工程，所以這一則降成提醒。填入真實素材尺寸後會重算。';
  // 干涉深到這個程度時，不管素材怎麼估都是撞
  const DEEP_INTRUSION_MM = 5;

  /** 診斷的干涉位置是否落在「未外擴的切削包絡」之內（XY 平面判斷）；沒有位置資訊回 null */
  function insideCutEnvelope(d, bounds) {
    if (!bounds || !bounds.min || !bounds.max) return null;
    const p = d && d.pos;
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    if (!Number.isFinite(bounds.min.x) || !Number.isFinite(bounds.max.x)) return null;
    const m = 1e-6;
    return p.x >= bounds.min.x - m && p.x <= bounds.max.x + m
      && p.y >= bounds.min.y - m && p.y <= bounds.max.y + m;
  }

  /**
   * 成品輪廓區（XY）：判斷「這個位置的材料是不是一定存在」的依據。
   *
   * 不能用 geometry.bounds（切削包絡），因為面銑刀的掃掠會把它撐到工件外好幾十 mm：
   * 面銑刀走的範圍比工件寬得多，包絡就跟著被撐大，於是工件外的干涉點被判成
   * 「在切削範圍內」而留下紅字——但工件輪廓只到 X±58，那裡有沒有料完全取決於毛胚多大。
   *
   * 改用「成品輪廓」：優先取刀徑補正後的精修輪廓段（G41/G42 走出來的就是工件外形），
   * 沒有補正段時退而取「明顯低於頂面」的切削段（深度切削不會憑空切空氣，範圍可信），
   * 再沒有才回到切削包絡。
   */
  const SURFACE_SKIM_MM = 2;   // 距頂面這麼淺的切削視為面銑／刮面，範圍不足以證明毛胚大小
  function partRegionOf(scenarios, order, stock, toolTable) {
    const keys = (order && order.length) ? order : Object.keys(scenarios || {});
    const top = (stock && stock.max && Number.isFinite(stock.max.z)) ? stock.max.z : null;
    const box = () => ({ min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } });
    const put = (b, p) => {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      if (p.x < b.min.x) b.min.x = p.x; if (p.x > b.max.x) b.max.x = p.x;
      if (p.y < b.min.y) b.min.y = p.y; if (p.y > b.max.y) b.max.y = p.y;
    };
    const ok = (b) => Number.isFinite(b.min.x) && b.max.x > b.min.x && b.max.y > b.min.y;
    const comp = box(), deep = box();
    let compR = 0;
    const tools = (toolTable && Array.isArray(toolTable.tools)) ? toolTable.tools : [];
    const radiusOf = (t) => {
      const tool = tools.find((x) => x && x.t === t);
      return (tool && tool.diameter > 0) ? tool.diameter / 2 : 0;
    };
    for (const sc of keys) {
      const segs = scenarios && scenarios[sc] && scenarios[sc].geometry && scenarios[sc].geometry.segments;
      if (!Array.isArray(segs)) continue;
      for (const s of segs) {
        if (!s || s.kind === 'rapid' || !s.from || !s.to) continue;
        if (s.path === 'compensated') {
          put(comp, s.from); put(comp, s.to);
          const r = radiusOf(s.tool);
          if (r > compR) compR = r;
        }
        if (top == null || Math.min(s.from.z, s.to.z) <= top - SURFACE_SKIM_MM) { put(deep, s.from); put(deep, s.to); }
      }
    }
    // 補正段走的是「刀心」路徑，比成品輪廓往外偏一個刀半徑；要縮回來才是真正的工件外形。
    // 不縮的話，G41 導入點（在工件外起刀的那種）掃過的空氣會被當成工件內部，
    // 分層下刀的每一層都會拿到一筆假的「G0 撞料」。
    if (ok(comp) && compR > 0) {
      const w = comp.max.x - comp.min.x, h = comp.max.y - comp.min.y;
      if (w > 2 * compR && h > 2 * compR) {
        comp.min.x += compR; comp.max.x -= compR;
        comp.min.y += compR; comp.max.y -= compR;
      }
    }
    if (ok(comp)) return comp;
    if (ok(deep)) return deep;
    return null;
  }

  /**
   * 干涉點的材料是不是「原始毛胚頂面」（程式從沒切過那裡）。
   * R27/R28/R20/R36 的 pos.z 是干涉點的材料高度；等於推估素材頂面就代表
   * 那塊料完全是推估出來的，程式自己都沒把它當材料處理過。
   */
  const UNCUT_TOL_MM = 0.05;
  function isUncutStockTop(d, stock) {
    const top = (stock && stock.max && Number.isFinite(stock.max.z)) ? stock.max.z : null;
    if (top == null) return null;
    const p = d && d.pos;
    if (!p || typeof p.z !== 'number' || !Number.isFinite(p.z)) return null;
    if (d.ruleId === 'R06') return null;   // R06 的 pos.z 是刀尖 Z，不是材料高度
    return Math.abs(p.z - top) <= UNCUT_TOL_MM;
  }

  /** 取所有情境的切削包絡（geometry.bounds，未外擴）聯集 */
  function cutEnvelopeOf(scenarios, order) {
    let out = null;
    const keys = (order && order.length) ? order : Object.keys(scenarios || {});
    for (const sc of keys) {
      const b = scenarios && scenarios[sc] && scenarios[sc].geometry && scenarios[sc].geometry.bounds;
      if (!b || !b.min || !b.max || !Number.isFinite(b.min.x) || !Number.isFinite(b.max.x)) continue;
      if (!out) { out = { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } }; continue; }
      out.min.x = Math.min(out.min.x, b.min.x); out.min.y = Math.min(out.min.y, b.min.y); out.min.z = Math.min(out.min.z, b.min.z);
      out.max.x = Math.max(out.max.x, b.max.x); out.max.y = Math.max(out.max.y, b.max.y); out.max.z = Math.max(out.max.z, b.max.z);
    }
    return out;
  }

  /**
   * 素材是推估值時，把依賴素材的判定降級並註明依據。
   * 推估素材是「由切削包絡外擴刀半徑」而來，程式本來就不會清除那一圈材料，
   * 常讓工件外的合法 G0 橫移看起來像在犁材料（面銑刀在工件外橫移最常見）。
   * 用猜出來的輸入報紅字會讓現場失去信任，所以：
   *   error   → 降成 warning 並附註（整合決議 15）
   *   warning → 仍是 warning，但一樣附註，讓現場知道判定依據是猜出來的素材（整合決議 16）
   */
  function softenEstimatedStock(list, stock, envelope) {
    if (!stock || stock.source !== 'estimated') return list;
    return list.map((d) => {
      if (!d || !STOCK_DEPENDENT_RULES.has(d.ruleId) || d.estimatedStock) return d;
      if (d.severity !== 'error' && d.severity !== 'warning') return d;
      // 兩段判斷（不再一刀切）：
      //  (1) 干涉位置落在切削包絡外 → 那是推估素材多擴出來的一圈，降成 warning
      //  (2) 落在包絡內、或干涉深度 >= 5 mm → 這塊料一定存在，紅字留著
      // 一刀切的話，「G0 直接下進實心料」這種真正該紅的，會和同一份清單裡
      // 47 筆「工件外圍那一圈」的假警報同色同級，真正的撞刀就被埋掉了。
      const inside = insideCutEnvelope(d, envelope);
      const uncut = isUncutStockTop(d, stock);
      const deep = typeof d.magnitude === 'number' && d.magnitude >= DEEP_INTRUSION_MM;
      // 落在包絡外 → 那一圈料是推估出來的，不管干涉多深都降級（深度本身也是猜的）；
      // 落在包絡內 → 這塊料一定存在，紅字留著；
      // 沒有位置資訊 → 只有干涉很深（≥5 mm）才敢留紅字，其餘降級。
      // 再加一道：干涉點的材料若是「原始毛胚頂面」（程式從沒切過那裡），
      // 那塊料純粹來自推估，不能當紅字。干涉點落在成品輪廓外、材料又是未加工的毛胚頂面
      // （未加工的頂面），工件輪廓只到 X±58 —— 真機上那裡多半是空的。
      const keep = d.severity === 'error'
        && uncut !== true
        && (inside === true || (inside === null && deep));
      const parts = [ESTIMATED_NOTE];
      if (keep) parts.push(INSIDE_NOTE);
      else if (uncut === true) parts.push(UNCUT_NOTE);
      else if (inside === false) parts.push(OUTSIDE_NOTE);
      const note = parts.join('\n');
      return Object.assign({}, d, {
        severity: keep ? d.severity : 'warning',
        detail: d.detail ? d.detail + '\n' + note : note,
        estimatedStock: true,
        estimatedStockInside: inside === true,
      });
    });
  }

  /**
   * G28 多軸同動（R17 warning）在「Z 已經高過素材頂面一段」時降成 info（整合決議 17）。
   * 四支程式的 `G91G28Y0.Z0.` 都是刻意把工作台送到前方方便卸料，執行時 Z 已在 Z50，
   * 撞不到工件；只有 Z 還在低處時 XY 先動才真的危險。
   * interpreter 看不到素材，所以這一步放在 analyze 做。
   */
  const G28_SAFE_CLEARANCE = 5;
  function softenSafeRefReturn(list, stock) {
    const top = stock && stock.max ? stock.max.z : null;
    if (top == null || !Number.isFinite(top)) return list;
    return list.map((d) => {
      if (!d || d.ruleId !== 'R17' || d.severity !== 'warning' || !d.multiAxis) return d;
      if (!d.pos || !(d.pos.z >= top + G28_SAFE_CLEARANCE)) return d;
      const note = `執行到這一行時 Z 已在 ${U.fmt(d.pos.z)}（比素材頂面 ${U.fmt(top)} 高 ${U.fmt(d.pos.z - top)} mm），撞不到工件，所以只是提醒。`;
      return Object.assign({}, d, {
        severity: 'info',
        detail: d.detail ? d.detail + '\n' + note : note,
        safeClearance: true,
      });
    });
  }

  /** 依實際素材對診斷做最後調整，再重新去重、排序、編號（降級會改變排序）。 */
  function finalizeDiagnostics(list, stock, envelope) {
    return reindex(sortDiagnostics(dedupe(softenSafeRefReturn(softenEstimatedStock(list, stock, envelope), stock))));
  }

  function finish(base, req, ruleDiags, rulesError, stage) {
    const result = {
      tok: base.tok,
      scenarios: base.scenarios,
      toolTable: base.toolTable,
      stock: base.stock,
      diagnostics: finalizeDiagnostics(
        mergeDiagnostics(base.tok, base.scenarios, base.order, ruleDiags),
        base.stock,
        partRegionOf(base.scenarios, base.order, base.stock, base.toolTable)
          || cutEnvelopeOf(base.scenarios, base.order)),
    };
    if (rulesError.length) result.rulesError = rulesError;
    stage('done');
    return result;
  }

  // ---------------------------------------------------------------------------
  // 對外：analyzeSync（不含模擬）
  // ---------------------------------------------------------------------------
  /**
   * 同步分析（不跑模擬）。編輯中每次改字都可以呼叫。
   * @param {AnalysisRequest} request
   * @param {function} [onStage]
   * @returns {AnalysisResult}
   */
  function analyzeSync(request, onStage) {
    const req = normalizeRequest(request);
    const stage = stageReporter(onStage);
    const signal = req.signal;
    const base = runPipeline(req, stage, signal);
    const rulesError = [];
    stage('rules');
    const ruleDiags = runRules(rulesContext(base, req), null, rulesError);
    throwIfAborted(signal);
    return finish(base, req, ruleDiags, rulesError, stage);
  }

  // ---------------------------------------------------------------------------
  // 對外：analyze（可含模擬）
  // ---------------------------------------------------------------------------
  /**
   * 完整分析。request.sim.enabled 時對每個情境各跑一次模擬，再讓 rules 的 sim/cross 階段跑第二趟。
   * @param {AnalysisRequest} request
   * @param {function} [onStage] (stage, scenario?, progress?)
   * @returns {Promise<AnalysisResult>}
   */
  async function analyze(request, onStage) {
    const req = normalizeRequest(request);
    const stage = stageReporter(onStage);
    const signal = req.signal;
    const base = runPipeline(req, stage, signal);
    const rulesError = [];

    stage('rules');
    const pass1 = runRules(rulesContext(base, req), null, rulesError);
    throwIfAborted(signal);

    let ruleDiags = pass1;
    const canSim = req.sim.enabled && NC.sim && typeof NC.sim.create === 'function' && typeof NC.sim.run === 'function';
    if (canSim) {
      for (const sc of base.order) {
        const sr = base.scenarios[sc];
        if (!sr) continue;
        stage('sim', sc, 0);
        throwIfAborted(signal);
        let sim;
        try {
          sim = NC.sim.create(base.stock, req.sim.cell);
        } catch (e) {
          throw new Error('模擬失敗（情境 ' + sc + '）：' + ((e && e.message) || e));
        }
        try {
          sr.sim = await NC.sim.run(sim, sr, base.toolTable, req.settings, {
            onProgress: (p) => {
              stage('sim', sc, p);
              // 進度回呼是模擬中途唯一的插斷點：丟出去讓 sim.run 的 Promise 直接 reject。
              if (aborted(signal)) throw abortError();
            },
          });
        } catch (e) {
          if (isAbortError(e)) throw e;
          throw new Error('模擬失敗（情境 ' + sc + '）：' + ((e && e.message) || e));
        }
        stage('sim', sc, 1);
        throwIfAborted(signal);
      }
      stage('rulesSim');
      const pass2 = runRules(rulesContext(base, req), ['sim', 'cross'], rulesError);
      throwIfAborted(signal);
      ruleDiags = combineRules(pass1, pass2);
    }

    return finish(base, req, ruleDiags, rulesError, stage);
  }

  NC.analyze = analyze;
  NC.analyzeSync = analyzeSync;
  NC.analysis = {
    defaultRequest, normalizeRequest, mergeDiagnostics, sortDiagnostics, dedupeDiagnostics: dedupe,
    finalizeDiagnostics, softenEstimatedStock, softenSafeRefReturn,
    isAbortError, abortError, SEVERITY_RANK,
  };
})(globalThis.NC = globalThis.NC || {});
