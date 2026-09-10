/*
 * 產生 QR code SVG（純自製、不連外）。
 *
 * 為什麼不用線上 QR 服務：有些服務給的是「經過它們網站轉址」的網址，試用期過了
 * 就要付費才能繼續導向；而且每次產圖都要連外。這支自己算，SVG 裡編的就是你給的
 * 字串，跑完會反解一次印出來給你看——外面的服務沒辦法讓你確認它到底編了什麼。
 *
 * 用法：
 *   node tools/make-qr.mjs "https://example.com" img/out.svg [模組像素]
 *
 * 支援 byte mode、錯誤更正等級 M、version 1–3（單一區塊，最多 42 個字元）。
 * 這裡只拿來做短網址，超過就報錯，不做多區塊交錯。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// GF(256)：QR 用的既約多項式是 0x11D
// ---------------------------------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

/** Reed-Solomon 產生多項式（次數 = ec 碼字數）；index 0 是最高次係數 */
function rsGenPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                      // ×x
      next[j + 1] ^= gmul(poly[j], EXP[i]);    // ×α^i
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  const buf = new Uint8Array(data.length + ecLen);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (!factor) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gmul(gen[j], factor);
  }
  return buf.slice(data.length);
}

// version → 模組邊長、資料碼字數(M)、ec 碼字數(M)、對齊圖案中心座標
const VERSIONS = {
  1: { size: 21, data: 16, ec: 10, align: [] },
  2: { size: 25, data: 28, ec: 16, align: [6, 18] },
  3: { size: 29, data: 44, ec: 26, align: [6, 22] },
};

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 資料放置與讀取共用的 zigzag 走訪：由右下往上，兩欄一組（跳過第 6 欄的時序） */
function* zigzag(N, reserved) {
  let up = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < N; k++) {
      const row = up ? N - 1 - k : k;
      for (const c of [col, col - 1]) if (!reserved[row][c]) yield [row, c];
    }
    up = !up;
  }
}

/**
 * 功能圖案（定位、時序、對齊、暗模組、格式資訊佔位）與「哪些格不能放資料」。
 * 編碼與解碼共用同一份佈局——解碼別人的圖時也要知道哪些格要跳過。
 */
function functionPatterns(version) {
  const V = VERSIONS[version];
  const N = V.size;
  const mod = Array.from({ length: N }, () => new Array(N).fill(null));   // null = 還沒放
  const set = (r, c, v) => { if (r >= 0 && r < N && c >= 0 && c < N) mod[r][c] = v; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(r0 + r, c0 + c, dark ? 1 : 0);
      }
    }
  };
  finder(0, 0); finder(0, N - 7); finder(N - 7, 0);

  for (let i = 8; i < N - 8; i++) {                 // 時序圖案
    const v = i % 2 === 0 ? 1 : 0;
    mod[6][i] = v; mod[i][6] = v;
  }
  for (const r of V.align) {                        // 對齊圖案（避開三個定位圖案）
    for (const c of V.align) {
      if ((r === 6 && c === 6) || (r === 6 && c === N - 7) || (r === N - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          set(r + dr, c + dc, dark ? 1 : 0);
        }
      }
    }
  }
  mod[N - 8][8] = 1;                                // 固定的暗模組
  for (let i = 0; i < 9; i++) {                     // 格式資訊的位置先佔起來
    if (mod[8][i] === null) mod[8][i] = 0;
    if (mod[i][8] === null) mod[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (mod[8][N - 1 - i] === null) mod[8][N - 1 - i] = 0;
    if (mod[N - 1 - i][8] === null) mod[N - 1 - i][8] = 0;
  }
  return { mod, reserved: mod.map((row) => row.map((v) => v !== null)) };
}

