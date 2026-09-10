// tools/make-qr.mjs 測試：往返、結構、以及「符不符合標準」的黃金樣本。
//
// 自己編自己解會通過是理所當然的（同一套邏輯的 bug 會互相抵銷），所以這裡另外用
// 一份外部產生器（api.qrserver.com）做出來的真實碼字當黃金樣本，驗 Reed-Solomon
// 與功能圖案佈局。那份樣本是抓下來後離線存進測試的，測試本身不連外。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, decodeMatrix, rsEncode, VERSIONS } from '../tools/make-qr.mjs';

test('往返：編進去的字串解得回來', () => {
  for (const s of [
    'https://buymeacoffee.com/chenggg0605',
    'mailto:chenggg0601@gmail.com',
    'A',
    'https://jljimmyh.github.io/0827_yuan/',
  ]) {
    assert.equal(decode(encode(s)), s, s);
  }
});

test('版本依長度挑最小的；超過 version 3 要報錯', () => {
  assert.equal(encode('A').version, 1);
  assert.equal(encode('x'.repeat(20)).version, 2);
  assert.equal(encode('https://buymeacoffee.com/chenggg0605').version, 3);
  assert.throws(() => encode('x'.repeat(43)), /太長/);
});

test('功能圖案：定位、時序、固定暗模組都在標準位置', () => {
  const qr = encode('https://buymeacoffee.com/chenggg0605');
  const m = qr.matrix;
  const N = qr.size;
  assert.equal(N, 29);
  // 三個角的定位圖案：外框實心、內圈留白、中心 3×3 實心
  for (const [r0, c0] of [[0, 0], [0, N - 7], [N - 7, 0]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(m[r0][c0 + i], 1, `上邊 (${r0},${c0 + i})`);
      assert.equal(m[r0 + 6][c0 + i], 1, `下邊 (${r0 + 6},${c0 + i})`);
    }
    assert.equal(m[r0 + 1][c0 + 1], 0, '內圈要留白');
    assert.equal(m[r0 + 3][c0 + 3], 1, '中心要實心');
  }
  // 時序圖案：第 6 列與第 6 欄交替
  for (let i = 8; i < N - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0 ? 1 : 0, `時序列 ${i}`);
    assert.equal(m[i][6], i % 2 === 0 ? 1 : 0, `時序欄 ${i}`);
  }
  assert.equal(m[N - 8][8], 1, '固定暗模組必須是 1');
});

test('遮罩號寫進格式資訊、又讀得回來（decodeMatrix 不靠外部參數）', () => {
  const qr = encode('https://buymeacoffee.com/chenggg0605');
  // decodeMatrix 只拿矩陣，遮罩號是自己從格式資訊讀的
  assert.equal(decodeMatrix(qr.matrix), 'https://buymeacoffee.com/chenggg0605');
});

// ---------------------------------------------------------------------------
// 黃金樣本：外部實作（api.qrserver.com）對 "https://buymeacoffee.com/chenggg0605"
// 產生的 version 3 / ECC M 的 70 個碼字（前 44 資料、後 26 校驗），離線存進來的。
//
// 它用的是**混合模式**：byte 段編網址主體、再接一個 numeric 段編結尾的 "0605"
//（數字用 numeric 比較省位元）。我們只做單一 byte 段，位元流本來就不一樣，
// 所以不比對整體碼字——比對的是「同一份資料碼字，RS 校驗碼算不算得出一樣的」。
// 這一項過了，就表示 GF(256)、產生多項式、餘式計算都跟標準相符。
// ---------------------------------------------------------------------------
const GOLDEN = `42 06 87 47 47 07 33 a2 f2 f6 27 57 96 d6 56 16 36 f6 66 66
  56 52 e6 36 f6 d2 f6 36 86 56 e6 76 76 71 01 03 c5 00 ec 11 ec 11 ec 11
  eb 6c ae fe 80 70 52 92 eb 0a 92 1d 28 a4 3f 49 61 a4 3a c7 38 34 1c 28 91 4e`
  .trim().split(/\s+/).map((h) => parseInt(h, 16));

