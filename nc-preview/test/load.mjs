// Node 測試載入器：把 js/core/*.js 依契約順序 eval 進同一個 global，回傳 globalThis.NC。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const CORE_ORDER = ['ns.js', 'tokenizer.js', 'interpreter.js', 'geometry.js', 'tools.js', 'simulation.js', 'rules.js', 'analyze.js'];

let loaded = false;
export function loadNC() {
  if (loaded) return globalThis.NC;
  for (const f of CORE_ORDER) {
    const p = path.join(ROOT, 'js', 'core', f);
    if (!fs.existsSync(p)) continue; // 尚未實作的模組略過
    const src = fs.readFileSync(p, 'utf8');
    vm.runInThisContext(src, { filename: p });
  }
  loaded = true;
  return globalThis.NC;
}

// ---------------------------------------------------------------------------
// Golden fixtures
//
// test/fixtures/ 放的是實際生產用的 NC 程式，不隨程式碼公開（見 .gitignore）。
// 有這些檔案時 golden test 照跑；沒有的時候（例如剛 clone 下來）整組自動 skip，
// 其餘單元測試不受影響。要跑完整的 golden test，把自己的程式放進 test/fixtures/
// 並照各測試檔的驗收數字調整即可。
// ---------------------------------------------------------------------------
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures');

function listFixtures() {
  try {
    return fs.readdirSync(FIXTURE_DIR).filter((f) => !f.startsWith('.')).sort();
  } catch (err) { return []; }
}

/** @type {string[]} 目前可用的 golden fixture 檔名（字典序） */
export const FIXTURES = listFixtures();
/** golden test 是否有料可跑 */
export const hasFixtures = FIXTURES.length >= 4;
/** 給測試當 test() 用：沒有 fixtures 時整個 skip */
export const goldenSkip = { skip: hasFixtures ? false : 'test/fixtures 不存在，略過 golden test' };
/** 四支 golden 程式的代號（沒有 fixtures 時為 undefined） */
export const [FIX_A, FIX_B, FIX_C, FIX_D] = FIXTURES;

export function fixture(name) {
  if (!name) return '';
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'latin1');
}
