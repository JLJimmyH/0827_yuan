// 素材規格（stock.spec）測試：形狀＋尺寸＋原點位置 → min/max 的換算、
// 包絡盒反算 spec（帶入推估值）、analyzeSync 走 spec、四軸 cylX、立圓柱的模擬遮罩。
//
// 換算語意（CONTRACT §5 analyze）：
//   anchor = 工件原點錨在素材的比例位置（0 = min 端、0.5 = 中、1 = max 端）
//   pos    = 錨點在工件座標的座標（預設 0,0,0）
//   min = pos − anchor·size；max = min + size
// 現場慣例：一軸尺寸難算就把原點放那一軸的邊（anchor 0 或 1），兩軸都難算才放角落。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNC } from './load.mjs';

const NC = loadNC();
const A = NC.analysis;

function box(size, anchor, pos) {
  return { shape: 'box', size, anchor, pos };
}

// ---------------------------------------------------------------------------
// stockFromSpec：spec → min/max
// ---------------------------------------------------------------------------
test('spec：置中的長方體（預設 anchor 0.5、pos 0）', () => {
  const s = A.stockFromSpec(box({ x: 100, y: 60, z: 20 }));
  assert.deepEqual(s.min, { x: -50, y: -30, z: -10 });
  assert.deepEqual(s.max, { x: 50, y: 30, z: 10 });
  assert.equal(s.source, 'user');
  assert.equal(s.shape, 'box');
  assert.deepEqual(s.spec.anchor, { x: 0.5, y: 0.5, z: 0.5 });
});

test('spec：原點在上邊中點（Y 尺寸難算的慣例；Z 錨頂面）', () => {
  // 寬 87.654 難除以 2 → 原點放 +Y 邊的中點，Y 一律往下（負）算
  const s = A.stockFromSpec(box({ x: 120, y: 87.654, z: 20 }, { x: 0.5, y: 1, z: 1 }));
  assert.deepEqual(s.min, { x: -60, y: -87.654, z: -20 });
  assert.deepEqual(s.max, { x: 60, y: 0, z: 0 });
});

test('spec：原點在左上角（兩軸都難算的慣例）', () => {
  const s = A.stockFromSpec(box({ x: 87.654, y: 43.21, z: 15 }, { x: 0, y: 1, z: 1 }));
  assert.deepEqual(s.min, { x: 0, y: -43.21, z: -15 });
  assert.deepEqual(s.max, { x: 87.654, y: 0, z: 0 });
});

test('spec：pos 平移錨點（原點不在素材上也成立）', () => {
  // 錨左下角、但錨點在工件座標 (10, -5, 0)：素材整體跟著平移
  const s = A.stockFromSpec(box({ x: 40, y: 40, z: 10 }, { x: 0, y: 0, z: 1 }, { x: 10, y: -5, z: 0 }));
  assert.deepEqual(s.min, { x: 10, y: -5, z: -10 });
  assert.deepEqual(s.max, { x: 50, y: 35, z: 0 });
});

test('spec：立圓柱直徑兩軸恆相等、XY 錨鎖在軸心', () => {
  const s = A.stockFromSpec({ shape: 'cylZ', size: { x: 50, y: 999, z: 30 }, anchor: { x: 0, y: 1, z: 1 } });
  assert.equal(s.shape, 'cylZ');
  assert.deepEqual(s.min, { x: -25, y: -25, z: -30 });
  assert.deepEqual(s.max, { x: 25, y: 25, z: 0 });
  assert.deepEqual(s.spec.anchor, { x: 0.5, y: 0.5, z: 1 });
});

test('spec：躺圓柱直徑取 y、YZ 錨鎖在軸心', () => {
  const s = A.stockFromSpec({ shape: 'cylX', size: { x: 80, y: 40, z: 999 }, anchor: { x: 0, y: 0.5, z: 0.5 } });
  assert.deepEqual(s.min, { x: 0, y: -20, z: -20 });
  assert.deepEqual(s.max, { x: 80, y: 20, z: 20 });
});

