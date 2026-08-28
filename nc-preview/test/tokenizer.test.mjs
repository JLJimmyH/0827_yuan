// tokenizer.js 測試（CONTRACT §1 驗收 + 邊角案例）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNC, fixture, FIXTURES, goldenSkip, FIX_A, FIX_D } from './load.mjs';

const NC = loadNC();
const tok = (s) => NC.tokenize(s);
const words = (s, i = 0) => tok(s).blocks[i].words.map((w) => `${w.comma ? ',' : ''}${w.addr}${w.value}`);
const r01 = (r) => r.diagnostics.filter((d) => d.ruleId === 'R01');

test('載入：NC.tokenize 存在', () => {
  assert.equal(typeof NC.tokenize, 'function');
});

// ---------------------------------------------------------------------------
// 驗收（四支真實程式）
// ---------------------------------------------------------------------------
test('驗收：樣本 A 的 blocks 數、O 號、頭尾的 % 行、行尾字元', goldenSkip, () => {
  const r = tok(fixture(FIX_A));
  assert.equal(r.blocks.length, 1593);
  assert.ok(Number.isInteger(r.programNumber) && r.programNumber > 0);
  assert.equal(r.blocks[0].isPercent, true);
  assert.equal(r.blocks[1592].isPercent, true);
  assert.equal(r.lineEnding, '\n');
});

test('驗收：樣本 D 的 O 號與 O 行括號註解都解析得出來', goldenSkip, () => {
  const r = tok(fixture(FIX_D));
  assert.ok(Number.isInteger(r.programNumber) && r.programNumber > 0, 'programNumber 應該是正整數');
  assert.ok(r.programName && r.programName.length > 0, 'programName 應該解析得出來');
});

test('驗收：多斜線節的 slashes=3、skipLevel=1、text 去掉斜線', goldenSkip, () => {
  const b = tok(fixture(FIX_A)).blocks[809];
  assert.equal(b.line, 810);
  assert.equal(b.slashes, 3);
  assert.equal(b.skipLevel, 1);
  assert.equal(b.text, 'G0Y3.');
  assert.deepEqual(b.words.map((w) => w.addr + w.value), ['G0', 'Y3']);
});

test('驗收：樣本 A 第 1015 行 words 含 {addr:C, value:0.3, comma:true}', goldenSkip, () => {
  const b = tok(fixture(FIX_A)).blocks[1014];
  assert.equal(b.line, 1015);
  const c = b.words.find((w) => w.addr === 'C');
  assert.ok(c, '找不到 C 字組');
  assert.equal(c.value, 0.3);
  assert.equal(c.comma, true);
  assert.equal(c.raw, ',C0.3');
  assert.equal(c.hasDecimal, true);
  assert.equal(b.words[0].addr, 'X');
  assert.equal(b.words[0].value, -34);
});

test('驗收：M6T20(100MM) → comment "100MM"、words M6、T20', () => {
  const b = tok('M6T20(100MM) ').blocks[0];
  assert.equal(b.comment, '100MM');
  assert.deepEqual(b.words.map((w) => w.addr + w.value), ['M6', 'T20']);
  assert.equal(b.text, 'M6T20');
});

test('驗收：四支程式 R01 診斷數 = 0', goldenSkip, () => {
  for (const f of FIXTURES) {
    const r = tok(fixture(f));
    assert.equal(r01(r).length, 0, `${f} R01: ${JSON.stringify(r01(r))}`);
    assert.equal(r.diagnostics.length, 0, `${f} diagnostics 應為 0`);
  }
});

test('四支程式：每個 block 的 line 與索引一致、% 行標記正確', goldenSkip, () => {
  for (const f of FIXTURES) {
    const r = tok(fixture(f));
    r.blocks.forEach((b, i) => assert.equal(b.line, i + 1, `${f} line`));
    assert.equal(r.blocks[0].isPercent, true, `${f} 第一行 %`);
    assert.equal(r.blocks[0].isEmpty, true);
    const last = r.blocks[r.blocks.length - 1];
    assert.equal(last.isPercent, true, `${f} 最後一行 %`);
  }
});

// ---------------------------------------------------------------------------
// 括號註解
// ---------------------------------------------------------------------------
test('註解先剝除：(M4*P0.7) 不可誤判成 M4', () => {
  const b = tok('M6T10(M4*P0.7) ').blocks[0];
  assert.equal(b.comment, 'M4*P0.7');
  assert.deepEqual(b.words.map((w) => w.addr + w.value), ['M6', 'T10']);
  assert.equal(b.words.filter((w) => w.addr === 'M').length, 1);
});

