/*
 * NC 預演台 — tokenizer.js
 * NC.tokenize(text) → TokenizeResult
 * 只做詞法：切行、剝註解、節首斜線、字組切分；不做任何語意判斷（那是 interpreter 的事）。
 * 詳見 docs/CONTRACT.md §1。
 */
(function (NC) {
  'use strict';

  const U = NC.util;

  // 數字：整數、帶小數點（可無小數位）、或以小數點開頭
  const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)';
  // 一般字組：字母 + 選擇性空白 + 數字（sticky）
  const WORD_RE = new RegExp('([A-Za-z])\\s*(' + NUM + ')', 'y');
  // 逗號字組：,C0.3 / ,R2.（選擇性倒角／圓角）
  const COMMA_RE = new RegExp(',\\s*([CcRr])\\s*(' + NUM + ')', 'y');
  // 節首斜線：/ 或 /n（n=1–9）或多斜線
  const LEAD_SLASH_RE = /^\s*(\/+)([1-9])?/;

  /** 剝掉括號註解，回傳 { stripped, comments, diagnostics } */
  function stripComments(raw, line, diags) {
    let out = '';
    const comments = [];
    let i = 0;
    const n = raw.length;
    while (i < n) {
      const ch = raw[i];
      if (ch === '(') {
        const close = raw.indexOf(')', i + 1);
        if (close < 0) {
          // 不平衡的左括號：整段到行尾視為註解，並回報 R01 error
          comments.push(raw.slice(i + 1).trim());
          diags.push(U.diag('R01', line, 'error', '括號註解沒有對應的右括號「)」',
            { detail: '從「(」到行尾都會被當成註解；機台會發 PS0003 類的格式警報。請補上「)」。', fanucAlarm: 'PS0003' }));
          i = n;
        } else {
          comments.push(raw.slice(i + 1, close).trim());
          i = close + 1;
        }
      } else if (ch === ')') {
        // 孤立的右括號：忽略並回報 info
        diags.push(U.diag('R01', line, 'info', '孤立的右括號「)」已忽略',
          { detail: '沒有對應的「(」，這個字元不會產生任何動作，建議刪除。' }));
        i++;
      } else {
        out += ch;
        i++;
      }
    }
    return { stripped: out, comments };
  }

  /** 把一段執行文字切成字組 */
  function scanWords(text, line, diags) {
    const words = [];
    let i = 0;
    const n = text.length;
    let badRun = null; // 連續非法字元合併成一筆診斷
    const flushBad = () => {
      if (badRun) {
        diags.push(U.diag('R01', line, 'error', `無法辨識的字元「${badRun.chars}」`,
          { detail: '不屬於任何字組（位址字母 + 數字）。機台會發格式警報（PS0010 等）。請刪除或修正。', fanucAlarm: 'PS0010' }));
        badRun = null;
      }
    };
    while (i < n) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t') { i++; continue; }
      if (ch === ',') {
        COMMA_RE.lastIndex = i;
        const m = COMMA_RE.exec(text);
        if (m) {
          flushBad();
          words.push(makeWord(m[1].toUpperCase(), m[2], m[0], i, true));
          i += m[0].length;
          continue;
        }
        // 逗號後不是 C/R + 數字
        if (!badRun) badRun = { chars: '' };
        badRun.chars += ch;
        i++;
        continue;
      }
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
        WORD_RE.lastIndex = i;
        const m = WORD_RE.exec(text);
        if (m) {
          flushBad();
          words.push(makeWord(m[1].toUpperCase(), m[2], m[0], i, false));
          i += m[0].length;
          continue;
        }
        flushBad();
        diags.push(U.diag('R01', line, 'error', `位址「${ch.toUpperCase()}」後面沒有數字`,
          { detail: '每個字組必須是「字母 + 數值」，例如 G0、X-34.。機台會發 PS0009／PS0010 格式警報。', fanucAlarm: 'PS0009' }));
        i++;
        continue;
      }
      if (!badRun) badRun = { chars: '' };
      badRun.chars += ch;
      i++;
    }
    flushBad();
    return words;
  }

  function makeWord(addr, numStr, raw, col, comma) {
    return {
      addr,
      value: parseFloat(numStr),
      raw,
      col,
      hasDecimal: numStr.indexOf('.') >= 0,
      comma,
    };
  }

  /** 解析單行 → Block */
  function parseLine(raw, line, diags) {
    const block = {
      line,
      raw,
      text: '',
      comment: null,
      slashes: 0,
      skipLevel: null,
      words: [],
      tailWords: [],
      isPercent: false,
      isEmpty: true,
      tailIgnored: null,
    };
    // 1. 先剝註解（(M4*P0.7) 之類絕不能被當成 M4）
    const sc = stripComments(raw, line, diags);
    if (sc.comments.length) block.comment = sc.comments.join(' ');
    let body = sc.stripped;

    // 2. % 行
    if (/^\s*%/.test(body)) {
      block.isPercent = true;
      block.text = '%';
      return block;
    }

    // 3. 節首斜線
    const lead = LEAD_SLASH_RE.exec(body);
    if (lead) {
      block.slashes = lead[1].length;
      if (block.slashes >= 2) block.skipLevel = 1;
      else block.skipLevel = lead[2] ? parseInt(lead[2], 10) : 1;
      body = body.slice(lead[0].length);
    }

    // 4. ; 視為 EOB，其後忽略
    const eob = body.indexOf(';');
    if (eob >= 0) body = body.slice(0, eob);

    // 5. 節中再出現的斜線：Fanuc 的規則是「block skip 開關 ON 時」才忽略斜線到 EOB 的內容；
    //    開關 OFF 時整節照跑。所以這裡仍然把尾段的內容切出來（tailIgnored 保留原字串供顯示），
    //    但同時把尾段也切成字組放進 tailWords，讓 interpreter 依情境決定要不要執行
    //    （情境 off／multiIgnored 執行、on 不執行）。不這樣做的話，開關關閉的情境會少掉
    //    F 之類的模態字，衍生一堆假的 R08「沒有 F」紅字。
    const mid = body.indexOf('/');
    let tail = null;
    if (mid >= 0) {
      tail = body.slice(mid);
      block.tailIgnored = tail;
      body = body.slice(0, mid);
    }

    block.text = body.trim();
    if (block.text) block.words = scanWords(block.text, line, diags);
    if (tail) {
      // 尾段可能還有更多斜線（X1./X2./X3.），一律當分隔符號去掉再切字組
      const tailBody = tail.replace(/\//g, ' ').trim();
      if (tailBody) {
        const tw = scanWords(tailBody, line, diags);
        for (const w of tw) w.afterSlash = true;
        block.tailWords = tw;
      }
    }
    block.isEmpty = block.words.length === 0 && block.tailWords.length === 0;
    return block;
  }

  /** 判斷換行字元（多數決） */
  function detectLineEnding(text) {
    let crlf = 0, lf = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++; else lf++;
      }
    }
    return crlf > lf ? '\r\n' : '\n';
  }

  /**
   * @param {string} text
   * @returns {TokenizeResult}
   */
  function tokenize(text) {
    text = text == null ? '' : String(text);
    const diagnostics = [];
    const lines = text.split(/\r\n|\n/);
    const blocks = new Array(lines.length);
    let programNumber = null;
    let programName = null;
    for (let i = 0; i < lines.length; i++) {
      const b = parseLine(lines[i], i + 1, diagnostics);
      blocks[i] = b;
      if (programNumber === null && !b.isEmpty) {
        for (const w of b.words) {
          if (w.addr === 'O') {
            programNumber = w.value;
            programName = b.comment;
            break;
          }
        }
      }
    }
    return {
      blocks,
      lineEnding: detectLineEnding(text),
      programNumber,
      programName,
      diagnostics,
    };
  }

  NC.tokenize = tokenize;
})(globalThis.NC = globalThis.NC || {});