test('spec：不合法（尺寸 0、負、缺 shape）回 null', () => {
  assert.equal(A.stockFromSpec(box({ x: 0, y: 10, z: 10 })), null);
  assert.equal(A.stockFromSpec(box({ x: 10, y: -1, z: 10 })), null);
  assert.equal(A.stockFromSpec({ size: { x: 1, y: 1, z: 1 } }), null);
  assert.equal(A.stockFromSpec(null), null);
});

test('spec：anchor 超界收斂到 [0,1]、非數字當預設', () => {
  const s = A.stockFromSpec(box({ x: 10, y: 10, z: 10 }, { x: 7, y: -3, z: 'nope' }));
  assert.deepEqual(s.spec.anchor, { x: 1, y: 0, z: 0.5 });
});

// ---------------------------------------------------------------------------
// specFromStock：min/max → spec（帶入推估值）
// ---------------------------------------------------------------------------
test('反算：原點靠邊的包絡盒挑 0／1 錨點，殘量進 pos', () => {
  // 原點在最左邊的實際慣例：X 從 0 起全正（±2 的殘量收進 pos）
  const spec = A.specFromStock({ min: { x: -2, y: -30, z: -20 }, max: { x: 98, y: 30, z: 0 } });
  assert.equal(spec.shape, 'box');
  assert.deepEqual(spec.size, { x: 100, y: 60, z: 20 });
  assert.deepEqual(spec.anchor, { x: 0, y: 0.5, z: 1 });
  assert.deepEqual(spec.pos, { x: -2, y: 0, z: 0 });
  // 反算完再導回 min/max 要一致（round trip）
  const back = A.stockFromSpec(spec);
  assert.deepEqual(back.min, { x: -2, y: -30, z: -20 });
  assert.deepEqual(back.max, { x: 98, y: 30, z: 0 });
});

test('反算：圓棒（kind cylinder）→ cylX，直徑與軸心照抄', () => {
  const spec = A.specFromStock({
    kind: 'cylinder', radius: 25, center: { y: 1.5, z: -2 },
    min: { x: -5, y: -23.5, z: -27 }, max: { x: 95, y: 26.5, z: 23 },
  });
  assert.equal(spec.shape, 'cylX');
  assert.equal(spec.size.y, 50);
  assert.equal(spec.size.z, 50);
  assert.equal(spec.size.x, 100);
  assert.equal(spec.pos.y, 1.5);
  assert.equal(spec.pos.z, -2);
  assert.deepEqual(spec.anchor, { x: 0, y: 0.5, z: 0.5 });
});

test('反算：不合法（min ≥ max）回 null', () => {
  assert.equal(A.specFromStock({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 10, z: 10 } }), null);
  assert.equal(A.specFromStock(null), null);
});

// ---------------------------------------------------------------------------
// analyzeSync：request.stock 帶 spec
// ---------------------------------------------------------------------------
const PROG = 'O0001\nT1 M6\nG0 X10 Y10\nG1 Z-2 F100\nG1 X20\nM30\n';

test('analyzeSync：spec 為正準，min/max 由它重算（舊 min/max 不殘留）', () => {
  const res = NC.analyzeSync(Object.assign(NC.analysis.defaultRequest(PROG), {
    stock: {
      spec: box({ x: 60, y: 40, z: 10 }, { x: 0, y: 1, z: 1 }),
      min: { x: -999, y: -999, z: -999 }, max: { x: 999, y: 999, z: 999 },
      fixtures: [{ name: '夾具 1', min: { x: 0, y: -40, z: -10 }, max: { x: 5, y: -35, z: 2 } }],
    },
  }));
  assert.deepEqual(res.stock.min, { x: 0, y: -40, z: -10 });
  assert.deepEqual(res.stock.max, { x: 60, y: 0, z: 0 });
  assert.equal(res.stock.source, 'user');
  assert.equal(res.stock.fixtures.length, 1);
  assert.equal(res.stock.spec.shape, 'box');
});