test('多個註解以空格串接；純註解行 isEmpty', () => {
  const b = tok('(A B) G0 (C) X1. (D)').blocks[0];
  assert.equal(b.comment, 'A B C D');
  assert.deepEqual(words('(A B) G0 (C) X1. (D)'), ['G0', 'X1']);
  const only = tok('(just comment)').blocks[0];
  assert.equal(only.isEmpty, true);
  assert.equal(only.comment, 'just comment');
  assert.equal(only.text, '');
});

test('不平衡的「(」→ R01 error；孤立的「)」→ 忽略並 info', () => {
  const r1 = tok('G0X1.(abc');
  assert.equal(r1.diagnostics.length, 1);
  assert.equal(r1.diagnostics[0].ruleId, 'R01');
  assert.equal(r1.diagnostics[0].severity, 'error');
  assert.equal(r1.diagnostics[0].line, 1);
  assert.deepEqual(words('G0X1.(abc'), ['G0', 'X1']);

  const r2 = tok('G0X1.)Y2.');
  assert.equal(r2.diagnostics.length, 1);
  assert.equal(r2.diagnostics[0].ruleId, 'R01');
  assert.equal(r2.diagnostics[0].severity, 'info');
  assert.deepEqual(r2.blocks[0].words.map((w) => w.addr + w.value), ['G0', 'X1', 'Y2']);
});

// ---------------------------------------------------------------------------
// 斜線
// ---------------------------------------------------------------------------
test('節首斜線：/ → 1、/3 → 3、多斜線 → skipLevel 1', () => {
  assert.equal(tok('/G0X1.').blocks[0].skipLevel, 1);
  assert.equal(tok('/G0X1.').blocks[0].slashes, 1);
  assert.equal(tok('/1G0X1.').blocks[0].skipLevel, 1);
  const b3 = tok('/3G1X-34.').blocks[0];
  assert.equal(b3.skipLevel, 3);
  assert.equal(b3.slashes, 1);
  assert.equal(b3.text, 'G1X-34.');
  const b5 = tok('/////G0Z5. ').blocks[0];
  assert.equal(b5.slashes, 5);
  assert.equal(b5.skipLevel, 1);
  assert.equal(b5.text, 'G0Z5.');
  assert.equal(tok('G0X1.').blocks[0].skipLevel, null);
  assert.equal(tok('G0X1.').blocks[0].slashes, 0);
});

test('節中斜線：其後到行尾為 tailIgnored，不產生字組', () => {
  const b = tok('G0 X1. / M3 S100').blocks[0];
  assert.equal(b.tailIgnored, '/ M3 S100');
  assert.deepEqual(b.words.map((w) => w.addr + w.value), ['G0', 'X1']);
  assert.equal(b.text, 'G0 X1.');
  assert.equal(tok('G0X1.').blocks[0].tailIgnored, null);
});

test('「;」視為 EOB，其後忽略', () => {
  const b = tok('G0X1.;G1Y2.').blocks[0];
  assert.deepEqual(b.words.map((w) => w.addr + w.value), ['G0', 'X1']);
  assert.equal(tok('G0X1.;G1Y2.').diagnostics.length, 0);
});

// ---------------------------------------------------------------------------
// 字組
// ---------------------------------------------------------------------------
test('無空格連寫：G0G90G54X100.Y-20.5G43H1Z10.M3S1200', () => {
  assert.deepEqual(words('G0G90G54X100.Y-20.5G43H1Z10.M3S1200 '),
    ['G0', 'G90', 'G54', 'X100', 'Y-20.5', 'G43', 'H1', 'Z10', 'M3', 'S1200']);
});

test('value 解析：G05.1 → 5.1、X-34. → -34、hasDecimal 標記', () => {
  const b = tok('G05.1Q1 X-34. Y.5 Z65').blocks[0];
  const g = b.words[0];
  assert.equal(g.addr, 'G');
  assert.equal(g.value, 5.1);
  assert.equal(g.hasDecimal, true);
  const x = b.words.find((w) => w.addr === 'X');
  assert.equal(x.value, -34);
  assert.equal(x.hasDecimal, true);
  assert.equal(b.words.find((w) => w.addr === 'Y').value, 0.5);
  const z = b.words.find((w) => w.addr === 'Z');
  assert.equal(z.value, 65);
  assert.equal(z.hasDecimal, false);
  const q = b.words.find((w) => w.addr === 'Q');
  assert.equal(q.hasDecimal, false);
});

test('逗號字組 ,C0.3 / ,R2. → addr C|R、comma:true；col 正確', () => {
  const b = tok('X58.,C0.3').blocks[0];
  assert.deepEqual(b.words.map((w) => [w.addr, w.value, w.comma]), [['X', 58, false], ['C', 0.3, true]]);
  assert.equal(b.words[1].col, 4);
  const b2 = tok('Y-80.5,R6. ').blocks[0];
  assert.deepEqual(b2.words.map((w) => [w.addr, w.value, w.comma]), [['Y', -80.5, false], ['R', 6, true]]);
  assert.equal(b2.words[1].raw, ',R6.');
  assert.equal(b2.words[1].hasDecimal, true);
});

