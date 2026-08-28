/*
 * NC 預演台 — 面板（NC.ui.panels）
 * 刀具表、錯誤清單、模態、作業摘要、素材、設定六個面板，全部用原生 DOM 建立。
 * 純邏輯（不碰 DOM）集中在 NC.ui.panels.logic，方便在 Node 下測試；DOM 部分只在呼叫面板函式時才碰 document。
 *
 * 面板呼叫方式（皆回傳 handle，至少含 el 與 update）：
 *   toolTable(container, {table, ops?, dByTool?, onChange, onExportCSV?, onImportFile?})
 *   magazine(container, {magazine, toolTable, usedTools, onChange})  onChange(magazine | null)  null = 不啟用
 *   diagnostics(container, {items, onJump, onFix?, filter?})     onJump(line, item)
 *   modal(container, state, extra?)                              純顯示
 *   ops(container, {ops, onJump, time?, toolTable?, selectedIndex?})  onJump(line, op)
 *   stock(container, {stock, onChange})                          onChange(newStock | null)  null = 回到推估
 *   settings(container, {settings, scenario, cell, onChange})    onChange({settings, scenario, cell})
 */
(function (NC) {
  'use strict';
  const ui = (NC.ui = NC.ui || {});
  const panels = (ui.panels = ui.panels || {});
  const U = NC.util;

  // ---------------------------------------------------------------------------
  // 常數與顯示文字
  // ---------------------------------------------------------------------------
  // 型式清單直接跟著 NC.tools 的型式表走，兩邊才不會各有一份、加了刀具只改到一邊。
  const TOOL_TYPES = (() => {
    const info = NC.tools && NC.tools.TYPE_INFO;
    if (!info) return [['endmill', '平刀（端銑刀）'], ['unknown', '未定義']];
    return Object.keys(info).map((k) => [k, info[k].ui || info[k].name]);
  })();
  const TOOL_TYPE_LABEL = Object.fromEntries(TOOL_TYPES);
  /** 型式 → 一句話說明（下拉選單的 tooltip） */
  const TOOL_TYPE_DESC = (() => {
    const info = NC.tools && NC.tools.TYPE_INFO;
    const out = {};
    if (info) for (const k of Object.keys(info)) out[k] = info[k].desc || '';
    return out;
  })();
  /** 型式 → 直徑以外還要現場補的欄位（cornerRad 角R／neckDia 頸徑） */
  function extraFieldsOf(type) {
    const info = NC.tools && NC.tools.TYPE_INFO && NC.tools.TYPE_INFO[type];
    return (info && Array.isArray(info.extra)) ? info.extra : [];
  }
  const SEVERITIES = ['error', 'warning', 'needsInput', 'info'];
  const SEVERITY_LABEL = { error: '錯誤', warning: '警告', needsInput: '需輸入', info: '資訊' };
  const SOURCE_LABEL = { comment: '註解', motion: '動作', default: '預設', user: '手填' };
  const KIND_LABEL = { face: '面銑', contour: '輪廓', pocket: '挖槽', drill: '鑽孔', tap: '攻牙', ream: '鉸孔', chamfer: '倒角', unknown: '未知' };
  // 「開關關 / 開關開」只差一個形近字，讀錯會做出完全相反的判斷 → 一律寫成「關／開」加說明
  const SCENARIO_LABEL = { off: 'Block skip 關（全部執行）', on: 'Block skip 開（跳過 / 節）', multiIgnored: '只跳過多斜線節' };
  const SCENARIO_SHORT = { off: 'skip 關', on: 'skip 開', multiIgnored: '多斜線' };
  const MULTISLASH_LABEL = { asSingle: '視同單斜線', ignoreBlock: '整節忽略', alarm: '視為錯誤（警報）' };
  const CELL_OPTIONS = [0.1, 0.25, 0.5, 1];

  // ---------------------------------------------------------------------------
  // 純邏輯（不碰 DOM）
  // ---------------------------------------------------------------------------
  /** 數字顯示：最多 d 位小數、去掉尾隨 0（不用 NC.util.fmt，它在小數不全為 0 時不會去尾）。 */
  function fmt(v, d = 3) {
    if (v == null || Number.isNaN(v)) return '—';
    const s = (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }
  function uniqSorted(arr) {
    return Array.from(new Set(arr.filter((n) => Number.isFinite(n)))).sort((a, b) => a - b);
  }
  function toNumber(v, fallback) {
    if (v === '' || v == null) return fallback;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * 每把刀用到的 D 號。優先用 ops（Operation.tool / dList），其次用 dByTool，最後退而用 offsets 中 n === t 的項目。
   * @returns {Object<number, number[]>}
   */
  function dListByTool(table, ops, dByTool) {
    const map = {};
    const tools = (table && table.tools) || [];
    for (const tool of tools) map[tool.t] = [];
    if (Array.isArray(ops) && ops.length) {
      for (const op of ops) {
        if (op.tool == null) continue;
        if (!map[op.tool]) map[op.tool] = [];
        for (const d of op.dList || []) map[op.tool].push(d);
      }
    } else if (dByTool) {
      for (const k of Object.keys(dByTool)) map[k] = (map[k] || []).concat(dByTool[k]);
    } else {
      const offs = (table && table.offsets) || [];
      for (const tool of tools) if (offs.some((o) => o.n === tool.t)) map[tool.t].push(tool.t);
    }
    for (const k of Object.keys(map)) map[k] = uniqSorted(map[k].map(Number));
    return map;
  }

  function findTool(table, t) { return table.tools.find((x) => x.t === t) || null; }
  function findOffset(table, n) { return table.offsets.find((x) => x.n === n) || null; }

  /** 確保每個用到的 D 號都有 OffsetEntry（沒有的用刀徑/2 補、來源 default）。就地修改並回傳 table。 */
  function ensureOffsets(table, dMap) {
    table.offsets = table.offsets || [];
    for (const tool of table.tools) {
      for (const d of dMap[tool.t] || []) {
        if (!findOffset(table, d)) {
          table.offsets.push({ n: d, lenGeom: 0, lenWear: 0, radGeom: U.round((tool.diameter || 0) / 2), radWear: 0, source: 'default' });
        }
      }
    }
    table.offsets.sort((a, b) => a.n - b.n);
    return table;
  }

  /** 一把刀是否用到預設值（型式／直徑／任一 D 的來源為 default）。 */
  function toolUsesDefault(table, tool, dMap) {
    const src = tool.source || {};
    if (src.type === 'default' || src.diameter === 'default') return true;
    for (const d of dMap[tool.t] || []) {
      const off = findOffset(table, d);
      if (off && off.source === 'default') return true;
    }
    return false;
  }
  function countDefaultTools(table, dMap) {
    return table.tools.filter((tool) => toolUsesDefault(table, tool, dMap)).length;
  }

  /**
   * 改刀具欄位。field='diameter' 時，該刀所有來源非 user 的 D 自動改 radGeom = 直徑/2（連動）。
   * @returns {number[]} 被連動更新的 D 號
   */
  function setToolField(table, t, field, value, dMap) {
    const tool = findTool(table, t);
    if (!tool) return [];
    tool[field] = value;
    tool.source = tool.source || {};
    if (field !== 'resident' && field !== 'label') tool.source[field] = 'user';
    const linked = [];
    if (field === 'diameter' && Number.isFinite(value)) {
      for (const d of dMap[t] || []) {
        const off = findOffset(table, d);
        if (off && off.source !== 'user') { off.radGeom = U.round(value / 2); linked.push(d); }
      }
    }
    return linked;
  }

  /** 改補正欄位（radGeom / radWear / lenGeom / lenWear）；改過即為手填，之後不再被直徑連動。 */
  function setOffsetField(table, n, field, value) {
    let off = findOffset(table, n);
    if (!off) { off = { n, lenGeom: 0, lenWear: 0, radGeom: 0, radWear: 0, source: 'user' }; table.offsets.push(off); table.offsets.sort((a, b) => a.n - b.n); }
    off[field] = value;
    off.source = 'user';
    return off;
  }

  function stamp(table) { table.updatedAt = new Date().toISOString(); return table; }

  /**
   * 篩選診斷。filter = {severities?: Severity[]|Set, onlyScenarioOn?: boolean, text?: string, rules?: string[]}
   * 「只看 skip ON 差異」= scenario === 'on' 的診斷，或 R06（情境差異）規則。
   */
  function filterDiagnostics(items, filter) {
    const f = filter || {};
    let sev = f.severities;
    if (sev && !(sev instanceof Set)) sev = new Set(sev);
    const text = (f.text || '').trim().toLowerCase();
    const rules = f.rules ? new Set(f.rules) : null;
    return (items || []).filter((it) => {
      if (sev && !sev.has(it.severity)) return false;
      if (f.onlyScenarioOn && !(it.scenario === 'on' || it.ruleId === 'R06')) return false;
      if (rules && !rules.has(it.ruleId)) return false;
      if (text) {
        const hay = `${it.ruleId} ${it.message} ${it.detail || ''} ${it.fanucAlarm || ''} L${it.line}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
  }
  function countBySeverity(items) {
    const c = { error: 0, warning: 0, needsInput: 0, info: 0 };
    for (const it of items || []) if (c[it.severity] != null) c[it.severity]++;
    return c;
  }

  /** 秒 → "12 s" / "3:05" / "1:02:03" */
  function formatTime(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    const s = Math.round(sec);
    if (s < 60) return `${s} s`;
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const two = (n) => String(n).padStart(2, '0');
    return hh > 0 ? `${hh}:${two(mm)}:${two(ss)}` : `${mm}:${two(ss)}`;
  }
  function rangeText(nums) {
    const a = uniqSorted(nums || []);
    if (!a.length) return '—';
    if (a.length === 1) return fmt(a[0]);
    return `${fmt(a[0])}–${fmt(a[a.length - 1])}`;
  }
  function listText(nums) {
    const a = uniqSorted(nums || []);
    return a.length ? a.map((n) => fmt(n)).join(', ') : '—';
  }

  // ---------------------------------------------------------------------------
  // 刀庫（settings.magazine）——純邏輯
  //
  // 為什麼要有這一塊：現場說過刀庫撞過刀（大直徑面銑刀和隔壁刀位的刀在刀庫旋轉時互撞，
  // 刀直接飛出來）。這是程式本身完全看不出來的問題，只有把「哪把刀在哪個刀位」和刀徑
  // 對起來才抓得到。rules.js 的 R30 早就實作好了，缺的一直是讓人把刀位填進去的地方。
  // ---------------------------------------------------------------------------
  const MAGAZINE_DEFAULTS = { size: 24, largeToolDiameter: 80, largeToolNeighbors: 1 };
  const MAGAZINE_MAX_SIZE = 200;
  const MAGAZINE_RING_MAX = 36;   // 超過這麼多刀位，環狀圖會擠成一團 → 改用格狀

  function clampInt(v, lo, hi, fallback) {
    const n = Math.round(toNumber(v, NaN));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  /** 一份全新的刀庫設定（「啟用刀庫檢查」剛打開時用）。刀位一開始全空，由使用者填。 */
  function defaultMagazine() {
    return {
      size: MAGAZINE_DEFAULTS.size,
      pots: {},
      resident: [],
      largeToolDiameter: MAGAZINE_DEFAULTS.largeToolDiameter,
      largeToolNeighbors: MAGAZINE_DEFAULTS.largeToolNeighbors,
    };
  }

  /**
   * 正規化 settings.magazine：補齊欄位、把 "T20" 這種 key 轉成數字、丟掉超出刀庫範圍的登記。
   * @param {*} raw
   * @returns {{size:number, pots:Object<number,number>, resident:number[], largeToolDiameter:number, largeToolNeighbors:number}|null}
   *   raw 不是物件 → null（等於不啟用，R30 整條不跑）
   */
  function normalizeMagazine(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const size = clampInt(raw.size, 1, MAGAZINE_MAX_SIZE, MAGAZINE_DEFAULTS.size);
    const pots = {};
    const src = (raw.pots && typeof raw.pots === 'object') ? raw.pots : {};
    for (const key of Object.keys(src)) {
      const t = clampInt(String(key).replace(/^T/i, ''), 1, 99999, NaN);
      const p = clampInt(src[key], 1, MAGAZINE_MAX_SIZE, NaN);
      if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
      if (p > size) continue;   // 刀庫縮小之後不存在的刀位，留著只會讓圖畫不出來
      pots[t] = p;
    }
    const resident = uniqSorted((Array.isArray(raw.resident) ? raw.resident : [])
      .map((x) => clampInt(String(x).replace(/^T/i, ''), 1, 99999, NaN)));
    const dia = toNumber(raw.largeToolDiameter, MAGAZINE_DEFAULTS.largeToolDiameter);
    return {
      size,
      pots,
      resident,
      largeToolDiameter: (Number.isFinite(dia) && dia > 0) ? dia : MAGAZINE_DEFAULTS.largeToolDiameter,
      largeToolNeighbors: clampInt(raw.largeToolNeighbors, 1, 8, MAGAZINE_DEFAULTS.largeToolNeighbors),
    };
  }

  /** 刀庫是環狀的：第 1 號的隔壁是最後一號。把任意刀位號折回 1..size。 */
  function wrapPot(pot, size) {
    if (!(size > 0)) return pot;
    return ((Math.round(pot) - 1) % size + size) % size + 1;
  }

  /**
   * 刀庫現況：每個刀位放了誰、誰是大徑刀、哪些刀位必須淨空、哪裡衝突。
   * 判定邏輯與 rules.js 的 R30 一致，只是這裡即時算給面板用（不必等分析跑完）。
   *
   * @param {*} mag                 settings.magazine（會先過 normalizeMagazine）
   * @param {Tool[]|ToolTable} tools 刀具表（取直徑；沒有直徑的刀只當「佔位的鄰居」）
   * @param {number[]} [used]       這支程式用到的 T 號
   * @returns {{cells:Array, issues:Array, potOf:Object<number,number>, unassigned:number[]}}
   */
  function magazineStatus(mag, tools, used) {
    const m = normalizeMagazine(mag);
    const out = { cells: [], issues: [], potOf: {}, unassigned: [] };
    if (!m) return out;
    const list = Array.isArray(tools) ? tools : ((tools && tools.tools) || []);
    const usedList = uniqSorted((used || []).map(Number));
    const usedSet = new Set(usedList);
    const diaOf = (t) => {
      const x = list.find((o) => o && o.t === t);
      return (x && x.diameter > 0) ? x.diameter : null;
    };
    const cells = [];
    for (let i = 0; i < m.size; i++) {
      cells.push({ pot: i + 1, tools: [], big: false, bigOwners: [], clearFor: [], conflict: false, resident: false, inProgram: false });
    }
    const cellOf = (p) => cells[wrapPot(p, m.size) - 1];
    const tList = Object.keys(m.pots).map(Number).sort((a, b) => a - b);
    for (const t of tList) {
      const c = cellOf(m.pots[t]);
      c.tools.push(t);
      out.potOf[t] = m.pots[t];
      if (m.resident.indexOf(t) >= 0) c.resident = true;
      if (usedSet.has(t)) c.inProgram = true;
    }
    // 同一刀位兩把刀
    for (const c of cells) {
      if (c.tools.length <= 1) continue;
      c.conflict = true;
      out.issues.push({
        severity: 'error', pot: c.pot,
        text: `第 ${c.pot} 號刀位登記了 ${c.tools.map((t) => 'T' + t).join('、')}——同一個刀位不可能同時放兩把刀`,
      });
    }
    // 大徑刀與相鄰刀位互撞（環狀）
    for (const c of cells) {
      for (const t of c.tools) {
        const d = diaOf(t);
        if (d != null && d >= m.largeToolDiameter) { c.big = true; c.bigOwners.push(t); }
      }
    }
    for (const c of cells) {
      for (const owner of c.bigOwners) {
        for (let k = 1; k <= m.largeToolNeighbors; k++) {
          for (const nb of [c.pot - k, c.pot + k]) {
            const nc = cellOf(nb);
            if (nc === c) continue;
            if (nc.clearFor.indexOf(owner) < 0) nc.clearFor.push(owner);
            for (const other of nc.tools) {
              if (other === owner) continue;
              nc.conflict = true;
              c.conflict = true;
              const od = diaOf(other);
              out.issues.push({
                severity: 'error', pot: nc.pot, t: owner,
                text: `T${owner}（Ø${fmt(diaOf(owner))}）在第 ${c.pot} 號刀位，隔壁第 ${nc.pot} 號放了 T${other}`
                  + (od ? `（Ø${fmt(od)}）` : '') + '——刀庫旋轉時會互撞',
              });
            }
          }
        }
      }
    }
    // 本程式用到、但刀庫沒登記／超出範圍
    for (const t of usedList) {
      if (t < 1 || t > m.size) {
        out.issues.push({ severity: 'error', t, text: `T${t} 超出刀庫範圍（刀庫只有 ${m.size} 個刀位）` });
        continue;
      }
      if (m.pots[t] == null) out.unassigned.push(t);
    }
    if (out.unassigned.length) {
      out.issues.push({
        severity: 'warning',
        text: `還有 ${out.unassigned.length} 把刀沒指定刀位：${out.unassigned.map((t) => 'T' + t).join('、')}`,
      });
    }
    // 常駐刀清單對不上刀具表的 ★
    for (const tool of list) {
      if (!tool || !tool.resident) continue;
      if (m.resident.indexOf(tool.t) >= 0) continue;
      out.issues.push({ severity: 'info', t: tool.t, text: `T${tool.t} 在刀具表標了 ★ 常駐刀，刀庫的常駐清單裡卻沒有它` });
    }
    out.cells = cells;
    return out;
  }

  /** 環狀刀位圖的座標（百分比，第 1 號在正上方順時針排）。 */
  function ringPositions(size) {
    const out = [];
    const n = Math.max(1, Math.round(size));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      out.push({ pot: i + 1, x: 50 + Math.cos(a) * 41, y: 50 + Math.sin(a) * 41 });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 刀具表 CSV 匯入／匯出——純邏輯
  // ---------------------------------------------------------------------------
  const BOM = '﻿';

  /**
   * 補上 UTF-8 BOM。少了它 Excel 會用系統 ANSI 讀，中文欄名整排變亂碼——
   * 這份 CSV 就是要拿給現場用 Excel 填的，亂碼等於整個功能作廢。
   */
  function withBOM(str) {
    const s = String(str == null ? '' : str);
    return s.charCodeAt(0) === 0xfeff ? s : BOM + s;
  }

  /** 匯出檔名：刀具表_O1001.csv（Windows 檔名不能有 \ / : * ? " < > |）。 */
  function csvFileName(programKey) {
    const key = String(programKey == null ? '' : programKey).trim().replace(/[\\/:*?"<>|]/g, '_');
    return '刀具表' + (key ? '_' + key : '') + '.csv';
  }

  /**
   * 這個檔是不是刀具表 CSV？整頁拖放同時要接 NC 程式和刀具表，得分得出來。
   * 先看副檔名，再看第一列有沒有「T」欄與其他刀具表欄名（現場可能把副檔名改掉）。
   */
  function looksLikeToolCSV(fileName, text) {
    if (/\.csv$/i.test(String(fileName == null ? '' : fileName))) return true;
    const head = String(text == null ? '' : text).replace(/^﻿/, '').split(/\r?\n/)[0] || '';
    if (head.indexOf(',') < 0) return false;
    const cells = head.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    if (cells.indexOf('T') < 0) return false;
    return cells.some((c) => c.indexOf('請填_') === 0 || c === '程式註解' || c === '推測型式' || c === '用到的D號');
  }

  const CSV_USER_FIELDS = ['type', 'diameter', 'angle', 'fluteLen', 'stickout', 'pitch', 'cornerRad', 'neckDia'];
  const CSV_FIELD_LABEL = {
    type: '型式', diameter: '直徑', angle: '角度', fluteLen: '刃長', stickout: '伸出長', pitch: '牙距',
    cornerRad: '角R', neckDia: '頸徑',
  };
  /** 這幾個「請填_」欄位只能填數字，填了別的東西會被整格丟掉（要講出來，不能默默吞掉）。 */
  const CSV_NUMERIC_COLUMNS = ['請填_直徑mm', '請填_刀尖或倒角角度', '請填_刃長mm', '請填_伸出長mm',
    '請填_角R半徑mm', '請填_頸徑mm'];

  /**
   * 匯入值的合理範圍。CSV 是拿給現場用 Excel 填的，`-`、`0`、`-5` 這種手誤一定會發生；
   * 照單全收的話刀半徑會變成 -2.5 mm，補正路徑與模擬全部跟著錯，而畫面上只寫「匯入成功」。
   * @returns {string|null} 不合理的原因（null = 可以收）
   */
  function csvFieldError(field, v) {
    if (field === 'type') return (typeof v === 'string' && v) ? null : '型式讀不出來';
    const n = toNumber(v, NaN);
    if (!Number.isFinite(n)) return '不是數字';
    if (field === 'angle') return (n > 0 && n < 180) ? null : '要在 0～180 度之間';
    if (!(n > 0)) return '要大於 0';
    if (n > 1000) return '大得不合理（超過 1000 mm）';
    return null;
  }

  /** 極簡 CSV 切列（只為了看原始格子長什麼樣，數值解析仍由 NC.tools.fromCSV 負責）。 */
  function csvRows(text) {
    const src = String(text == null ? '' : text).replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; continue; } q = false; continue; }
        field += ch; continue;
      }
      if (ch === '"') { q = true; continue; }
      if (ch === ',') { row.push(field); field = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  }

  /**
   * 找出「有寫東西、但不是純數字」的請填_ 格子。
   * 專案根目錄那份 `刀具資料 CSV` 的 T11／T12 直徑就寫成 `8?`（意思是「大概 8，待確認」），
   * fromCSV 的數字驗證吃不下 → 整格當成沒填。不講的話現場會以為 8 mm 已經進去了。
   * @returns {{t:number, column:string, raw:string}[]}
   */
  function csvUnparsedCells(text) {
    const rows = csvRows(text);
    if (!rows.length) return [];
    const header = rows[0].map((s) => s.trim());
    const tCol = header.indexOf('T');
    if (tCol < 0) return [];
    const cols = CSV_NUMERIC_COLUMNS.map((name) => [name, header.indexOf(name)]).filter(([, i]) => i >= 0);
    const out = [];
    const seen = new Set();
    for (const r of rows.slice(1)) {
      const t = toNumber(String(r[tCol] == null ? '' : r[tCol]).trim().replace(/^T/i, ''), NaN);
      if (!Number.isFinite(t)) continue;
      for (const [name, i] of cols) {
        const raw = String(r[i] == null ? '' : r[i]).trim();
        if (!raw) continue;
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) continue;   // 與 NC.tools.fromCSV 的驗證一致
        // 同一份 CSV 常常同時放好幾支程式的列（刀具資料 CSV 就是），同一把刀會重複出現
        const key = t + '|' + name + '|' + raw;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ t, column: name, raw });
      }
    }
    return out;
  }

  /** 把 [{t:11,column:'請填_直徑mm',raw:'8?'},{t:12,...}] 併成「T11、T12 的「請填_直徑mm」寫的是 8?」。 */
  function groupUnparsed(list) {
    const groups = [];
    for (const x of (list || [])) {
      const g = groups.find((o) => o.column === x.column && o.raw === x.raw);
      if (g) g.ts.push(x.t); else groups.push({ column: x.column, raw: x.raw, ts: [x.t] });
    }
    // 原始值要用引號夾住：現場常常填「-」，不夾的話會和後面的破折號黏成一團看不出來
    return groups.map((g) => `${uniqSorted(g.ts).map((t) => 'T' + t).join('、')} 的「${g.column}」寫的是「${g.raw}」`);
  }

  /**
   * 把匯入的 CSV 合併進目前的刀具表：只取 CSV 裡標成「手填」的欄位，其餘維持原本的推測值。
   * 目前刀具表沒有的 T 號會記在 skipped（這支程式沒用到那把刀，硬塞進去只會污染資料）；
   * 數值不合理的格子記在 rejected（收進來只會讓成品圖無聲地錯掉）。
   *
   * @param {ToolTable} current
   * @param {ToolTable} imported  NC.tools.fromCSV 的輸出
   * @returns {{table:ToolTable, tools:number, offsets:number, fields:number, skipped:number[], rejected:Array, changed:Array}}
   */
  function mergeCSVTable(current, imported) {
    const table = U.deepClone(current || { programKey: '', tools: [], offsets: [], updatedAt: '' });
    table.tools = table.tools || [];
    table.offsets = table.offsets || [];
    const inTools = (imported && imported.tools) || [];
    const inOffsets = (imported && imported.offsets) || [];
    const skipped = [];
    const changed = [];
    const rejected = [];
    let toolCount = 0, fieldCount = 0, offsetCount = 0;
    for (const src of inTools) {
      if (!src || !Number.isFinite(src.t)) continue;
      const dst = table.tools.find((x) => x.t === src.t);
      if (!dst) { skipped.push(src.t); continue; }
      dst.source = dst.source || {};
      let hit = 0;
      for (const f of CSV_USER_FIELDS) {
        if (!src.source || src.source[f] !== 'user') continue;
        if (src[f] == null || src[f] === '') continue;
        const why = csvFieldError(f, src[f]);
        if (why) { rejected.push({ t: src.t, field: f, value: src[f], why }); continue; }
        dst[f] = src[f];
        dst.source[f] = 'user';
        hit++;
        changed.push({ t: src.t, field: f, value: src[f] });
      }
      if (hit) { toolCount++; fieldCount += hit; }
    }
    for (const o of inOffsets) {
      if (!o || !Number.isFinite(o.n) || o.source !== 'user') continue;
      const radGeom = toNumber(o.radGeom, 0) || 0;
      // 半徑形狀是負的沒有意義（摩耗可以是負的，形狀不行）
      if (!(radGeom >= 0)) { rejected.push({ d: o.n, field: 'radGeom', value: o.radGeom, why: '半徑形狀不可以是負的' }); continue; }
      const i = table.offsets.findIndex((e) => e.n === o.n);
      const entry = {
        n: o.n,
        lenGeom: toNumber(o.lenGeom, 0) || 0,
        lenWear: toNumber(o.lenWear, 0) || 0,
        radGeom,
        radWear: toNumber(o.radWear, 0) || 0,
        source: 'user',
      };
      if (i >= 0) table.offsets[i] = entry; else table.offsets.push(entry);
      offsetCount++;
    }
    table.offsets.sort((a, b) => a.n - b.n);
    table.updatedAt = new Date().toISOString();
    return { table, tools: toolCount, offsets: offsetCount, fields: fieldCount, skipped: uniqSorted(skipped), rejected, changed };
  }

  /** 「T11 的直徑」這種人看得懂的說法。 */
  function csvCellName(x) {
    if (x.d != null) return `D${x.d} 的補正值`;
    return `T${x.t} 的${CSV_FIELD_LABEL[x.field] || x.field}`;
  }

  /**
   * 匯入結果的一句話（沒東西可匯入也要講清楚，不能只是靜靜地什麼都沒發生）。
   * @param {*} r                  mergeCSVTable 的回傳
   * @param {Array} [unparsed]     csvUnparsedCells 的回傳（有寫東西但不是數字的格子）
   */
  function describeImport(r, unparsed) {
    if (!r) return '匯入失敗';
    const parts = [];
    if (r.tools) parts.push(`${r.tools} 把刀`);
    if (r.offsets) parts.push(`${r.offsets} 筆補正值`);
    let s = parts.length ? `匯入了 ${parts.join('、')}` : '這個檔案裡沒有「請填_」欄位的值可以匯入';
    if (r.skipped && r.skipped.length) {
      s += `；${r.skipped.map((t) => 'T' + t).join('、')} 這支程式沒用到，已略過`;
    }
    const bad = (r.rejected || []).slice(0, 4).map((x) => `${csvCellName(x)}（${x.value}：${x.why}）`);
    if (bad.length) {
      s += `；${bad.join('、')}${r.rejected.length > 4 ? ` 等 ${r.rejected.length} 格` : ''}沒有收`;
    }
    const raw = groupUnparsed(unparsed);
    if (raw.length) {
      s += `；${raw.slice(0, 3).join('、')}${raw.length > 3 ? ` 等 ${raw.length} 種` : ''}`
        + '——這幾格只填得下純數字，沒有匯進來';
    }
    return s;
  }

  /** 匯入結果該用哪一種顏色：有東西沒收進來就不能顯示成純綠色。 */
  function importStatusKind(r, unparsed) {
    if (!r || (!r.tools && !r.offsets)) return 'error';
    if ((r.rejected && r.rejected.length) || (unparsed && unparsed.length)) return 'warn';
    return 'ok';
  }

  panels.logic = {
    dListByTool, ensureOffsets, toolUsesDefault, countDefaultTools, setToolField, setOffsetField,
    filterDiagnostics, countBySeverity, formatTime, rangeText, listText, toNumber, fmt, clampInt,
    normalizeMagazine, defaultMagazine, magazineStatus, ringPositions, wrapPot,
    withBOM, csvFileName, looksLikeToolCSV, mergeCSVTable, describeImport, importStatusKind,
    csvFieldError, csvUnparsedCells, csvRows, groupUnparsed, CSV_FIELD_LABEL, CSV_NUMERIC_COLUMNS,
    TOOL_TYPES, TOOL_TYPE_LABEL, SEVERITIES, SEVERITY_LABEL, SOURCE_LABEL, KIND_LABEL, SCENARIO_LABEL, MULTISLASH_LABEL, CELL_OPTIONS,
    MAGAZINE_DEFAULTS, MAGAZINE_MAX_SIZE, MAGAZINE_RING_MAX,
  };

  // ---------------------------------------------------------------------------
  // DOM 小工具
  // ---------------------------------------------------------------------------
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') for (const dk of Object.keys(v)) el.dataset[dk] = String(v[dk]);
        else if (k === 'attrs') for (const ak of Object.keys(v)) el.setAttribute(ak, String(v[ak]));
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el[k] = v; // value / type / title / checked / disabled / placeholder …
      }
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function mount(container, root) { clear(container); container.appendChild(root); return root; }
  function call(fn, ...args) { if (typeof fn === 'function') return fn(...args); return undefined; }
  function numberInput(value, onCommit, extra) {
    const el = h('input', Object.assign({
      type: 'number', class: 'nc-num', value: value == null ? '' : String(value),
      onchange: (ev) => {
        const raw = el.value;
        const n = toNumber(raw, null);
        onCommit(n, raw, ev);
      },
    }, extra || {}));
    return el;
  }
  function sourceTag(source) {
    if (!source) return null;
    const label = SOURCE_LABEL[source] || source;
    return h('span', { class: `nc-src nc-src-${source}`, title: `來源：${label}` }, label);
  }
  function pill(severity) {
    return h('span', { class: `nc-pill nc-pill-${severity}` }, SEVERITY_LABEL[severity] || severity);
  }
  function select(options, value, onChange, extra) {
    const el = h('select', Object.assign({ class: 'nc-select' }, extra || {}),
      options.map(([v, label]) => h('option', { value: String(v) }, label)));
    el.value = String(value);
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }
  function checkbox(checked, onChange, label) {
    const input = h('input', { type: 'checkbox', checked: !!checked });
    input.addEventListener('change', () => onChange(!!input.checked));
    return h('label', { class: 'nc-check' }, input, ' ', label);
  }
  /** 拖進來的是不是檔案（在編輯器裡拖文字不算） */
  function dragHasFiles(ev) {
    const dt = ev && ev.dataTransfer;
    if (!dt) return false;
    if (dt.types) {
      for (let i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
      return false;
    }
    return !!(dt.files && dt.files.length);
  }
  function row(label, ...content) {
    return h('div', { class: 'nc-row' }, h('span', { class: 'nc-row-label' }, label), h('span', { class: 'nc-row-value' }, content));
  }

  // ---------------------------------------------------------------------------
  // 刀具表
  // ---------------------------------------------------------------------------
  panels.toolTable = function toolTable(container, opts) {
    const state = { table: null, dMap: {}, opts: Object.assign({}, opts), importMsg: null };
    const root = h('div', { class: 'nc-panel nc-panel-tools' });
    mount(container, root);
    let bannerEl = null;
    let msgEl = null;

    function commit() {
      stamp(state.table);
      call(state.opts.onChange, U.deepClone(state.table));
    }
    function refreshBanner() {
      const n = countDefaultTools(state.table, state.dMap);
      if (!bannerEl) return;
      bannerEl.className = 'nc-banner nc-banner-warn' + (n ? '' : ' nc-hidden');
      bannerEl.textContent = n ? `${n} 把刀使用預設值，成品圖可能不準` : '';
      bannerEl.dataset.count = String(n);
    }
    /** 匯入結果就顯示在刀具表上面（不用跑去看狀態列） */
    function renderImportMsg() {
      if (!msgEl) return;
      const m = state.importMsg;
      msgEl.className = 'nc-import-msg' + (m ? ' is-' + m.kind : ' nc-hidden');
      msgEl.textContent = m ? m.text : '';
    }
    function setImportStatus(text, kind) {
      state.importMsg = text ? { text, kind: kind || 'ok' } : null;
      renderImportMsg();
    }
    function pickFile(file) {
      if (!file) return;
      setImportStatus('讀取中…', 'busy');
      call(state.opts.onImportFile, file);
    }
    /** CSV 工具列：現場拿 Excel 填直徑、角度、刃長、D 補正值，就是靠這兩顆按鈕來回。 */
    function csvBar() {
      const fileEl = h('input', {
        type: 'file', class: 'nc-hidden-file', dataset: { role: 'csv' },
        attrs: { accept: '.csv,text/csv', 'aria-label': '選擇刀具表 CSV' },
      });
      fileEl.addEventListener('change', () => {
        const f = fileEl.files && fileEl.files[0];
        fileEl.value = '';
        pickFile(f);
      });
      return h('div', { class: 'nc-tools-bar' },
        h('button', {
          type: 'button', class: 'nc-btn nc-btn-small', dataset: { action: 'exportCsv' },
          title: '存成 CSV（UTF-8 BOM，Excel 直接開得起來），拿給現場填直徑、角度、刃長、D 補正值',
          onclick: () => call(state.opts.onExportCSV),
        }, '匯出 CSV'),
        h('button', {
          type: 'button', class: 'nc-btn nc-btn-small', dataset: { action: 'importCsv' },
          title: '讀入填好的 CSV，把「請填_」欄位的值併進刀具表（也可以直接把檔案拖進這個面板）',
          onclick: () => { if (typeof fileEl.click === 'function') fileEl.click(); },
        }, '匯入 CSV'),
        fileEl,
        h('span', { class: 'nc-muted nc-tools-bar-hint' }, '把 CSV 拖進這個面板也可以'));
    }
    function replaceTag(holder, source) {
      clear(holder);
      const t = sourceTag(source);
      if (t) holder.appendChild(t);
    }

    function renderRow(tool) {
      const table = state.table;
      const tags = {};
      const dInputs = {}; // d → {rad, wear, tag}
      const tagHolder = (field) => { const sp = h('span', { class: 'nc-tag-holder', dataset: { field } }, sourceTag(tool.source && tool.source[field])); tags[field] = sp; return sp; };

      const star = h('button', {
        type: 'button', class: 'nc-star' + (tool.resident ? ' nc-on' : ''), title: tool.resident ? '常駐刀（跨程式共用）' : '設為常駐刀',
        onclick: () => {
          setToolField(table, tool.t, 'resident', !tool.resident, state.dMap);
          star.className = 'nc-star' + (tool.resident ? ' nc-on' : '');
          star.title = tool.resident ? '常駐刀（跨程式共用）' : '設為常駐刀';
          commit();
        },
      }, '★');

      const labelInput = h('input', {
        type: 'text', class: 'nc-text', value: tool.label || '', placeholder: '註解',
        onchange: () => { setToolField(table, tool.t, 'label', labelInput.value, state.dMap); commit(); },
      });

      const typeSel = select(TOOL_TYPES, tool.type || 'unknown', (v) => {
        setToolField(table, tool.t, 'type', v, state.dMap);
        replaceTag(tags.type, 'user');
        typeSel.title = TOOL_TYPE_DESC[v] || '';
        renderExtra(v);
        refreshBanner();
        commit();
      }, { dataset: { field: 'type' }, title: TOOL_TYPE_DESC[tool.type || 'unknown'] || '' });

      const diaInput = numberInput(tool.diameter, (n) => {
        if (n == null || n <= 0) { diaInput.value = String(tool.diameter == null ? '' : tool.diameter); return; }
        const linked = setToolField(table, tool.t, 'diameter', n, state.dMap);
        replaceTag(tags.diameter, 'user');
        for (const d of linked) {
          const off = findOffset(table, d);
          if (dInputs[d]) { dInputs[d].rad.value = String(off.radGeom); replaceTag(dInputs[d].tag, off.source); }
        }
        refreshBanner();
        commit();
      }, { attrs: { min: '0', step: '0.01' }, title: '直徑 mm', dataset: { field: 'diameter' } });

      const angInput = numberInput(tool.angle, (n) => {
        setToolField(table, tool.t, 'angle', n, state.dMap);
        replaceTag(tags.angle, 'user');
        commit();
      }, { attrs: { min: '0', max: '180', step: '1' }, title: '刀尖角／倒角夾角（度）', placeholder: '—', dataset: { field: 'angle' } });

      const fluteInput = numberInput(tool.fluteLen, (n) => {
        setToolField(table, tool.t, 'fluteLen', n, state.dMap);
        replaceTag(tags.fluteLen, 'user');
        commit();
      }, { attrs: { min: '0', step: '0.5' }, title: '刃長 mm', placeholder: '未填', dataset: { field: 'fluteLen' } });

      // 角R／頸徑：只有需要的型式才給欄位（圓鼻刀、外R成型刀、T型刀、鳩尾槽刀、糖球形銑刀、
      // 中心鑽、魚眼孔鑽）。換型式時就地重畫，不用整張表重繪。
      const extraCell = h('td', { class: 'nc-td-extra' });
      function renderExtra(type) {
        clear(extraCell);
        const fields = extraFieldsOf(type);
        if (!fields.length) { extraCell.appendChild(h('span', { class: 'nc-muted' }, '—')); return; }
        for (const f of fields) {
          const tagSp = h('span', { class: 'nc-tag-holder', dataset: { field: f } }, sourceTag(tool.source && tool.source[f]));
          const input = numberInput(tool[f], (n) => {
            setToolField(table, tool.t, f, n, state.dMap);
            replaceTag(tagSp, 'user');
            commit();
          }, {
            attrs: { min: '0', step: '0.1' }, placeholder: '未填', dataset: { field: f },
            title: f === 'cornerRad' ? '角R／成型半徑 mm' : '頸徑（刀桿或導柱直徑）mm',
          });
          extraCell.appendChild(h('div', { class: 'nc-extra-line', dataset: { field: f } },
            h('span', { class: 'nc-extra-name' }, CSV_FIELD_LABEL[f]), input, tagSp));
        }
      }
      renderExtra(tool.type || 'unknown');

      const dList = state.dMap[tool.t] || [];
      const dCell = h('td', { class: 'nc-td-d' });
      if (!dList.length) dCell.appendChild(h('span', { class: 'nc-muted' }, '—'));
      for (const d of dList) {
        const off = findOffset(table, d) || { n: d, radGeom: 0, radWear: 0, source: 'default' };
        const tagSp = h('span', { class: 'nc-tag-holder', dataset: { d } }, sourceTag(off.source));
        const rad = numberInput(off.radGeom, (n) => {
          if (n == null) { rad.value = String(findOffset(table, d).radGeom); return; }
          setOffsetField(table, d, 'radGeom', n);
          replaceTag(tagSp, 'user');
          refreshBanner();
          commit();
        }, { attrs: { step: '0.001' }, title: `D${d} 半徑形狀`, class: 'nc-num nc-num-d', dataset: { d, field: 'radGeom' } });
        const wear = numberInput(off.radWear, (n) => {
          if (n == null) { wear.value = String(findOffset(table, d).radWear); return; }
          setOffsetField(table, d, 'radWear', n);
          replaceTag(tagSp, 'user');
          refreshBanner();
          commit();
        }, { attrs: { step: '0.001' }, title: `D${d} 半徑摩耗`, class: 'nc-num nc-num-d', dataset: { d, field: 'radWear' } });
        dInputs[d] = { rad, wear, tag: tagSp };
        dCell.appendChild(h('div', { class: 'nc-dline', dataset: { d } },
          h('span', { class: 'nc-dno' }, `D${d}`),
          h('span', { class: 'nc-dfield' }, '形狀 ', rad),
          h('span', { class: 'nc-dfield' }, '摩耗 ', wear),
          tagSp));
      }

      const marks = [];
      if (tool.probe) marks.push(h('span', { class: 'nc-badge nc-badge-probe', title: '無註解且無切削動作，可能是定位器／測距用的空刀位' }, '定位器?'));
      if (tool.type === 'tap' && tool.pitch != null) marks.push(h('span', { class: 'nc-badge' }, `P${fmt(tool.pitch)}`));

      // 標記放在第一欄：D 補正欄很寬，擺在最後一欄常常要橫向捲動才看得到。
      return h('tr', { class: 'nc-tool' + (tool.probe ? ' nc-probe' : ''), dataset: { t: tool.t } },
        h('td', { class: 'nc-td-t' }, h('span', { class: 'nc-tno' }, `T${tool.t}`), star,
          marks.length ? h('span', { class: 'nc-td-marks' }, marks) : null),
        h('td', null, labelInput),
        h('td', null, typeSel, tagHolder('type')),
        h('td', null, diaInput, tagHolder('diameter')),
        h('td', null, angInput, tagHolder('angle')),
        h('td', null, fluteInput, tagHolder('fluteLen')),
        extraCell,
        dCell);
    }

    function render() {
      clear(root);
      const table = state.table;
      bannerEl = h('div', { class: 'nc-banner nc-banner-warn nc-hidden' });
      root.appendChild(bannerEl);
      root.appendChild(csvBar());
      msgEl = h('div', { class: 'nc-import-msg nc-hidden' });
      root.appendChild(msgEl);
      renderImportMsg();
      root.appendChild(h('div', { class: 'nc-legend' },
        h('span', { class: 'nc-legend-title' }, '來源：'),
        Object.keys(SOURCE_LABEL).map((s) => sourceTag(s)),
        h('span', { class: 'nc-legend-sep' }, ' ★ 常駐刀 ')));
      if (!table.tools.length) {
        root.appendChild(h('div', { class: 'nc-empty' }, '沒有刀具（程式中沒有 M6）'));
        return;
      }
      const thead = h('thead', null, h('tr', null,
        ['T', '註解', '型式', '直徑 mm', '角度°', '刃長', '角R／頸徑', 'D 補正（半徑）'].map((s) => h('th', null, s))));
      const tbody = h('tbody', null, table.tools.map(renderRow));
      root.appendChild(h('div', { class: 'nc-scroll' }, h('table', { class: 'nc-table nc-tools' }, thead, tbody)));
      refreshBanner();
    }

    function update(next) {
      if (next) Object.assign(state.opts, next);
      state.table = U.deepClone(state.opts.table || { programKey: '', tools: [], offsets: [], updatedAt: '' });
      state.table.tools = state.table.tools || [];
      state.table.offsets = state.table.offsets || [];
      state.dMap = dListByTool(state.table, state.opts.ops, state.opts.dByTool);
      ensureOffsets(state.table, state.dMap);
      render();
    }
    update();

    // 把 CSV 直接拖到刀具表面板上。整頁拖放是開 NC 程式用的，所以這裡只攔副檔名是 .csv 的；
    // 其他檔案照樣讓它冒泡到 window，由 app 當成程式開起來。
    root.addEventListener('dragover', (ev) => {
      if (!dragHasFiles(ev)) return;
      if (ev.preventDefault) ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
      root.classList.add('is-csv-drop');
    });
    root.addEventListener('dragleave', () => root.classList.remove('is-csv-drop'));
    root.addEventListener('drop', (ev) => {
      root.classList.remove('is-csv-drop');
      if (!dragHasFiles(ev)) return;
      const f = ev.dataTransfer.files[0];
      if (!f || !/\.csv$/i.test(String(f.name || ''))) return;   // 交給整頁拖放去判斷
      if (ev.preventDefault) ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
      pickFile(f);
    });

    return {
      el: root, update, setImportStatus,
      getTable: () => U.deepClone(state.table), getDMap: () => U.deepClone(state.dMap),
    };
  };

  // ---------------------------------------------------------------------------
  // 錯誤清單
  // ---------------------------------------------------------------------------
  panels.diagnostics = function diagnostics(container, opts) {
    const state = {
      opts: Object.assign({}, opts),
      filter: Object.assign({ severities: SEVERITIES.slice(), onlyScenarioOn: false, text: '', flat: false }, (opts && opts.filter) || {}),
      expanded: new Set(),
      selectedId: (opts && opts.selectedId) || null,
    };
    const root = h('div', { class: 'nc-panel nc-panel-diag' });
    mount(container, root);
    let listEl = null;
    let summaryEl = null;

    function sevSet() { return new Set(state.filter.severities || SEVERITIES); }

    /**
     * 同一原因、只是發生在很多行的診斷歸成一組（analyze.js 已標好 groupKey）。
     * 回傳 [{ head, members }]，head 是這一組要列出的那一則。
     * 沒有 groupKey（例如自己組的資料）就一則一組，行為與分組前相同。
     */
    function groupDiagnostics(list) {
      const out = [];
      const byKey = new Map();
      for (const it of list) {
        const k = it.groupKey || null;
        if (!k) { out.push({ head: it, members: [it] }); continue; }
        const g = byKey.get(k);
        // analyze 已經把組內最嚴重的那一筆標成 groupFirst；摺疊列要顯示它，
        // 不然「干涉 0.05 mm ×25」會蓋掉組內真正的 46 mm。
        if (g) { g.members.push(it); if (it.groupFirst) g.head = it; continue; }
        const ng = { head: it, members: [it] };
        byKey.set(k, ng);
        out.push(ng);
      }
      return out;
    }

    /** 摺疊列的「0.05–46.5 mm」：analyze 在代表那一筆放了 groupRange */
    function rangeText(it) {
      const r = it && it.groupRange;
      if (!r || !(r.max > r.min)) return '';
      return `（${fmt(r.min, 2)}–${fmt(r.max, 2)}）`;
    }
    function rangeTitle(it) {
      const r = it && it.groupRange;
      if (!r || !(r.max > r.min)) return '';
      return `\n這一組的嚴重程度從 ${fmt(r.min, 2)} 到 ${fmt(r.max, 2)}，這一列顯示的是最嚴重的那一筆。`;
    }

    const MAX_LINE_CHIPS = 60;
    /** 一組裡每一行做成可點的小方塊，點了直接跳到那一行 */
    function lineChips(members, headId) {
      const wrap = h('div', { class: 'nc-diag-lines' },
        h('span', { class: 'nc-diag-lines-label' }, `同一原因共 ${members.length} 處：`));
      for (const m of members.slice(0, MAX_LINE_CHIPS)) {
        wrap.appendChild(h('button', {
          type: 'button', class: 'nc-lineno', dataset: { line: m.line }, title: `跳到第 ${m.line} 行`,
          onclick: (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); highlight(headId); call(state.opts.onJump, m.line, m); },
        }, m.line > 0 ? `L${m.line}` : '全程式'));
      }
      if (members.length > MAX_LINE_CHIPS) {
        wrap.appendChild(h('span', { class: 'nc-muted' }, ` …還有 ${members.length - MAX_LINE_CHIPS} 處`));
      }
      return wrap;
    }

    function renderItem(it, members) {
      const group = members && members.length > 1 ? members : null;
      const hasBody = !!(it.detail || it.fanucAlarm || it.fix || group);
      const li = h('li', {
        class: `nc-diag nc-sev-${it.severity}` + (state.expanded.has(it.id) ? ' nc-open' : '') + (state.selectedId === it.id ? ' nc-selected' : ''),
        dataset: { id: it.id, line: it.line, rule: it.ruleId },
        title: it.line > 0 ? `跳到第 ${it.line} 行` : '整支程式',
        onclick: () => { highlight(it.id); call(state.opts.onJump, it.line, it); },
      });
      const head = h('div', { class: 'nc-diag-head' },
        pill(it.severity),
        h('span', { class: 'nc-diag-line' }, it.line > 0 ? `L${it.line}` : '全程式'),
        h('span', { class: 'nc-diag-msg' }, it.message),
        group ? h('span', {
          class: 'nc-diag-count',
          title: `同一原因共 ${group.length} 處，展開可看全部行號` + rangeTitle(it),
        }, `×${group.length}${rangeText(it)}`) : null,
        it.estimatedStock ? h('span', {
          class: 'nc-badge nc-badge-est',
          title: '這一則是拿「推估素材」判出來的（素材尺寸是用切削範圍猜的，不是真的毛胚）。'
            + '到「素材與設定」填入真實尺寸後會重算。',
        }, '推估素材') : null,
        it.scenario ? h('span', { class: `nc-badge nc-badge-scn nc-scn-${it.scenario}`, title: `只在「${SCENARIO_LABEL[it.scenario] || it.scenario}」情境發生` }, SCENARIO_SHORT[it.scenario] || it.scenario) : null,
        h('span', { class: 'nc-diag-rule' }, it.ruleId),
        hasBody ? h('button', {
          type: 'button', class: 'nc-expand', title: '展開／收合詳情',
          onclick: (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); toggle(it.id, li); },
        }, '▸') : null);
      li.appendChild(head);
      if (hasBody) {
        const body = h('div', { class: 'nc-diag-detail' });
        if (group) body.appendChild(lineChips(group, it.id));
        if (it.detail) body.appendChild(h('p', { class: 'nc-diag-text' }, it.detail));
        if (it.fanucAlarm) body.appendChild(h('p', { class: 'nc-diag-alarm' }, '機台警報：', h('code', null, it.fanucAlarm)));
        if (it.fix) {
          body.appendChild(h('p', { class: 'nc-diag-fix' },
            h('span', null, '建議：', it.fix.label, ' '),
            h('button', {
              type: 'button', class: 'nc-btn nc-btn-small',
              onclick: (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); call(state.opts.onFix, it); },
            }, '套用修正')));
        }
        li.appendChild(body);
      }
      return li;
    }
    function toggle(id, li) {
      if (state.expanded.has(id)) { state.expanded.delete(id); li.classList.remove('nc-open'); }
      else { state.expanded.add(id); li.classList.add('nc-open'); }
    }
    function highlight(id) {
      state.selectedId = id;
      if (!listEl) return;
      for (const li of Array.from(listEl.children)) {
        if (li.dataset && li.dataset.id === id) li.classList.add('nc-selected'); else li.classList.remove('nc-selected');
      }
    }
    function renderList() {
      const shown = filterDiagnostics(state.opts.items, state.filter);
      const total = (state.opts.items || []).length;
      const groups = state.filter.flat ? shown.map((it) => ({ head: it, members: [it] })) : groupDiagnostics(shown);
      if (summaryEl) {
        summaryEl.textContent = groups.length === shown.length
          ? `顯示 ${shown.length} / ${total} 筆`
          : `顯示 ${groups.length} 組（${shown.length} / ${total} 筆）`;
      }
      clear(listEl);
      if (!shown.length) { listEl.appendChild(h('li', { class: 'nc-empty' }, total ? '篩選後沒有項目' : '沒有問題')); return; }
      for (const g of groups) listEl.appendChild(renderItem(g.head, g.members));
    }
    function render() {
      clear(root);
      const counts = countBySeverity(state.opts.items);
      const sev = sevSet();
      const bar = h('div', { class: 'nc-filter' });
      for (const s of SEVERITIES) {
        bar.appendChild(checkbox(sev.has(s), (on) => {
          const cur = sevSet();
          if (on) cur.add(s); else cur.delete(s);
          state.filter.severities = SEVERITIES.filter((x) => cur.has(x));
          renderList();
        }, [pill(s), h('span', { class: 'nc-count', dataset: { sev: s } }, String(counts[s]))]));
      }
      const onlyOn = checkbox(state.filter.onlyScenarioOn, (on) => { state.filter.onlyScenarioOn = on; renderList(); }, '只看 skip ON 差異');
      onlyOn.className += ' nc-check-scn';
      bar.appendChild(onlyOn);
      const flat = checkbox(!!state.filter.flat, (on) => { state.filter.flat = on; renderList(); }, '逐行列出');
      flat.className += ' nc-check-flat';
      flat.title = '關閉時同一原因的多行會摺成一列（後面顯示 ×N），展開可看全部行號';
      bar.appendChild(flat);
      const search = h('input', { type: 'search', class: 'nc-text nc-search', placeholder: '搜尋訊息／規則', value: state.filter.text || '' });
      search.addEventListener('input', () => { state.filter.text = search.value; renderList(); });
      search.addEventListener('change', () => { state.filter.text = search.value; renderList(); });
      bar.appendChild(search);
      summaryEl = h('span', { class: 'nc-diag-summary' });
      bar.appendChild(summaryEl);
      root.appendChild(bar);
      listEl = h('ul', { class: 'nc-diag-list' });
      root.appendChild(listEl);
      renderList();
    }
    function update(next) {
      if (next) {
        if (next.filter) Object.assign(state.filter, next.filter);
        if (next.selectedId !== undefined) state.selectedId = next.selectedId;
        Object.assign(state.opts, next);
      }
      render();
    }
    update();
    return {
      el: root, update, highlight,
      setFilter: (f) => { Object.assign(state.filter, f || {}); render(); },
      getFilter: () => Object.assign({}, state.filter, { severities: (state.filter.severities || SEVERITIES).slice() }),
      getShown: () => filterDiagnostics(state.opts.items, state.filter),
    };
  };

  // ---------------------------------------------------------------------------
  // 模態狀態
  // ---------------------------------------------------------------------------
  function fmtPos(p) { return p ? `X${fmt(p.x)}  Y${fmt(p.y)}  Z${fmt(p.z)}` : '—'; }
  panels.modal = function modal(container, state, extra) {
    const root = h('div', { class: 'nc-panel nc-panel-modal' });
    mount(container, root);
    function section(title, rows) {
      return h('div', { class: 'nc-modal-sec' }, h('div', { class: 'nc-modal-title' }, title), h('div', { class: 'nc-modal-grid' },
        rows.filter(Boolean).map(([k, v, cls]) => [h('span', { class: 'nc-k' }, k), h('span', { class: 'nc-v' + (cls ? ' ' + cls : ''), dataset: { key: k } }, v)])));
    }
    function render(st, ex) {
      clear(root);
      if (!st) { root.appendChild(h('div', { class: 'nc-empty' }, '游標所在行尚無執行資訊')); return; }
      const x = ex || {};
      const sp = st.spindle || {};
      const cyc = st.cycle;
      const extraRows = [];
      if (x.line != null) extraRows.push(['行', `L${x.line}`]);
      if (x.text) extraRows.push(['內容', h('code', null, x.text)]);
      if (x.comment) extraRows.push(['註解', x.comment]);
      if (x.opIndex != null) extraRows.push(['作業', x.opIndex < 0 ? '換刀前' : `#${x.opIndex + 1}`]);
      if (x.skipped) extraRows.push(['狀態', '此情境下被跳過', 'nc-warn']);
      if (x.ignored) extraRows.push(['狀態', '多斜線節，永遠忽略', 'nc-warn']);
      for (const k of Object.keys(x)) if (!['line', 'text', 'comment', 'opIndex', 'skipped', 'ignored'].includes(k) && x[k] != null && typeof x[k] !== 'object') extraRows.push([k, String(x[k])]);
      if (extraRows.length) root.appendChild(section('節', extraRows));
      root.appendChild(section('位置（執行後，工件座標）', [
        ['位置', fmtPos(st.pos), 'nc-pos'],
        // 第四軸只在真的轉離 0 之後才列——三軸程式（A 恆為 0）多一列反而是雜訊
        (typeof st.a === 'number' && Math.abs(st.a) > 1e-9) ? ['第四軸', `A${fmt(st.a)}°`, 'nc-active'] : null,
      ]));
      root.appendChild(section('G 群組', [
        ['移動', st.motion || '—'], ['距離', st.distance], ['平面', st.plane], ['單位', st.units], ['進給模式', st.feedMode], ['座標系', st.wcs],
        ['刀徑補正', st.comp + (st.d ? ` D${st.d}` : ''), st.comp !== 'G40' ? 'nc-active' : ''],
        ['刀長補正', st.lengthComp + (st.h ? ` H${st.h}` : ''), st.lengthComp === 'G43' && !st.lengthCompActive ? 'nc-warn' : ''],
        ['固定循環', cyc ? cyc.code : 'G80', cyc ? 'nc-active' : ''], ['回歸', st.retractMode],
      ]));
      root.appendChild(section('F / S / M', [
        ['F', st.feed == null ? '未指定' : `${fmt(st.feed)} mm/min`, st.feed == null ? 'nc-warn' : ''],
        ['S', `${sp.dir || 'M5'}${sp.rpm != null ? ' ' + fmt(sp.rpm) + ' rpm' : ''}`, sp.dir === 'M5' ? 'nc-warn' : ''],
        ['冷卻', st.coolant ? 'M8 開' : 'M9 關'],
        ['AICC', st.aicc ? 'G05.1 Q1 開' : '關'],
        st.rigidTap ? ['剛性攻牙', `M29${st.rigidTapS != null ? ' S' + fmt(st.rigidTapS) : ''}`, 'nc-active'] : null,
      ]));
      root.appendChild(section('刀具', [
        ['主軸', st.toolInSpindle != null ? `T${st.toolInSpindle}` : '—'],
        ['預選', st.toolStaged != null ? `T${st.toolStaged}` : '—'],
      ]));
      if (cyc) {
        root.appendChild(section('循環', [
          ['R 點', fmt(cyc.r)], ['孔底 Z', fmt(cyc.z)], ['Q', cyc.q != null ? fmt(cyc.q) : '—'], ['P', cyc.p != null ? fmt(cyc.p) : '—'],
          ['初始面', fmt(cyc.initialZ)], ['退回', cyc.retract === 'G98' ? 'G98 初始面' : 'G99 R 點'],
        ]));
      }
    }
    render(state, extra);
    return { el: root, update: render };
  };

  // ---------------------------------------------------------------------------
  // 作業摘要
  // ---------------------------------------------------------------------------
  panels.ops = function ops(container, opts) {
    const state = { opts: Object.assign({}, opts), selected: (opts && opts.selectedIndex != null) ? opts.selectedIndex : null };
    const root = h('div', { class: 'nc-panel nc-panel-ops' });
    mount(container, root);
    let tbody = null;
    function toolLabel(op) {
      const tt = state.opts.toolTable;
      const tool = tt && tt.tools ? tt.tools.find((x) => x.t === op.tool) : null;
      return op.toolComment || (tool ? tool.label : '') || '';
    }
    function select(index) {
      state.selected = index;
      if (!tbody) return;
      for (const tr of Array.from(tbody.children)) {
        if (Number(tr.dataset.index) === index) tr.classList.add('nc-selected'); else tr.classList.remove('nc-selected');
      }
    }
    function render() {
      clear(root);
      const list = state.opts.ops || [];
      const time = state.opts.time || null;
      if (!list.length) { root.appendChild(h('div', { class: 'nc-empty' }, '沒有作業（程式中沒有 M6）')); return; }
      const thead = h('thead', null, h('tr', null,
        ['#', 'T', '註解', 'H', 'D', '型式', '最深 Z', 'F', 'S', '行', '時間'].map((s) => h('th', null, s))));
      tbody = h('tbody', null, list.map((op, i) => {
        const t = time && time.perOp ? time.perOp[op.index != null ? op.index : i] : null;
        return h('tr', {
          class: 'nc-op' + (state.selected === op.index ? ' nc-selected' : ''),
          dataset: { index: op.index, line: op.lineStart },
          title: `跳到第 ${op.lineStart} 行`,
          onclick: () => { select(op.index); call(state.opts.onJump, op.lineStart, op); },
        },
          h('td', null, String(op.index + 1)),
          h('td', { class: 'nc-tno' }, op.tool != null ? `T${op.tool}` : '—'),
          h('td', null, toolLabel(op)),
          h('td', null, op.h != null ? `H${op.h}` : '—'),
          h('td', null, (op.dList && op.dList.length) ? op.dList.map((d) => `D${d}`).join(' ') : '—'),
          h('td', null, h('span', { class: `nc-kind nc-kind-${op.kindGuess || 'unknown'}` }, KIND_LABEL[op.kindGuess] || op.kindGuess || '未知')),
          h('td', { class: 'nc-num-cell' + (op.zMin != null && op.zMin < 0 ? ' nc-deep' : '') }, op.zMin == null ? '—' : fmt(op.zMin)),
          h('td', { class: 'nc-num-cell' }, listText(op.feeds)),
          h('td', { class: 'nc-num-cell' }, listText(op.rpms)),
          h('td', { class: 'nc-num-cell' }, `${op.lineStart}–${op.lineEnd}`),
          h('td', { class: 'nc-num-cell' }, formatTime(t)));
      }));
      const tfoot = time ? h('tfoot', null, h('tr', null, h('td', { attrs: { colspan: '10' } }, '合計'), h('td', { class: 'nc-num-cell' }, formatTime(time.total)))) : null;
      root.appendChild(h('div', { class: 'nc-scroll' }, h('table', { class: 'nc-table nc-ops' }, thead, tbody, tfoot)));
    }
    function update(next) {
      if (next) { Object.assign(state.opts, next); if (next.selectedIndex !== undefined) state.selected = next.selectedIndex; }
      render();
    }
    update();
    return { el: root, update, select };
  };

  // ---------------------------------------------------------------------------
  // 素材與夾具
  // ---------------------------------------------------------------------------
  panels.stock = function stock(container, opts) {
    const state = { opts: Object.assign({}, opts), stock: null };
    const root = h('div', { class: 'nc-panel nc-panel-stock' });
    mount(container, root);

    function commit(asUser) {
      if (asUser) state.stock.source = 'user';
      call(state.opts.onChange, U.deepClone(state.stock));
    }
    function vecRows(obj, onEdit, prefix) {
      // obj = {min, max}；回傳 X/Y/Z 三列，每列 min/max 兩個輸入
      return ['x', 'y', 'z'].map((axis) => h('div', { class: 'nc-row' },
        h('span', { class: 'nc-row-label' }, axis.toUpperCase()),
        h('span', { class: 'nc-row-value' },
          numberInput(obj.min[axis], (n) => { if (n == null) return; obj.min[axis] = n; onEdit(); }, { attrs: { step: '1' }, title: `${axis.toUpperCase()} 最小`, dataset: { field: `${prefix}min.${axis}` } }),
          ' ～ ',
          numberInput(obj.max[axis], (n) => { if (n == null) return; obj.max[axis] = n; onEdit(); }, { attrs: { step: '1' }, title: `${axis.toUpperCase()} 最大`, dataset: { field: `${prefix}max.${axis}` } }),
          h('span', { class: 'nc-muted nc-size', dataset: { axis } }, ` （${fmt(obj.max[axis] - obj.min[axis])}）`))));
    }
    function render() {
      clear(root);
      const s = state.stock;
      const isUser = s.source === 'user';
      root.appendChild(h('div', { class: 'nc-stock-head' },
        h('span', { class: 'nc-badge ' + (isUser ? 'nc-badge-user' : 'nc-badge-est'), dataset: { source: s.source } }, isUser ? '手動指定' : '由程式推估'),
        h('span', { class: 'nc-muted' }, ` 尺寸 ${fmt(s.max.x - s.min.x)} × ${fmt(s.max.y - s.min.y)} × ${fmt(s.max.z - s.min.z)} mm`),
        isUser ? h('button', { type: 'button', class: 'nc-btn nc-btn-small nc-btn-reset', title: '丟掉手動值，改用程式推估', onclick: () => call(state.opts.onChange, null) }, '回到推估') : null));
      if (!isUser) {
        root.appendChild(h('div', { class: 'nc-muted nc-stock-note' },
          '這是用「程式切到哪裡」往外擴一個刀半徑猜出來的，不是真的毛胚尺寸；'
          + '工件外圍那一圈料實際上可能不存在。填入真實尺寸後，碰撞與下刀判定會全部重算。'));
      }
      root.appendChild(h('div', { class: 'nc-stock-box' },
        h('div', { class: 'nc-sub-title' }, '素材範圍（工件座標）'),
        vecRows(s, () => { commit(true); render(); }, '')));
      const fx = h('div', { class: 'nc-fixtures' }, h('div', { class: 'nc-sub-title' }, '夾具／不可切區域'));
      if (!s.fixtures.length) fx.appendChild(h('div', { class: 'nc-muted' }, '（無）'));
      s.fixtures.forEach((f, i) => {
        const nameInput = h('input', { type: 'text', class: 'nc-text', value: f.name || '', placeholder: `夾具 ${i + 1}`, onchange: () => { f.name = nameInput.value; commit(true); } });
        fx.appendChild(h('div', { class: 'nc-fixture', dataset: { index: i } },
          h('div', { class: 'nc-fixture-head' }, nameInput,
            h('button', { type: 'button', class: 'nc-btn nc-btn-small nc-btn-danger', title: '刪除此夾具', onclick: () => { s.fixtures.splice(i, 1); commit(true); render(); } }, '刪除')),
          vecRows(f, () => { commit(true); render(); }, `fixture${i}.`)));
      });
      fx.appendChild(h('button', {
        type: 'button', class: 'nc-btn nc-btn-small nc-btn-add',
        onclick: () => {
          const n = s.fixtures.length + 1;
          s.fixtures.push({ name: `夾具 ${n}`, min: { x: s.min.x, y: s.min.y, z: s.min.z }, max: { x: s.min.x + 20, y: s.min.y + 20, z: s.max.z } });
          commit(true); render();
        },
      }, '＋ 新增夾具'));
      root.appendChild(fx);
    }
    function update(next) {
      if (next) Object.assign(state.opts, next);
      const src = state.opts.stock || { min: { x: 0, y: 0, z: -10 }, max: { x: 100, y: 100, z: 0 }, source: 'estimated', fixtures: [] };
      state.stock = U.deepClone(src);
      state.stock.fixtures = state.stock.fixtures || [];
      render();
    }
    update();
    return { el: root, update, getStock: () => U.deepClone(state.stock) };
  };

  // ---------------------------------------------------------------------------
  // 刀庫配置
  //
  // magazine(container, {magazine, toolTable, usedTools, onChange})
  //   onChange(magazine | null)   null = 關閉刀庫檢查（settings.magazine 要變成 undefined）
  // ---------------------------------------------------------------------------
  panels.magazine = function magazine(container, opts) {
    const state = {
      opts: Object.assign({}, opts),
      mag: null,          // null = 未啟用
      armed: null,        // 目前「拿在手上」要放進刀位的 T 號
      note: '',           // 一次性提示（例如縮小刀庫時被移除的登記）
      lastMag: null,      // 上一次啟用時的配置：不小心關掉再打開，刀位不該整份消失
    };
    const root = h('div', { class: 'nc-panel nc-panel-mag' });
    mount(container, root);

    function toolsOf() {
      const tt = state.opts.toolTable;
      return (tt && tt.tools) || [];
    }
    function usedTs() {
      if (Array.isArray(state.opts.usedTools)) return uniqSorted(state.opts.usedTools.map(Number));
      return uniqSorted(toolsOf().map((x) => x.t));
    }
    function toolOf(t) { return toolsOf().find((x) => x.t === t) || null; }
    function labelOf(t) {
      const tool = toolOf(t);
      if (!tool) return `T${t}`;
      const dia = tool.diameter > 0 ? ` Ø${fmt(tool.diameter)}` : '';
      const name = tool.label && tool.label !== `T${t}` ? ` ${tool.label}` : '';
      return `T${t}${name}${dia}`;
    }
    function commit() {
      call(state.opts.onChange, state.mag ? U.deepClone(state.mag) : null);
    }
    function commitAndRender() { commit(); render(); }

    /** 目前刀庫裡登記的所有 T（含本程式沒用到的鄰居刀） */
    function registeredTs() {
      return state.mag ? Object.keys(state.mag.pots).map(Number).sort((a, b) => a - b) : [];
    }

    function assign(t, pot) {
      if (!state.mag) return;
      if (pot == null) delete state.mag.pots[t];
      else state.mag.pots[t] = wrapPot(pot, state.mag.size);
    }

    // ---- 刀位圖 ----
    function potCell(cell) {
      const cls = ['nc-pot'];
      if (cell.tools.length) cls.push('is-filled');
      if (cell.big) cls.push('is-big');
      if (cell.clearFor.length) cls.push('is-clear');
      if (cell.conflict) cls.push('is-conflict');
      if (cell.inProgram) cls.push('is-inprogram');
      if (state.armed != null) cls.push('is-target');
      const names = cell.tools.map((t) => labelOf(t));
      const tip = [`第 ${cell.pot} 號刀位`];
      if (names.length) tip.push('放：' + names.join('、')); else tip.push('（空）');
      if (cell.big) tip.push('大徑刀，兩側刀位必須淨空');
      if (cell.clearFor.length) tip.push(`必須為 ${cell.clearFor.map((t) => 'T' + t).join('、')} 淨空`);
      if (cell.conflict) tip.push('⚠ 這裡會撞刀');
      tip.push(state.armed != null ? `點一下把 T${state.armed} 放進來` : '點一下清空這個刀位');
      return h('button', {
        type: 'button', class: cls.join(' '), title: tip.join('\n'),
        dataset: { pot: cell.pot, tools: cell.tools.join(','), conflict: cell.conflict ? '1' : '0', big: cell.big ? '1' : '0' },
        onclick: () => {
          if (state.armed != null) {
            assign(state.armed, cell.pot);
            state.armed = null;
          } else if (cell.tools.length) {
            for (const t of cell.tools) assign(t, null);
          } else {
            state.note = '這個刀位是空的。先點右邊清單裡的刀名把刀拿起來，再點刀位就能放進去。';
            render();
            return;
          }
          state.note = '';
          commitAndRender();
        },
      },
        h('span', { class: 'nc-pot-no' }, String(cell.pot)),
        h('span', { class: 'nc-pot-t' }, cell.tools.length ? cell.tools.map((t) => 'T' + t).join('/') : ''),
        // 撞刀時三個刀位都是紅的，沒有這個記號就分不出「肇事的大徑刀」和「被撞的鄰居」
        cell.big ? h('span', { class: 'nc-pot-big', title: `大徑刀（${cell.bigOwners.map((t) => 'T' + t).join('、')}），兩側刀位必須淨空` }, '大') : null,
        cell.resident ? h('span', { class: 'nc-pot-star', title: '常駐刀' }, '★') : null);
    }

    function potMap(status) {
      const size = state.mag.size;
      const cells = status.cells;
      if (size > MAGAZINE_RING_MAX) {
        return h('div', { class: 'nc-pot-grid', dataset: { layout: 'grid' } }, cells.map((c) => potCell(c)));
      }
      const px = Math.max(280, Math.min(460, 150 + size * 9));
      const ring = h('div', { class: 'nc-pot-ring', dataset: { layout: 'ring' } });
      ring.style.width = px + 'px';
      ring.style.height = px + 'px';
      const pos = ringPositions(size);
      for (const p of pos) {
        const btn = potCell(cells[p.pot - 1]);
        btn.style.left = p.x + '%';
        btn.style.top = p.y + '%';
        ring.appendChild(btn);
      }
      ring.appendChild(h('div', { class: 'nc-pot-hub' },
        h('div', { class: 'nc-pot-hub-n' }, `${size} 刀位`),
        h('div', { class: 'nc-pot-hub-s' }, `已登記 ${registeredTs().length}`)));
      return h('div', { class: 'nc-pot-ring-wrap' }, ring);
    }

    // ---- 刀具清單（T → 刀位，也是圖畫不出來時的退路） ----
    function toolRows(status) {
      const rows = [];
      const used = usedTs();
      const extra = registeredTs().filter((t) => used.indexOf(t) < 0);
      const mkRow = (t, isExtra) => {
        const tool = toolOf(t);
        const pot = state.mag.pots[t] == null ? null : state.mag.pots[t];
        const cell = pot != null ? status.cells[wrapPot(pot, state.mag.size) - 1] : null;
        const potIn = numberInput(pot, (n) => {
          if (n == null) { assign(t, null); commitAndRender(); return; }   // 清空 = 還沒指定
          // 刀庫沒有的號碼就退回原值。夾到 size 看起來體貼，實際上是把刀默默搬到使用者沒指定的位置
          const p = Math.round(n);
          if (!(p >= 1 && p <= state.mag.size)) { potIn.value = pot == null ? '' : String(pot); return; }
          assign(t, p);
          commitAndRender();
        }, {
          attrs: { min: '1', max: String(state.mag.size), step: '1' }, class: 'nc-num nc-num-pot',
          placeholder: '—', title: `T${t} 放在第幾號刀位（清空代表還沒指定）`, dataset: { t, field: 'pot' },
        });
        const res = h('input', {
          type: 'checkbox', checked: state.mag.resident.indexOf(t) >= 0,
          title: '常駐刀：跨程式共用、不會拆下來的刀', dataset: { t, field: 'resident' },
        });
        res.addEventListener('change', () => {
          const i = state.mag.resident.indexOf(t);
          if (res.checked && i < 0) state.mag.resident.push(t);
          else if (!res.checked && i >= 0) state.mag.resident.splice(i, 1);
          state.mag.resident = uniqSorted(state.mag.resident);
          commitAndRender();
        });
        const armBtn = h('button', {
          type: 'button', class: 'nc-mag-tool' + (state.armed === t ? ' is-armed' : '') + (pot == null ? ' is-unplaced' : ''),
          title: state.armed === t ? '再點一次取消' : '點一下拿起這把刀，再點刀位圖上的格子放進去',
          dataset: { t },
          onclick: () => { state.armed = (state.armed === t ? null : t); state.note = ''; render(); },
        }, labelOf(t));
        // 別支程式的刀：刀號要改得動，不然使用者只能登記到系統挑給他的號碼
        const tIn = !isExtra ? null : numberInput(t, (n) => {
          const nt = n == null ? null : Math.round(n);
          if (!(nt >= 1) || (nt !== t && state.mag.pots[nt] != null)) { tIn.value = String(t); return; }
          if (nt === t) return;
          state.mag.pots[nt] = state.mag.pots[t];
          delete state.mag.pots[t];
          if (state.mag.resident.indexOf(t) >= 0) {
            state.mag.resident = uniqSorted(state.mag.resident.filter((x) => x !== t).concat([nt]));
          }
          if (state.armed === t) state.armed = nt;
          commitAndRender();
        }, { attrs: { min: '1', step: '1' }, class: 'nc-num nc-num-t', title: '刀號', dataset: { t, field: 't' } });
        const flags = [];
        if (tool && tool.resident) flags.push(h('span', { class: 'nc-star nc-on', title: '刀具表標了 ★ 常駐刀' }, '★'));
        if (cell && cell.conflict) flags.push(h('span', { class: 'nc-badge nc-badge-conflict', title: '這個刀位有撞刀風險' }, '衝突'));
        // 只標「這一把」是不是大徑刀。用 cell.big 的話，和大徑刀擠在同一格的小刀會被誤標
        if (cell && cell.bigOwners.indexOf(t) >= 0) flags.push(h('span', { class: 'nc-badge nc-badge-big', title: `刀徑已達大徑刀門檻 ${fmt(state.mag.largeToolDiameter)} mm，兩側刀位必須淨空` }, '大徑刀'));
        if (isExtra) flags.push(h('span', { class: 'nc-badge', title: '這支程式沒用到，只是佔著刀位的鄰居' }, '他程式'));
        return h('tr', { class: 'nc-mag-row' + (cell && cell.conflict ? ' nc-conflict' : ''), dataset: { t } },
          h('td', null, isExtra ? h('span', { class: 'nc-mag-tedit' }, 'T', tIn) : armBtn),
          h('td', null, potIn),
          h('td', { class: 'nc-td-center' }, res),
          h('td', null, flags.length ? h('span', { class: 'nc-mag-flags' }, flags) : null),
          isExtra ? h('td', null, h('button', {
            type: 'button', class: 'nc-btn nc-btn-small nc-btn-danger', title: '從刀庫移除這個登記',
            onclick: () => { delete state.mag.pots[t]; state.mag.resident = state.mag.resident.filter((x) => x !== t); commitAndRender(); },
          }, '移除')) : h('td', null));
      };
      for (const t of used) rows.push(mkRow(t, false));
      for (const t of extra) rows.push(mkRow(t, true));
      return rows;
    }

    function issueList(status) {
      const box = h('div', { class: 'nc-mag-issues' });
      if (!status.issues.length) {
        box.appendChild(h('div', { class: 'nc-mag-ok' }, '刀庫配置沒有發現衝突。'));
        return box;
      }
      for (const it of status.issues) {
        box.appendChild(h('div', { class: `nc-mag-issue nc-sev-${it.severity}`, dataset: { severity: it.severity, pot: it.pot == null ? '' : it.pot } },
          pill(it.severity), ' ', h('span', { class: 'nc-mag-issue-text' }, it.text)));
      }
      return box;
    }

    function numField(field, label, extra, suffix) {
      const el = numberInput(state.mag[field], (n) => {
        if (n == null) { el.value = String(state.mag[field]); return; }
        if (field === 'size') {
          const size = clampInt(n, 1, MAGAZINE_MAX_SIZE, state.mag.size);
          const dropped = Object.keys(state.mag.pots).map(Number).filter((t) => state.mag.pots[t] > size);
          state.mag.size = size;
          for (const t of dropped) delete state.mag.pots[t];
          state.note = dropped.length ? `刀庫縮成 ${size} 個刀位，${dropped.map((t) => 'T' + t).join('、')} 原本的刀位不存在了，登記已移除。` : '';
        } else if (field === 'largeToolNeighbors') {
          state.mag[field] = clampInt(n, 1, 8, state.mag[field]);
        } else {
          if (!(n > 0)) { el.value = String(state.mag[field]); return; }
          state.mag[field] = n;
        }
        commitAndRender();
      }, Object.assign({ dataset: { field } }, extra || {}));
      return row(label, el, suffix ? h('span', { class: 'nc-muted' }, suffix) : null);
    }

    function render() {
      clear(root);
      const on = !!state.mag;
      const head = h('div', { class: 'nc-mag-head' },
        checkbox(on, (v) => {
          if (v) {
            state.mag = normalizeMagazine(state.opts.magazine) || state.lastMag || defaultMagazine();
            state.note = '';
          } else {
            state.lastMag = U.deepClone(state.mag);
            state.mag = null;
            state.armed = null;
          }
          commitAndRender();
        }, h('b', null, '啟用刀庫檢查')));
      root.appendChild(head);
      root.appendChild(h('div', { class: 'nc-muted nc-mag-why' },
        '刀庫是整台機共用的，設定不會跟著程式走（存在瀏覽器裡，換程式照樣在）。'
        + '填了「哪把刀在哪個刀位」，才驗得到大直徑刀和隔壁刀位的刀在刀庫旋轉時互撞——'
        + '這件事程式本身完全看不出來。'));
      if (!on) {
        root.appendChild(h('div', { class: 'nc-empty' }, '目前不檢查刀庫（R30 不會跑）。'));
        return;
      }
      const status = magazineStatus(state.mag, toolsOf(), usedTs());

      const cfg = h('div', { class: 'nc-mag-cfg' });
      cfg.appendChild(numField('size', '刀位總數', { attrs: { min: '1', max: String(MAGAZINE_MAX_SIZE), step: '1' }, title: '這台機的刀庫有幾個刀位' }, '個'));
      cfg.appendChild(numField('largeToolDiameter', '大徑刀門檻', { attrs: { min: '1', step: '5' }, title: '刀徑達到這個值就視為大徑刀' }, 'mm 以上算大徑刀'));
      cfg.appendChild(numField('largeToolNeighbors', '單邊需淨空', { attrs: { min: '1', max: '8', step: '1' }, title: '大徑刀每一側要空幾個刀位' }, '個刀位（兩側各算）'));
      root.appendChild(cfg);

      root.appendChild(h('div', { class: 'nc-mag-hint' },
        state.armed != null
          ? h('b', null, `已拿起 T${state.armed}，點一個刀位放進去`)
          : '點右邊的刀名拿起一把刀，再點刀位圖上的格子；點已經有刀的刀位可以清空。',
        h('span', { class: 'nc-mag-legend' },
          h('span', { class: 'nc-pot-key is-inprogram', title: '這支程式會換上的刀' }, '本程式'),
          h('span', { class: 'nc-pot-key is-big', title: '刀位圖上標「大」的那格' }, '大徑刀'),
          h('span', { class: 'nc-pot-key is-clear' }, '需淨空'),
          h('span', { class: 'nc-pot-key is-conflict' }, '衝突'))));

      // 刀位圖擺左邊固定看得到，衝突與刀具清單排右邊——衝突多的時候把圖擠出畫面就白做了
      const body = h('div', { class: 'nc-mag-body' });
      body.appendChild(potMap(status));
      const thead = h('thead', null, h('tr', null, ['刀', '刀位', '常駐', '', ''].map((s) => h('th', null, s))));
      const listBox = h('div', { class: 'nc-mag-list' },
        issueList(status),
        state.note ? h('div', { class: 'nc-mag-note' }, state.note) : null,
        h('div', { class: 'nc-mag-actions' },
          h('button', {
            type: 'button', class: 'nc-btn nc-btn-small', title: 'T1 放第 1 號、T11 放第 11 號…（最常見的排法，之後可以再改）',
            onclick: () => {
              for (const t of usedTs()) if (t >= 1 && t <= state.mag.size) state.mag.pots[t] = t;
              state.note = '已依刀號填入刀位，請對照機台實際配置修正。';
              commitAndRender();
            },
          }, '依刀號自動填入'),
          h('button', {
            type: 'button', class: 'nc-btn nc-btn-small', title: '把所有刀位登記清空',
            onclick: () => { state.mag.pots = {}; state.armed = null; state.note = ''; commitAndRender(); },
          }, '全部清空'),
          h('button', {
            type: 'button', class: 'nc-btn nc-btn-small nc-btn-add', title: '登記一把這支程式沒用到、但佔著刀位的刀（隔壁刀位有沒有東西才算得出來）',
            onclick: () => {
              // 本程式用到的 T 不能拿來當「其他刀」的預設號碼，不然按下去只是默默幫 T1 指定刀位，
              // 使用者要的那一列「他程式」根本不會出現
              const taken = new Set(registeredTs().concat(usedTs()));
              let t = 1;
              while (taken.has(t)) t++;
              const usedPots = new Set(Object.keys(state.mag.pots).map((k) => state.mag.pots[k]));
              let pot = null;
              for (let p = 1; p <= state.mag.size; p++) if (!usedPots.has(p)) { pot = p; break; }
              if (pot == null) {
                state.note = `刀庫 ${state.mag.size} 個刀位都登記滿了，沒有空位可以再登記。`;
                render();
                return;
              }
              state.mag.pots[t] = pot;
              state.note = `已登記 T${t} 在第 ${pot} 號刀位（別支程式的刀）。刀號可以直接在下面那一列改成現場實際的號碼。`;
              commitAndRender();
            },
          }, '＋ 登記其他刀')),
        h('div', { class: 'nc-scroll' }, h('table', { class: 'nc-table nc-mag-table' }, thead, h('tbody', null, toolRows(status)))));
      body.appendChild(listBox);
      root.appendChild(body);
    }

    function update(next) {
      if (next) Object.assign(state.opts, next);
      const norm = normalizeMagazine(state.opts.magazine);
      state.mag = norm;
      if (norm) state.lastMag = U.deepClone(norm);
      if (state.armed != null && !norm) state.armed = null;
      render();
    }
    update();
    return {
      el: root, update,
      getMagazine: () => (state.mag ? U.deepClone(state.mag) : null),
      getStatus: () => magazineStatus(state.mag, toolsOf(), usedTs()),
    };
  };

  // ---------------------------------------------------------------------------
  // 設定（block skip 情境、機台設定、模擬格距）
  // ---------------------------------------------------------------------------
  panels.settings = function settings(container, opts) {
    const state = { opts: Object.assign({}, opts), settings: null, scenario: 'off', cell: 0.5 };
    const root = h('div', { class: 'nc-panel nc-panel-settings' });
    mount(container, root);

    function commit() {
      call(state.opts.onChange, { settings: U.deepClone(state.settings), scenario: state.scenario, cell: state.cell });
    }
    function num(field, extra) {
      const el = numberInput(state.settings[field], (n) => {
        if (n == null || n <= 0) { el.value = String(state.settings[field]); return; }
        state.settings[field] = n; commit();
      }, Object.assign({ dataset: { field } }, extra || {}));
      return el;
    }
    function render() {
      clear(root);
      const s = state.settings;
      // 第四軸：只有程式真的轉過 A 才顯示——三軸程式看到這一區只會困惑。
      // 放在最上面：四軸程式的一切（成品、切深、展開圖）都靠這幾個值，
      // 藏在面板最底下的話現場會以為「素材設定都不能動」（真的發生過）。
      // 這幾個值決定「工件在哪裡轉」，展開圖與 3D 圓棒完全靠它們；填錯的話圖會歪掉，
      // 但改個數字就立刻重畫，現場可以用試的把對的值找出來（比問座標系術語快）。
      if (state.opts.rotaryUsed) {
        if (!s.rotary) s.rotary = { center: { y: 0, z: 0 }, radius: 0 };
        if (!s.rotary.center) s.rotary.center = { y: 0, z: 0 };
        const rc = s.rotary.center;
        root.appendChild(h('div', { class: 'nc-sub-title' }, '第四軸（A 繞 X 軸）'));
        const mk = (field, get, set, title) => numberInput(get(), (n) => {
          set(n == null ? 0 : n);
          commit();
        }, { attrs: { step: '0.5' }, title, dataset: { field } });
        root.appendChild(row('迴轉中心 Y',
          mk('rotaryCenterY', () => rc.y, (v) => { rc.y = v; }, '分度頭中心線在工件座標的 Y。對刀時 Y0 就對在中心線的話填 0。'),
          ' mm'));
        root.appendChild(row('迴轉中心 Z',
          mk('rotaryCenterZ', () => rc.z, (v) => { rc.z = v; }, 'Z0 對在中心線 → 填 0；Z0 對在圓棒最頂端 → 填「−半徑」（例如 Ø50 就填 −25）。'),
          ' mm'));
        root.appendChild(row('工件直徑',
          numberInput(s.rotary.radius > 0 ? s.rotary.radius * 2 : '', (n) => {
            s.rotary.radius = (n != null && n > 0) ? n / 2 : 0;
            commit();
          }, { attrs: { step: '1', min: '0' }, title: '空白 = 由程式推估（取切削段離中心最遠的距離）', dataset: { field: 'rotaryDiameter' } }),
          ' mm'));
        root.appendChild(h('div', { class: 'nc-muted' },
          '填錯不會怎樣，圖會立刻重畫。分度孔在展開圖上排成一直線、r 從表面往中心遞減，就是對了。'));
      }
      root.appendChild(h('div', { class: 'nc-sub-title' }, 'Block skip'));
      root.appendChild(row('預演情境', select(Object.keys(SCENARIO_LABEL).map((k) => [k, SCENARIO_LABEL[k]]), state.scenario, (v) => { state.scenario = v; commit(); }, { dataset: { field: 'scenario' } })));
      root.appendChild(row('多斜線 //', select(Object.keys(MULTISLASH_LABEL).map((k) => [k, MULTISLASH_LABEL[k]]), s.multiSlash, (v) => { s.multiSlash = v; commit(); }, { dataset: { field: 'multiSlash' } })));
      const levels = h('input', {
        type: 'text', class: 'nc-text nc-short', value: (s.skipLevelsOn || [1]).join(','), title: '開關開時視為開的等級，逗號分隔（如 1,2）', dataset: { field: 'skipLevelsOn' },
      });
      levels.addEventListener('change', () => {
        const arr = uniqSorted(String(levels.value).split(/[,\s]+/).map((x) => parseInt(x, 10))).filter((n) => n >= 1 && n <= 9);
        if (!arr.length) { levels.value = (s.skipLevelsOn || [1]).join(','); return; }
        s.skipLevelsOn = arr; commit();
      });
      root.appendChild(row('開的等級', levels));
      root.appendChild(h('div', { class: 'nc-sub-title' }, '機台'));
      root.appendChild(row('換刀前需 M5', checkbox(s.requireM5BeforeM6, (on) => { s.requireM5BeforeM6 = on; commit(); }, '缺 M5 就 M6 → 警告')));
      root.appendChild(row('小數點', checkbox(s.dpi, (on) => { s.dpi = on; commit(); }, '計算機式（無小數點 = mm）')));
      root.appendChild(row('快速速率', num('rapidRate', { attrs: { step: '1000', min: '1' }, title: 'G0 速率，時間估算用' }), ' mm/min'));
      root.appendChild(row('下刀進給上限', num('plungeFeedMax', { attrs: { step: '10', min: '1' }, title: 'G1 向下且在材料內超過此值 → 警告' }), ' mm/min'));
      root.appendChild(row('先讀節數', num('lookahead', { attrs: { step: '1', min: '1' }, title: '刀徑補正先讀節數（參數 19625）' })));
      root.appendChild(h('div', { class: 'nc-sub-title' }, '模擬'));
      const cellOpts = CELL_OPTIONS.includes(state.cell) ? CELL_OPTIONS : CELL_OPTIONS.concat([state.cell]).sort((a, b) => a - b);
      root.appendChild(row('格距', select(cellOpts.map((c) => [c, `${c} mm`]), state.cell, (v) => { state.cell = parseFloat(v); commit(); }, { dataset: { field: 'cell' } }), h('span', { class: 'nc-muted' }, ' 越小越準、越慢')));
    }
    function update(next) {
      if (next) Object.assign(state.opts, next);
      state.settings = U.deepClone(state.opts.settings || U.defaultSettings());
      state.scenario = state.opts.scenario || 'off';
      state.cell = state.opts.cell != null ? state.opts.cell : 0.5;
      render();
    }
    update();
    return { el: root, update, getState: () => ({ settings: U.deepClone(state.settings), scenario: state.scenario, cell: state.cell }) };
  };

  panels.h = h;
  panels.clear = clear;
})(globalThis.NC = globalThis.NC || {});