test('黃金樣本：Reed-Solomon 校驗碼跟外部實作算出來的一模一樣', () => {
  const data = Uint8Array.from(GOLDEN.slice(0, 44));
  assert.deepEqual(rsEncode(data, 26), Uint8Array.from(GOLDEN.slice(44)),
    '同一份資料碼字，RS 校驗碼必須與外部實作相同');
});

test('自己產生的圖：碼字還原得回來，遮罩號在合法範圍', () => {
  const qr = encode('https://buymeacoffee.com/chenggg0605');
  assert.equal(qr.version, 3);
  // 不跟外部比對遮罩號：選哪個遮罩是「懲罰分數最低」的啟發式，規則 3（假定位圖案）
  // 在符號邊界怎麼算各家有差，選不同遮罩照樣掃得出來——掃描器是從格式資訊讀遮罩號的。
  assert.ok(qr.mask >= 0 && qr.mask <= 7, '遮罩號要在 0–7');
  const cw = codewordsOf(qr);
  assert.equal(cw.length, 70, 'version 3 共 70 個碼字');
  assert.equal(cw[0], 0x42, '第一個碼字＝byte mode(0100) + 長度高 4 bits');
  assert.deepEqual(rsEncode(Uint8Array.from(cw.slice(0, 44)), 26), Uint8Array.from(cw.slice(44)),
    '自己圖裡的校驗碼要能被自己的 RS 重算出來');
});

// ---------------------------------------------------------------------------
// 參考實作的完整矩陣：nayuki 的 QR-Code-generator（MIT，公認的參考實作，LVGL 的
// lv_lib_qrcode 用的也是同一份 C 版）對 "https://buymeacoffee.com/chenggg0605"
// 以 ECC M 產生的 29×29。用 Node 的 --experimental-transform-types 跑他的 TypeScript
// 版取得，離線存進來，測試本身不連外。
//
// 這是最強的一項驗證：逐格一致，代表資料編碼、RS、遮罩選擇、格式資訊位置全部相符。
// 早期版本就是靠這個抓到「格式資訊的兩份副本座標寫成轉置」的 bug——資料區全對、
// 只有 8 格差在格式資訊帶，掃描器會因此讀到錯的遮罩號。
// ---------------------------------------------------------------------------
const NAYUKI = [
  '11111110001001010111101111111',
  '10000010011011111100101000001',
  '10111010110111011001001011101',
  '10111010100100111100001011101',
  '10111010110010000111101011101',
  '10000010111110010000001000001',
  '11111110101010101010101111111',
  '00000000100100110001100000000',
  '10111110010010011111001111100',
  '00010000000111100111011110001',
  '11001111001101110100100110000',
  '11100101000011001000100101010',
  '10001110010100111100000001100',
  '11101100110100000011111110001',
  '11100011001000010110110111100',
  '10101101110100110000100000010',
  '01110010001110011100000101100',
  '11100101111101100111111110101',
  '10101011011001111010010110100',
  '10110000011001001011101110010',
  '10110111101000110100111110111',
  '00000000110010001010100011111',
  '11111110010000011001101011100',
  '10000010101000101001100010010',
  '10111010111010010100111110100',
  '10111010111101101110100101111',
  '10111010101101111101011111110',
  '10000010001000101010101001010',
  '11111110110111010101001010100',
];

test('與 nayuki 參考實作逐格一致', () => {
  const qr = encode('https://buymeacoffee.com/chenggg0605');
  assert.equal(qr.size, NAYUKI.length);
  const mine = qr.matrix.map((row) => row.join(''));
  for (let r = 0; r < NAYUKI.length; r++) {
    assert.equal(mine[r], NAYUKI[r], `第 ${r} 列`);
  }
});

/** 把矩陣還原成碼字：反遮罩 → 照 zigzag 讀 → 每 8 bit 一個碼字 */
function codewordsOf(qr) {
  const MASKS = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const { size: N, matrix, mask, reserved } = qr;
  const m = matrix.map((row) => row.slice());
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) if (!reserved[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
  }
  const bits = [];
  let up = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < N; k++) {
      const row = up ? N - 1 - k : k;
      for (const c of [col, col - 1]) if (!reserved[row][c]) bits.push(m[row][c]);
    }
    up = !up;
  }
  const out = [];
  const total = VERSIONS[qr.version].data + VERSIONS[qr.version].ec;
  for (let i = 0; i < total; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out.push(v);
  }
  return out;
}
