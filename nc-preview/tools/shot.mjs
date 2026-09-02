/*
 * 用 Chrome/Edge headless（CDP）對 index.html 截圖，並收集 console 訊息與未捕捉例外。
 * 不需要 npm：只用 Node 22 內建的 fetch 與 WebSocket。
 *
 * 用法（在 nc-preview 目錄下）：
 *   node tools/shot.mjs                       四個範例各截一張到 test/shot-<id>.png
 *   node tools/shot.mjs demo-plate               只截一個
 *   node tools/shot.mjs demo-plate:mode=sectionX&tab=diag   自訂 hash
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const exe = CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) { console.error('找不到 Chrome/Edge'); process.exit(1); }

// 視窗大小可用環境變數蓋掉（手機版驗證：NCSHOT_W=390 NCSHOT_H=844）
const W = Number(process.env.NCSHOT_W) || 1680;
const H = Number(process.env.NCSHOT_H) || 1050;
const PORT = 9333 + (process.pid % 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ncshot-'));
const child = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files', '--force-device-scale-factor=1',
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

let nextId = 1;
function rpc(ws, method, params, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const on = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id !== id) return;
      ws.removeEventListener('message', on);
      m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) { /* 還沒起來 */ }
    await sleep(100);
  }
  throw new Error('CDP 沒有回應');
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(new Error('WS 連不上')));
  });
}

const args = process.argv.slice(2);
const specs = (args.length ? args : ['demo-drill', 'demo-tap', 'demo-plate', 'demo-pocket']).map((a) => {
  const i = a.indexOf(':');
  return i < 0 ? { id: a, extra: '' } : { id: a.slice(0, i), extra: a.slice(i + 1) };
});

const wsUrl = await browserWs();
const ws = await openWs(wsUrl);
const results = [];

for (const spec of specs) {
  const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  const logs = [];
  const onMsg = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
      logs.push({ level: m.params.type, text: txt });
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push({ level: 'exception', text: (d.exception && (d.exception.description || d.exception.value)) || d.text });
    } else if (m.method === 'Log.entryAdded') {
      logs.push({ level: m.params.entry.level, text: m.params.entry.text + ' ' + (m.params.entry.url || '') });
    }
  };
  ws.addEventListener('message', onMsg);
  await rpc(ws, 'Runtime.enable', {}, sessionId);
  await rpc(ws, 'Log.enable', {}, sessionId);
  await rpc(ws, 'Page.enable', {}, sessionId);
  await rpc(ws, 'Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W <= 800 }, sessionId);

  const hash = '#sample=' + encodeURIComponent(spec.id) + (spec.extra ? '&' + spec.extra : '');
  const url = pathToFileURL(path.join(ROOT, 'index.html')).href + hash;
  await rpc(ws, 'Page.navigate', { url }, sessionId);

  // 等到分析＋模擬跑完（狀態列不再顯示「模擬中」且有結果），最多 60 秒
  let state = null;
  for (let i = 0; i < 300; i++) {
    await sleep(200);
    const r = await rpc(ws, 'Runtime.evaluate', {
      expression: `(() => { const a = window.NC && NC.ui && NC.ui.app; if (!a) return null;
        const sr = a.state.result && a.state.result.scenarios[a.state.scenario];
        return JSON.stringify({ text: document.getElementById('statusText').textContent,
          has: !!a.state.result, sim: !!(sr && sr.sim), diag: a.state.result ? a.state.result.diagnostics.length : 0,
          tools: a.state.result ? a.state.result.toolTable.tools.length : 0,
          segs: sr ? sr.geometry.segments.length : 0 }); })()`,
      returnByValue: true,
    }, sessionId);
    const v = r.result && r.result.value;
    if (v) { state = JSON.parse(v); if (state.has && state.sim && !/模擬中/.test(state.text)) break; }
  }
  await sleep(400);
  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  const file = path.join(ROOT, 'test', `shot-${spec.id.replace(/[^\w.-]/g, '_') || 'main'}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  ws.removeEventListener('message', onMsg);
  await rpc(ws, 'Target.closeTarget', { targetId });
  results.push({ spec, file, state, logs });
  console.log(`--- ${spec.id}${spec.extra ? ' [' + spec.extra + ']' : ''} → ${path.basename(file)}`);
  console.log('    狀態:', state ? JSON.stringify(state) : '（沒抓到）');
  const bad = logs.filter((l) => ['error', 'exception', 'warning'].includes(l.level));
  console.log('    console:', logs.length, '則；error/exception:', bad.length);
  for (const l of bad.slice(0, 12)) console.log(`      [${l.level}] ${l.text.slice(0, 300)}`);
}

ws.close();
child.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
const totalBad = results.reduce((n, r) => n + r.logs.filter((l) => ['error', 'exception'].includes(l.level)).length, 0);
console.log('\n完成：', results.length, '張；error/exception 共', totalBad, '則');
process.exit(0);