function encode(text) {
  const bytes = new TextEncoder().encode(text);
  const version = Object.keys(VERSIONS).map(Number).find((v) => bytes.length + 2 <= VERSIONS[v].data);
  if (!version) throw new Error(`字串太長（${bytes.length} bytes），這支只做到 version 3 / 42 字元`);
  const V = VERSIONS[version];
  const N = V.size;

  // ---- 位元流：mode(0100) + 長度(8 bits) + 資料 + 終止符 + 補滿碼字 ----
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < V.data * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    codewords.push(v);
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < V.data; i++) codewords.push(PAD[i % 2]);

  const all = [...codewords, ...rsEncode(Uint8Array.from(codewords), V.ec)];

  const { mod, reserved } = functionPatterns(version);

  // ---- 資料位元填進 zigzag ----
  const dataBits = [];
  for (const cw of all) for (let i = 7; i >= 0; i--) dataBits.push((cw >> i) & 1);
  let idx = 0;
  for (const [r, c] of zigzag(N, reserved)) mod[r][c] = idx < dataBits.length ? dataBits[idx++] : 0;

  // ---- 遮罩：8 種各算懲罰分數，取最低 ----
  let best = null;
  for (let id = 0; id < 8; id++) {
    const m = mod.map((row) => row.slice());
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) if (!reserved[r][c] && MASKS[id](r, c)) m[r][c] ^= 1;
    }
    applyFormat(m, N, id);
    const score = penalty(m, N);
    if (!best || score < best.score) best = { score, m, id };
  }
  return { matrix: best.m, size: N, mask: best.id, version, reserved };
}

/** ECC 等級 M = 00，接 3 bits 遮罩號 → BCH(15,5)（生成多項式 0x537），最後 XOR 0x5412 */
function formatBits(maskId) {
  const v = (0b00 << 3) | maskId;
  let d = v << 10;
  for (let i = 4; i >= 0; i--) if ((d >> (i + 10)) & 1) d ^= 0x537 << i;
  return ((v << 10) | d) ^ 0x5412;
}

/**
 * 15 bits 格式資訊的兩份副本。座標順序照標準（與 nayuki 的參考實作逐格對過）：
 *   第一份：bit0–5 → (0,8)…(5,8) 往下、bit6 → (7,8)、bit7 → (8,8)、bit8 → (8,7)、
 *           bit9–14 → (8,5)…(8,0) 往左。
 *   第二份：bit0–7 → (8,N-1)…(8,N-8) 往左、bit8–14 → (N-7,8)…(N-1,8) 往下。
 * 第二份的縱向那段從 N-7 起跳，(N-8,8) 是固定暗模組不能蓋。
 */
function applyFormat(m, N, maskId) {
  const f = formatBits(maskId);
  const bit = (i) => (f >> i) & 1;
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) m[8][14 - i] = bit(i);
  for (let i = 0; i <= 7; i++) m[8][N - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) m[N - 15 + i][8] = bit(i);
}

function penalty(m, N) {
  let p = 0;
  // 規則 1：同色連續 5 格以上
  for (let i = 0; i < N; i++) {
    for (const line of [m[i], m.map((row) => row[i])]) {
      let run = 1;
      for (let j = 1; j < N; j++) {
        if (line[j] === line[j - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else run = 1;
      }
    }
  }
  // 規則 2：2×2 同色
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
    }
  }
  // 規則 3：1:1:3:1:1 的假定位圖案
  const PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < N; i++) {
    for (const line of [m[i], m.map((row) => row[i])]) {
      for (let j = 0; j + 11 <= N; j++) {
        const seg = line.slice(j, j + 11);
        if (seg.every((v, k) => v === PAT1[k]) || seg.every((v, k) => v === PAT2[k])) p += 40;
      }
    }
  }
  // 規則 4：黑格比例偏離 50%
  let dark = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) dark += m[r][c];
  p += Math.floor(Math.abs((dark * 100) / (N * N) - 50) / 5) * 10;
  return p;
}

