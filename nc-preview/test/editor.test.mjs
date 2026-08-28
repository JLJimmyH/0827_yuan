// editor.js 的 Node 測試：UI 本身不在 Node 測，這裡只測掛在 NC.ui.editorText 的純文字工具，
// 並確認 editor.js 在沒有 DOM 的環境載入不會出錯。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadNC, fixture, FIXTURES, ROOT, goldenSkip, FIX_A } from './load.mjs';

const NC = loadNC();
{
  const p = path.join(ROOT, 'js', 'ui', 'editor.js');
  vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
}
const T = NC.ui.editorText;

test('editor.js 載入後掛在 NC.ui', () => {
  assert.equal(typeof NC.ui.createEditor, 'function');
  assert.ok(T && typeof T.replaceLinesInText === 'function');
});

test('createEditor 沒有容器會丟錯，不碰 document', () => {
  assert.throws(() => NC.ui.createEditor(null), /容器/);
});

test('computeLineStarts / lineOfIndex', () => {
  const text = 'ab\ncd\n\nef';
  const starts = T.computeLineStarts(text);
  assert.deepEqual(starts, [0, 3, 6, 7]);
  assert.equal(T.lineOfIndex(starts, 0), 1);
  assert.equal(T.lineOfIndex(starts, 2), 1);   // 換行字元本身屬於第 1 行
  assert.equal(T.lineOfIndex(starts, 3), 2);
  assert.equal(T.lineOfIndex(starts, 6), 3);
  assert.equal(T.lineOfIndex(starts, 7), 4);
  assert.equal(T.lineOfIndex(starts, 99), 4);
  assert.deepEqual(T.computeLineStarts(''), [0]);
});

test('detectLineEnding 多數決', () => {
  assert.equal(T.detectLineEnding('a\r\nb\r\nc'), '\r\n');
  assert.equal(T.detectLineEnding('a\nb\nc'), '\n');
  assert.equal(T.detectLineEnding('a\r\nb\nc\nd'), '\n');
  assert.equal(T.detectLineEnding('沒有換行'), '\n');
});

test('replaceLinesInText：取代中間單行', () => {
  const r = T.replaceLinesInText('L1\nL2\nL3\nL4', 2, 2, 'X');
  assert.equal(r.text, 'L1\nX\nL3\nL4');
  assert.equal(r.start, 3);
  assert.equal(r.end, 5);
  assert.equal(r.inserted, 'X');
});

test('replaceLinesInText：多行換成多行、最後一行、第一行', () => {
  assert.equal(T.replaceLinesInText('L1\nL2\nL3\nL4', 2, 3, 'A\nB\nC').text, 'L1\nA\nB\nC\nL4');
  assert.equal(T.replaceLinesInText('L1\nL2\nL3', 3, 3, 'Z').text, 'L1\nL2\nZ');
  assert.equal(T.replaceLinesInText('L1\nL2\nL3', 1, 1, 'Z').text, 'Z\nL2\nL3');
  assert.equal(T.replaceLinesInText('L1\nL2\nL3', 1, 3, '').text, '');
  // a > b 會自動對調；超出範圍會夾住
  assert.equal(T.replaceLinesInText('L1\nL2\nL3', 3, 2, 'Z').text, 'L1\nZ');
  assert.equal(T.replaceLinesInText('L1\nL2\nL3', 0, 99, 'Z').text, 'Z');
  // 取代內容的 CRLF 會正規化成 LF
  assert.equal(T.replaceLinesInText('L1\nL2', 1, 1, 'A\r\nB').text, 'A\nB\nL2');
});

test('replaceLinesInText：null 刪除（含換行、不留空行）', () => {
  assert.equal(T.replaceLinesInText('L1\nL2\nL3\nL4', 2, 3, null).text, 'L1\nL4');
  assert.equal(T.replaceLinesInText('L1\nL2\nL3', 3, 3, null).text, 'L1\nL2');
  assert.equal(T.replaceLinesInText('L1\nL2\nL3', 1, 1, null).text, 'L2\nL3');
  assert.equal(T.replaceLinesInText('L1\nL2\nL3', 1, 3, null).text, '');
  assert.equal(T.replaceLinesInText('only', 1, 1, null).text, '');
});

test('groupDiagnostics / topSeverity', () => {
  const diags = [
    { id: 'a', ruleId: 'R05', line: 3, severity: 'info', message: 'i' },
    { id: 'b', ruleId: 'R08', line: 3, severity: 'error', message: 'e' },
    { id: 'c', ruleId: 'R04', line: 3, severity: 'warning', message: 'w' },
    { id: 'd', ruleId: 'R32', line: 0, severity: 'warning', message: '整支程式' },
    { id: 'e', ruleId: 'R22', line: 7, severity: 'needsInput', message: 'n' },
    null,
  ];
  const map = T.groupDiagnostics(diags);
  assert.deepEqual([...map.keys()].sort((a, b) => a - b), [0, 3, 7]);
  assert.deepEqual(map.get(3).map((d) => d.id), ['b', 'c', 'a']);
  assert.equal(T.topSeverity(map.get(3)), 'error');
  assert.equal(T.topSeverity(map.get(7)), 'needsInput');
  assert.equal(T.topSeverity([]), null);
  assert.equal(T.topSeverity(null), null);
  assert.equal(T.groupDiagnostics(undefined).size, 0);
  assert.equal(T.SEV_LABEL.needsInput, '需輸入');
});

test('真實程式：行起點與行數一致、往返取代不變', goldenSkip, () => {
  for (const f of FIXTURES) {
    const raw = fixture(f);
    const text = raw.replace(/\r\n?/g, '\n');
    const starts = T.computeLineStarts(text);
    assert.equal(starts.length, text.split('\n').length, f);
    // 最後一個字元一定落在最後一行
    assert.equal(T.lineOfIndex(starts, text.length), starts.length, f);
    // 把第 810 行換成自己 → 文字不變
    if (starts.length > 810) {
      const line810 = text.slice(starts[809], starts[810] - 1);
      assert.equal(T.replaceLinesInText(text, 810, 810, line810).text, text, f);
    }
  }
});

test('效能：1,593 行程式重算行起點 < 5 ms', goldenSkip, () => {
  const text = fixture(FIX_A).replace(/\r\n?/g, '\n');
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) T.computeLineStarts(text);
  const per = (performance.now() - t0) / 20;
  assert.ok(per < 5, `每次 ${per.toFixed(2)} ms`);
});