test('小寫字母、字母與數字間空白、正號都可接受；正負號與數字間不可有空白', () => {
  assert.deepEqual(words('g0 x +1.5 y -2'), ['G0', 'X1.5', 'Y-2']);
  assert.equal(tok('g0 x +1.5 y -2').diagnostics.length, 0);
  assert.ok(tok('y - 2').diagnostics.length >= 1);
});

test('字母後無數字 → R01 error', () => {
  const r = tok('G X1.');
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].ruleId, 'R01');
  assert.equal(r.diagnostics[0].severity, 'error');
  assert.deepEqual(r.blocks[0].words.map((w) => w.addr + w.value), ['X1']);
});

test('非法字元 → R01 error（連續非法字元合併一筆）', () => {
  const r = tok('G0 #X1. @@Y2.');
  assert.equal(r.diagnostics.length, 2);
  assert.ok(r.diagnostics.every((d) => d.ruleId === 'R01' && d.severity === 'error'));
  assert.ok(r.diagnostics[0].message.includes('#'));
  assert.ok(r.diagnostics[1].message.includes('@@'));
  assert.deepEqual(r.blocks[0].words.map((w) => w.addr + w.value), ['G0', 'X1', 'Y2']);
});

test('O 字：programNumber 取第一個；O1004(DEMO-PLATE)', () => {
  const r = tok('%\nO1004(DEMO-PLATE)\nG0X1.\nO9999(other)\n%');
  assert.equal(r.programNumber, 1004);
  assert.equal(r.programName, 'DEMO-PLATE');
  const r2 = tok('%\nG0X1.\nM30\n%');
  assert.equal(r2.programNumber, null);
  assert.equal(r2.programName, null);
});

test('% 行：isPercent=true、isEmpty=true；空行 isEmpty', () => {
  const r = tok('%\n\n   \nG0X1.\n%');
  assert.equal(r.blocks[0].isPercent, true);
  assert.equal(r.blocks[0].isEmpty, true);
  assert.equal(r.blocks[1].isEmpty, true);
  assert.equal(r.blocks[1].isPercent, false);
  assert.equal(r.blocks[2].isEmpty, true);
  assert.equal(r.blocks[3].isEmpty, false);
  assert.equal(r.blocks[4].isPercent, true);
  assert.equal(r.blocks.length, 5);
});

test('行號 1-based、raw 保留尾隨空白、以 \\r\\n 或 \\n 切行、lineEnding 多數決', () => {
  const r = tok('%\r\nO1 \r\nG0X1.\r\nM30\n%');
  assert.equal(r.blocks.length, 5);
  assert.equal(r.blocks[1].raw, 'O1 ');
  assert.equal(r.blocks[1].line, 2);
  assert.equal(r.lineEnding, '\r\n');
  assert.equal(tok('a\nb\r\nc\n').lineEnding, '\n');
  assert.equal(tok('').blocks.length, 1);
  assert.equal(tok('').lineEnding, '\n');
});

test('不做語意判斷：未知 G/M 不在 tokenizer 報錯', () => {
  const r = tok('G999 M77 X1');
  assert.equal(r.diagnostics.length, 0);
  assert.equal(r.blocks[0].words.length, 3);
});

test('效能：樣本 A tokenize < 50 ms', goldenSkip, () => {
  const text = fixture(FIX_A);
  tok(text); // 暖身
  const t0 = performance.now();
  tok(text);
  const ms = performance.now() - t0;
  console.log(`  tokenize 樣本 A: ${ms.toFixed(2)} ms`);
  assert.ok(ms < 50, `tokenize 花了 ${ms} ms`);
});


test('節中斜線：尾段也切成 tailWords，讓 interpreter 依情境決定要不要執行', () => {
  const b = tok('G0 X1. / M3 S100').blocks[0];
  assert.equal(b.tailIgnored, '/ M3 S100');
  assert.deepEqual(b.words.map((w) => w.addr + w.value), ['G0', 'X1']);
  assert.deepEqual(b.tailWords.map((w) => w.addr + w.value), ['M3', 'S100']);
  assert.ok(b.tailWords.every((w) => w.afterSlash === true));
  assert.equal(tok('G0X1.').blocks[0].tailWords.length, 0);
});

test('節中多個斜線：全部當分隔符號，不會變成 R01 非法字元', () => {
  const r = tok('G1X10./X20./X30.F100');
  const b = r.blocks[0];
  assert.deepEqual(b.words.map((w) => w.addr + w.value), ['G1', 'X10']);
  assert.deepEqual(b.tailWords.map((w) => w.addr + w.value), ['X20', 'X30', 'F100']);
  assert.equal(r.diagnostics.filter((d) => d.ruleId === 'R01').length, 0);
});