/**
 * 解一張 QR 矩陣（0/1 的二維陣列），回傳裡面編的字串。
 *
 * 不限於自己產生的圖——遮罩號是從矩陣裡的格式資訊讀回來的，功能圖案的位置
 * 由 version 重建。這樣就能拿別的產生器做出來的圖來驗自己的實作對不對。
 * 資料沒有損壞時不需要 RS 糾錯，直接讀資料碼字。
 *
 * 限制：只讀第一個 byte 模式的段落。別家產生器常用「混合模式」（例如網址主體用
 * byte 段、結尾的數字另接一個 numeric 段比較省位元），那種圖用這裡解會只讀到前半段。
 * 我們自己只產生單一 byte 段，所以自我驗證不受影響。
 */
function decodeMatrix(matrix) {
  const N = matrix.length;
  const version = Object.keys(VERSIONS).map(Number).find((v) => VERSIONS[v].size === N);
  if (!version) throw new Error(`不支援的尺寸 ${N}×${N}（這支只做到 version 3）`);
  const { reserved } = functionPatterns(version);

  // 格式資訊 15 bits：讀第一份，位置與 applyFormat 對稱，XOR 0x5412 還原
  let f = 0;
  for (let i = 0; i <= 5; i++) f |= matrix[i][8] << i;
  f |= matrix[7][8] << 6; f |= matrix[8][8] << 7; f |= matrix[8][7] << 8;
  for (let i = 9; i <= 14; i++) f |= matrix[8][14 - i] << i;
  // 15 bits 裡，高 5 bits 是「ECC 等級(2) + 遮罩號(3)」，低 10 bits 是 BCH 校驗
  const raw = f ^ 0x5412;
  const mask = (raw >> 10) & 0b111;

  const m = matrix.map((row) => row.slice());
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) if (!reserved[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
  }
  const bits = [];
  for (const [r, c] of zigzag(N, reserved)) bits.push(m[r][c]);
  const read = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits.shift(); return v; };
  if (read(4) !== 0b0100) throw new Error('解碼失敗：不是 byte mode');
  const len = read(8);
  const out = [];
  for (let i = 0; i < len; i++) out.push(read(8));
  return new TextDecoder().decode(Uint8Array.from(out));
}

/** 反解自己剛產生的那張，證明編進去的就是原字串 */
function decode(qr) { return decodeMatrix(qr.matrix); }

function toSvg(qr, px, text) {
  const { matrix, size: N } = qr;
  const parts = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) if (matrix[r][c]) parts.push(`M${c} ${r}h1v1h-1z`);
  }
  // 四周留 2 個模組的靜區（掃描器需要），所以 viewBox 比模組數大 4
  const Q = 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N + Q * 2} ${N + Q * 2}" width="${(N + Q * 2) * px}" height="${(N + Q * 2) * px}" shape-rendering="crispEdges" role="img" aria-label="QR code：${text}">
<title>${text}</title>
<rect width="${N + Q * 2}" height="${N + Q * 2}" fill="#fff"/>
<path fill="#000" transform="translate(${Q} ${Q})" d="${parts.join('')}"/>
</svg>
`;
}

export { encode, decode, decodeMatrix, toSvg, rsEncode, VERSIONS };

// 被 import 時（test/qr.test.mjs）只取函式，不要跑 CLI
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [text, outPath, pxArg] = process.argv.slice(2);
  if (!text || !outPath) {
    console.error('用法：node tools/make-qr.mjs "要編的字串" 輸出.svg [模組像素，預設 8]');
    process.exit(1);
  }
  const qr = encode(text);
  const back = decode(qr);
  if (back !== text) {
    console.error(`反解不一致，不寫檔：\n  編進去：${text}\n  讀回來：${back}`);
    process.exit(1);
  }
  const svg = toSvg(qr, Number(pxArg) || 8, text);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, svg);
  console.log(`version ${qr.version}（${qr.size}×${qr.size}）· 遮罩 ${qr.mask} · ${svg.length} bytes → ${outPath}`);
  console.log(`反解讀回：${back}`);
}