test('analyzeSync：四軸程式 + cylX spec → 圓棒吃使用者的直徑與範圍', () => {
  const prog4 = 'O0002\nT1 M6\nG0 X0 Y0 Z30 A0.\nG1 Z-1 F100\nG1 X50\nG0 Z30\nA90.\nG1 Z-1\nG1 X50\nM30\n';
  const res = NC.analyzeSync(Object.assign(NC.analysis.defaultRequest(prog4), {
    stock: { spec: { shape: 'cylX', size: { x: 80, y: 40, z: 40 }, anchor: { x: 0, y: 0.5, z: 0.5 }, pos: { x: -10, y: 0, z: 0 } } },
  }));
  assert.equal(res.stock.kind, 'cylinder');
  assert.equal(res.stock.radius, 20);
  assert.equal(res.stock.source, 'user');
  assert.equal(res.stock.xMin, -10);
  assert.equal(res.stock.xMax, 70);
  assert.equal(res.stock.spec.shape, 'cylX');
});

test('analyzeSync：四軸程式 + 使用者挑了長方體 → 尊重使用者、不硬蓋成圓棒', () => {
  const prog4 = 'O0003\nT1 M6\nG0 X0 Y0 Z30 A0.\nG1 Z-1 F100\nG1 X50\nG0 Z30\nA90.\nG1 Z-1\nG1 X50\nM30\n';
  const res = NC.analyzeSync(Object.assign(NC.analysis.defaultRequest(prog4), {
    stock: { spec: box({ x: 60, y: 40, z: 40 }, { x: 0, y: 0.5, z: 0.5 }) },
  }));
  assert.notEqual(res.stock.kind, 'cylinder');
  assert.equal(res.stock.spec.shape, 'box');
  assert.deepEqual(res.stock.min, { x: 0, y: -20, z: -20 });
  assert.deepEqual(res.stock.max, { x: 60, y: 20, z: 20 });
});

// ---------------------------------------------------------------------------
// 模擬：立圓柱的圓外沒有料
// ---------------------------------------------------------------------------
test('sim.create：cylZ 的角落格子高度＝底（無料），圓心＝頂面', () => {
  const stock = A.stockFromSpec({ shape: 'cylZ', size: { x: 40, y: 40, z: 10 }, anchor: { x: 0.5, y: 0.5, z: 1 } });
  const sim = NC.sim.create(stock, 1);
  const at = (x, y) => NC.sim.heightAt(sim, x, y);
  assert.equal(at(0, 0), 0);            // 圓心：素材頂面
  assert.equal(at(18, 0), 0);           // 圓內靠邊：仍有料
  assert.equal(at(-19, 19), -10);       // 角落：圓外，高度＝min.z（無料）
  assert.equal(at(19, -19), -10);
});

test('sim.create：box 素材不受遮罩影響（角落仍是頂面）', () => {
  const stock = A.stockFromSpec(box({ x: 40, y: 40, z: 10 }, { x: 0.5, y: 0.5, z: 1 }));
  const sim = NC.sim.create(stock, 1);
  assert.equal(NC.sim.heightAt(sim, -19, 19), 0);
});

test('sim：鑽穿素材底 → 高度停在 floorZ（薄素材配深孔，剖面才不會畫出掛在底下的料）', async () => {
  // 素材只有 10 厚、鑽到 Z-32：孔位的高度應是 floorZ（無料），不是 -32
  const prog = 'O0004\nT1 M6\nG0 X0 Y0 Z25\nG98 R2. G81 Z-32. F60\nG80\nM30\n';
  const req = Object.assign(NC.analysis.defaultRequest(prog), {
    stock: { spec: box({ x: 40, y: 40, z: 10 }, { x: 0.5, y: 0.5, z: 1 }) },
    sim: { enabled: true, cell: 0.5 },
  });
  const res = await NC.analyze(req);
  const sim = res.scenarios.off.sim;
  assert.equal(sim.floorZ, -10);
  assert.equal(NC.sim.heightAt(sim, 0, 0), -10);   // 孔中心：穿了，但停在底
  let below = 0;
  for (const h of sim.height) if (h < sim.floorZ - 1e-9) below++;
  assert.equal(below, 0);
});
