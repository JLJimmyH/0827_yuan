/*
 * NC 預演台 — 程式編輯器（CONTRACT §8 editor）
 * NC.ui.createEditor(container, opts?) → Editor
 *
 * 版面：左 gutter（行號 + 診斷色點，hover 顯示訊息）｜中 textarea｜右 行旁資訊欄（setLineInfo(fn) 提供字串）。
 * 三欄共用同一行高；左右欄只畫可視範圍的列（虛擬化），並用 transform 跟著 textarea 的 scrollTop 走，
 * 所以 2,000 行以上也只維護幾十個 DOM 節點，更新診斷／資訊只需重畫可視列。
 *
 * 另外把不碰 DOM 的純文字工具掛在 NC.ui.editorText，供 Node 測試。
 */
(function (NC) {
  'use strict';
  const ui = (NC.ui = NC.ui || {});

  // ---------------------------------------------------------------------------
  // 純文字工具（不碰 DOM）
  // ---------------------------------------------------------------------------
  const SEV_ORDER = { error: 0, warning: 1, needsInput: 2, info: 3 };
  const SEV_LABEL = { error: '錯誤', warning: '警告', needsInput: '需輸入', info: '資訊' };

  /** 每行起始索引（0-based 字元位置）；第 i 個元素 = 第 i+1 行的起點。 */
  function computeLineStarts(text) {
    const starts = [0];
    let i = -1;
    while ((i = text.indexOf('\n', i + 1)) !== -1) starts.push(i + 1);
    return starts;
  }

  /** 字元索引 → 1-based 行號（二分搜尋）。 */
  function lineOfIndex(starts, idx) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }

  /** 多數決判斷換行字元；沒有換行時回 '\n'。 */
  function detectLineEnding(text) {
    let crlf = 0;
    let lf = 0;
    let i = -1;
    while ((i = text.indexOf('\n', i + 1)) !== -1) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++; else lf++;
    }
    return crlf > lf ? '\r\n' : '\n';
  }

  /**
   * 以「行」為單位取代文字（純函式）。
   * @param {string} text  以 '\n' 分行的內容
   * @param {number} a     起始行（1-based，含）
   * @param {number} b     結束行（1-based，含）
   * @param {string|null} repl  新內容（可含多行）；null = 整段刪除（連同換行）
   * @returns {{text:string, start:number, end:number, inserted:string}}  start/end 為被取代的字元區間
   */
  function replaceLinesInText(text, a, b, repl) {
    const starts = computeLineStarts(text);
    const n = starts.length;
    let lo = Math.max(1, Math.min(n, Math.floor(Number(a) || 1)));
    let hi = Math.max(1, Math.min(n, Math.floor(Number(b) || lo)));
    if (hi < lo) { const t = lo; lo = hi; hi = t; }
    let start;
    let end;
    let inserted;
    if (repl === null || repl === undefined) {
      // 刪除：連同行尾換行；最後一行則改吃掉前一行的換行，避免留下空行
      if (hi < n) { start = starts[lo - 1]; end = starts[hi]; }
      else if (lo > 1) { start = starts[lo - 1] - 1; end = text.length; }
      else { start = 0; end = text.length; }
      inserted = '';
    } else {
      start = starts[lo - 1];
      end = hi < n ? starts[hi] - 1 : text.length;
      inserted = String(repl).replace(/\r\n?/g, '\n');
    }
    return { text: text.slice(0, start) + inserted + text.slice(end), start, end, inserted };
  }

  /** 診斷依行分組（每行依嚴重度排序）；line 0（整支程式）也保留在 key 0。 */
  function groupDiagnostics(diags) {
    const map = new Map();
    if (!Array.isArray(diags)) return map;
    for (const d of diags) {
      if (!d) continue;
      const line = Number.isFinite(d.line) ? Math.max(0, Math.floor(d.line)) : 0;
      let arr = map.get(line);
      if (!arr) { arr = []; map.set(line, arr); }
      arr.push(d);
    }
    for (const arr of map.values()) {
      if (arr.length > 1) arr.sort((p, q) => (SEV_ORDER[p.severity] ?? 9) - (SEV_ORDER[q.severity] ?? 9));
    }
    return map;
  }

  /** 一行裡最嚴重的等級（'error'|'warning'|'needsInput'|'info'|null）。 */
  function topSeverity(list) {
    if (!list || !list.length) return null;
    let best = null;
    for (const d of list) {
      const s = d.severity;
      if (SEV_ORDER[s] === undefined) continue;
      if (best === null || SEV_ORDER[s] < SEV_ORDER[best]) best = s;
    }
    return best;
  }

  ui.editorText = { computeLineStarts, lineOfIndex, detectLineEnding, replaceLinesInText, groupDiagnostics, topSeverity, SEV_LABEL };

  // ---------------------------------------------------------------------------
  // 編輯器
  // ---------------------------------------------------------------------------
  const ROW_BUFFER = 8;         // 可視範圍上下各多畫幾列，避免捲動時露白
  const SEV_CLASSES = ['is-error', 'is-warning', 'is-info', 'is-needsInput'];
  const ROW_SEV_CLASSES = ['is-sev-error', 'is-sev-warning', 'is-sev-info', 'is-sev-needsInput'];

  /**
   * @param {HTMLElement} container  會在裡面建立 .nc-editor（容器需有高度）
   * @param {{debounceMs?:number, text?:string, hideInfoWhenEmpty?:boolean}} [opts]
   * @returns {Editor}
   */
  function createEditor(container, opts) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new Error('createEditor：需要一個 DOM 容器元素');
    }
    opts = opts || {};
    const doc = container.ownerDocument || globalThis.document;
    const win = doc.defaultView || globalThis;
    const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 300;

    const mk = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };

    // ---- DOM ----
    const root = mk('div', 'nc-editor');
    const gutter = mk('div', 'nc-editor__gutter');
    const gutterInner = mk('div', 'nc-editor__col-inner');
    const main = mk('div', 'nc-editor__main');
    const hl = mk('div', 'nc-editor__hl');
    const ta = mk('textarea', 'nc-editor__text');
    const info = mk('div', 'nc-editor__info');
    const infoInner = mk('div', 'nc-editor__col-inner');
    const tip = mk('div', 'nc-editor__tip');

    ta.spellcheck = false;
    ta.wrap = 'off';
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('aria-label', 'NC 程式');

    gutter.appendChild(gutterInner);
    main.appendChild(hl);
    main.appendChild(ta);
    info.appendChild(infoInner);
    root.appendChild(gutter);
    root.appendChild(main);
    root.appendChild(info);
    root.appendChild(tip);
    container.appendChild(root);

    // ---- 狀態 ----
    let lineEnding = '\n';          // setText 時記下，getText 還原
    let lineStarts = [0];           // 每行起點（以 textarea 的 '\n' 內容為準）
    let lineCount = 1;
    let diagMap = new Map();        // line → Diagnostic[]
    let lineInfoFn = null;
    let highlighted = 0;            // 目前底色行；0 = 無
    let cursorLine = 0;             // 最後回報的游標行
    const changeCbs = [];
    const cursorCbs = [];
    let changeTimer = 0;
    let lh = 20;                    // 行高 px
    let padTop = 4;                 // textarea 上留白 px
    let rangeStart = -1;            // 目前已畫的列範圍 [rangeStart, rangeEnd)
    let rangeEnd = -1;
    let gutterDigits = 0;
    const gutterPool = [];          // 可重用的列節點
    const infoPool = [];
    let destroyed = false;
    let tipLine = 0;

    // ---- 量測 ----
    function measure() {
      const cs = win.getComputedStyle ? win.getComputedStyle(ta) : null;
      let v = cs ? parseFloat(cs.lineHeight) : NaN;
      if (!Number.isFinite(v) || v <= 0) {
        const fs = cs ? parseFloat(cs.fontSize) : NaN;
        v = Number.isFinite(fs) && fs > 0 ? Math.round(fs * 1.5) : 20;
      }
      lh = v;
      const pt = cs ? parseFloat(cs.paddingTop) : NaN;
      padTop = Number.isFinite(pt) ? pt : 0;
      root.style.setProperty('--nc-editor-lh', lh + 'px');
    }

    function updateGutterWidth() {
      const digits = Math.max(3, String(lineCount).length);
      if (digits !== gutterDigits) {
        gutterDigits = digits;
        gutter.style.width = (digits + 3) + 'ch';
      }
    }

    // ---- 文字狀態 ----
    function refreshTextState() {
      lineStarts = computeLineStarts(ta.value);
      lineCount = lineStarts.length;
      updateGutterWidth();
    }

    // ---- 虛擬化列 ----
    function visibleRange() {
      const top = ta.scrollTop - padTop;
      const h = ta.clientHeight || 0;
      const first = Math.max(0, Math.floor(top / lh) - ROW_BUFFER);
      const last = Math.min(lineCount, Math.ceil((top + h) / lh) + ROW_BUFFER);
      return [first, Math.max(first, last)];
    }

    function ensureRow(pool, parent, isGutter, k) {
      let row = pool[k];
      if (!row) {
        row = mk('div', 'nc-editor__row');
        if (isGutter) {
          const mark = mk('span', 'nc-editor__mark');
          const num = mk('span', 'nc-editor__num');
          row.appendChild(mark);
          row.appendChild(num);
          row._mark = mark;
          row._num = num;
        }
        row._line = 0;
        row._sev = '';
        row._multi = false;
        row._cur = false;
        row._text = '';
        pool[k] = row;
        parent.appendChild(row);
      }
      return row;
    }

    function setClassFlag(el, cls, on) {
      if (on) el.classList.add(cls); else el.classList.remove(cls);
    }

    function paintGutterRow(row, line) {
      const list = diagMap.get(line);
      const sev = topSeverity(list) || '';
      const multi = !!(list && list.length > 1);
      const cur = line === highlighted;
      if (row._line !== line) {
        row._line = line;
        row.dataset.line = String(line);
        row._num.textContent = String(line);
        row.style.top = (padTop + (line - 1) * lh) + 'px';
      }
      if (row._sev !== sev) {
        for (const c of SEV_CLASSES) row._mark.classList.remove(c);
        for (const c of ROW_SEV_CLASSES) row.classList.remove(c);
        if (sev) { row._mark.classList.add('is-' + sev); row.classList.add('is-sev-' + sev); }
        row._sev = sev;
      }
      if (row._multi !== multi) { setClassFlag(row._mark, 'is-multi', multi); row._multi = multi; }
      if (row._cur !== cur) { setClassFlag(row, 'is-current', cur); row._cur = cur; }
    }

    function paintInfoRow(row, line) {
      let text = '';
      if (lineInfoFn) {
        try { const r = lineInfoFn(line); text = r == null ? '' : String(r); } catch (e) { text = ''; }
      }
      const cur = line === highlighted;
      if (row._line !== line) {
        row._line = line;
        row.dataset.line = String(line);
        row.style.top = (padTop + (line - 1) * lh) + 'px';
      }
      if (row._text !== text) { row.textContent = text; row.title = text; row._text = text; }
      if (row._cur !== cur) { setClassFlag(row, 'is-current', cur); row._cur = cur; }
    }

    /** 重畫可視列。force=false 時若範圍沒變就略過。 */
    function renderRows(force) {
      if (destroyed) return;
      const [s, e] = visibleRange();
      if (!force && s === rangeStart && e === rangeEnd) return;
      rangeStart = s;
      rangeEnd = e;
      const count = e - s;
      for (let k = 0; k < count; k++) {
        const line = s + k + 1;
        const g = ensureRow(gutterPool, gutterInner, true, k);
        if (g.style.display) g.style.display = '';
        paintGutterRow(g, line);
        const r = ensureRow(infoPool, infoInner, false, k);
        if (r.style.display) r.style.display = '';
        paintInfoRow(r, line);
      }
      for (let k = count; k < gutterPool.length; k++) {
        if (gutterPool[k].style.display !== 'none') { gutterPool[k].style.display = 'none'; gutterPool[k]._line = 0; }
      }
      for (let k = count; k < infoPool.length; k++) {
        if (infoPool[k].style.display !== 'none') { infoPool[k].style.display = 'none'; infoPool[k]._line = 0; }
      }
    }

    function updateHighlightPos() {
      if (!highlighted || highlighted > lineCount) { hl.style.display = 'none'; return; }
      hl.style.display = 'block';
      hl.style.top = (padTop + (highlighted - 1) * lh - ta.scrollTop) + 'px';
    }

    function syncScroll() {
      if (destroyed) return;
      const st = ta.scrollTop;
      const tr = 'translateY(' + (-st) + 'px)';
      gutterInner.style.transform = tr;
      infoInner.style.transform = tr;
      updateHighlightPos();
      renderRows(false);
      if (tipLine) hideTip();
    }

    // ---- 變更通知 ----
    function scheduleChange() {
      if (changeTimer) win.clearTimeout(changeTimer);
      changeTimer = win.setTimeout(flushChange, debounceMs);
    }
    function flushChange() {
      if (changeTimer) { win.clearTimeout(changeTimer); changeTimer = 0; }
      if (destroyed || !changeCbs.length) return;
      const text = getText();
      for (const cb of changeCbs.slice()) {
        try { cb(text); } catch (e) { if (win.console) win.console.error(e); }
      }
    }

    // ---- 游標 ----
    function getCursorLine() {
      return lineOfIndex(lineStarts, ta.selectionStart || 0);
    }
    function updateCursor() {
      if (destroyed) return;
      const line = getCursorLine();
      if (line === cursorLine) return;
      cursorLine = line;
      for (const cb of cursorCbs.slice()) {
        try { cb(line); } catch (e) { if (win.console) win.console.error(e); }
      }
    }

    // ---- 診斷提示 ----
    function buildTip(list) {
      tip.textContent = '';
      for (const d of list) {
        const item = mk('div', 'nc-editor__tip-item');
        const head = mk('div', 'nc-editor__tip-head');
        const sev = mk('span', 'nc-editor__tip-sev is-' + (d.severity || 'info'));
        sev.textContent = SEV_LABEL[d.severity] || String(d.severity || '');
        const rule = mk('span', 'nc-editor__tip-rule');
        rule.textContent = d.ruleId || '';
        head.appendChild(sev);
        head.appendChild(rule);
        head.appendChild(doc.createTextNode(d.message || ''));
        if (d.fanucAlarm) {
          const al = mk('span', 'nc-editor__tip-alarm');
          al.textContent = d.fanucAlarm;
          head.appendChild(al);
        }
        item.appendChild(head);
        if (d.detail) {
          const det = mk('div', 'nc-editor__tip-detail');
          det.textContent = d.detail;
          item.appendChild(det);
        }
        tip.appendChild(item);
      }
    }
    function showTip(line) {
      const list = diagMap.get(line);
      if (!list || !list.length) { hideTip(); return; }
      if (tipLine !== line) { buildTip(list); tipLine = line; }
      tip.style.display = 'block';
      tip.style.left = (gutter.offsetWidth + 6) + 'px';
      const rowTop = padTop + (line - 1) * lh - ta.scrollTop;
      const rootH = root.clientHeight || 0;
      const tipH = tip.offsetHeight || 0;
      let top = rowTop + lh + 2;
      if (rootH && top + tipH > rootH) top = Math.max(0, rowTop - tipH - 2);
      tip.style.top = top + 'px';
    }
    function hideTip() {
      tipLine = 0;
      tip.style.display = 'none';
    }

    // ---- 事件 ----
    function onInput() {
      refreshTextState();
      renderRows(true);
      updateHighlightPos();
      scheduleChange();
      updateCursor();
    }
    function onSelectionChange() {
      if (doc.activeElement === ta) updateCursor();
    }
    function onGutterOver(ev) {
      const row = ev.target && ev.target.closest ? ev.target.closest('.nc-editor__row') : null;
      if (!row || !row._line) { hideTip(); return; }
      showTip(row._line);
    }
    function onGutterLeave() { hideTip(); }
    function onGutterClick(ev) {
      const row = ev.target && ev.target.closest ? ev.target.closest('.nc-editor__row') : null;
      if (!row || !row._line) return;
      const line = row._line;
      const start = lineStarts[line - 1];
      const end = line < lineCount ? lineStarts[line] - 1 : ta.value.length;
      ta.focus();
      ta.setSelectionRange(start, end);
      updateCursor();
    }
    function onResize() {
      if (destroyed) return;
      measure();
      renderRows(true);
      syncScroll();
    }

    ta.addEventListener('input', onInput);
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keyup', updateCursor);
    ta.addEventListener('click', updateCursor);
    ta.addEventListener('mouseup', updateCursor);
    ta.addEventListener('focus', updateCursor);
    doc.addEventListener('selectionchange', onSelectionChange);
    gutter.addEventListener('mouseover', onGutterOver);
    gutter.addEventListener('mouseleave', onGutterLeave);
    gutter.addEventListener('click', onGutterClick);

    let ro = null;
    if (typeof win.ResizeObserver === 'function') {
      ro = new win.ResizeObserver(onResize);
      ro.observe(root);
    } else {
      win.addEventListener('resize', onResize);
    }

    // ---- 公開 API ----
    /** 程式化設定全文：不觸發 onChange、清掉診斷與底色、捲回頂端。 */
    function setText(text) {
      text = text == null ? '' : String(text);
      lineEnding = detectLineEnding(text);
      const normalized = text.replace(/\r\n?/g, '\n');
      if (normalized === ta.value) return;
      if (changeTimer) { win.clearTimeout(changeTimer); changeTimer = 0; }
      ta.value = normalized;
      try { ta.setSelectionRange(0, 0); } catch (e) { /* 尚未掛進文件時部分瀏覽器會丟錯，忽略 */ }
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
      diagMap = new Map();
      highlighted = 0;
      hideTip();
      refreshTextState();
      renderRows(true);
      syncScroll();
      cursorLine = 0;
    }

    /** 取回全文；換行字元還原成 setText 當時的形式（\r\n 或 \n）。 */
    function getText() {
      const v = ta.value;
      return lineEnding === '\r\n' ? v.replace(/\n/g, '\r\n') : v;
    }

    function onChange(cb) {
      if (typeof cb !== 'function') return () => {};
      changeCbs.push(cb);
      return () => { const i = changeCbs.indexOf(cb); if (i >= 0) changeCbs.splice(i, 1); };
    }

    function setDiagnostics(diags) {
      diagMap = groupDiagnostics(diags);
      hideTip();
      renderRows(true);
    }

    function setLineInfo(fn) {
      lineInfoFn = typeof fn === 'function' ? fn : null;
      setClassFlag(root, 'is-no-info', !lineInfoFn && opts.hideInfoWhenEmpty === true);
      renderRows(true);
    }

    function highlightLine(n) {
      const line = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      if (line === highlighted) return;
      highlighted = line;
      updateHighlightPos();
      renderRows(true);
    }

    function isLineVisible(line) {
      const top = padTop + (line - 1) * lh;
      const st = ta.scrollTop;
      return top >= st && top + lh <= st + ta.clientHeight;
    }

    /** 捲到第 n 行：已在可視範圍內就不動；否則置中。o.center=true 強制置中。 */
    function scrollToLine(n, o) {
      const line = Number.isFinite(n) ? Math.max(1, Math.min(lineCount, Math.floor(n))) : 1;
      const center = !!(o && o.center);
      if (!center && isLineVisible(line)) return;
      const top = padTop + (line - 1) * lh;
      const target = Math.max(0, top - Math.max(0, (ta.clientHeight - lh) / 2));
      ta.scrollTop = target;
      syncScroll();
    }

    function onCursorLine(cb) {
      if (typeof cb !== 'function') return () => {};
      cursorCbs.push(cb);
      return () => { const i = cursorCbs.indexOf(cb); if (i >= 0) cursorCbs.splice(i, 1); };
    }

    function getSelectionLines() {
      const s = ta.selectionStart || 0;
      const e = ta.selectionEnd || 0;
      const a = lineOfIndex(lineStarts, Math.min(s, e));
      let b = lineOfIndex(lineStarts, Math.max(s, e));
      // 選取結尾剛好在某行行首（前一字元是換行）→ 不算那一行
      if (e > s && b > a && ta.value.charCodeAt(Math.max(s, e) - 1) === 10) b--;
      return [a, b];
    }

    /** 取代第 a..b 行（含）；text=null 表示刪除。會走 onChange（視同使用者編輯），並保留 undo。 */
    function replaceLines(a, b, text) {
      const res = replaceLinesInText(ta.value, a, b, text);
      if (res.end === res.start && res.inserted === '') return;
      const keepTop = ta.scrollTop;
      const keepLeft = ta.scrollLeft;
      if (typeof ta.setRangeText === 'function') {
        ta.setRangeText(res.inserted, res.start, res.end, res.inserted ? 'select' : 'end');
      } else {
        ta.value = res.text;
        const p = res.start + res.inserted.length;
        ta.setSelectionRange(res.inserted ? res.start : p, p);
      }
      ta.scrollTop = keepTop;
      ta.scrollLeft = keepLeft;
      onInput();               // setRangeText 不會觸發 input 事件，手動走同一條路（含 onChange）
      syncScroll();
    }

    function refresh() { onResize(); }
    function focus() { ta.focus(); }
    function getLineCount() { return lineCount; }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (changeTimer) { win.clearTimeout(changeTimer); changeTimer = 0; }
      ta.removeEventListener('input', onInput);
      ta.removeEventListener('scroll', syncScroll);
      ta.removeEventListener('keyup', updateCursor);
      ta.removeEventListener('click', updateCursor);
      ta.removeEventListener('mouseup', updateCursor);
      ta.removeEventListener('focus', updateCursor);
      doc.removeEventListener('selectionchange', onSelectionChange);
      gutter.removeEventListener('mouseover', onGutterOver);
      gutter.removeEventListener('mouseleave', onGutterLeave);
      gutter.removeEventListener('click', onGutterClick);
      if (ro) ro.disconnect(); else win.removeEventListener('resize', onResize);
      changeCbs.length = 0;
      cursorCbs.length = 0;
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    // ---- 初始化 ----
    measure();
    refreshTextState();
    renderRows(true);
    syncScroll();
    if (typeof opts.text === 'string') setText(opts.text);

    /** @typedef {ReturnType<typeof createEditor>} Editor */
    return {
      el: root,
      textarea: ta,
      setText, getText, onChange, setDiagnostics, setLineInfo, highlightLine, scrollToLine,
      onCursorLine, getCursorLine, getSelectionLines, replaceLines,
      getLineCount, refresh, focus, flushChange, destroy,
    };
  }

  ui.createEditor = createEditor;
})(globalThis.NC = globalThis.NC || {});
