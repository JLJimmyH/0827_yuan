/*
 * NC 預演台 — rules.js：跨模組檢查規則（CONTRACT §6）
 *
 * NC.rules.registry : Rule[]  每條規則 {id, title, severity, phase, check(ctx) → Diagnostic[]}
 * NC.rules.run(ctx, opts?)    跑規則，回傳 Diagnostic[]
 *
 *   ctx = { tok, scenarios:{off:ScenarioResult, on?:ScenarioResult, multiIgnored?:ScenarioResult},
 *           toolTable, stock, settings }
 *   opts = { phases?: string[] }  只跑指定 phase 的規則（不給 = 全跑）
 *
 * 關於 phase 的用法（給 analyze.js）：
 *   - 沒有要跑模擬時：run(ctx) 一次跑完。
 *   - 要跑模擬時：先 run(ctx, {phases: NC.rules.PRE_SIM_PHASES})，模擬完再
 *     run(ctx, {phases: NC.rules.SIM_PHASES})。'sim' / 'cross' 的規則在有沒有 sim
 *     的情況下會給出不同結論（例如 R20 沒有 sim 時是 needsInput、有 sim 時才敢說是不是
 *     warning），兩階段都跑會留下過時的結論，所以第一階段請用 PRE_SIM_PHASES 過濾。
 *
 * 設計原則（使用者要求「寧可少報也不要誤報」）：
 *   - 能確定的才給 error；只要牽涉到「材料當下長什麼樣」而手上沒有模擬資料的，一律降成
 *     warning 或 needsInput。
 *   - 同一種情形重複很多次時聚合成一筆，避免把診斷清單洗版。
 *   - message 用白話講「發生什麼事」，detail 講「會有什麼後果、建議怎麼改」。
 */
