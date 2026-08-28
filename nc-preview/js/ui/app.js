/*
 * NC 預演台 — 應用程式主控（CONTRACT §8 app）
 *
 * 責任：
 *   1. 開檔（按鈕 + 整頁拖放，UTF-8 → big5 解碼）、存檔（Blob 下載）、複製、載入內建範例、URL hash #sample=…
 *   2. 分析流程：編輯／換檔 → 立刻 analyzeSync（路徑、診斷、模態、刀具表、作業摘要）
 *      → 1 秒後 analyze（含模擬），用版本號丟棄過時結果，進度顯示在狀態列
 *   3. 選取同步：編輯器游標行 ↔ 視圖 ↔ 診斷 ↔ 作業
 *   4. 刀具表／設定存 localStorage（file:// 下可能失敗，全部 try/catch）
 *   5. 刀具表 CSV 匯出／匯入（拿給現場用 Excel 填），刀庫設定（機台層級，key = ncPreview.machine）
 *
 * 對 analyze.js / rules.js 尚未載入的情況要容錯：
 *   NC.analyzeSync / NC.analyze 不存在時，本檔自己串 tokenize → interpret → buildSegments（→ sim）。
 */
(function (NC) {
  'use strict';
  const ui = (NC.ui = NC.ui || {});
  const U = NC.util;

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  const SEV_ORDER = { error: 0, warning: 1, needsInput: 2, info: 3 };
  const SETTINGS_KEY = 'ncPreview.appSettings.v1';
  // 刀庫是整台機共用的，不跟著程式號走 → 自己一個 key，換程式不會被洗掉。
  const MACHINE_KEY = 'ncPreview.machine';
  // 第四軸的裝夾參數（迴轉中心、工件直徑）**跟著程式走**，不是機台設定：
  // 現場說「Z 高度不一定，會依案子調整」，放進機台設定的話換一支程式就帶著上一支的值。
  const ROTARY_KEY = 'ncPreview.rotary.v1';

  /** 數字顯示（panels.logic.fmt 修掉了 NC.util.fmt 的去尾 0 問題，優先用它）。 */
  const fmt = (NC.ui.panels && NC.ui.panels.logic && NC.ui.panels.logic.fmt)
    || function (v, d) {
      if (v == null || Number.isNaN(v)) return '—';
      d = d == null ? 3 : d;
      const s = (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
      return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
    };

  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (el) el.classList.toggle('nc-hidden', !on); };
  const clearEl = (el) => { while (el && el.firstChild) el.removeChild(el.firstChild); };

  /**
   * 範例的短代號（下拉選單的 value 與 URL hash 用）：`樣本 C` → `樣本 C`。
   * samples.js 由 tools/make-samples.mjs 產生，只保證有 {name, text}；若日後補了 id 就直接用。
   */
  function sampleId(s) {
    if (!s) return '';
    if (s.id) return String(s.id);
    return String(s.name || '').replace(/\(\d+\)$/, '').replace(/-$/, '') || String(s.name || '');
  }

  /** 依短代號或檔名找範例（不分大小寫，允許前綴）。 */
  function findSample(key) {
    const list = ui.samples || [];
    const k = String(key == null ? '' : key).trim().toLowerCase();
    if (!k) return null;
    return list.find((s) => sampleId(s).toLowerCase() === k)
      || list.find((s) => String(s.name || '').toLowerCase() === k)
      || list.find((s) => String(s.name || '').toLowerCase().indexOf(k) === 0)
      || null;
  }

  /** 程式識別鍵：有 O 號用 O 號，否則用檔名（刀具表存 localStorage 的 key）。 */
  function programKeyOf(tok, fileName) {
    if (tok && tok.programNumber != null) return 'O' + String(tok.programNumber).padStart(4, '0');
    return fileName || '(未命名)';
  }

  /** 解碼：先試 UTF-8（fatal），失敗改 big5；都不行就 latin1。保留原始行尾。 */
  function decodeBytes(buf) {
    const bytes = new Uint8Array(buf);
    try {
      const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { text: t.replace(/^﻿/, ''), encoding: 'UTF-8' };
    } catch (e) { /* 不是合法 UTF-8，往下試 big5 */ }
    try {
      return { text: new TextDecoder('big5').decode(bytes), encoding: 'Big5' };
    } catch (e) { /* 瀏覽器不支援 big5 */ }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return { text: s, encoding: 'Latin-1' };
  }

  function downloadText(fileName, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'program.nc';   // 保留無副檔名與括號的原檔名
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 退回舊做法 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } },
  };

  // ---------------------------------------------------------------------------
  // 分析：優先用 NC.analyze / NC.analyzeSync，沒有就自己串
  // ---------------------------------------------------------------------------
  function sortDiagnostics(list) {
    return list.slice().sort((a, b) => {
      const sa = SEV_ORDER[a.severity] == null ? 9 : SEV_ORDER[a.severity];
      const sb = SEV_ORDER[b.severity] == null ? 9 : SEV_ORDER[b.severity];
      if (sa !== sb) return sa - sb;
      if (a.line !== b.line) return a.line - b.line;
      return String(a.ruleId).localeCompare(String(b.ruleId));
    });
  }

  /** tokenize → interpret ×N → buildTable → buildSegments ×N → estimateStock（不含 sim、不含 rules）。 */
  function fallbackCore(request) {
    const settings = request.settings || U.defaultSettings();
    const tok = NC.tokenize(request.text || '');
    const ids = (request.scenarios && request.scenarios.length) ? request.scenarios.slice() : ['off'];
    if (ids.indexOf('off') < 0) ids.unshift('off');

    const runs = {};
    for (const s of ids) runs[s] = NC.interpret(tok.blocks, settings, s);

    const toolTable = NC.tools.buildTable(tok, runs.off, request.toolTable || null, request.programKey || null);

    const scenarios = {};
    const geos = [];
    for (const s of ids) {
      const geometry = NC.buildSegments(runs[s], toolTable, settings);
      scenarios[s] = { run: runs[s], geometry, sim: null };
      geos.push(geometry);
    }
    const stock = request.stock || NC.tools.estimateStock(ids.map((s) => runs[s]), geos, toolTable);
    return { tok, scenarios, toolTable, stock, diagnostics: [], _ids: ids, _settings: settings };
  }

  /** 蒐集所有診斷：tokenizer + interpreter + geometry + sim 事件 + rules（若已載入），去重後排序。 */
  function fallbackDiagnostics(res) {
    const out = [];
    const seen = new Set();
    const push = (d, scenario) => {
      if (!d || !d.ruleId) return;
      const scn = d.scenario || (scenario && scenario !== 'off' ? scenario : undefined);
      const key = d.ruleId + '|' + d.line + '|' + (scn || '') + '|' + d.message;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(scn ? Object.assign({}, d, { scenario: scn }) : d);
    };
    // 同一條規則若在 off 與 on 都出現且訊息一樣，先跑 off（不帶情境標籤）就會蓋掉 on 的重複
    const dedupeAcrossScenarios = new Set();
    const pushRun = (d, scenario) => {
      if (!d || !d.ruleId) return;
      const plain = d.ruleId + '|' + d.line + '|' + d.message;
      if (dedupeAcrossScenarios.has(plain)) return;
      dedupeAcrossScenarios.add(plain);
      push(d, scenario);
    };

    for (const d of (res.tok.diagnostics || [])) pushRun(d, null);
    for (const s of res._ids) {
      const sr = res.scenarios[s];
      if (!sr) continue;
      for (const d of (sr.run.diagnostics || [])) pushRun(d, s);
      for (const d of (sr.geometry.diagnostics || [])) pushRun(d, s);
      if (sr.sim) for (const d of (sr.sim.events || [])) push(d, s);
    }
    if (NC.rules && typeof NC.rules.run === 'function') {
      try {
        const list = NC.rules.run({
          tok: res.tok, scenarios: res.scenarios, toolTable: res.toolTable, stock: res.stock, settings: res._settings,
        }) || [];
        for (const d of list) push(d, d.scenario || null);
      } catch (e) {
        console.warn('rules.run 失敗，略過規則檢查：', e);
      }
    }
    return sortDiagnostics(out);
  }

  function analyzeSyncCompat(request) {
    if (typeof NC.analyzeSync === 'function') return NC.analyzeSync(request);
    const res = fallbackCore(request);
    res.diagnostics = fallbackDiagnostics(res);
    return res;
  }

  async function analyzeCompat(request, onStage) {
    if (typeof NC.analyze === 'function') return NC.analyze(request, onStage);
    const res = fallbackCore(request);
    if (request.sim && request.sim.enabled && NC.sim) {
      for (const s of res._ids) {
        const sr = res.scenarios[s];
        try {
          const sim = NC.sim.create(res.stock, request.sim.cell || 0.5);
          sr.sim = await NC.sim.run(sim, sr, res.toolTable, res._settings, {
            onProgress: (p) => { if (onStage) onStage('sim', s, p); },
          });
        } catch (e) {
          console.warn('模擬失敗（情境 ' + s + '）：', e);
          sr.sim = null;
        }
      }
    }
    res.diagnostics = fallbackDiagnostics(res);
    return res;
  }

  // ---------------------------------------------------------------------------
  // 主程式
  // ---------------------------------------------------------------------------
  function createApp() {
    const el = {
      app: $('app'),
      btnOpen: $('btnOpen'), fileInput: $('fileInput'), selSample: $('selSample'),
      btnSave: $('btnSave'), btnCopy: $('btnCopy'), selScenario: $('selScenario'),
      defaultBanner: $('defaultBanner'),
      statusText: $('statusText'), statusCounts: $('statusCounts'),
      progressWrap: $('progressWrap'), progressBar: $('progressBar'),
      fileLabel: $('fileLabel'), editorHost: $('editorHost'),
      modalHost: $('modalHost'), modalLineLabel: $('modalLineLabel'),
      viewCanvas: $('viewCanvas'),
      viewHost: $('viewHost'), view3dHost: $('view3dHost'), viewCanvas3d: $('viewCanvas3d'),
      btnMode3d: $('btnMode3d'), chkRef: $('chkRef'), stockBanner: $('stockBanner'), rotaryBanner: $('rotaryBanner'),
      btnModeUnroll: $('btnModeUnroll'), chkRotary: $('chkRotary'), lblRotary: $('lblRotary'),
      rngSection: $('rngSection'), secVal: $('secVal'), btnFit: $('btnFit'),
      rngSnapshot: $('rngSnapshot'), snapVal: $('snapVal'),
      chkRapid: $('chkRapid'), chkFeed: $('chkFeed'), chkStock: $('chkStock'),
      toolFilter: $('toolFilter'),
      tabTools: $('tabTools'), tabDiag: $('tabDiag'), tabOps: $('tabOps'),
      stockHost: $('stockHost'), settingsHost: $('settingsHost'), magHost: $('magHost'),
      diagBadge: $('diagBadge'), dropOverlay: $('dropOverlay'),
    };

    const state = {
      text: '',
      fileName: '',
      programKey: '(未命名)',
      settings: U.defaultSettings(),
      scenario: 'off',
      cell: 0.5,
      userTable: null,   // 使用者編輯過的刀具表（會存 localStorage）
      stock: null,       // null = 用推估
      result: null,
      hiddenTools: new Set(),
      tableSaved: true,   // 刀具表最後一次寫入 localStorage 是否成功
      machineSaved: true, // 刀庫設定最後一次寫入 localStorage 是否成功
      lineInfo: [],
      execByLine: [],
      selectedLine: 0,
      simCache: {},        // 上一輪完整分析的 SimResult（依情境），編輯途中沿用免得成品圖整片消失
      simStale: false,     // 目前畫面上的 heightmap 是不是上一輪的（HUD 會標「更新中」）
      rotary: null,        // 第四軸裝夾參數（跟著程式走，見 ROTARY_KEY）；null = 用推估值
    };

    // ---- 還原設定 ----
    (function restoreSettings() {
      const raw = store.get(SETTINGS_KEY);
      if (!raw) return;
      try {
        const o = JSON.parse(raw);
        if (o && o.settings) state.settings = Object.assign(U.defaultSettings(), o.settings);
        if (o && o.scenario) state.scenario = o.scenario;
        if (o && o.cell > 0) state.cell = o.cell;
      } catch (e) { /* 壞掉就用預設 */ }
    })();
    /** 這支程式存過的第四軸設定（沒有就 null） */
    function loadRotary(key) {
      if (!key) return null;
      try {
        const all = JSON.parse(store.get(ROTARY_KEY) || '{}');
        const o = all && all[key];
        if (!o || !o.center) return null;
        return { center: { y: Number(o.center.y) || 0, z: Number(o.center.z) || 0 }, radius: Number(o.radius) || 0 };
      } catch (e) { return null; }
    }
    function persistRotary() {
      if (!state.programKey || !state.rotary) return;
      let all = {};
      try { all = JSON.parse(store.get(ROTARY_KEY) || '{}') || {}; } catch (e) { all = {}; }
      all[state.programKey] = state.rotary;
      store.set(ROTARY_KEY, JSON.stringify(all));
    }
    /**
     * 這支程式目前生效的第四軸參數。
     *
     * **不從程式反推。** 一律「使用者填過就用他的，沒填就用 (0,0)」——
     * (0,0) 對應四軸的標準對刀方式：G54 的 Y0／Z0 就對在夾頭中心線上，
     * 那時候程式裡的 Z 值本身就是「離軸心多遠」，不需要任何額外輸入。
     *
     * 反推的那支演算法（geometry.rotary.estimateCenter）只拿來**檢查**
     * ——查各個分度孔是不是都在同一條母線上（R37），不拿來當設定值。
     * 猜出來的裝夾參數會安靜地把整張圖畫歪，而現場看不出是猜的。
     */
    function effectiveRotary() {
      if (state.rotary) return state.rotary;
      return { center: { y: 0, z: 0 }, radius: 0 };
    }

    function persistSettings() {
      // 刀庫（機台層級）與第四軸（程式層級）都另外存，這裡剔掉免得兩邊各留一份、
      // 改了其中一份就對不起來
      const s = Object.assign({}, state.settings);
      delete s.magazine;
      delete s.rotary;
      store.set(SETTINGS_KEY, JSON.stringify({ settings: s, scenario: state.scenario, cell: state.cell }));
    }

    // ---- 還原刀庫設定（機台層級，與程式號無關）----
    (function restoreMachine() {
      const raw = store.get(MACHINE_KEY);
      if (!raw) return;
      try {
        const o = JSON.parse(raw);
        const mag = ui.panels.logic.normalizeMagazine(o && o.magazine);
        if (mag) state.settings.magazine = mag;
      } catch (e) { /* 壞掉就當沒設定過，R30 不跑 */ }
    })();
    function persistMachine() {
      const mag = state.settings.magazine || null;
      state.machineSaved = store.set(MACHINE_KEY, JSON.stringify({ magazine: mag })) !== false;
    }

    // ---- 建立子元件 ----
    const editor = ui.createEditor(el.editorHost, { debounceMs: 300 });
    const view = ui.createView2D(el.viewCanvas);
    const P = ui.panels;

    // 3D 視圖：第一次切到 3D 才建（WebGL context 很貴）。建不起來就把按鈕標成不可用並說明原因。
    let view3d = null;
    let view3dFailed = false;
    let viewMode = 'top';
    function ensureView3D() {
      if (view3d || view3dFailed) return view3d;
      if (!ui.createView3D) { view3dFailed = true; return null; }
      try {
        view3d = ui.createView3D(el.viewCanvas3d);
      } catch (e) { view3d = null; }
      if (!view3d) { view3dFailed = true; return null; }
      view3d.onPick((line) => { if (line > 0) selectLine(line, { scroll: true }); });
      return view3d;
    }
    /** 對所有已建立的視圖做同一件事（3D 沒建就只做 2D） */
    function eachView(fn) { fn(view); if (view3d) fn(view3d); }

    let toolsPanel = null, diagPanel = null, modalPanel = null, opsPanel = null, stockPanel = null, settingsPanel = null, magPanel = null;

    modalPanel = P.modal(el.modalHost, null, null);
    stockPanel = P.stock(el.stockHost, {
      stock: { min: { x: -50, y: -50, z: -10 }, max: { x: 50, y: 50, z: 0 }, source: 'estimated', fixtures: [] },
      onChange: (s) => { state.stock = s; refresh(); },
    });
    settingsPanel = P.settings(el.settingsHost, {
      settings: state.settings, scenario: state.scenario, cell: state.cell,
      onChange: (o) => {
        state.settings = o.settings;
        // 第四軸是「這個案子怎麼裝夾」，抽出來跟著程式存，不要混進機台設定
        if (o.settings && o.settings.rotary) {
          state.rotary = U.deepClone(o.settings.rotary);
          delete state.settings.rotary;
          persistRotary();
        }
        state.scenario = o.scenario;
        state.cell = o.cell;
        el.selScenario.value = state.scenario;
        persistSettings();
        refresh();
      },
    });
    toolsPanel = P.toolTable(el.tabTools, {
      table: { programKey: '', tools: [], offsets: [], updatedAt: '' },
      ops: [],
      onChange: (table) => {
        state.userTable = table;
        // file:// 下 localStorage 可能被擋，save 內部已 try/catch，這裡只記下有沒有成功
        state.tableSaved = NC.tools.save(state.programKey, table) !== false;
        refresh();
      },
      onExportCSV: () => exportToolCSV(),
      onImportFile: (file) => openToolCSVFile(file),
    });
    magPanel = P.magazine(el.magHost, {
      magazine: state.settings.magazine || null,
      toolTable: { programKey: '', tools: [], offsets: [], updatedAt: '' },
      usedTools: [],
      onChange: (mag) => {
        // 沒啟用時 settings.magazine 必須整個不存在（R30 靠它決定跑不跑）
        if (mag) state.settings.magazine = mag; else delete state.settings.magazine;
        persistMachine();
        // 設定面板手上是另一份 settings 複本，不同步的話它下次 onChange 會把刀庫吃掉
        settingsPanel.update({ settings: state.settings, scenario: state.scenario, cell: state.cell });
        refresh();
      },
    });
    diagPanel = P.diagnostics(el.tabDiag, {
      items: [],
      onJump: (line, item) => jumpToLine(line, { from: 'diag', item }),
      onFix: (item) => applyFix(item),
    });
    opsPanel = P.ops(el.tabOps, {
      ops: [],
      onJump: (line, op) => {
        jumpToLine(line, { from: 'ops' });
        eachView((v) => v.highlightTool(op && op.tool != null ? op.tool : null));
      },
    });

    // -------------------------------------------------------------------------
    // 狀態列
    // -------------------------------------------------------------------------
    let statusBase = '尚未載入程式';
    function setStatus(text) { statusBase = text; el.statusText.textContent = text; }
    function setProgress(p) {
      if (p == null) { show(el.progressWrap, false); return; }
      show(el.progressWrap, true);
      el.progressBar.style.width = Math.round(U.clamp(p, 0, 1) * 100) + '%';
    }
    function renderCounts(diags, pending) {
      clearEl(el.statusCounts);
      const by = { error: 0, warning: 0, needsInput: 0, info: 0 };
      for (const d of diags) if (by[d.severity] != null) by[d.severity]++;
      for (const sev of ['error', 'warning', 'needsInput', 'info']) {
        if (!by[sev]) continue;
        const sp = document.createElement('span');
        sp.className = 'nc-pill nc-pill-' + sev;
        sp.textContent = { error: '錯 ', warning: '警 ', needsInput: '需 ', info: '訊 ' }[sev] + by[sev];
        el.statusCounts.appendChild(sp);
      }
      if (pending) {
        const sp = document.createElement('span');
        sp.className = 'nc-pill nc-pill-pending';
        sp.textContent = '模擬中，尚未含碰撞檢查';
        sp.title = '碰撞（R27）、重切削（R28）等要等素材模擬跑完才會出現，大約 1 秒。';
        el.statusCounts.appendChild(sp);
      }
      const n = by.error || by.warning;
      show(el.diagBadge, n > 0);
      if (n > 0) {
        el.diagBadge.textContent = String(by.error || by.warning);
        el.diagBadge.classList.toggle('is-warn', !by.error);
      }
    }

    // -------------------------------------------------------------------------
    // 分析排程（版本號丟棄過時結果）
    // -------------------------------------------------------------------------
    let version = 0;
    let fullTimer = 0;
    let liveSignal = null;   // 目前這一輪的中止旗標（analyze.js 支援 request.signal）

    const STAGE_LABEL = {
      tokenize: '斷字', interpret: '解譯', tools: '刀具', geometry: '路徑',
      stock: '素材', rules: '規則檢查', sim: '模擬', rulesSim: '模擬後檢查', done: '完成',
    };

    function isAbortError(e) {
      if (NC.analysis && typeof NC.analysis.isAbortError === 'function') return NC.analysis.isAbortError(e);
      return !!(e && (e.name === 'AbortError' || e.aborted === true));
    }

    function buildRequest(withSim, signal) {
      const ids = ['off', 'on'];
      if (ids.indexOf(state.scenario) < 0) ids.push(state.scenario);
      return {
        text: state.text,
        // rotary 不存在機台設定裡（見 ROTARY_KEY），但 core/rules 是從 settings 讀，
        // 所以每次組 request 時把「這支程式生效的值」補進去
        settings: Object.assign({}, state.settings, { rotary: effectiveRotary() }),
        toolTable: state.userTable,
        stock: state.stock,
        scenarios: ids,
        sim: { enabled: !!withSim, cell: state.cell },
        programKey: state.programKey,
        signal: signal || null,
      };
    }

    /** 立刻做同步分析（無模擬），並排程 delay ms 之後的完整分析（含模擬）。 */
    function refresh(opts) {
      opts = opts || {};
      const ver = ++version;
      if (liveSignal) liveSignal.aborted = true;   // 讓還在跑的完整分析自己停下來
      liveSignal = { aborted: false };
      if (fullTimer) { clearTimeout(fullTimer); fullTimer = 0; }
      if (!state.text) {
        state.result = null;
        state.lineInfo = [];
        state.execByLine = [];
        setStatus('尚未載入程式');
        setProgress(null);
        renderCounts([]);
        editor.setDiagnostics([]);
        view.setData({ segments: [], sim: null, stock: null, toolTable: null, scenario: state.scenario });
        toolsPanel.update({ table: { programKey: '', tools: [], offsets: [], updatedAt: '' }, ops: [] });
        magPanel.update({ toolTable: { programKey: '', tools: [], offsets: [], updatedAt: '' }, usedTools: [] });
        diagPanel.update({ items: [] });
        opsPanel.update({ ops: [], toolTable: null, time: null });
        modalPanel.update(null, null);
        renderToolFilter({ tools: [] }, []);
        show(el.defaultBanner, false);
        el.rngSnapshot.disabled = true;
        el.snapVal.textContent = '尚未模擬';
        return;
      }
      const t0 = (performance && performance.now) ? performance.now() : Date.now();
      let res = null;
      try {
        res = analyzeSyncCompat(buildRequest(false, null));
      } catch (e) {
        console.error('分析失敗：', e);
        setStatus('分析失敗：' + (e && e.message ? e.message : e));
        return;
      }
      if (ver !== version) return;
      const ms = ((performance && performance.now) ? performance.now() : Date.now()) - t0;
      applyResult(res, false);
      setStatus(describeResult(res) + ' · 分析 ' + Math.round(ms) + ' ms');
      const delay = opts.fullDelay == null ? 1000 : opts.fullDelay;
      fullTimer = setTimeout(() => runFull(ver), delay);
    }

    async function runFull(ver) {
      if (ver !== version) return;
      const signal = liveSignal;
      setProgress(0);
      el.statusText.textContent = statusBase + ' · 模擬中…';
      let res = null;
      try {
        res = await analyzeCompat(buildRequest(true, signal), (stage, scenario, progress) => {
          if (ver !== version) return;
          if (stage === 'sim' && typeof progress === 'number') {
            setProgress(progress);
            el.statusText.textContent = statusBase + ' · 模擬中 ' + Math.round(progress * 100) + '%';
          } else if (STAGE_LABEL[stage] && stage !== 'done') {
            el.statusText.textContent = statusBase + ' · ' + STAGE_LABEL[stage] + '…';
          }
        });
      } catch (e) {
        if (isAbortError(e)) return;   // 已被新的一輪取代
        console.error('完整分析失敗：', e);
        if (ver === version) { setProgress(null); el.statusText.textContent = statusBase + ' · 模擬失敗：' + ((e && e.message) || e); }
        return;
      }
      if (ver !== version) return;   // 已經有新版本，丟棄
      setProgress(null);
      applyResult(res, true);
      const sr = res.scenarios[state.scenario] || res.scenarios.off;
      const secs = sr && sr.sim && sr.sim.time ? sr.sim.time.total : 0;
      setStatus(describeResult(res) + (secs > 0 ? ' · 估時 ' + fmtDuration(secs) : ''));
    }

    function fmtDuration(sec) {
      if (!(sec > 0)) return '—';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.round(sec % 60);
      if (h > 0) return `${h} 小時 ${m} 分`;
      return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
    }

    function describeResult(res) {
      const n = res.tok.blocks.length;
      const name = state.fileName || state.programKey;
      const on = res.tok.programName ? `（${res.tok.programName}）` : '';
      const key = state.programKey === name ? '' : ' · ' + state.programKey;
      // 存不進去要講出來，不然使用者填了一整天的刀具表／刀庫，關掉分頁就沒了
      const saveNote = (state.tableSaved === false ? ' · 刀具表無法存入瀏覽器' : '')
        + (state.machineSaved === false ? ' · 刀庫設定無法存入瀏覽器' : '');
      return `${name}${on} · ${n} 行${key}${saveNote}`;
    }

    // -------------------------------------------------------------------------
    // 套用分析結果
    // -------------------------------------------------------------------------
    function applyResult(res, hasSim) {
      state.result = res;

      // O 號可能被編輯改掉 → 換 key、換存檔位置
      const key = programKeyOf(res.tok, state.fileName);
      let keyChanged = false;
      if (key !== state.programKey) {
        state.programKey = key;
        state.rotary = loadRotary(key);
        const saved = NC.tools.load(key);
        // saved 是 null 時一定要把舊程式的手填刀具表清掉，否則 O1004 的 Ø49.5
        // 會跟著跑到 O0999，而且下次存檔會把這份錯的資料存進新的 key。
        const before = state.userTable;
        state.userTable = saved || null;
        keyChanged = before !== state.userTable;
        state.simCache = {};
      }

      const sr = res.scenarios[state.scenario] || res.scenarios.off;
      const run = sr.run;

      // 編輯途中的同步分析沒有模擬結果。直接把 null 丟給視圖的話，成品圖會整片消失一秒鐘，
      // 狀態列的紅字計數也會跟著跳；沿用上一輪的 heightmap（格網對得起來才用）並標成「更新中」。
      let simForView = sr.sim;
      state.simStale = false;
      if (hasSim) {
        state.simCache[state.scenario] = sr.sim || null;
      } else if (!simForView) {
        const cached = state.simCache[state.scenario];
        if (cached && simMatchesStock(cached, res.stock)) { simForView = cached; state.simStale = true; }
      }

      // ---- 編輯器：診斷 + 行旁資訊 ----
      buildLineTables(res, sr);
      editor.setDiagnostics(res.diagnostics);
      editor.setLineInfo((line) => state.lineInfo[line] || '');

      // ---- 視圖 ----
      const viewData = {
        segments: sr.geometry.segments,
        sim: simForView,
        simStale: state.simStale,
        stock: res.stock,
        toolTable: res.toolTable,
        scenario: state.scenario,
        rotaryCenter: rotaryCenterOf(),
        rotary: rotaryOptOf(run),
      };
      eachView((v) => v.setData(viewData));
      syncRotaryUI(run);
      syncSectionRange(res.stock);
      syncSnapshotSlider(simForView, run.ops, state.simStale);
      renderToolFilter(res.toolTable, sr.geometry.segments);
      applyVisible();

      // ---- 面板 ----
      toolsPanel.update({ table: res.toolTable, ops: run.ops });
      diagPanel.update({ items: res.diagnostics });
      opsPanel.update({ ops: run.ops, toolTable: res.toolTable, time: sr.sim ? sr.sim.time : null });
      stockPanel.update({ stock: res.stock });
      settingsPanel.update({
        settings: Object.assign({}, state.settings, { rotary: effectiveRotary() }),
        scenario: state.scenario, cell: state.cell, rotaryUsed: !!rotaryOptOf(run),
      });
      magPanel.update({
        magazine: state.settings.magazine || null,
        toolTable: res.toolTable,
        usedTools: usedToolsOf(run),
      });

      renderCounts(res.diagnostics, !hasSim);
      renderDefaultBanner(res.toolTable, run.ops);
      renderStockBanner(res.stock, res.diagnostics);
      renderRotaryBanner(run);
      showModalFor(state.selectedLine || editor.getCursorLine());

      // 換了 O 號 → 刀具表換了一份，得用新的表重算一次（畫面上的結果現在還是舊表算的）
      if (keyChanged) setTimeout(() => { if (state.text) refresh(); }, 0);
    }

    /** 這支程式真的換上主軸過的 T 號（刀庫面板只列這些，不然一次列 24 格沒重點） */
    function usedToolsOf(run) {
      const out = [];
      for (const op of ((run && run.ops) || [])) if (op.tool != null && out.indexOf(op.tool) < 0) out.push(op.tool);
      return out.sort((a, b) => a - b);
    }

    // -------------------------------------------------------------------------
    // 刀具表 CSV（拿給現場用 Excel 填直徑、角度、刃長、D 補正值）
    // -------------------------------------------------------------------------
    function exportToolCSV() {
      const res = state.result;
      if (!res || !res.toolTable || !res.toolTable.tools.length) {
        toolsPanel.setImportStatus('沒有刀具可以匯出（這支程式裡沒有 M6 換刀）', 'error');
        return false;
      }
      let csv;
      try {
        const sr = res.scenarios.off || currentScenario();
        csv = NC.tools.toCSV(res.toolTable, { tok: res.tok, run: sr ? sr.run : null });
      } catch (e) {
        console.error('匯出 CSV 失敗：', e);
        toolsPanel.setImportStatus('匯出失敗：' + ((e && e.message) || e), 'error');
        return false;
      }
      const name = P.logic.csvFileName(state.programKey);
      // BOM 一定要有：少了它 Excel 用系統 ANSI 讀，中文欄名整排變亂碼
      downloadText(name, P.logic.withBOM(csv), 'text/csv;charset=utf-8');
      toolsPanel.setImportStatus(`已匯出 ${res.toolTable.tools.length} 把刀到 ${name}（UTF-8 BOM，Excel 可直接開）`, 'ok');
      setStatus('已匯出 ' + name);
      return true;
    }

    /**
     * CSV 的「程式」欄可能寫 O 號，也可能寫檔名（刀具資料 CSV 寫的是 樣本 A）。
     * 兩個都試過再退回「整份都收」，免得欄位對不上就整份匯不進來。
     */
    function readToolCSV(text) {
      for (const key of [state.programKey, state.fileName]) {
        if (!key) continue;
        const t = NC.tools.fromCSV(text, key);
        if (t && t.tools && t.tools.length) return t;
      }
      return NC.tools.fromCSV(text, null);
    }

    function importToolCSV(text, fileName) {
      if (!state.result) {
        toolsPanel.setImportStatus('請先載入 NC 程式，再匯入刀具表', 'error');
        return false;
      }
      let imported = null;
      try {
        imported = readToolCSV(text);
      } catch (e) {
        console.warn('CSV 解析失敗：', e);
        toolsPanel.setImportStatus('這個 CSV 讀不進來：' + ((e && e.message) || e), 'error');
        return false;
      }
      if (!imported || !imported.tools || !imported.tools.length) {
        toolsPanel.setImportStatus('這個檔案裡找不到刀具資料。第一列要有欄名而且必須包含「T」欄——'
          + '最保險的做法是先按「匯出 CSV」，在那份檔案上直接填。', 'error');
        return false;
      }
      const r = P.logic.mergeCSVTable(state.userTable || state.result.toolTable, imported);
      // 「8?」這種有寫東西但不是純數字的格子，fromCSV 會整格丟掉。不講的話現場會以為填進去了
      let unparsed = [];
      try { unparsed = P.logic.csvUnparsedCells(text); } catch (e) { unparsed = []; }
      const from = fileName ? `（來源 ${fileName}）` : '';
      const msg = P.logic.describeImport(r, unparsed);
      if (!r.tools && !r.offsets) {
        toolsPanel.setImportStatus(msg + '——「請填_」欄位留白時不會覆蓋推測值。' + from, 'warn');
        return false;
      }
      state.userTable = r.table;
      state.tableSaved = NC.tools.save(state.programKey, r.table) !== false;
      toolsPanel.setImportStatus(msg + from, P.logic.importStatusKind(r, unparsed));
      setStatus(msg);
      refresh();
      return true;
    }

    function openToolCSVFile(file) {
      if (!file) return;
      readFile(file).then((r) => importToolCSV(r.text, file.name)).catch((e) => {
        toolsPanel.setImportStatus('讀檔失敗：' + file.name + ((e && e.message) ? '（' + e.message + '）' : ''), 'error');
      });
    }

    /** 舊的 SimResult 和目前素材的格網對不對得起來（對不起來就不能沿用） */
    function simMatchesStock(sim, stock) {
      if (!sim || !stock || !stock.min || !stock.max) return false;
      const cell = sim.cell > 0 ? sim.cell : state.cell;
      const nx = Math.ceil((stock.max.x - stock.min.x) / cell - 1e-9) + 1;
      const ny = Math.ceil((stock.max.y - stock.min.y) / cell - 1e-9) + 1;
      return sim.nx === nx && sim.ny === ny
        && Math.abs(sim.origin.x - stock.min.x) < 1e-9 && Math.abs(sim.origin.y - stock.min.y) < 1e-9;
    }

    /** 建立 行號 → ExecutedBlock、行號 → 行旁資訊字串 兩張表（O(1) 查詢）。 */
    function buildLineTables(res, sr) {
      const blocks = res.tok.blocks || [];
      const info = new Array(blocks.length + 2).fill('');
      const exec = new Array(blocks.length + 2).fill(null);
      const isEmpty = new Array(blocks.length + 2).fill(false);
      for (const b of blocks) isEmpty[b.line] = b.isEmpty;
      for (const eb of (sr.run.executed || [])) {
        exec[eb.line] = eb;
        if (eb.skipped) { info[eb.line] = '（此情境跳過）'; continue; }
        if (eb.ignored) { info[eb.line] = '（多斜線忽略）'; continue; }
        if (isEmpty[eb.line]) continue;
        const s = eb.after;
        const parts = [];
        parts.push(s.motion || '—');
        parts.push(s.distance === 'G91' ? '91' : '90');
        if (s.comp !== 'G40') parts.push(s.comp + (s.d ? 'D' + s.d : ''));
        if (s.cycle) parts.push(s.cycle.code);
        if (s.feed != null) parts.push('F' + fmt(s.feed, 1));
        parts.push('Z' + fmt(s.pos.z, 2));
        info[eb.line] = parts.join(' ');
      }
      state.lineInfo = info;
      state.execByLine = exec;
    }

    function renderDefaultBanner(table, ops) {
      let n = 0;
      const L = P.logic;
      try {
        const t = U.deepClone(table);
        const dMap = L.dListByTool(t, ops);
        L.ensureOffsets(t, dMap);
        n = L.countDefaultTools(t, dMap);
      } catch (e) { n = 0; }
      show(el.defaultBanner, n > 0);
      el.defaultBanner.textContent = n > 0 ? `${n} 把刀使用預設值，成品圖可能不準` : '';
      el.defaultBanner.title = n > 0 ? '到「刀具表」分頁把型式、直徑、D 補正值填成實際值，模擬結果才會準。' : '';
    }

    /**
     * 素材是推估的時候，頂列要有一條橫幅講清楚——因為推估素材造成的誤判
     * 比「刀具用預設值」多得多（樣本 B 94 筆 warning 有 90 筆來自推估素材）。
     */
    function renderStockBanner(stock, diags) {
      const est = !!(stock && stock.source === 'estimated');
      const n = est ? diags.filter((d) => d.estimatedStock).length : 0;
      show(el.stockBanner, est);
      if (!est) return;
      const dx = fmt(stock.max.x - stock.min.x, 1);
      const dy = fmt(stock.max.y - stock.min.y, 1);
      const dz = fmt(stock.max.z - stock.min.z, 1);
      el.stockBanner.textContent = `素材為程式推估（${dx}×${dy}×${dz} mm）${n > 0 ? `，${n} 筆判定依此` : ''}`;
      el.stockBanner.title = '推估素材是「用切削範圍往外擴一個刀半徑」猜出來的，不是真的毛胚。'
        + '點一下到「素材與設定」填入真實尺寸，這些判定會重算。';
    }

    /**
     * 第四軸的迴轉中心（工件座標的 Y/Z）。
     * 四軸的裝夾慣例是 G54 的 Y0／Z0 對到夾頭中心線，所以預設 (0,0)；
     * 現場對不上時由設定覆寫（settings.rotary.center）。
     */
    function rotaryCenterOf() {
      const c = effectiveRotary().center;
      return { y: Number(c.y) || 0, z: Number(c.z) || 0 };
    }

    /**
     * 3D 視圖的第四軸選項：只有 A 真的轉過才給，否則三軸程式會被當成四軸畫。
     * 給了之後 3D 會把路徑換算到工件座標、素材改畫圓棒、不建高度圖成品。
     */
    function rotaryUsedNow() {
      const sr = currentScenario();
      return !!(sr && rotaryOptOf(sr.run));
    }

    function rotaryOptOf(run) {
      const rot = run && run.rotary;
      if (!rot || !rot.used || !rot.rotateLines.length) return null;
      return { center: rotaryCenterOf(), radius: Number(effectiveRotary().radius) || 0 };
    }

    /**
     * 展開圖只有在第四軸真的轉過的時候才有意義——三軸程式的每一段角度都是 0，
     * 攤平之後會變成一條沒有資訊的橫線，還會讓人以為工具壞了。所以按鈕預設停用。
     */
    function syncRotaryUI(run) {
      const rot = run && run.rotary;
      const on = !!(rot && rot.used && rot.rotateLines.length);
      el.btnModeUnroll.disabled = !on;
      el.btnModeUnroll.title = on
        ? `第四軸展開圖：把圓柱工件的表面攤平（橫軸＝X 軸向位置，縱軸＝${rot.axis} 角度）。分度孔的角度等不等分，這張圖一眼就看得出來。`
        : '這支程式沒有用到第四軸（或 A 從頭到尾沒轉過），展開圖沒有東西可以畫';

      // 四軸時所有視圖必須是同一套座標，不然兩張圖會互相矛盾。
      // 剖面 X 轉得過去（A 繞 X 轉，X 不受影響）→ 變成圓棒橫截面，與 3D／展開圖一致。
      // 俯視與剖面 Y 的投影面會跟著工件轉，轉過去之後畫出來的東西沒有意義 → 停用。
      const NO_ROTARY_MODES = { top: '俯視', sectionY: '剖面 Y' };
      for (const b of document.querySelectorAll('.app-seg__btn')) {
        const m = b.dataset.mode;
        if (!NO_ROTARY_MODES[m]) continue;
        b.disabled = on;
        b.title = on
          ? `第四軸程式不適用：工件會轉，${NO_ROTARY_MODES[m]}的投影面跟著工件跑，畫出來的東西沒有意義。請用「剖面 X」（圓棒橫截面）、3D 或展開圖。`
          : '';
      }
      // 「工件轉動軌跡」只有四軸才有意義
      show(el.lblRotary, on);
      if (!on && el.chkRotary.checked) { el.chkRotary.checked = false; applyVisible(); }
      // 停用時如果正停在那個模式，換到還能看的那一張
      if (on && (viewMode === 'top' || viewMode === 'sectionY')) setViewMode('sectionX');
      if (!on && viewMode === 'unroll') setViewMode('top');
    }

    /**
     * 第四軸橫幅。這條是三條橫幅裡最不能省的一條：
     * 本工具不套用工件旋轉，四軸程式的畫面會把不同角度的加工全部疊在同一面上，
     * 看起來完全正常。錯誤清單裡雖然有 R37，但現場多半是先看圖才看清單——
     * 圖旁邊沒有這句話，等於默認那張圖可以信。
     */
    function renderRotaryBanner(run) {
      const rot = run && run.rotary;
      const on = !!(rot && rot.used && rot.rotateLines.length);
      show(el.rotaryBanner, on);
      if (!on) return;
      const sim = rot.mode === 'simultaneous';
      el.rotaryBanner.textContent = sim
        ? `有 ${rot.axis} 軸同動切削，這幾段沒有預演`
        : `有 ${rot.axis} 軸分度 ${rot.angles.length} 個角度 → 請看「展開圖」`;
      el.rotaryBanner.title = (sim
        ? `第 ${rot.simLines.slice(0, 8).join('、')} 行是 ${rot.axis} 軸與 XYZ 同時進給的四軸插補，實際刀路是繞著旋轉中心展開的曲面，本工具畫不出來。\n`
        : `這支程式把工件轉到 ${rot.angles.map((v) => rot.axis + fmt(v)).join('、')} 這幾個角度加工。\n\n`
          + '【展開圖】把圓棒表面攤平，各角度分開畫——分度對不對看這張。\n'
          + '【俯視／剖面／3D】沒有把工件轉過去，各角度會疊在同一面上，不要當成品看。\n')
        + '仍然有效：G 碼語法、模態、刀長／刀徑補正、固定循環參數、進給轉速、換刀順序、逐行的孔位與深度。\n'
        + '不要採信：素材殘料、碰撞結果、加工時間（高度圖是 2.5D 的，工件一轉就對不上）。\n'
        + '點一下看錯誤清單裡的 R37。';
    }

    // -------------------------------------------------------------------------
    // 視圖控制
    // -------------------------------------------------------------------------
    let sectionTouched = false;
    let snapshotTouched = false;
    let snapshotAfterOp = null;   // 使用者選的「第幾把刀之後」（afterOpIndex），null = 最終
    let snapshotOpCount = 0;   // 這一輪模擬總共有幾個作業（快照可能比它少，見 applySnapshot）
    function syncSectionRange(stock) {
      const mode = view.getMode();
      const axis = mode === 'sectionY' ? 'y' : 'x';
      const lo = Math.floor(stock.min[axis]);
      const hi = Math.ceil(stock.max[axis]);
      el.rngSection.min = String(lo);
      el.rngSection.max = String(hi);
      el.rngSection.disabled = false;
      let v = Number(el.rngSection.value);
      if (!sectionTouched || !(v >= lo && v <= hi)) {
        v = Math.round(((lo + hi) / 2) * 2) / 2;
        el.rngSection.value = String(v);
      }
      view.setSection(v);
      el.secVal.textContent = (mode === 'sectionY' ? 'Y' : 'X') + fmt(v, 2);
    }

    function syncSnapshotSlider(sim, ops, stale) {
      const snaps = sim && sim.snapshots ? sim.snapshots : [];
      if (!snaps.length) {
        el.rngSnapshot.min = '0';
        el.rngSnapshot.max = '0';
        el.rngSnapshot.value = '0';
        el.rngSnapshot.disabled = true;
        el.snapVal.textContent = sim ? '無作業' : '尚未模擬';
        return;
      }
      el.rngSnapshot.min = '0';
      el.rngSnapshot.max = String(snaps.length);
      el.rngSnapshot.disabled = false;
      snapshotOpCount = (ops && ops.length) || snaps.length;
      // 使用者拉過滑桿的話要記住他選的是「第幾把刀之後」（不是陣列索引——
      // 作業數超過預算時快照是抽樣的），重新模擬後找最接近的那一份還原。
      let v = snaps.length;
      if (snapshotTouched && snapshotAfterOp != null) {
        let best = -1, bestDiff = Infinity;
        for (let i = 0; i < snaps.length; i++) {
          const diff = Math.abs((snaps[i].afterOpIndex == null ? i : snaps[i].afterOpIndex) - snapshotAfterOp);
          if (diff < bestDiff) { bestDiff = diff; best = i; }
        }
        if (best >= 0) v = best;
      }
      el.rngSnapshot.value = String(v);
      applySnapshot(v, snaps, stale);
    }

    function applySnapshot(v, snaps, stale) {
      snaps = snaps || ((state.result && currentScenario() && currentScenario().sim) ? currentScenario().sim.snapshots : []);
      if (!snaps || !snaps.length) return;
      const note = (stale == null ? state.simStale : stale) ? '（更新中）' : '';
      if (v >= snaps.length) {
        eachView((vw) => vw.setSnapshot(null));
        el.snapVal.textContent = `最終（${snapshotOpCount || snaps.length} 把）` + note;
        return;
      }
      eachView((vw) => vw.setSnapshot(v));
      // 作業數超過快照預算時 simulation 只存部分快照，所以序號要看 afterOpIndex，不能用陣列索引。
      const s = snaps[v];
      const opNo = (s && s.afterOpIndex != null ? s.afterOpIndex : v) + 1;
      el.snapVal.textContent = `第 ${opNo} 把${s && s.tool != null ? '（T' + s.tool + '）' : ''}後` + note;
    }

    function currentScenario() {
      if (!state.result) return null;
      return state.result.scenarios[state.scenario] || state.result.scenarios.off || null;
    }

    function renderToolFilter(table, segments) {
      const used = new Set();
      for (const s of segments) if (s.tool != null) used.add(s.tool);
      const list = (table.tools || []).filter((t) => used.has(t.t)).sort((a, b) => a.t - b.t);
      clearEl(el.toolFilter);
      if (!list.length) {
        const sp = document.createElement('span');
        sp.className = 'nc-muted';
        sp.textContent = '（無）';
        el.toolFilter.appendChild(sp);
        return;
      }
      const color = (NC.ui.view2dUtil && NC.ui.view2dUtil.toolColor) ? NC.ui.view2dUtil.toolColor : () => '#888';
      for (const t of list) {
        const lab = document.createElement('label');
        lab.className = 'app-toolchk' + (state.hiddenTools.has(t.t) ? ' is-off' : '');
        lab.title = `T${t.t} ${t.label || ''}`;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !state.hiddenTools.has(t.t);
        cb.addEventListener('change', () => {
          if (cb.checked) state.hiddenTools.delete(t.t); else state.hiddenTools.add(t.t);
          lab.classList.toggle('is-off', !cb.checked);
          applyVisible();
        });
        const swatch = document.createElement('i');
        swatch.style.background = color(t.t);
        const span = document.createElement('span');
        span.textContent = 'T' + t.t;
        lab.appendChild(cb);
        lab.appendChild(swatch);
        lab.appendChild(span);
        el.toolFilter.appendChild(lab);
      }
    }

    function applyVisible() {
      const sr = currentScenario();
      const all = new Set();
      if (sr) for (const s of sr.geometry.segments) if (s.tool != null) all.add(s.tool);
      let tools = null;
      if (state.hiddenTools.size) {
        tools = new Set();
        for (const t of all) if (!state.hiddenTools.has(t)) tools.add(t);
      }
      const vis = {
        rapid: el.chkRapid.checked,
        feed: el.chkFeed.checked,
        refReturn: el.chkRef.checked,
        stock: el.chkStock.checked,
        rotary: el.chkRotary.checked,
        tools,
      };
      eachView((v) => v.setVisible(vis));
    }

    // -------------------------------------------------------------------------
    // 選取同步
    // -------------------------------------------------------------------------
    function showModalFor(line) {
      const eb = line > 0 ? state.execByLine[line] : null;
      const blocks = state.result ? state.result.tok.blocks : null;
      const b = (blocks && line > 0) ? blocks[line - 1] : null;
      el.modalLineLabel.textContent = line > 0 ? `第 ${line} 行` : '';
      if (!eb) { modalPanel.update(null, null); return; }
      modalPanel.update(eb.after, {
        line,
        text: b ? (b.text || b.raw) : '',
        comment: b ? b.comment : null,
        opIndex: eb.opIndex,
        skipped: eb.skipped,
        ignored: eb.ignored,
      });
    }

    function selectLine(line, opts) {
      opts = opts || {};
      state.selectedLine = line;
      editor.highlightLine(line);
      eachView((v) => v.highlightLine(line));
      showModalFor(line);
      if (opts.scroll) editor.scrollToLine(line, { center: true });
      // 作業表跟著選
      const sr = currentScenario();
      if (sr && opsPanel) {
        const eb = state.execByLine[line];
        if (eb && eb.opIndex >= 0) opsPanel.select(eb.opIndex);
      }
    }

    function jumpToLine(line, opts) {
      if (!(line > 0)) return;
      selectLine(line, { scroll: true });
      editor.focus();
    }

    function applyFix(item) {
      if (!item || !item.fix || !Array.isArray(item.fix.edits)) return;
      const edits = item.fix.edits.slice().sort((a, b) => b.line - a.line);
      for (const e of edits) editor.replaceLines(e.line, e.line, e.text);
      setStatus('已套用修正：' + (item.fix.label || item.ruleId));
    }

    // -------------------------------------------------------------------------
    // 載入程式
    // -------------------------------------------------------------------------
    function loadProgram(text, fileName, note) {
      state.text = String(text == null ? '' : text);
      state.fileName = fileName || '';
      state.hiddenTools.clear();
      state.stock = null;
      state.rotary = null;   // 第四軸裝夾參數跟著程式走；換程式先清掉，稍後依 programKey 讀回
      state.selectedLine = 0;
      sectionTouched = false;

      let tok = null;
      try { tok = NC.tokenize(state.text); } catch (e) { tok = null; }
      state.programKey = programKeyOf(tok, state.fileName);
      state.rotary = loadRotary(state.programKey);
      state.userTable = NC.tools.load(state.programKey) || null;

      el.fileLabel.textContent = (state.fileName || state.programKey) + (note ? ' · ' + note : '');
      el.fileLabel.title = el.fileLabel.textContent;
      editor.setText(state.text);
      refresh();
    }

    function loadSample(id) {
      const s = findSample(id);
      if (!s) { setStatus('找不到範例：' + id); return false; }
      el.selSample.value = sampleId(s);
      loadProgram(s.text, s.name, '內建範例');
      return true;
    }

    /** 讀成文字（先 UTF-8、失敗改 Big5）。優先用 Blob.arrayBuffer()，沒有才退回 FileReader。 */
    function readFile(file) {
      return new Promise((resolve, reject) => {
        const done = (buf) => { try { resolve(decodeBytes(buf)); } catch (e) { reject(e); } };
        if (typeof file.arrayBuffer === 'function') { file.arrayBuffer().then(done).catch(reject); return; }
        const reader = new FileReader();
        reader.onload = () => done(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
      });
    }

    /**
     * 開檔的總入口。同一個入口要接兩種東西：NC 程式與刀具表 CSV。
     * 先看副檔名，副檔名被改掉時再看第一列的欄名（現場的檔名常常沒有副檔名）。
     */
    function openFile(file) {
      if (!file) return;
      readFile(file).then((r) => {
        if (P.logic.looksLikeToolCSV(file.name, r.text)) { importToolCSV(r.text, file.name); return; }
        el.selSample.value = '';
        loadProgram(r.text, file.name, r.encoding);
      }).catch((e) => setStatus('讀檔失敗：' + file.name + (e && e.message ? '（' + e.message + '）' : '')));
    }

    // -------------------------------------------------------------------------
    // 事件接線
    // -------------------------------------------------------------------------
    editor.onChange((text) => {
      state.text = text;
      refresh();
    });
    editor.onCursorLine((line) => {
      state.selectedLine = line;
      editor.highlightLine(line);
      eachView((v) => v.highlightLine(line));
      showModalFor(line);
    });
    view.onPick((line) => {
      if (!(line > 0)) return;
      selectLine(line, { scroll: true });
    });

    el.btnOpen.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => {
      if (el.fileInput.files && el.fileInput.files[0]) openFile(el.fileInput.files[0]);
      el.fileInput.value = '';
    });

    el.selSample.addEventListener('change', () => {
      if (el.selSample.value) loadSample(el.selSample.value);
    });

    el.btnSave.addEventListener('click', () => {
      if (!state.text) { setStatus('沒有內容可以存'); return; }
      downloadText(state.fileName || (state.programKey + '.nc'), editor.getText());
      setStatus('已下載 ' + (state.fileName || state.programKey));
    });

    el.btnCopy.addEventListener('click', async () => {
      const ok = await copyText(editor.getText());
      setStatus(ok ? '已複製到剪貼簿' : '複製失敗（瀏覽器不允許）');
    });

    el.selScenario.addEventListener('change', () => {
      state.scenario = el.selScenario.value;
      settingsPanel.update({ settings: state.settings, scenario: state.scenario, cell: state.cell, rotaryUsed: rotaryUsedNow() });
      persistSettings();
      refresh();
    });

    function setViewMode(mode) {
      if (mode === '3d') {
        const v3 = ensureView3D();
        if (!v3) {
          el.btnMode3d.disabled = true;
          el.btnMode3d.title = ui.view3d && ui.view3d.isSupported && !ui.view3d.isSupported()
            ? '這個瀏覽器／裝置開不了 WebGL，3D 視圖不能用（俯視與剖面照常）'
            : '3D 視圖初始化失敗，請改用俯視或剖面';
          setStatus2('3D 視圖不能用：' + el.btnMode3d.title);
          return false;
        }
      }
      let hit = false;
      for (const b of document.querySelectorAll('.app-seg__btn')) {
        const on = b.dataset.mode === mode;
        if (on) hit = true;
        b.classList.toggle('is-on', on);
      }
      if (!hit) return false;
      viewMode = mode;
      const is3d = mode === '3d';
      show(el.viewHost, !is3d);
      show(el.view3dHost, is3d);
      el.rngSection.disabled = is3d || mode === 'unroll' || !state.result;
      if (is3d) {
        // 建好之後要把目前的資料餵給它（它是在切過來的這一刻才誕生的）
        feedView3D();
        view3d.resize();
        view3d.fit();
      } else {
        view.setMode(mode);
        if (state.result) syncSectionRange(state.result.stock);
      }
      return true;
    }

    /** 3D 視圖剛建立時補餵目前的資料 */
    function feedView3D() {
      if (!view3d || !state.result) return;
      const sr = currentScenario();
      if (!sr) return;
      const sim = sr.sim || state.simCache[state.scenario] || null;
      view3d.setData({
        segments: sr.geometry.segments,
        sim,
        stock: state.result.stock,
        toolTable: state.result.toolTable,
        scenario: state.scenario,
        rotary: rotaryOptOf(sr.run),
      });
      applyVisible();
    }

    /** 只寫狀態列文字，不動 statusBase（暫時性的提示） */
    function setStatus2(text) { el.statusText.textContent = text; }
    for (const btn of document.querySelectorAll('.app-seg__btn')) {
      btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
    }
    el.rngSection.addEventListener('input', () => {
      sectionTouched = true;
      const v = Number(el.rngSection.value);
      view.setSection(v);
      el.secVal.textContent = (view.getMode() === 'sectionY' ? 'Y' : 'X') + fmt(v, 2);
    });
    el.btnFit.addEventListener('click', () => { if (viewMode === '3d' && view3d) view3d.fit(); else view.fit(); });
    el.stockBanner.addEventListener('click', () => selectTab('stock'));
    el.rotaryBanner.addEventListener('click', () => selectTab('diag'));
    el.rngSnapshot.addEventListener('input', () => {
      const v = Number(el.rngSnapshot.value);
      const sim = currentScenario() && currentScenario().sim;
      const snaps = (sim && sim.snapshots) || [];
      snapshotTouched = true;
      // 記「第幾把刀之後」而不是陣列索引：作業數超過快照預算時快照是抽樣的
      snapshotAfterOp = (v >= snaps.length || !snaps[v]) ? null
        : (snaps[v].afterOpIndex == null ? v : snaps[v].afterOpIndex);
      applySnapshot(v);
    });
    for (const c of [el.chkRapid, el.chkFeed, el.chkRef, el.chkStock, el.chkRotary]) c.addEventListener('change', applyVisible);

    // 分頁
    function selectTab(name) {
      let hit = false;
      for (const t of document.querySelectorAll('.app-tab')) {
        const on = t.dataset.tab === name;
        if (on) hit = true;
        t.classList.toggle('is-on', on);
      }
      if (!hit) return false;
      for (const body of document.querySelectorAll('.app-tab-body')) {
        body.classList.toggle('nc-hidden', body.dataset.panel !== name);
      }
      return true;
    }
    for (const tab of document.querySelectorAll('.app-tab')) {
      tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    }

    // 整頁拖放（只接檔案；在編輯器內拖曳文字不受影響）
    function dragHasFiles(ev) {
      const dt = ev.dataTransfer;
      if (!dt) return false;
      if (dt.types) {
        for (let i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
        return false;
      }
      return true;
    }
    let dragDepth = 0;
    window.addEventListener('dragenter', (ev) => {
      if (!dragHasFiles(ev)) return;
      ev.preventDefault();
      dragDepth++;
      el.app.classList.add('is-dropping');
    });
    window.addEventListener('dragover', (ev) => {
      if (!dragHasFiles(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (ev) => {
      if (!dragDepth) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) el.app.classList.remove('is-dropping');
    });
    // 捕獲階段先關掉遮罩：刀具表面板會把 CSV 的 drop 攔下來（stopPropagation），
    // 只靠下面那個冒泡的 handler 的話，拖進刀具表之後遮罩會一直留在畫面上。
    window.addEventListener('drop', () => {
      dragDepth = 0;
      el.app.classList.remove('is-dropping');
    }, true);
    window.addEventListener('drop', (ev) => {
      if (!dragHasFiles(ev)) return;
      ev.preventDefault();
      dragDepth = 0;
      el.app.classList.remove('is-dropping');
      const dt = ev.dataTransfer;
      if (dt && dt.files && dt.files[0]) openFile(dt.files[0]);
    });

    // 範例選單
    (function fillSamples() {
      for (const s of (ui.samples || [])) {
        const op = document.createElement('option');
        op.value = sampleId(s);
        const n = String(s.text || '').split('\n').length;
        op.textContent = `${s.name}（${n} 行）`;
        el.selSample.appendChild(op);
      }
    })();

    // URL hash：#sample=樣本 C（可再加 &scenario=on&mode=sectionY&section=-20&tab=diag，供截圖／分享用）
    function hashParams() {
      const out = {};
      const raw = String(location.hash || '').replace(/^#/, '');
      if (!raw) return out;
      for (const part of raw.split('&')) {
        if (!part) continue;
        const i = part.indexOf('=');
        const k = i < 0 ? part : part.slice(0, i);
        const v = i < 0 ? '' : part.slice(i + 1);
        try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { out[k] = v; }
      }
      return out;
    }

    function applyHash() {
      const p = hashParams();
      if (p.scenario && ['off', 'on', 'multiIgnored'].indexOf(p.scenario) >= 0 && p.scenario !== state.scenario) {
        state.scenario = p.scenario;
        el.selScenario.value = p.scenario;
        settingsPanel.update({ settings: state.settings, scenario: state.scenario, cell: state.cell });
      }
      const loaded = p.sample ? loadSample(p.sample) : false;
      if (p.mode) setViewMode(p.mode);
      if (p.tab) selectTab(p.tab);
      if (p.section !== undefined && p.section !== '' && Number.isFinite(Number(p.section))) {
        sectionTouched = true;
        const v = Number(p.section);
        el.rngSection.value = String(v);
        view.setSection(v);
        el.secVal.textContent = (view.getMode() === 'sectionY' ? 'Y' : 'X') + fmt(v, 2);
      }
      return loaded;
    }

    window.addEventListener('hashchange', () => { applyHash(); });

    // ---- 起始狀態 ----
    el.selScenario.value = state.scenario;
    if (!applyHash()) {
      const first = (ui.samples || [])[0];
      if (first) loadSample(sampleId(first));
      else setStatus('請按「開檔…」或把 NC 檔拖進視窗');
    }

    return {
      state, editor, view,
      panels: { tools: toolsPanel, diag: diagPanel, modal: modalPanel, ops: opsPanel, stock: stockPanel, settings: settingsPanel, magazine: magPanel },
      loadProgram, loadSample, refresh, exportToolCSV, importToolCSV,
    };
  }

  ui.createApp = createApp;
  ui.analyzeSyncCompat = analyzeSyncCompat;
  ui.analyzeCompat = analyzeCompat;

  if (typeof document !== 'undefined') {
    const boot = () => {
      try {
        ui.app = createApp();
      } catch (e) {
        console.error('NC 預演台啟動失敗：', e);
        const host = document.getElementById('editorHost');
        if (host) host.innerHTML = '<div class="app-empty">啟動失敗：' + String(e && e.message ? e.message : e) + '</div>';
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(globalThis.NC = globalThis.NC || {});
