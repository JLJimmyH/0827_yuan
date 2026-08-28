import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNC, fixture, FIXTURES, goldenSkip } from './load.mjs';
const NC = loadNC();
test('ns 載入', () => { assert.ok(NC.util); assert.equal(typeof NC.util.defaultSettings, 'function'); });
test('golden fixtures 讀得到', goldenSkip, () => { for (const f of FIXTURES) assert.ok(fixture(f).length > 0, f); });