(function (NC) {
  'use strict';

  const U = NC.util;
  const EPS = 1e-6;

  // ===========================================================================
  // 共用小工具
  // ===========================================================================
  function settingsOf(ctx) {
    const out = U.defaultSettings();
    const s = (ctx && ctx.settings) || {};
    for (const k of Object.keys(s)) if (s[k] !== undefined) out[k] = s[k];
    return out;
  }
  function scen(ctx, name) { return (ctx && ctx.scenarios && ctx.scenarios[name]) || null; }
  function runOf(ctx, name) { const s = scen(ctx, name); return (s && s.run) || null; }
  function geoOf(ctx, name) { const s = scen(ctx, name); return (s && s.geometry) || null; }
  function simOf(ctx, name) { const s = scen(ctx, name); return (s && s.sim) || null; }
  function blocksOf(ctx) { return (ctx && ctx.tok && ctx.tok.blocks) || []; }
  function blockAt(ctx, line) { const b = blocksOf(ctx); return (line >= 1 && line <= b.length) ? b[line - 1] : null; }
  function toolListOf(ctx) { const t = ctx && ctx.toolTable; return (t && Array.isArray(t.tools)) ? t.tools : []; }
  function findTool(ctx, t) { return toolListOf(ctx).find((x) => x && x.t === t) || null; }
  function topZ(ctx) {
    const st = ctx && ctx.stock;
    return (st && st.max && typeof st.max.z === 'number') ? st.max.z : 0;
  }
  const f = (v) => U.fmt(v, 3);
  const p3 = (p) => p ? `(${f(p.x)}, ${f(p.y)}, ${f(p.z)})` : '（未知）';
  const p2 = (x, y) => `(${f(x)}, ${f(y)})`;

  function diag(ruleId, line, severity, message, extra) {
    const d = U.diag(ruleId, line, severity, message);
    if (extra) for (const k of Object.keys(extra)) if (extra[k] !== undefined) d[k] = extra[k];
    return d;
  }

  const MOTION = { rapid: 1, linear: 1, arc: 1, hole: 1 };
  function firstMotion(eb) {
    if (!eb || !eb.actions) return null;
    for (const a of eb.actions) if (MOTION[a.kind]) return a;
    return null;
  }
  function kindLabel(a) {
    if (!a) return '（沒有動作）';
    if (a.kind === 'rapid') return 'G0 快速定位';
    if (a.kind === 'linear') return 'G1 直線進給';
    if (a.kind === 'arc') return (a.cw ? 'G2' : 'G3') + ' 圓弧進給';
    if (a.kind === 'hole') return '固定循環鑽孔';
    return String(a.kind);
  }
  function moveWord(a) {
    if (!a) return '';
    if (a.kind === 'rapid') return 'G0';
    if (a.kind === 'linear') return 'G1 ' + (a.feed == null ? 'F（未指定）' : 'F' + f(a.feed));
    if (a.kind === 'arc') return (a.cw ? 'G2 ' : 'G3 ') + (a.feed == null ? 'F（未指定）' : 'F' + f(a.feed));
    return kindLabel(a);
  }
  /** 找出「把某個高度切出來」的作業（用實際的水平切削動作找，比 op.zMin 準）。 */
  function cutAtDepth(ctx, run, z) {
    const tools = [];
    let line = 0;
    for (const e of (run.executed || [])) {
      if (!e || e.skipped || e.ignored) continue;
      for (const a of (e.actions || [])) {
        if (a.kind !== 'linear' && a.kind !== 'arc') continue;
        if (!a.from || !a.to) continue;
        if (Math.abs(a.to.z - a.from.z) > 0.005) continue;   // 只看水平切削（真的在鋪底面）
        if (Math.abs(a.to.z - z) > 0.02) continue;
        const t = e.after.toolInSpindle;
        if (t != null && tools.indexOf(t) < 0) tools.push(t);
        if (!line) line = e.line;
      }
    }
    return { tools, line };
  }
  function samePt(a, b) {
    return !!a && !!b && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
  }
  function xyDist(a, b) { return (a && b) ? Math.hypot(a.x - b.x, a.y - b.y) : 0; }
  function rawOf(ctx, line) { const b = blockAt(ctx, line); return b ? String(b.raw || '').trim() : ''; }
  function toolLabel(ctx, t) {
    if (t == null) return '（未指定刀具）';
    const tool = findTool(ctx, t);
    return tool && tool.label && tool.label !== ('T' + t) ? `T${t}（${tool.label}）` : `T${t}`;
  }

  // ---- 模擬高度圖 -----------------------------------------------------------
  function simHeightAt(sim, hm, x, y) {
    if (!sim || !hm) return null;
    const ix = Math.round((x - sim.origin.x) / sim.cell);
    const iy = Math.round((y - sim.origin.y) / sim.cell);
    if (ix < 0 || iy < 0 || ix >= sim.nx || iy >= sim.ny) return null;
    const v = hm[iy * sim.nx + ix];
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }
  /** 「做完第 opIndex 個作業之後」的高度圖；找不到 snapshot 就用最終高度圖。 */
  function heightAfterOp(sim, opIndex) {
    if (!sim) return null;
    let best = null;
    for (const s of (sim.snapshots || [])) {
      if (!s || !s.height) continue;
      if (s.afterOpIndex >= opIndex && (!best || s.afterOpIndex < best.afterOpIndex)) best = s;
    }
    return best ? best.height : sim.height;
  }
  /** 「開始做第 opIndex 個作業之前」的高度圖；找不到回 null（呼叫端自行退回素材頂面）。 */
  function heightBeforeOp(sim, opIndex) {
    if (!sim) return null;
    let best = null;
    for (const s of (sim.snapshots || [])) {
      if (!s || !s.height) continue;
      if (s.afterOpIndex <= opIndex - 1 && (!best || s.afterOpIndex > best.afterOpIndex)) best = s;
    }
    return best ? best.height : null;
  }
  /** 沿著一段路徑找「材料比刀尖高最多」的位置。回 {depth,x,y,z,h} 或 null。 */
  function worstIntrusion(sim, hm, from, to) {
    if (!sim || !hm || !from || !to) return null;
    const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const step = Math.max(0.2, sim.cell / 2);
    const n = Math.max(2, Math.min(600, Math.ceil(len / step)));
    let worst = null;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const x = from.x + (to.x - from.x) * u;
      const y = from.y + (to.y - from.y) * u;
      const z = from.z + (to.z - from.z) * u;
      const h = simHeightAt(sim, hm, x, y);
      if (h == null) continue;
      const d = h - z;
      if (!worst || d > worst.depth) worst = { depth: d, x, y, z, h };
    }
    return worst;
  }

  // ---- 統計小工具 -----------------------------------------------------------
  function modeOf(arr) {
    const m = new Map();
    for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
    let bv = null, bc = 0;
    for (const [v, c] of m) if (c > bc) { bv = v; bc = c; }
    return { value: bv, count: bc, map: m };
  }
  function joinLines(lines, max) {
    const n = max || 12;
    const shown = lines.slice(0, n).map((l) => '第 ' + l + ' 行').join('、');
    return lines.length > n ? `${shown}…（共 ${lines.length} 處）` : shown;
  }

  // ===========================================================================
  // R05 — 節首多斜線
  // ===========================================================================
  function checkR05(ctx) {
    const st = settingsOf(ctx);
    const out = [];
    const modeText = st.multiSlash === 'ignoreBlock' ? '整節忽略（不管開關開或關）'
      : st.multiSlash === 'alarm' ? '直接發警報'
        : '視同一個斜線（開關打開時整節被跳過）';
    for (const b of blocksOf(ctx)) {
      if (!b || (b.slashes || 0) < 2) continue;
      const alarm = st.multiSlash === 'alarm';
      const fixed = String(b.raw || '').replace(/^(\s*)\/+/, '$1/');
      out.push(diag('R05', b.line, alarm ? 'error' : 'warning',
        `節首寫了 ${b.slashes} 個斜線（${'/'.repeat(b.slashes)}），Fanuc 只認得一個`, {
          detail: `選擇性跳過（block skip）在 Fanuc 只認節首的一個「/」，或「/1」～「/9」指定等級。多打的斜線各家控制器解讀不一樣：有的當成一個斜線、有的整節不執行、有的直接警報。本工具目前的設定是「${modeText}」。\n`
            + `這一節去掉斜線後的內容是「${b.text}」。\n`
            + `建議：如果這幾個斜線只是拿來當段落記號、不是真的要當跳過節，請整個刪掉（斜線在 Fanuc 一定是「跳過節」的意思，不是註解）；如果真的要當跳過節，只留一個斜線。`,
          fanucAlarm: alarm ? 'PS0010' : undefined,
          fix: { label: '改成單斜線', edits: [{ line: b.line, text: fixed }] },
        }));
    }
    return out;
  }

  // ===========================================================================
  // R06 — block skip 開／關的差異（最重要的一條）
  // ===========================================================================
  function checkR06(ctx) {
    const off = runOf(ctx, 'off');
    const on = runOf(ctx, 'on');
    if (!off || !on) return [];
    const sim = simOf(ctx, 'off');
    const top = topZ(ctx);
    const out = [];

    // ---- 1) 每個被跳過的節：找它之後第一個實際動作，和「開關關」時同一行比較 ----
    const n = Math.min(on.executed.length, off.executed.length);
    for (let i = 0; i < n; i++) {
      const eb = on.executed[i];
      if (!eb || !eb.skipped) continue;
      const blk = blockAt(ctx, eb.line);
      const skippedText = blk ? String(blk.raw || '').trim() : '';

      let j = -1, onA = null;
      for (let k = i + 1; k < n; k++) {
        const a = firstMotion(on.executed[k]);
        if (a) { j = k; onA = a; break; }
      }
      if (!onA) {
        out.push(diag('R06', eb.line, 'info', '這一節被跳過之後，程式就沒有其他動作了', {
          scenario: 'on',
          detail: `「${skippedText}」是這支程式最後一個會動的節。開關打開時它不會執行，等於這一刀不做。`,
        }));
        continue;
      }
      const nextLine = on.executed[j].line;
      const offA = firstMotion(off.executed[j]);
      const onFeed = (onA.feed == null) ? null : onA.feed;
      const offFeed = (!offA || offA.feed == null) ? null : offA.feed;
      const changed = !offA || onA.kind !== offA.kind || !samePt(onA.from, offA.from)
        || !samePt(onA.to, offA.to) || onFeed !== offFeed;
      if (!changed) continue; // 跳過這一節完全沒有影響（例如刀具本來就已經在那個位置）

      const tipZ = Math.min(onA.from ? onA.from.z : Infinity, onA.to ? onA.to.z : Infinity);
      const inCut = isFinite(tipZ) && tipZ < top - 0.01;
      const horizontal = xyDist(onA.from, onA.to) > 0.001;
      const dzStart = (onA.from && offA && offA.from) ? (onA.from.z - offA.from.z) : 0;
      const dxyStart = (onA.from && offA && offA.from) ? xyDist(onA.from, offA.from) : 0;
      const kindChanged = !!offA && onA.kind !== offA.kind;
      const feedChanged = !!offA && onFeed !== offFeed;

      // 材料判定：用「開關關」情境「做完同一個作業之後」的高度圖。
      // 那張圖是當下材料高度的下界（後面的作業只會再挖掉更多），所以只要它還高過刀尖，
      // 就代表這條路徑當時一定有材料擋著 → 才敢判 error。
      let worst = null;
      if (sim && onA.from && onA.to) {
        const hm = heightAfterOp(sim, on.executed[j].opIndex);
        worst = worstIntrusion(sim, hm, onA.from, onA.to);
      }
      const hitsMaterial = !!(worst && worst.depth > 0.05);

      let severity;
      if (hitsMaterial) severity = 'error';
      else if (inCut && (horizontal || kindChanged)) severity = 'warning';
      else if (Math.abs(dzStart) > EPS || dxyStart > 0.001) severity = 'warning';
      else severity = 'info';

      let message;
      if (hitsMaterial) {
        message = `這一節被跳過的話，第 ${nextLine} 行會直接切進實心材料（材料比刀尖高 ${f(worst.depth)} mm）`;
      } else if (kindChanged && offA.kind === 'rapid') {
        message = `這一節（抬刀）被跳過的話，第 ${nextLine} 行的快速定位會變成 ${moveWord(onA)} 的切削，而且刀具還在 Z${f(tipZ)}`;
      } else if (dxyStart > 0.001) {
        message = `這一節被跳過的話，第 ${nextLine} 行會從 ${p3(onA.from)} 開始，而不是 ${p3(offA.from)}（差 ${f(dxyStart)} mm）`;
      } else if (Math.abs(dzStart) > EPS) {
        message = `這一節被跳過的話，第 ${nextLine} 行會在 Z${f(onA.from.z)} 加工，而不是 Z${f(offA.from.z)}（少下刀 ${f(Math.abs(dzStart))} mm）`;
      } else if (feedChanged) {
        message = `這一節被跳過的話，第 ${nextLine} 行的進給會變成 ${moveWord(onA)}，而不是 ${moveWord(offA)}`;
      } else {
        message = `這一節被跳過的話，第 ${nextLine} 行的動作會跟著改變`;
      }

      let detail = `若這行被跳過：刀具會從 ${p3(onA.from)} 以 ${moveWord(onA)} 移到 ${p3(onA.to)}。\n`;
      detail += offA
        ? `開關關閉（照常執行「${skippedText}」）時：從 ${p3(offA.from)} 以 ${moveWord(offA)} 移到 ${p3(offA.to)}。\n`
        : `開關關閉時，第 ${nextLine} 行不會產生這個動作。\n`;
      const estimated = !!(ctx.stock && ctx.stock.source && ctx.stock.source !== 'user');
      if (worst) {
        detail += worst.depth > 0.05
          ? `素材模擬顯示這條路徑上材料最高到 Z${f(worst.h)}（在 ${p2(worst.x, worst.y)}），比刀尖高 ${f(worst.depth)} mm，刀具會硬切進去。\n`
          : `素材模擬顯示這條路徑上材料最高只到 Z${f(worst.h)}，還在刀尖下方 ${f(-worst.depth)} mm，不會撞到；但成品形狀會和預期不一樣。\n`;
        if (hitsMaterial && estimated) {
          detail += '（此判定依據推估素材。推估素材是用切削包絡往外擴一個刀半徑得到的，工件外圍那一圈料實際上可能不存在；請填入真實素材尺寸後再確認一次。）\n';
        }
      } else if (inCut) {
        detail += `刀具停在 Z${f(tipZ)}（材料頂面 Z${f(top)} 以下）就橫向移動。目前沒有素材模擬資料，無法判斷該處還有沒有材料，打開素材模擬可以確認會不會撞刀。\n`;
      }
      if (blk && blk.text) {
        const sameText = [];
        for (let k = 0; k < n; k++) {
          if (k === i || !on.executed[k].skipped) continue;
          if (on.executed[k].opIndex !== eb.opIndex) continue;
          const b2 = blockAt(ctx, on.executed[k].line);
          if (b2 && b2.text === blk.text) sameText.push(on.executed[k].line);
        }
        if (sameText.length) {
          detail += `同一個作業裡還有 ${sameText.length} 行內容一樣的跳過節（${joinLines(sameText, 8)}），開關打開時會一起被跳過。\n`;
        }
      }
      detail += '建議：確認這一節是不是真的要當「選擇性跳過節」。如果斜線只是想做記號，請把斜線刪掉；如果真的要能選擇性跳過，請把同一層要一起跳的節都加上斜線，並改用 G90 寫絕對座標，不要讓後面的動作依賴這一節的結果。';

      out.push(diag('R06', eb.line, severity, message, {
        scenario: 'on',
        detail,
        pos: worst ? { x: worst.x, y: worst.y, z: worst.z } : (onA.to ? U.clone3(onA.to) : undefined),
        // magnitude：這一組診斷的「嚴重程度數值」，摺疊時用來挑代表（analyze.reindex）。
        // 撞料的是干涉深度，其餘的是位置差。
        magnitude: hitsMaterial ? worst.depth : Math.max(Math.abs(dzStart), dxyStart),
      }));
    }

    // ---- 2) 每個作業的最深 Z 比較（整層被跳過時最直接的後果）----
    const m = Math.min(off.ops.length, on.ops.length);
    for (let i = 0; i < m; i++) {
      const a = off.ops[i], b = on.ops[i];
      if (!a || !b || a.zMin == null || b.zMin == null) continue;
      if (Math.abs(a.zMin - b.zMin) <= 1e-6) continue;
      out.push(diag('R06', a.lineStart, 'warning',
        `${toolLabel(ctx, a.tool)} 這個作業在 block skip 打開時最深只切到 Z${f(b.zMin)}，關閉時是 Z${f(a.zMin)}`, {
          scenario: 'on',
          detail: `差 ${f(Math.abs(a.zMin - b.zMin))} mm。這一段（第 ${a.lineStart}–${a.lineEnd} 行）的分層下刀節被斜線標成選擇性跳過，開關打開時那幾層不會做，成品會比圖面淺。\n`
            + '建議：確認機台面板上的 block skip 開關該開還是該關，並在程式開頭用註解寫清楚。',
        }));
    }

    // ---- 3) 兩種情境的成品差異（要有兩邊的素材模擬才算得出來）----
    const simOn = simOf(ctx, 'on');
    if (sim && simOn && sim.nx === simOn.nx && sim.ny === simOn.ny && sim.height && simOn.height) {
      let cells = 0, maxDiff = 0, worstIdx = -1;
      for (let k = 0; k < sim.height.length; k++) {
        const d = Math.abs(sim.height[k] - simOn.height[k]);
        if (d > 0.01) {
          cells++;
          if (d > maxDiff) { maxDiff = d; worstIdx = k; }
        }
      }
      if (cells > 0) {
        const total = sim.height.length;
        const pct = Math.round((cells / total) * 1000) / 10;
        const wx = worstIdx >= 0 ? sim.origin.x + (worstIdx % sim.nx) * sim.cell : 0;
        const wy = worstIdx >= 0 ? sim.origin.y + Math.floor(worstIdx / sim.nx) * sim.cell : 0;
        out.push(diag('R06', 0, 'info',
          `block skip 開和關做出來的東西不一樣：素材有 ${cells} 格（約 ${pct}%）高度不同，最大差 ${f(maxDiff)} mm`, {
            detail: `差最多的位置在 ${p2(wx, wy)}。這代表面板上的 block skip 開關會影響成品尺寸，不是可有可無的設定。\n`
              + '建議：在程式開頭用註解寫清楚這支程式該用哪一種設定跑。',
          }));
      }
    }
    return out;
  }

  // ===========================================================================
  // R07 — 被跳過的節裡面含模態字
  // ===========================================================================
  // 註：G0/G1/G2/G3（01 群組）的模態遺失由 R06 直接描述後果，這裡不重複報，
  //     只處理其他會影響「後面每一節」的模態字（G90/G91、F、S、D/H、G41…）。
  const R07_FIELDS = [
    { k: 'distance', label: 'G90/G91 絕對／增量', sev: 'error', why: '後面所有座標的意思會整個改變（絕對值被當成增量，或反過來），刀具會跑到完全不同的位置。' },
    { k: 'plane', label: 'G17/G18/G19 加工平面', sev: 'error', why: '圓弧與刀徑補正的平面會不對。' },
    { k: 'units', label: 'G20/G21 單位', sev: 'error', why: '吋和公厘會弄反，尺寸差 25.4 倍。' },
    { k: 'wcs', label: 'G54–G59 工件座標系', sev: 'error', why: '整個原點會跑掉。' },
    { k: 'comp', label: 'G40/G41/G42 刀徑補正', sev: 'error', why: '補正的啟動或取消會遺失，輪廓會差一個刀半徑，也可能讓後面的 G40/G41 出現警報。' },
    { k: 'd', label: 'D 補正號', sev: 'error', why: '刀徑補正會用到別的補正號，尺寸會跑掉。' },
    { k: 'lengthComp', label: 'G43/G44/G49 刀長補正', sev: 'error', why: '刀長補正沒建立或沒取消，Z 深度會整個錯掉。' },
    { k: 'h', label: 'H 補正號', sev: 'error', why: '會用到別把刀的長度補正，Z 深度會錯。' },
    { k: 'feedMode', label: 'G94/G95 進給模式', sev: 'warning', why: '每分鐘進給和每轉進給會弄反。' },
    { k: 'retractMode', label: 'G98/G99 循環退刀', sev: 'warning', why: '固定循環會退到 R 點而不是初始面（或反過來），可能撞到夾具。' },
    { k: 'feed', label: 'F 進給', sev: 'warning', why: '後面的切削會沿用前一個 F 值，進給可能整個變快或變慢。' },
    { k: 'toolStaged', label: 'T 預選刀', sev: 'warning', why: '刀庫會預選到別把刀，下一次 M6 可能換錯刀。' },
    { k: 'aicc', label: 'G05.1 AI 輪廓控制', sev: 'warning', why: 'AI 輪廓控制沒有開或沒有關，加工的順滑度與精度會不同。' },
    { k: 'coolant', label: 'M8/M9 切削液', sev: 'info', why: '切削液可能沒開就開始切，或切完沒關。' },
  ];
  function checkR07(ctx) {
    const off = runOf(ctx, 'off');
    const on = runOf(ctx, 'on');
    if (!off || !on) return [];
    const out = [];
    const n = Math.min(on.executed.length, off.executed.length);
    for (let i = 0; i < n; i++) {
      if (!on.executed[i] || !on.executed[i].skipped) continue;
      const e = off.executed[i];
      if (!e || e.before === e.after) continue;
      const lost = [];
      for (const fd of R07_FIELDS) {
        if (e.before[fd.k] === e.after[fd.k]) continue;
        lost.push({ fd, from: e.before[fd.k], to: e.after[fd.k] });
      }
      if (e.before.spindle && e.after.spindle) {
        if (e.before.spindle.rpm !== e.after.spindle.rpm) {
          lost.push({ fd: { label: 'S 主軸轉速', sev: 'warning', why: '後面的切削會沿用前一個轉速。' }, from: e.before.spindle.rpm, to: e.after.spindle.rpm });
        }
        if (e.before.spindle.dir !== e.after.spindle.dir) {
          lost.push({ fd: { label: '主軸啟停 M3/M4/M5', sev: 'error', why: '主軸可能沒轉就開始切，或該停沒停。' }, from: e.before.spindle.dir, to: e.after.spindle.dir });
        }
      }
      const cb = (e.before.cycle && e.before.cycle.code) || null;
      const ca = (e.after.cycle && e.after.cycle.code) || null;
      if (cb !== ca) {
        lost.push({ fd: { label: '固定循環 G73–G89/G80', sev: 'warning', why: '固定循環沒啟動或沒取消，後面帶 X/Y 的節會多鑽孔或不鑽孔。' }, from: cb || '（無）', to: ca || '（無）' });
      }
      if (!lost.length) continue;
      const worst = lost.some((l) => l.fd.sev === 'error') ? 'error'
        : lost.some((l) => l.fd.sev === 'warning') ? 'warning' : 'info';
      const names = lost.map((l) => l.fd.label).join('、');
      out.push(diag('R07', e.line, worst,
        `這個跳過節裡有模態字（${names}），跳過的話後面全部沿用舊值`, {
          scenario: 'on',
          detail: `「${rawOf(ctx, e.line)}」除了移動之外還改了模態狀態：\n`
            + lost.map((l) => `  · ${l.fd.label}：${String(l.from)} → ${String(l.to)}；跳過後會維持 ${String(l.from)}。${l.fd.why}`).join('\n')
            + '\n模態字（G90/G91、F、S、D、H、G41…）一旦寫在跳過節裡，開關的狀態就會改變後面每一節的行為，不只是少做這一節而已。\n'
            + '建議：把模態字搬到不會被跳過的節，跳過節裡只留座標。',
        }));
    }
    return out;
  }

  // ===========================================================================
  // R14 — D／H 補正號和刀號不一致；D0／H0
  // ===========================================================================
  function checkR14(ctx) {
    const off = runOf(ctx, 'off');
    if (!off) return [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < off.executed.length; i++) {
      const e = off.executed[i];
      if (!e || e.skipped || e.ignored) continue;
      const b = blockAt(ctx, e.line);
      if (!b || !b.words || !b.words.length) continue;
      const t = e.after.toolInSpindle;
      for (const w of b.words) {
        if (w.comma) continue;
        if (w.addr !== 'D' && w.addr !== 'H') continue;
        const isD = w.addr === 'D';
        if (w.value === 0) {
          const key = `${w.addr}0@${e.opIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(isD
            ? diag('R14', e.line, 'warning', 'D0 會把刀徑補正量當成 0', {
              detail: 'Fanuc 的 0 號補正永遠是 0，不能修改。G41/G42 配 D0 等於沒有補正，刀具會直接走在程式寫的路徑上，工件會多切掉一個刀半徑。\n'
                + '建議：改成實際使用的補正號（一般會和刀號一致，例如 T11 用 D11），並確認補正畫面上有輸入刀具半徑。',
            })
            : diag('R14', e.line, 'warning', 'H0 等於沒有刀長補正', {
              detail: 'H0 的補正量固定是 0，G43 H0 之後刀尖位置會以機械原點為基準，Z 深度會差一整個刀長，通常會直接撞到工件或夾具。\n'
                + '建議：改成這把刀實際的長度補正號（一般和刀號一致）。',
            }));
          continue;
        }
        if (t == null || w.value === t) continue;
        const key = `${w.addr}${w.value}|T${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(diag('R14', e.line, 'info',
          `這裡用 ${w.addr}${w.value}，但主軸上是 T${t}，${w.addr} 號和刀號不一樣`, {
            detail: isD
              ? `Fanuc 不要求 D 號等於刀號，很多程式會刻意把粗銑／精修的補正分開放（例如同一把 T${t} 粗銑用 D${t}、精修用 D${w.value} 多留一點餘量）。這只是提醒你確認 D${w.value} 的補正值有沒有輸入、是不是給這把刀用的。\n`
                + `如果只是打錯號碼，刀徑補正會抓到別把刀的半徑，輪廓尺寸會整個跑掉。`
              : `H 號通常會跟刀號一致。這裡用 H${w.value} 而主軸上是 T${t}，請確認 H${w.value} 裡放的真的是這把刀的長度，否則 Z 深度會錯。`,
          }));
      }
    }
    return out;
  }

  // ===========================================================================
  // R15 — D 值和刀徑對不起來
  // ===========================================================================
  function checkR15(ctx) {
    const off = runOf(ctx, 'off');
    const table = ctx && ctx.toolTable;
    if (!off || !table) return [];
    const st = settingsOf(ctx);
    const tol = (typeof st.dToleranceMm === 'number' && st.dToleranceMm >= 0) ? st.dToleranceMm : 0.5;
    const out = [];
    const seen = new Set();
    for (const op of (off.ops || [])) {
      if (!op || op.tool == null || !op.dList || !op.dList.length) continue;
      const tool = findTool(ctx, op.tool);
      if (!tool) continue;
      // 倒角刀／中心鑽例外：實際切削直徑由下刀深度決定，公稱直徑跟補正量本來就沒關係。
      if (tool.type === 'chamfer' || tool.type === 'spot') continue;
      const nominal = (typeof tool.diameter === 'number' && tool.diameter > 0) ? tool.diameter / 2 : null;
      if (nominal == null) continue;
      for (const d of op.dList) {
        const key = `D${d}|T${op.tool}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const r = NC.tools && NC.tools.effectiveRadius ? NC.tools.effectiveRadius(table, op.tool, d) : null;
        if (r == null) continue; // 沒有 D 值 → geometry 會出 R10 needsInput，這裡不重複
        const diff = Math.abs(r - nominal);
        if (diff <= tol) continue;
        out.push(diag('R15', op.lineStart, 'warning',
          `D${d} 的補正值 ${f(r)} mm 和 ${toolLabel(ctx, op.tool)} 的刀半徑 ${f(nominal)} mm 差了 ${f(diff)} mm`, {
            detail: `刀徑補正的 D 值一般就是刀具半徑（要留精修餘量時會再多留一點點）。差到 ${f(diff)} mm 通常是：D 值輸錯、抓到別把刀的補正、或刀具表裡的直徑填錯。\n`
              + `實際走出來的輪廓會和程式路徑差 ${f(diff)} mm。若這是刻意留的精修餘量，可以忽略這條，或把容許值（目前 ${f(tol)} mm）調大。`,
          }));
      }
    }
    return out;
  }

  // ===========================================================================
  // R19 — 固定循環：模態延續與逐孔統計
  // ===========================================================================
  function collectCycleGroups(ctx, run) {
    const groups = [];
    let g = null;
    const close = () => { if (g && g.holes.length) groups.push(g); g = null; };
    for (const e of (run.executed || [])) {
      if (!e || e.skipped || e.ignored) continue;
      const holes = (e.actions || []).filter((a) => a.kind === 'hole');
      if (holes.length) {
        const code = holes[0].cycle || (e.after.cycle && e.after.cycle.code) || 'G8x';
        if (!g || g.code !== code || g.opIndex !== e.opIndex) { close(); g = { code, opIndex: e.opIndex, tool: e.after.toolInSpindle, startLine: e.line, endLine: e.line, holes: [] }; }
        for (const h of holes) g.holes.push({ line: e.line, a: h });
        g.endLine = e.line;
      } else if (g && !(e.after && e.after.cycle)) {
        close();
      }
    }
    close();
    return groups;
  }
  function holeR(a) { return (a && a.rPoint != null) ? a.rPoint : (a ? a.r : null); }

  function checkR19(ctx) {
    const off = runOf(ctx, 'off');
    if (!off) return [];
    const out = [];
    const r18Lines = new Set((off.diagnostics || []).filter((d) => d && d.ruleId === 'R18').map((d) => d.line));

    for (const g of collectCycleGroups(ctx, off)) {
      const zs = [], rs = [], feeds = [];
      for (const h of g.holes) {
        if (h.a.z != null && zs.indexOf(h.a.z) < 0) zs.push(h.a.z);
        const rp = holeR(h.a);
        if (rp != null && rs.indexOf(rp) < 0) rs.push(rp);
        if (h.a.feed != null && feeds.indexOf(h.a.feed) < 0) feeds.push(h.a.feed);
      }
      const posList = g.holes.map((h) => p2(h.a.x, h.a.y));
      out.push(diag('R19', g.startLine, 'info',
        `${g.code} 固定循環從第 ${g.startLine} 行到第 ${g.endLine} 行，一共鑽 ${g.holes.length} 個孔`, {
          detail: `孔位：${posList.slice(0, 10).join('、')}${posList.length > 10 ? `…（共 ${posList.length} 個）` : ''}\n`
            + `孔底 Z：${zs.map(f).join(' / ')}；R 點 Z：${rs.map(f).join(' / ')}；進給：${feeds.map((v) => 'F' + f(v)).join(' / ') || '（沿用模態 F）'}\n`
            + '固定循環是模態的：在 G80（或 G0/G1/G2/G3）之前，每一個帶 X 或 Y 的節都會再鑽一個孔——包括你以為「只是定位」的節。請確認這幾個孔都是要鑽的。',
        }));

      // 同一組裡孔位重複 → 同一個孔會鑽兩次
      const seenXY = new Map();
      for (const h of g.holes) {
        const key = `${U.round(h.a.x, 3)},${U.round(h.a.y, 3)}`;
        if (seenXY.has(key)) {
          out.push(diag('R19', h.line, 'warning',
            `這個孔位 ${p2(h.a.x, h.a.y)} 和第 ${seenXY.get(key)} 行重複，同一個孔會被鑽兩次`, {
              detail: '固定循環在同一個 XY 再下一次，等於對同一個孔再鑽一次。深度一樣的話只是多花時間；深度不一樣則後面那次會決定最後的孔深。\n'
                + '建議：確認是不是漏改座標，或本來就是想分兩次鑽（先淺後深）。',
            }));
        } else seenXY.set(key, h.line);
      }
    }

    // 循環還開著就換刀／結束程式
    for (const e of (off.executed || [])) {
      if (!e || e.skipped || e.ignored) continue;
      const hasTc = (e.actions || []).some((a) => a.kind === 'toolchange');
      const hasEnd = (e.actions || []).some((a) => a.kind === 'stop' && (a.code === 'M30' || a.code === 'M2'));
      if (!hasTc && !hasEnd) continue;
      if (!e.before.cycle) continue;
      if (r18Lines.has(e.line)) continue;
      out.push(diag('R19', e.line, 'warning',
        `${hasTc ? '換刀' : '程式結束'}前沒有先用 G80 取消固定循環（${e.before.cycle.code} 還開著）`, {
          detail: 'Fanuc 的固定循環是模態的，M6／M30 之後如果控制器沒有自動取消，下一段程式只要有 X 或 Y 就會突然鑽孔。\n'
            + '建議：在 M6／M30 之前加一節 G80（常見寫法是 G91 G28 G80 Z0.）。',
        }));
    }

    // 重新進入循環卻沒給 R 或 Z（interpreter 的 R18 已經報過的行不重複）
    for (const e of (off.executed || [])) {
      if (!e || e.skipped || e.ignored) continue;
      if (e.before.cycle || !e.after.cycle) continue;
      if (r18Lines.has(e.line)) continue;
      const b = blockAt(ctx, e.line);
      if (!b) continue;
      const hasR = b.words.some((w) => !w.comma && w.addr === 'R');
      const hasZ = b.words.some((w) => !w.comma && w.addr === 'Z');
      if (hasR && hasZ) continue;
      out.push(diag('R19', e.line, 'error',
        `這裡重新啟動 ${e.after.cycle.code} 固定循環，卻沒有指定 ${!hasR && !hasZ ? 'R 點和孔底 Z' : (!hasR ? 'R 點' : '孔底 Z')}`, {
          detail: 'G80 之後循環的 R／Z 資料就清掉了，重新下 G8x 一定要把 R 和 Z 一起寫出來。少寫的那一個會被當成 0（或沿用當下的位置），孔會鑽錯深度、或是刀具從很高的地方以進給速度慢慢下來。\n'
            + '建議：把 R 點和孔底 Z 補齊，例如 G98 R2. G81 Z-10. F50。',
        }));
    }
    return out;
  }

  // ===========================================================================
  // R20 — R 點落在材料裡面
  // ===========================================================================
  function checkR20(ctx) {
    const off = runOf(ctx, 'off');
    if (!off) return [];
    const sim = simOf(ctx, 'off');
    const top = topZ(ctx);
    const out = [];
    const seen = new Set();
    for (const e of (off.executed || [])) {
      if (!e || e.skipped || e.ignored) continue;
      for (const a of (e.actions || [])) {
        if (a.kind !== 'hole') continue;
        const rp = holeR(a);
        // 沒有模擬資料時，只有「明顯低於工件頂面（Z0 或素材頂面取小者）」才問，
        // 免得 R2.／R3. 這種正常的安全高度被當成問題。
        if (rp == null || rp >= Math.min(0, top) - 0.01) continue;
        // 同一個作業、同一個 R 值只問一次（一個循環常常連鑽好幾個孔）
        const key = `${e.opIndex}|${U.round(rp, 3)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let h = null;
        if (sim) {
          const hm = heightBeforeOp(sim, e.opIndex);
          if (hm) h = simHeightAt(sim, hm, a.x, a.y);
          else if (simHeightAt(sim, sim.height, a.x, a.y) != null) h = top; // 第一個作業之前 = 原始素材頂面
        }
        if (h != null) {
          if (h <= rp + 0.01) continue; // 前面的作業已經挖到比 R 點更深 → 安全，不報
          out.push(diag('R20', e.line, 'warning',
            `R 點 Z${f(rp)} 卡在材料裡面（這個位置材料高到 Z${f(h)}），G0 下刀到 R 點會撞進去`, {
              detail: `固定循環會先用 G0 快速下降到 R 點，再從 R 點開始進給。素材模擬顯示做到這個作業之前，${p2(a.x, a.y)} 的材料還在 Z${f(h)}，比 R 點高 ${f(h - rp)} mm。\n`
                + '快速下刀撞進實心材料在真機上通常就是斷刀。\n'
                + `建議：把 R 點提到材料上方（例如 R${f(Math.max(top, h) + 2)}），或確認前面的作業真的有先把這裡挖開。`,
              pos: { x: a.x, y: a.y, z: rp },
            }));
        } else {
          out.push(diag('R20', e.line, 'needsInput',
            `R 點 Z${f(rp)} 在工件頂面（Z${f(Math.min(0, top))}）以下，需要確認這裡是不是已經先挖開了`, {
              detail: `固定循環會先用 G0 快速下降到 R 點再開始進給。R 點寫在材料頂面以下，代表程式假設 ${p2(a.x, a.y)} 這個位置前面已經被銑出凹槽了。\n`
                + '這在多把刀的程式裡很常見（先用銑刀挖穴、再用鑽頭從穴底鑽下去），本身不是錯；但如果那個凹槽沒有挖到這麼深，快速下刀就會直接撞進材料。\n'
                + '建議：打開素材模擬，本工具就會自動判斷該處到底有沒有材料。',
              pos: { x: a.x, y: a.y, z: rp },
            }));
        }
      }
    }
    return out;
  }

  // ===========================================================================
  // R24 — G91 增量區段
  // ===========================================================================
  function checkR24(ctx) {
    const off = runOf(ctx, 'off');
    if (!off) return [];
    const out = [];

    // (a) G91 區段裡出現選擇性跳過節
    for (let i = 0; i < off.executed.length; i++) {
      const e = off.executed[i];
      if (!e) continue;
      const b = blockAt(ctx, e.line);
      if (!b || !(b.slashes > 0)) continue;
      if (e.before.distance !== 'G91') continue;
      const z = (() => {
        const w = b.words.find((w2) => !w2.comma && w2.addr === 'Z');
        return w ? w.value : null;
      })();
      out.push(diag('R24', e.line, 'warning',
        'G91 增量模式裡放了選擇性跳過節，跳過之後後面所有位置都會整個平移', {
          detail: `增量模式下每一節的座標是「相對上一點」。這一節「${rawOf(ctx, e.line)}」被跳過的話，不是只少做這一節，`
            + (z != null ? `而是後面每一個位置都會往上（或往回）平移 ${f(Math.abs(z))} mm。\n` : '而是後面每一個位置都會整個平移。\n')
            + '這種寫法很容易讓成品深度差一整層，而且面板開關的狀態不同就做出不同的東西。\n'
            + '建議：分層下刀改寫成 G90 的絕對 Z 值（每層各自寫死深度），這樣就算跳過某一層，其他層還是切在正確的深度。',
        }));
    }

    // (b) 換刀／暫停／結束時還停在 G91
    for (let i = 0; i < off.executed.length; i++) {
      const e = off.executed[i];
      if (!e || e.skipped || e.ignored) continue;
      const acts = e.actions || [];
      const tc = acts.find((a) => a.kind === 'toolchange');
      const stop = acts.find((a) => a.kind === 'stop');
      if (!tc && !stop) continue;
      if (e.before.distance !== 'G91') continue;
      const isEnd = !!(stop && (stop.code === 'M30' || stop.code === 'M2'));
      if (isEnd) {
        out.push(diag('R24', e.line, 'info', '程式結束時還停在 G91 增量模式', {
          detail: 'Fanuc 的 G90/G91 是模態的。M30 之後是否回到 G90 由參數（3402#0）決定，很多機台不會自動復歸。\n'
            + '下一支程式如果沒有在開頭寫 G90，第一個移動就會被當成增量值執行，刀具會跑到完全料想不到的位置。\n'
            + '建議：在 M30 前補一節 G90（或至少確認每支程式開頭都有 G90）。',
        }));
        continue;
      }
      // 換刀／M0：只要下一個移動節自己有帶 G90 就沒問題，不用報
      let restored = null;
      for (let k = i + 1; k < off.executed.length; k++) {
        if (!firstMotion(off.executed[k])) continue;
        restored = off.executed[k].after.distance === 'G90';
        break;
      }
      if (restored !== false) continue;
      out.push(diag('R24', e.line, 'warning',
        `${tc ? '換刀' : '暫停'}時還停在 G91 增量模式，而且後面第一個移動也沒有寫 G90`, {
          detail: '換刀之後刀具位置已經被機台移到換刀點，接下來的第一個移動如果還是增量值，會從換刀點再加上去，刀具會跑到完全不對的地方。\n'
            + '建議：換刀後第一個定位節寫成 G0 G90 G54 X… Y…（這也是最常見的寫法）。',
        }));
    }
    return out;
  }

  // ===========================================================================
  // R25 — 主軸與切削液
  // ===========================================================================
  function checkR25(ctx) {
    const off = runOf(ctx, 'off');
    if (!off) return [];
    const st = settingsOf(ctx);
    const out = [];
    const reportedOps = new Set();
    const noM5 = [];
    let running = false;

    for (const e of (off.executed || [])) {
      if (!e || e.skipped || e.ignored) continue;
      for (const a of (e.actions || [])) {
        if (a.kind === 'spindle') {
          running = (a.dir === 'M3' || a.dir === 'M4');
          continue;
        }
        if (a.kind === 'toolchange') {
          if (running) noM5.push(e.line);
          running = false; // M6 一定會先定位主軸，換刀後主軸是停的
          continue;
        }
        if (a.kind === 'stop') {
          // M0／M1 會不會停主軸由機台設定決定；設定成會停時就當它停了，不算「沒有 M5」。
          if (a.code === 'M0' || a.code === 'M1') { if (st.m0StopsSpindle) running = false; }
          else running = false;
          continue;
        }
        if (a.kind !== 'linear' && a.kind !== 'arc' && a.kind !== 'hole') continue;
        // 真正的切削動作
        const rpm = e.after.spindle ? e.after.spindle.rpm : null;
        if (!running || rpm == null || rpm === 0) {
          const key = `${e.opIndex}|${!running ? 'stop' : 'rpm'}`;
          if (reportedOps.has(key)) continue;
          reportedOps.add(key);
          out.push(diag('R25', e.line, 'error',
            !running ? '主軸沒有轉就開始切削' : '主軸轉速 S 沒有指定就開始切削', {
              detail: !running
                ? '這一節是進給切削（G1/G2/G3 或固定循環），但前面沒有有效的 M3／M4，主軸是停的。真機上刀具會直接壓進材料，輕則崩刃、重則拉壞主軸。\n'
                  + '建議：在第一個下刀動作之前加 M3 S…（換刀後、M0 之後都要重下）。'
                : '這一節開始切削，但從程式開頭到這裡都沒有出現 S 指令，主軸轉速是未知的（Fanuc 會沿用上一支程式留下的值）。\n'
                  + '建議：在 M3 的同一節寫上 S 轉速。',
              fanucAlarm: undefined,
            }));
        }
      }
    }

    if (noM5.length) {
      const strict = !!st.requireM5BeforeM6;
      out.push(diag('R25', noM5[0], strict ? 'warning' : 'info',
        `有 ${noM5.length} 次換刀之前主軸還在轉（沒有先 M5，中間也沒有 M0）`, {
          detail: `發生在：${joinLines(noM5, 12)}。\n`
            + '多數加工中心的 M6 會自己定位並停主軸，所以這通常不是問題（本工具預設就當它安全）。\n'
            + '但如果機台沒有這個設定、或是要人手動開門處理，主軸還在轉就很危險。\n'
            + `建議：習慣上在 G91 G28 Z0. 之前寫 M5 M9。若你的機台一定要先 M5，可以把設定裡的「換刀前必須 M5」打開，這條會升級成警告。`,
        }));
    }
    return out;
  }

  // ===========================================================================
  // R26 — G05.1 AI 輪廓控制
  // ===========================================================================
  function checkR26(ctx) {
    const off = runOf(ctx, 'off');
    if (!off) return [];
    const out = [];
    let openLine = null;
    const g28InAicc = [];
    const m6InAicc = [];
    const cycleInAicc = [];

    for (const e of (off.executed || [])) {
      if (!e || e.skipped || e.ignored) continue;
      const b = blockAt(ctx, e.line);
      // G05.1 節裡不可以有別的字
      if (b && b.words.some((w) => !w.comma && w.addr === 'G' && Math.abs(w.value - 5.1) < 1e-9)) {
        const extra = b.words.filter((w) => !w.comma
          && !(w.addr === 'G' && Math.abs(w.value - 5.1) < 1e-9)
          && w.addr !== 'Q' && w.addr !== 'N');
        if (extra.length) {
          out.push(diag('R26', e.line, 'error',
            `G05.1 必須單獨成一節，這一節還有 ${extra.map((w) => w.raw).join('、')}`, {
              detail: 'Fanuc 規定 G05.1 Q1／Q0 要自己一節，同一節寫其他指令會發警報。\n'
                + '建議：把其他指令搬到下一節。',
              fanucAlarm: 'PS5010',
            }));
        }
      }
      for (const a of (e.actions || [])) {
        if (a.kind === 'aicc') {
          if (a.on) {
            if (openLine != null) {
              out.push(diag('R26', e.line, 'info', '這裡又下了一次 G05.1 Q1，但前面的 AI 輪廓控制還沒關掉', {
                detail: `上一次開啟是在第 ${openLine} 行。重複開啟不會出錯，但通常表示中間漏了 G05.1 Q0。`,
              }));
            }
            openLine = e.line;
          } else {
            if (openLine == null) {
              out.push(diag('R26', e.line, 'info', '這裡下了 G05.1 Q0，但前面沒有對應的 G05.1 Q1', {
                detail: '取消一個沒開啟的模式不會出錯，只是多餘的一節。也可能是前面的 Q1 被寫在跳過節裡。',
              }));
            }
            openLine = null;
          }
          continue;
        }
        if (openLine == null) continue;
        if (a.kind === 'refReturn') g28InAicc.push(e.line);
        else if (a.kind === 'toolchange') m6InAicc.push(e.line);
        else if (a.kind === 'hole' && cycleInAicc.indexOf(e.line) < 0) cycleInAicc.push(e.line);
      }
    }
    if (openLine != null) {
      out.push(diag('R26', openLine, 'warning', '這裡開啟了 G05.1 Q1，但程式跑到最後都沒有 G05.1 Q0 取消', {
        detail: 'AI 輪廓控制是模態的，沒有取消就結束程式，下一支程式會在 AI 模式下開始跑，加減速行為和你預期的不一樣。\n'
          + '建議：在 M30 之前補一節 G05.1 Q0。',
      }));
    }
    if (m6InAicc.length) {
      out.push(diag('R26', m6InAicc[0], 'warning',
        `AI 輪廓控制（G05.1 Q1）還開著就換刀，共 ${m6InAicc.length} 處`, {
          detail: `發生在：${joinLines(m6InAicc, 12)}。\n`
            + 'AI 輪廓控制模式中不該做換刀這種需要精確停止的動作。\n'
            + '建議：換刀前先寫 G05.1 Q0。',
        }));
    }
    if (g28InAicc.length) {
      out.push(diag('R26', g28InAicc[0], 'info',
        `AI 輪廓控制（G05.1 Q1）還開著就下 G28 回原點，共 ${g28InAicc.length} 處`, {
          detail: `發生在：${joinLines(g28InAicc, 12)}。\n`
            + '依 Fanuc B-63944EN §19.1，AI 輪廓控制模式中是允許 G28 的（不能用的是 G62／G63／G41.1／G42.1／螺紋切削），所以這不是錯誤，只是提醒。\n'
            + '若想讓程式讀起來更清楚，可以照 G0 Z50. M9 → G05.1 Q0 → G91 G28 Z0. 的順序寫，先關 AI 再回原點。',
        }));
    }
    if (cycleInAicc.length) {
      out.push(diag('R26', cycleInAicc[0], 'info',
        `AI 輪廓控制（G05.1 Q1）還開著就用固定循環，共 ${cycleInAicc.length} 處`, {
          detail: `發生在：${joinLines(cycleInAicc, 12)}。\n`
            + 'AI 輪廓控制是給高速輪廓銑削用的，固定循環（鑽孔、攻牙）用不到，多數控制器會在循環期間自動暫停這個模式。\n'
            + '不影響加工結果，只是這幾節的 G05.1 Q1 沒有意義。',
        }));
    }
    return out;
  }

  // ===========================================================================
  // R29 — T 預選與換刀的一致性
  // ===========================================================================
  function checkR29(ctx) {
    const off = runOf(ctx, 'off');
    if (!off) return [];
    const out = [];
    let lastStage = null; // {line, t}
    for (let i = 0; i < off.executed.length; i++) {
      const e = off.executed[i];
      if (!e || e.skipped || e.ignored) continue;
      const tc = (e.actions || []).find((a) => a.kind === 'toolchange');
      if (tc) {
        const b = blockAt(ctx, e.line);
        const ownT = b ? b.words.find((w) => !w.comma && w.addr === 'T') : null;
        const staged = e.before.toolStaged;
        if (ownT && staged != null && staged !== tc.tool) {
          out.push(diag('R29', e.line, 'warning',
            `前面第 ${lastStage ? lastStage.line : '?'} 行預選的是 T${staged}，這裡卻換 T${tc.tool}`, {
              detail: `刀庫已經先把 T${staged} 轉到待機位置，這裡的 M6 卻指定 T${tc.tool}，刀庫必須再轉一次，換刀時間會拉長；`
                + `更常見的情況是其中一個號碼打錯，結果換到不對的刀。\n`
                + `建議：讓前一個作業裡預選的 T 號和下一個 M6 的 T 號一致。`,
            }));
        }
        if (tc.tool != null && e.before.toolInSpindle === tc.tool) {
          out.push(diag('R29', e.line, 'info',
            `T${tc.tool} 本來就在主軸上，這個 M6 會把同一把刀再換一次`, {
              detail: '同一把刀連做兩個作業時，中間常會為了「回到已知狀態」再下一次 M6。Fanuc 會照做（把刀放回刀庫再拿出來），不會出錯，只是多花十幾秒，而且刀具重新夾持後跳動可能不一樣。\n'
                + '如果本來就是刻意要重新換刀，忽略這條即可；如果只是想重設補正，用 G43 H… 就夠了，不需要 M6。',
            }));
        }
        lastStage = null;
        continue;
      }
      if (e.before.toolStaged !== e.after.toolStaged && e.after.toolStaged != null) {
        lastStage = { line: e.line, t: e.after.toolStaged };
      }
    }
    const finalStaged = off.finalState ? off.finalState.toolStaged : null;
    if (finalStaged != null && lastStage) {
      out.push(diag('R29', lastStage.line, 'info',
        `程式最後預選了 T${finalStaged}，但後面沒有 M6 把它換上來`, {
          detail: '這通常是刻意的：程式跑完先把下一支程式（或常用的第一把刀）轉到待機位置，下次開工可以少等一次刀庫。\n'
            + `請確認 T${finalStaged} 真的是你希望留在待機位的刀；如果是打錯字，下一支程式的第一次換刀會多轉一次刀庫。`,
        }));
    }
    return out;
  }

  // ===========================================================================
  // R30 — 刀庫（只有 settings.magazine 存在時才檢查）
  // ===========================================================================
  function checkR30(ctx) {
    const st = settingsOf(ctx);
    const mag = st.magazine;
    const off = runOf(ctx, 'off');
    if (!mag || !off) return [];
    const out = [];
    const used = [];
    for (const e of (off.executed || [])) {
      if (!e || e.skipped || e.ignored) continue;
      for (const a of (e.actions || [])) {
        if (a.kind === 'toolchange' && a.tool != null && !used.some((u) => u.t === a.tool)) used.push({ t: a.tool, line: e.line });
      }
    }
    const size = (typeof mag.size === 'number' && mag.size > 0) ? mag.size : null;
    for (const u of used) {
      if (size != null && (u.t < 1 || u.t > size)) {
        out.push(diag('R30', u.line, 'error',
          `T${u.t} 超出刀庫範圍（刀庫只有 ${size} 個刀位）`, {
            detail: `刀庫設定是 1～${size} 號。指定不存在的刀號，換刀時機台會直接警報停下來。\n建議：確認刀號有沒有打錯，或更新刀庫設定。`,
            fanucAlarm: 'PS0116',
          }));
      }
    }
    const pots = mag.pots && typeof mag.pots === 'object' ? mag.pots : null;
    if (pots) {
      const byPot = new Map();
      for (const u of used) {
        const pot = pots[u.t] != null ? pots[u.t] : pots['T' + u.t];
        if (pot == null) {
          out.push(diag('R30', u.line, 'warning', `刀庫清單裡沒有 T${u.t} 的位置`, {
            detail: `這支程式會換 T${u.t}，但刀庫設定裡找不到它。可能是刀還沒裝上去，或刀庫資料沒更新。\n建議：上機前確認 T${u.t} 已經裝進刀庫。`,
          }));
          continue;
        }
        if (byPot.has(pot)) {
          out.push(diag('R30', u.line, 'error',
            `T${u.t} 和 T${byPot.get(pot).t} 被登記在同一個刀位（第 ${pot} 號）`, {
              detail: '同一個刀位不可能同時放兩把刀，換刀時一定會拿錯。\n建議：更正刀庫設定。',
            }));
        } else byPot.set(pot, u);
      }
    }
    // 大徑刀與相鄰刀位互撞。
    // 這是現場真的發生過的事故（大直徑面銑刀和隔壁刀位的刀在刀庫裡互撞、刀子飛出來），
    // 而且程式本身完全看不出來——只有把「哪把刀在哪個刀位」和刀徑對起來才抓得到。
    if (pots) {
      const bigDia = (typeof mag.largeToolDiameter === 'number' && mag.largeToolDiameter > 0)
        ? mag.largeToolDiameter : null;
      const span = (typeof mag.largeToolNeighbors === 'number' && mag.largeToolNeighbors > 0)
        ? Math.floor(mag.largeToolNeighbors) : 1;
      const potOf = (t) => (pots[t] != null ? pots[t] : pots['T' + t]);
      const occupant = new Map();               // 刀位 → 刀號（刀庫裡所有登記的刀，不只本程式用到的）
      for (const key of Object.keys(pots)) {
        const t = Number(String(key).replace(/^T/i, ''));
        const pot = pots[key];
        if (Number.isFinite(t) && pot != null) occupant.set(Number(pot), t);
      }
      const diaOf = (t) => {
        const tool = toolListOf(ctx).find((x) => x && x.t === t);
        return (tool && tool.diameter > 0) ? tool.diameter : null;
      };
      if (bigDia != null) {
        for (const u of used) {
          const dia = diaOf(u.t);
          const pot = potOf(u.t);
          if (dia == null || pot == null || dia < bigDia) continue;
          for (let k = 1; k <= span; k++) {
            for (const nb of [Number(pot) - k, Number(pot) + k]) {
              // 刀庫是環狀的：第 1 號的前一個是最後一號
              const p = (size != null) ? ((nb - 1 + size * 2) % size) + 1 : nb;
              const other = occupant.get(p);
              if (other == null || other === u.t) continue;
              const od = diaOf(other);
              out.push(diag('R30', u.line, 'error',
                `T${u.t}（Ø${U.fmt(dia)}）在第 ${pot} 號刀位，隔壁第 ${p} 號放了 T${other}${od ? `（Ø${U.fmt(od)}）` : ''}`, {
                  detail: `刀徑 ${U.fmt(dia)} mm 已達「大徑刀」門檻（設定為 ${U.fmt(bigDia)} mm），`
                    + `依設定相鄰 ${span} 個刀位必須淨空。\n`
                    + '大徑刀和隔壁刀位的刀在刀庫旋轉或換刀時會互撞，可能把刀撞飛——這是程式本身看不出來的問題。\n'
                    + `建議：把 T${other} 移到別的刀位，或把 T${u.t} 移到兩側都空著的刀位；`
                    + '機台若有「大徑刀」設定功能也要一併登記。',
                }));
            }
          }
        }
      }
    }
    if (Array.isArray(mag.resident)) {
      for (const tool of toolListOf(ctx)) {
        if (!tool || !tool.resident) continue;
        if (mag.resident.indexOf(tool.t) >= 0) continue;
        const u = used.find((x) => x.t === tool.t);
        out.push(diag('R30', u ? u.line : 0, 'info',
          `T${tool.t} 在刀具表裡標成常駐刀，但刀庫設定的常駐清單裡沒有它`, {
            detail: '常駐刀是跨程式共用、不會拆下來的刀（例如面銑刀）。清單對不起來時，換班的人可能會把它拆走。\n建議：兩邊對一下。',
          }));
      }
    }
    return out;
  }

  // ===========================================================================
  // R31 — 刀具推定的衝突與空刀位
  // ===========================================================================
  function checkR31(ctx) {
    const off = runOf(ctx, 'off');
    if (!off || !ctx.tok) return [];
    const out = [];
    let details = null;
    try {
      if (NC.tools && NC.tools.inferDetails) details = NC.tools.inferDetails(ctx.tok, off);
    } catch (err) { details = null; }
    if (!details) return [];
    const typeName = (t) => {
      if (!t || t === 'unknown') return '不確定的型式';
      return (NC.tools && NC.tools.TYPE_NAMES && NC.tools.TYPE_NAMES[t]) || String(t);
    };
    for (const d of details) {
      const tool = findTool(ctx, d.t);
      if (d.conflict) {
        out.push(diag('R31', d.line, 'warning',
          `T${d.t} 的註解寫「${d.comment}」（看起來是${typeName(d.commentType)}），但程式裡的動作像${typeName(d.motionType)}`, {
            detail: `刀具表會以註解為準（型式：${typeName(d.commentType)}），但模擬時的刀具形狀可能就不對，切削量與碰撞判斷都會失準。\n`
              + '建議：確認註解有沒有打錯，或直接在刀具表裡把型式和直徑改成正確的值。',
          }));
        continue;
      }
      const isProbe = tool ? !!tool.probe : (!d.comment && !d.hasCut);
      if (isProbe) {
        out.push(diag('R31', d.line, 'info',
          `T${d.t} 沒有註解、程式裡也沒有任何切削動作，推測是空的刀位`, {
            detail: '這不是錯誤，只是提醒：常見的用法是刻意選一個沒用到的刀位裝定位器／量測棒，換上去量距離或對刀。\n'
              + `刀具表裡 T${d.t} 沒有型式和直徑可以推定，模擬時會用 Ø10 的圓盤代替（不會切到材料，也不會影響成品）。\n`
              + `如果 T${d.t} 其實有切削，請在刀具表補上型式與直徑；如果只是拿來換到定位器的位置，這樣就對了。`,
          }));
      }
    }
    return out;
  }

  // ===========================================================================
  // R33 — 軟極限（只有 settings.softLimits 存在時才檢查）
  // ===========================================================================
  function checkR33(ctx) {
    const st = settingsOf(ctx);
    const lim = st.softLimits;
    if (!lim || !lim.min || !lim.max) return [];
    const geo = geoOf(ctx, 'off');
    if (!geo || !geo.segments) return [];
    const out = [];
    const axes = [
      { k: 'x', name: 'X' },
      { k: 'y', name: 'Y' },
      { k: 'z', name: 'Z' },
    ];
    const worst = new Map(); // 'X+' → {over, line, pos}
    const note = (axis, dir, over, line, pos) => {
      const key = axis + dir;
      const cur = worst.get(key);
      if (!cur || over > cur.over) worst.set(key, { over, line, pos, axis, dir });
    };
    const test = (pt, line) => {
      for (const a of axes) {
        const v = pt[a.k];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        if (v > lim.max[a.k] + 1e-6) note(a.name, '+', v - lim.max[a.k], line, pt);
        else if (v < lim.min[a.k] - 1e-6) note(a.name, '-', lim.min[a.k] - v, line, pt);
      }
    };
    for (const seg of geo.segments) {
      if (!seg) continue;
      if (seg.arc && NC.geometry && NC.geometry.sampleSegment) {
        let pts = null;
        try { pts = NC.geometry.sampleSegment(seg, 0.2); } catch (err) { pts = null; }
        if (pts) { for (const p of pts) test(p, seg.line); continue; }
      }
      test(seg.from, seg.line);
      test(seg.to, seg.line);
    }
    for (const w of worst.values()) {
      out.push(diag('R33', w.line, 'error',
        `路徑超出 ${w.axis} 軸${w.dir === '+' ? '正' : '負'}向軟極限 ${f(w.over)} mm`, {
          detail: `這個位置是 ${p3(w.pos)}，${w.axis} 軸的軟極限設定是 ${f(lim.min[w.axis.toLowerCase()])} ～ ${f(lim.max[w.axis.toLowerCase()])}（工件座標）。\n`
            + '真機跑到這裡會發行程超極限警報並急停，程式會停在半路，刀具還埋在工件裡。\n'
            + '建議：檢查工件原點設定，或把這一段路徑改到行程內。（軟極限值是設定裡輸入的，若和機台不符請先更新設定。）',
          fanucAlarm: 'OT0500',
          pos: U.clone3(w.pos),
        }));
    }
    return out;
  }

  // ===========================================================================
  // R34 — 重複層偏離
  // ===========================================================================
  function blockSig(b) {
    if (!b || b.isEmpty || !b.words || !b.words.length) return null;
    const parts = b.words.map((w) => {
      const a = (w.comma ? ',' : '') + w.addr;
      if (a === 'Z') return 'Z*';
      return a + U.round(w.value, 4);
    });
    parts.sort();
    return parts.join(' ');
  }
  function zOfBlock(b) {
    if (!b || !b.words) return null;
    const w = b.words.find((x) => !x.comma && x.addr === 'Z');
    return w ? w.value : null;
  }
  function checkR34(ctx) {
    const off = runOf(ctx, 'off');
    if (!off) return [];
    const out = [];
    const usedLines = new Set();
    for (const op of (off.ops || [])) {
      if (!op || op.lineEnd - op.lineStart < 12) continue;
      const items = [];
      for (let line = op.lineStart; line <= op.lineEnd; line++) {
        const b = blockAt(ctx, line);
        const sig = blockSig(b);
        if (sig == null) continue;
        items.push({ line, sig, b });
      }
      if (items.length < 12) continue;

      const bySig = new Map();
      items.forEach((it, idx) => { const arr = bySig.get(it.sig); if (arr) arr.push(idx); else bySig.set(it.sig, [idx]); });
      let best = null;
      for (const [sig, idxs] of bySig) {
        if (idxs.length < 5) continue;
        if (sig.indexOf('Z*') < 0) continue; // 層的起點一定是「設定這一層深度」的那一節
        // 深度要真的有變化，否則像 G0Z5. 這種每層都一樣的抬刀節也會被當成層起點
        const zs = idxs.map((idx) => zOfBlock(items[idx].b)).filter((v) => v != null);
        if (new Set(zs.map((v) => U.round(v, 4))).size < 3) continue;
        const lens = [];
        for (let k = 0; k + 1 < idxs.length; k++) lens.push(idxs[k + 1] - idxs[k]);
        const m = modeOf(lens);
        if (!(m.value >= 2)) continue;
        if (m.count < 4) continue;
        // 層長度要夠一致：出現 1～2 次的長度算「孤例」（值得報），孤例太多就代表這一段
        // 根本不是分層結構，只是剛好有幾節長得像，不要硬套。
        let odd = 0, oddLayers = 0;
        for (const [len, c] of m.map) { if (c <= 2 && len !== m.value) { odd++; oddLayers += c; } }
        if (odd > 3 || oddLayers > lens.length * 0.25) continue;
        if (!best || m.count > best.modalCount) best = { sig, idxs, modalLen: m.value, modalCount: m.count };
      }
      if (!best || best.modalCount < 4) continue;

      const layers = [];
      for (let k = 0; k + 1 < best.idxs.length; k++) {
        layers.push({ i0: best.idxs[k], i1: best.idxs[k + 1] - 1, len: best.idxs[k + 1] - best.idxs[k] });
      }
      const zLadder = best.idxs.map((idx) => zOfBlock(items[idx].b));
      const steps = [];
      for (let k = 0; k + 1 < zLadder.length; k++) {
        if (zLadder[k] == null || zLadder[k + 1] == null) continue;
        steps.push(U.round(zLadder[k + 1] - zLadder[k], 4));
      }
      const stepMode = modeOf(steps);
      const irregular = [];
      for (let k = 0; k < steps.length; k++) {
        if (steps[k] !== stepMode.value) irregular.push({ from: best.idxs[k], to: best.idxs[k + 1], step: steps[k] });
      }

      const startLine = items[best.idxs[0]].line;
      usedLines.add(startLine);
      out.push(diag('R34', startLine, 'info',
        `這一段是 ${best.idxs.length} 層重複的加工（每層約 ${best.modalLen} 節），Z 從 ${f(Math.max.apply(null, zLadder.filter((v) => v != null)))} 一路做到 ${f(Math.min.apply(null, zLadder.filter((v) => v != null)))}`, {
          detail: `層起點都是「${items[best.idxs[0]].b.text}」這種節，深度依序是：${zLadder.map(f).join('、')}。\n`
            + (stepMode.value != null ? `多數層的深度間隔是 ${f(stepMode.value)} mm。\n` : '')
            + (irregular.length
              ? `間隔不一樣的地方：${irregular.map((g) => `第 ${items[g.from].line} 行 → 第 ${items[g.to].line} 行 差 ${f(g.step)} mm`).join('；')}。請確認是刻意的還是漏了一層。\n`
              : '每一層的間隔都一樣。\n')
            + '這條只是把分層結構整理出來給你對照，不是錯誤。',
        }));

      // (a) 某一層的長度和其他層不同
      const lenMode = modeOf(layers.map((l) => l.len));
      const commonLens = [];
      for (const [len, c] of lenMode.map) if (c > 2) commonLens.push(len);
      commonLens.sort((a, b) => a - b);
      for (const l of layers) {
        if (l.len === lenMode.value) continue;
        if ((lenMode.map.get(l.len) || 0) > 2) continue; // 出現好幾次 = 刻意的變化
        const line = items[l.i0].line;
        if (usedLines.has(line)) continue;
        usedLines.add(line);
        out.push(diag('R34', line, 'info',
          `這一層有 ${l.len} 節，其他層是 ${commonLens.join(' 或 ')} 節`, {
            detail: `第 ${items[l.i0].line}–${items[l.i1].line} 行這一層的節數和其他層對不起來。\n`
              + '常見原因：某一層多寫或漏寫了一節（例如多了一次抬刀、漏了 F），或是這裡其實已經換成別的特徵、不再是同一組層了。\n'
              + '建議：把這一層和上下相鄰的層對照一次。',
          }));
      }

      // (b) 同一個位置的內容和其他層不同（只報「孤例」，重複出現的視為刻意變更）
      const full = layers.filter((l) => l.len === lenMode.value);
      if (full.length >= 5) {
        for (let q = 1; q < lenMode.value; q++) {
          const sigs = full.map((l) => items[l.i0 + q].sig);
          const m = modeOf(sigs);
          if (m.count < 5) continue;
          const sample = items[full[sigs.indexOf(m.value)].i0 + q];
          for (let li = 1; li < full.length; li++) { // 第一層常會多帶 F／S，不算偏離
            if (sigs[li] === m.value) continue;
            if ((m.map.get(sigs[li]) || 0) > 2) continue;
            const it = items[full[li].i0 + q];
            if (usedLines.has(it.line)) continue;
            usedLines.add(it.line);
            out.push(diag('R34', it.line, 'info',
              `這一行和其他 ${m.count} 層的同一個位置不一樣：其他層是「${sample.b.text}」，這裡是「${it.b.text}」`, {
                detail: `這一段有 ${full.length} 層寫法一模一樣（Z 值除外），只有這一層在第 ${q + 1} 節不同。\n`
                  + '重複層裡的單一例外，多半不是打錯字就是刻意留的特例（例如最後一層要走長一點、或某一層要換進給）。\n'
                  + '建議：對照上下相鄰的層確認一下。',
              }));
          }
        }
      }
    }
    return out;
  }

  // ===========================================================================
  // R35 — 切削參數合理性
  // ===========================================================================
  function checkR35(ctx) {
    const off = runOf(ctx, 'off');
    if (!off) return [];
    const out = [];
    const top = topZ(ctx);

    for (const op of (off.ops || [])) {
      if (!op || op.tool == null) continue;
      const tool = findTool(ctx, op.tool);
      if (!tool) continue;
      const dia = (typeof tool.diameter === 'number' && tool.diameter > 0) ? tool.diameter : null;
      const goodRpms = (op.rpms || []).filter((v) => typeof v === 'number' && v > 0);
      const rpm = goodRpms.length ? Math.max.apply(null, goodRpms) : null;
      const label = toolLabel(ctx, op.tool);

      // 切削速度 Vc（絲攻不適用：攻牙轉速本來就低）
      if (dia && rpm && tool.type !== 'tap') {
        const vc = Math.PI * dia * rpm / 1000;
        if (vc > 400) {
          out.push(diag('R35', op.lineStart, 'info',
            `${label} 的切削速度偏高：Ø${f(dia)} × S${rpm} ≈ Vc ${Math.round(vc)} m/min`, {
              detail: '一般碳鋼／不鏽鋼用碳化鎢刀具大約 60～250 m/min，鋁合金才會到 400 以上。\n'
                + '請確認材質和刀具等級；轉速太高在不鏽鋼上會很快磨損刀刃。',
            }));
        } else if (vc < 8) {
          out.push(diag('R35', op.lineStart, 'info',
            `${label} 的切削速度偏低：Ø${f(dia)} × S${rpm} ≈ Vc ${f(vc)} m/min`, {
              detail: '轉速太低容易產生積屑瘤、表面會很粗糙，刀具反而更容易崩。\n請確認轉速是不是少打了一個零。',
            }));
        }
      }
      // 每轉進給
      if (rpm && op.feeds && op.feeds.length) {
        const fprs = op.feeds.filter((v) => v > 0).map((v) => v / rpm);
        if (fprs.length) {
          const hi = Math.max.apply(null, fprs), lo = Math.min.apply(null, fprs);
          if (hi > 1.0) {
            out.push(diag('R35', op.lineStart, 'info',
              `${label} 的每轉進給偏大：最大 F${Math.round(hi * rpm)} ÷ S${rpm} ≈ ${f(hi)} mm/rev`, {
                detail: '銑削的每轉進給通常在 0.05～0.6 mm/rev 之間（看刃數）。太大容易崩刃或悶車。\n請確認 F 值和 S 值有沒有寫錯。',
              }));
          } else if (lo < 0.005) {
            out.push(diag('R35', op.lineStart, 'info',
              `${label} 的每轉進給偏小：最小 F${Math.round(lo * rpm)} ÷ S${rpm} ≈ ${f(lo)} mm/rev`, {
                detail: '進給太小刀刃會用「磨」的而不是「切」的，加工硬化嚴重的材料（例如不鏽鋼）反而更傷刀。\n請確認 F 值是不是少打了。',
              }));
          }
        }
      }
      // 切削深度 vs 刃長／伸出長，以及銑削的長徑比
      if (dia && op.zMin != null && op.zMin < 0 && op.kindGuess !== 'drill' && op.kindGuess !== 'tap' && op.kindGuess !== 'ream') {
        const depth = -op.zMin;
        const ld = depth / dia;
        const flute = (typeof tool.fluteLen === 'number' && tool.fluteLen > 0) ? tool.fluteLen : null;
        const fluteIsUser = !!(tool.source && tool.source.fluteLen === 'user');
        const tooDeep = flute != null && depth > flute + 1e-6;
        // 刃長不夠代表夾頭／刀柄會磨到工件，是現場最貴的那一類撞機，
        // 而且是「工具知道、人不一定會算」的事。長徑比沒有超過 6 的刀一樣會不夠長
        // （Ø10 倒角刀切到 Z-47，長徑比 4.7 出頭，以前完全沒有提示）。
        if (tooDeep && (fluteIsUser || !(ld > 6))) {
          if (fluteIsUser) {
            out.push(diag('R35', op.lineStart, 'error',
              `${label} 要切到 Z${f(op.zMin)}（深 ${f(depth)} mm），但刀具表登記的刃長只有 ${f(flute)} mm，差 ${f(depth - flute)} mm`, {
                detail: '刃長不足時，刀柄（無刃部分）會磨到工件側壁，輕則表面刮傷、重則刀柄斷裂、夾頭撞到工件。\n'
                  + '建議：換長刃刀、或分兩把刀（先短刀粗銑再換長刀），也可以把工件翻面加工。',
              }));
          } else {
            out.push(diag('R35', op.lineStart, 'needsInput',
              `${label} 要切到 Z${f(op.zMin)}（深 ${f(depth)} mm），可能比刀刃還長——請在刀具表填上 T${op.tool} 的實際刃長`, {
                detail: `目前刀具表裡的刃長是用「刀徑 × 3 = ${f(flute)} mm」推估的，不是真的量出來的，\n`
                  + '所以工具沒辦法確定這把刀構不構得到 Z' + f(op.zMin) + '。\n'
                  + '要確定，請填兩個數字：(1) 刃長（有切刃的那一段長度）、(2) 伸出長（刀尖到夾頭端面的長度）。\n'
                  + '填好之後這一條會重算：刃長不夠會變成紅字，夠的話就不再提醒。',
              }));
          }
        }
        if (ld > 6 && !(tooDeep && fluteIsUser)) {
          out.push(diag('R35', op.lineStart, 'warning',
            `${label} 要切到 Z${f(op.zMin)}，深度是刀徑的 ${f(ld)} 倍（Ø${f(dia)} 切 ${f(depth)} mm 深）`, {
              detail: `長徑比超過 6 的刀很容易讓刀（尺寸縮水）、振刀（表面有紋路），也容易斷。\n`
                + (fluteIsUser ? '' : `刀具表裡 T${op.tool} 的刃長目前是推估值（Ø×3），不能拿來判斷夠不夠。\n`)
                + '建議：在刀具表填上實際刃長與伸出長，並確認排屑與轉速／進給有沒有跟著降。',
            }));
        }
      }
    }

    // 逐孔檢查：啄鑽次數、鑽孔長徑比、攻牙進給
    const seen = new Set();
    for (const e of (off.executed || [])) {
      if (!e || e.skipped || e.ignored) continue;
      for (const a of (e.actions || [])) {
        if (a.kind !== 'hole') continue;
        const rp = holeR(a);
        const tool = findTool(ctx, e.after.toolInSpindle);
        const dia = (tool && typeof tool.diameter === 'number' && tool.diameter > 0) ? tool.diameter : null;
        const depth = (rp != null && a.z != null) ? (rp - a.z) : null;
        const key = `${a.cycle}|${e.opIndex}`;
        if (seen.has(key)) continue;

        if ((a.cycle === 'G83' || a.cycle === 'G73') && a.q > 0 && depth != null) {
          const pecks = depth / a.q;
          if (pecks > 40) {
            seen.add(key);
            out.push(diag('R35', e.line, 'info',
              `這個孔要啄 ${Math.round(pecks)} 次（深 ${f(depth)} mm ÷ 每次 ${f(a.q)} mm）`, {
                detail: '啄鑽次數太多，光是進退刀就會花掉大部分時間（這一刀的鑽孔時間大約會是連續鑽的 2～3 倍）。\n'
                  + `建議：如果排屑沒問題，可以把 Q 加大（例如 Q${f(Math.max(a.q * 2, dia ? dia * 0.3 : a.q * 2))}）；深孔則考慮改用 G73 高速啄鑽（只退一點點，不回 R 點）。`,
              }));
          }
        }
        if (dia && depth != null && depth / dia > 6 && tool && tool.type !== 'tap') {
          const k2 = `LD|${e.opIndex}`;
          if (!seen.has(k2)) {
            seen.add(k2);
            out.push(diag('R35', e.line, 'warning',
              `${toolLabel(ctx, e.after.toolInSpindle)} 鑽 ${f(depth)} mm 深，是鑽頭直徑的 ${f(depth / dia)} 倍`, {
                detail: '長徑比超過 6 的深孔要特別注意排屑與冷卻，一般鑽頭的排屑槽長度也可能不夠。\n'
                  + '建議：確認鑽頭的有效刃長夠不夠、有沒有內冷卻，並用 G83 分段排屑。',
              }));
          }
        }
        if (tool && tool.type === 'tap' && (a.cycle === 'G84' || a.cycle === 'G74') && tool.pitch > 0) {
          const rpmHere = e.after.spindle ? e.after.spindle.rpm : null;
          const feedHere = a.feed;
          if (rpmHere > 0 && feedHere > 0) {
            const need = (e.after.feedMode === 'G95') ? tool.pitch : tool.pitch * rpmHere;
            const tolF = Math.max(0.5, need * 0.02);
            if (Math.abs(feedHere - need) > tolF) {
              const k3 = `TAP|${e.opIndex}`;
              if (!seen.has(k3)) {
                seen.add(k3);
                out.push(diag('R35', e.line, 'error',
                  `攻牙進給對不上螺距：F${f(feedHere)} 應該要是 ${f(need)}（螺距 ${f(tool.pitch)} × S${rpmHere}）`, {
                    detail: '攻牙時主軸每轉一圈，Z 就必須剛好走一個螺距。進給和轉速對不上，牙就會被拉壞，剛性攻牙還可能直接把絲攻扭斷。\n'
                      + `建議：把這一節的 F 改成 ${f(need)}${e.after.feedMode === 'G95' ? '（G95 每轉進給 = 螺距）' : `（F = 螺距 ${f(tool.pitch)} × 轉速 ${rpmHere}）`}。`,
                    fanucAlarm: undefined,
                  }));
              }
            }
          }
        }
      }
    }
    return out;
  }

  // ===========================================================================
  // R36 — 同一個特徵出現兩個很接近的底面深度
  // ===========================================================================
  function checkR36(ctx) {
    const sim = simOf(ctx, 'off');
    if (!sim || !sim.height) return [];
    const off = runOf(ctx, 'off');
    const h = sim.height, nx = sim.nx, ny = sim.ny;
    const total = h.length;
    if (!(total > 0)) return [];
    const top = topZ(ctx);

    // 高度直方圖（量化到 0.01 mm），只留佔一定面積的「平台」
    const hist = new Map();
    for (let i = 0; i < total; i++) {
      const k = Math.round(h[i] * 100);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    const minCells = Math.max(20, Math.round(total * 0.002));
    const plateau = new Set();
    for (const [k, c] of hist) if (c >= minCells) plateau.add(k);
    if (plateau.size < 2) return [];
    // 只留「真的是平面」的高度：錐面（鑽尖、倒角）也會有很多格落在同一個高度，
    // 但那些格子四周的高度都不一樣。要求同高度的格子成片（四鄰至少 3 個同高）。
    const interior = new Map();
    for (let iy = 1; iy < ny - 1; iy++) {
      for (let ix = 1; ix < nx - 1; ix++) {
        const k = Math.round(h[iy * nx + ix] * 100);
        if (!plateau.has(k)) continue;
        let same = 0;
        if (Math.round(h[iy * nx + ix - 1] * 100) === k) same++;
        if (Math.round(h[iy * nx + ix + 1] * 100) === k) same++;
        if (Math.round(h[(iy - 1) * nx + ix] * 100) === k) same++;
        if (Math.round(h[(iy + 1) * nx + ix] * 100) === k) same++;
        if (same >= 3) interior.set(k, (interior.get(k) || 0) + 1);
      }
    }
    for (const k of Array.from(plateau)) if ((interior.get(k) || 0) < 20) plateau.delete(k);
    if (plateau.size < 2) return [];

    const pairs = new Map();
    const tally = (a, b, ix, iy) => {
      if (a === b) return;
      if (!plateau.has(a) || !plateau.has(b)) return;
      const d = Math.abs(a - b);
      if (d <= 2 || d >= 50) return; // 只看 0.02 ～ 0.50 mm 的落差
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = lo + '|' + hi;
      const rec = pairs.get(key);
      if (rec) rec.count++;
      else pairs.set(key, { lo, hi, count: 1, ix, iy });
    };
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = Math.round(h[iy * nx + ix] * 100);
        if (ix + 1 < nx) tally(a, Math.round(h[iy * nx + ix + 1] * 100), ix, iy);
        if (iy + 1 < ny) tally(a, Math.round(h[(iy + 1) * nx + ix] * 100), ix, iy);
      }
    }
    const out = [];
    for (const rec of pairs.values()) {
      if (rec.count < 8) continue;
      const zHi = rec.hi / 100, zLo = rec.lo / 100;
      // 兩邊都要是「挖出來的底面」；貼著工件頂面的高度差多半是面銑留量（刻意的），不報。
      if (zHi >= Math.min(0, top) - 0.1) continue;
      const x = sim.origin.x + rec.ix * sim.cell;
      const y = sim.origin.y + rec.iy * sim.cell;
      // 找出切到這兩個深度的作業，訊息才講得清楚
      const hiCut = off ? cutAtDepth(ctx, off, zHi) : { tools: [], line: 0 };
      const loCut = off ? cutAtDepth(ctx, off, zLo) : { tools: [], line: 0 };
      const whoHi = hiCut.tools.length ? hiCut.tools.map((t) => toolLabel(ctx, t)).join('、') : null;
      const whoLo = loCut.tools.length ? loCut.tools.map((t) => toolLabel(ctx, t)).join('、') : null;
      out.push(diag('R36', hiCut.line || loCut.line || 0, 'warning',
        `這裡有兩個只差 ${f(zHi - zLo)} mm 的底面（Z${f(zHi)} 和 Z${f(zLo)}），成品上會留下一道小台階`, {
          detail: `位置大約在 ${p2(x, y)} 附近，兩個高度相鄰的格子有 ${rec.count} 處。\n`
            + (whoHi || whoLo ? `切到 Z${f(zHi)} 的是 ${whoHi || '不確定的作業'}（第 ${hiCut.line} 行附近）；切到 Z${f(zLo)} 的是 ${whoLo || '不確定的作業'}（第 ${loCut.line} 行附近）。\n` : '')
            + '同一個面被兩把刀（或兩個作業）用了不一樣的深度時，就會留下這種肉眼看不太出來、但量得到的台階。常見原因是精修的 Z 值打錯了一位，或粗銑留的餘量沒有被精修完全清掉。\n'
            + '建議：確認這兩個深度是不是刻意的（例如刻意留階梯）；如果應該是同一個面，把兩邊的 Z 值改成一樣。',
          pos: { x, y, z: zHi },
        }));
    }
    return out;
  }

  // ===========================================================================
  // registry / run
  // ===========================================================================
  /** @type {Array<{id:string,title:string,severity:string,phase:string,check:Function}>} */
  const registry = [
    { id: 'R05', title: '節首多斜線', severity: 'warning', phase: 'run', check: checkR05 },
    { id: 'R06', title: 'block skip 開／關的差異', severity: 'error', phase: 'cross', check: checkR06 },
    { id: 'R07', title: '被跳過的節含模態字', severity: 'error', phase: 'cross', check: checkR07 },
    { id: 'R14', title: 'D／H 補正號和刀號不一致', severity: 'info', phase: 'run', check: checkR14 },
    { id: 'R15', title: 'D 值和刀徑對不起來', severity: 'warning', phase: 'run', check: checkR15 },
    { id: 'R19', title: '固定循環的模態延續與逐孔統計', severity: 'info', phase: 'run', check: checkR19 },
    { id: 'R20', title: 'R 點落在材料裡面', severity: 'warning', phase: 'sim', check: checkR20 },
    { id: 'R24', title: 'G91 增量區段', severity: 'warning', phase: 'run', check: checkR24 },
    { id: 'R25', title: '主軸與切削液', severity: 'error', phase: 'run', check: checkR25 },
    { id: 'R26', title: 'G05.1 AI 輪廓控制', severity: 'warning', phase: 'run', check: checkR26 },
    { id: 'R29', title: 'T 預選與換刀的一致性', severity: 'warning', phase: 'run', check: checkR29 },
    { id: 'R30', title: '刀庫', severity: 'error', phase: 'run', check: checkR30 },
    { id: 'R31', title: '刀具推定的衝突與空刀位', severity: 'warning', phase: 'run', check: checkR31 },
    { id: 'R33', title: '軟極限', severity: 'error', phase: 'geometry', check: checkR33 },
    { id: 'R34', title: '重複層偏離', severity: 'info', phase: 'run', check: checkR34 },
    { id: 'R35', title: '切削參數合理性', severity: 'warning', phase: 'run', check: checkR35 },
    { id: 'R36', title: '同一特徵出現多個底面深度', severity: 'warning', phase: 'sim', check: checkR36 },
  ];

  const PHASES = ['run', 'geometry', 'sim', 'cross'];
  const PRE_SIM_PHASES = ['run', 'geometry'];
  const SIM_PHASES = ['sim', 'cross'];

  /**
   * 跑規則。
   * @param {Object} ctx {tok, scenarios, toolTable, stock, settings}
   * @param {{phases?:string[]}} [opts]
   * @returns {Array} Diagnostic[]
   */
  function run(ctx, opts) {
    if (!ctx || !ctx.scenarios || !ctx.scenarios.off) return [];
    const st = settingsOf(ctx);
    const disabled = new Set(Array.isArray(st.disabledRules) ? st.disabledRules : []);
    const phases = (opts && Array.isArray(opts.phases)) ? opts.phases : null;
    const out = [];
    for (const rule of registry) {
      if (disabled.has(rule.id)) continue;
      if (phases && phases.indexOf(rule.phase) < 0) continue;
      let items;
      try {
        items = rule.check(ctx) || [];
      } catch (err) {
        out.push(diag(rule.id, 0, 'info', `規則 ${rule.id}（${rule.title}）執行時發生內部錯誤，這條檢查被略過`, {
          detail: String((err && err.stack) || err),
        }));
        continue;
      }
      for (const d of items) if (d) out.push(d);
    }
    return out;
  }

  NC.rules = { registry, run, PHASES, PRE_SIM_PHASES, SIM_PHASES };
})(globalThis.NC = globalThis.NC || {});
