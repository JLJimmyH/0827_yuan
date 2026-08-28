# NC 預演台 — 模組契約（CONTRACT）

所有實作者必讀。型別定義（JSDoc）在 `js/core/ns.js`，**不得修改**；需要新增欄位請在本檔最底下的「提案」區寫下，由整合者決定。

## 0. 總則

- 純 JavaScript（ES2020），**不用任何 npm 套件、不用建置工具**。瀏覽器以 `<script src>` 傳統腳本依序載入；Node 測試用 `test/load.mjs` 依序 eval 進同一個 global。
- 每個檔案的形式固定：
  ```js
  (function (NC) {
    'use strict';
    // ...
    NC.tokenize = tokenize;
  })(globalThis.NC = globalThis.NC || {});
  ```
  `js/ui/*.js` 掛在 `NC.ui`，`js/core/*.js` 掛在 `NC` 或 `NC.<module>`。
- 核心模組（`js/core/*`）**不得碰 DOM／window／localStorage**（`tools.js` 的儲存函式例外，且必須 try/catch）。
- 載入順序：`ns.js → tokenizer.js → interpreter.js → geometry.js → tools.js → simulation.js → rules.js → analyze.js`，然後 `ui/*.js`，最後 `ui/app.js`。
- 行號一律 1-based，檔案第一行 = 1（通常是 `%`）。
- 座標一律工件座標（G54），刀尖 Z = 程式 Z（忽略 H 值）；G54–G59 視為同一原點（設定沒有提供偏置時）。
- 訊息文字用繁體中文；程式碼識別字保留英文。
- 測試：`node --test "test/*.test.mjs"` 可跑全部（在 nc-preview 目錄下執行）；每個模組至少一個 `test/<module>.test.mjs`，並用 `test/fixtures/` 的四支真實程式做 golden test（見各模組的驗收數字）。
- 效能目標：1,600 行左右的程式，tokenize + interpret + geometry（不含模擬）< 200 ms；模擬（0.25 mm 格）< 2 s。

## 1. `tokenizer.js` — `NC.tokenize(text) → TokenizeResult`

- 以 `\r\n` 或 `\n` 切行；記錄 `lineEnding`（多數決）。
- 每行：`raw` = 原文；先抽出 `( ... )` 註解（可多個；不平衡的 `(` → R01 error，孤立的 `)` 忽略並 info）；去掉註解後計算節首斜線：`^/+` 的個數為 `slashes`；`/n`（n=1–9）→ `skipLevel=n`；多斜線 → `skipLevel=1`。斜線之後若在**節中**再出現 `/`，其後到行尾為 `tailIgnored`。
- 字組正則：`/([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g`；逗號字組 `,C0.3` `,R2.` → `addr:'C'|'R', comma:true`。字母後無數字（如 `G`）→ R01 error。非空白且不屬於任何字組的字元 → R01 error（含 `;` 以外的東西；`;` 視為 EOB 忽略其後）。
- `%` 行：`isPercent=true, isEmpty=true`。
- `O` 字：`programNumber`（第一個）與同行註解 `programName`。`O1004(DEMO-PLATE)` → 105, "DEMO-PLATE"。
- `value` 解析：`G05.1` → 5.1；`X-34.` → -34；`hasDecimal` 標記是否有 `.`。
- 不做任何語意判斷（那是 interpreter 的事）。
- 驗收：`M6T20(100MM)` → comment "100MM"、words M6、T20。blocks 數、`programNumber`／`programName`、多斜線節的 `slashes`／`skipLevel`、逗號字組、R01 診斷數 = 0 這些，用 golden test 對 `test/fixtures/` 的實際程式驗收，見 `test/tokenizer.test.mjs`（那個目錄不進版控，沒有的時候整組自動 skip）。

## 2. `interpreter.js` — `NC.interpret(blocks, settings, scenario) → Run`

初始狀態：`motion:null, distance:'G90', plane:'G17', units:'G21', feedMode:'G94', wcs:'G54', comp:'G40', d:0, lengthComp:'G49', h:0, cycle:null, retractMode:'G98', feed:null, spindle:{dir:'M5',rpm:null}, coolant:false, toolInSpindle:null, toolStaged:null, aicc:false, rigidTap:false, rigidTapS:null, pos: settings.refPosition, lengthCompActive:false`。

情境（scenario）：
- `off`：所有節執行。
- `on`：`skipLevel` 在 `settings.skipLevelsOn` 內的節 → `skipped=true`（不執行，`after=before`）。多斜線節依 `settings.multiSlash`：`asSingle` → 視同 `/`；`ignoreBlock` → `ignored=true`；`alarm` → 執行但由 rules 報 error（interpreter 不管）。
- `multiIgnored`：`slashes>=2` → `ignored=true` 永遠不執行；`slashes==1` 執行（相當於開關關）。

G 碼群組（同節同群組兩個以上 → R03 warning，後者有效）：01 `G0 G1 G2 G3`；02 `G17 G18 G19`；03 `G90 G91`；05 `G94 G95`；06 `G20 G21`；07 `G40 G41 G42`；08 `G43 G44 G49`；09 `G73 G74 G76 G80–G89`；10 `G98 G99`；12 `G54–G59`；00（單節）`G4 G28 G30 G53 G05.1 G10 G92`。群組 01 的 G0–G3 會取消群組 09 的循環（同節同時有 → 循環取消，warning R18）。

每節處理順序（Fanuc 慣例）：
1. 套用所有非移動模態字（G 群組、F、S、T、H、D、M 的狀態部分）。
2. `M6`：`toolInSpindle = 同節 T（若有）否則 toolStaged`；產生 `toolchange` 動作；新作業（Operation）從此節開始；`lengthCompActive=false`。同節 T 不再算預選。
3. `T`（非 M6 節）→ `toolStaged`。
4. 座標字 → 目標點：G90 用絕對；G91 加到目前位置；未指定的軸保持。**只有在有座標字或循環節時才產生移動**。
5. 群組 01 動作：`G0 → rapid`（多軸 → `nonLinear=true`）；`G1 → linear`（feed = state.feed；feed 為 null → R08 error 但仍產生動作）；`G2/G3 → arc`：圓心由 `I/J`（增量、相對起點）或 `R`（半徑；弦長 > 2|R| → R23 error 並退化成直線；`R<0` = 大弧）算出；起終點重合且用 R → error。只支援 G17 平面（其他平面 → R02 error）。
6. `,C` / `,R`：附在本節動作的 `corner`；本節非 G1/G2/G3 → R22 warning「被忽略」；下一節檢查交給 geometry。
7. `G41/G42`：啟動節 `compStart=true`；`G40` 節 `compEnd=true`。啟動或取消發生在 G2/G3 節 → R09 error（PS0034）；D=0 或 > maxOffsets → R09 error（PS0030）。
8. `G43 H`：`lengthComp='G43', h`, `lengthCompActive=true`；同節無 Z → R16 warning。新刀第一次 Z 向下（to.z < from.z 且 to.z < initialZ）前未 G43 → R16 error。
9. `G28`：`refReturn` 動作，`via` = 依 G90/G91 計算的中間點（G91 `Z0.` = 目前位置），`to` = `settings.refPosition` 只替換回歸的軸。G90 且中間點 ≠ 目前位置 → R17 error；兩軸以上 → R17 warning。之後 `pos = to`。G28 同節有 `G80` → 先取消循環。
10. 固定循環（G73–G89 生效中）：本節含 X/Y/Z/R 任一 → 產生 `hole` 動作：`x,y` = 目標 XY（G90/G91 換算），`r`、`z` 依 G90（絕對）/G91（R 相對初始面、Z 相對 R）換算；`q,p` 同節有就更新模態；`initialZ` = 進入循環時的 Z；`retract` = 目前 G98/G99。孔完成後 `pos = {x,y,z: retract==='G98' ? initialZ : r}`。G80 → `cycle=null`。`G84` 前一節或同節有 `M29 S` → `rigid=true`；`M29` 後遇到 G80 清除 `rigidTap`。G73/G83 無 Q → R18 error（PS0045）；循環第一節無 Z 或 R → R18 error。循環中 G28/G30 且同節無 G80 → R18 error（PS0044）。
11. `G05.1 Q1/Q0` → `aicc` 動作；`M3/M4/M5` → spindle 動作；`M8/M9` → coolant；`M0/M1/M2/M30` → stop；`G4 P/X` → dwell（P 毫秒或 X 秒）。
12. `S` 只更新 `spindle.rpm`；`M29` 記 `rigidTap=true, rigidTapS=S`。

未知 G（不在上述表）→ R02 error（PS0010）；未知 M → R02 info。無小數點的 X/Y/Z/I/J/K/R/Q(僅循環內) 且 `settings.dpi=false` → R04 warning（值仍照字面 mm 使用，但 message 顯示「機台會讀成 0.065 mm」）。`G05.1 Q1` 的 Q、P、S、T、M、N、D、H、L、K 排除。

Operation 切分：每個 M6 開始一個新 Operation（index 遞增）；M6 之前的節 `opIndex=-1`。`ops[i]` 統計：`tool`、`toolComment`（M6 節註解）、`h`、`dList`、`lineStart/lineEnd`、`zMin`（linear/arc 的 to.z 與 hole 的 z 最小）、`feeds`、`rpms`、`gCodes`、`kindGuess`：只有 hole 且 G84 → tap；G85 → ream；只有 hole → drill；有 G41/G42 → contour；toolComment 含 `V` 且 linear → chamfer；無 G41 但有 linear 且 zMin<0 → pocket；zMin >= -0.1 且 linear → face；其他 unknown。

第四軸（A）的讀取、`rotate` 動作、固定循環中的分度、`Run.rotary` 摘要見 §13.3。

interpreter 負責的診斷：R02、R03、R04（含第四軸的「度」版本）、R08（error 部分）、R09、R13（G41/G42 模態下 M6/G28/M30/換平面 → error）、R16、R17、R18、R21（M29 與 G84 之間有軸移動或 S → error PS0203；G84 無 F → error）、R23、R32（無 O 號 warning；無 M30/M02 error；`/M30` warning；`%` 缺 info）。其他規則由 rules.js 做。

驗收（scenario off）：Operation 切分與 T 序列、各 op 的 zMin、剛性攻牙的 `rigid=true`、G91 區段累積後回 G90 的絕對座標、block skip 情境下的 `skipped` 標記、固定循環展開的孔數、R02 error = 0（G05.1 要認得），全部用 golden test 驗收，見 `test/interpreter.test.mjs`。

## 3. `geometry.js` — `NC.buildSegments(run, toolTable, settings) → GeometryResult`

- 每個 `rapid/linear/arc` 動作 → 一個 Segment（`path:'programmed'`）。`refReturn` → 兩段 rapid（到 via、到 ref），`refReturn:true`。
- `hole` → `NC.geometry.expandHole(action, ctx?)`（`ctx = {pos?, feed?}`）展開：rapid 到 (x,y,initialZ 或目前 Z)、rapid 到 R、依循環：G81/G82 feed 到 z 再 rapid 回 R；G83 每次進 Q 後 rapid 回 R 再 rapid 到「上次深度**上方** 0.5 mm」（Fanuc 參數 5115 餘隙 d，預設 0.5 mm）；G84/G74 feed 到 z、feed 回 R（`sub:'tapUp'`）；G85/G89 feed 到 z、feed 回 R；最後 G98 → rapid 到 initialZ。展開的下刀段 `kind:'drill'`。
- `,C`/`,R`：需要下一個移動動作。本節與下一節皆須直線（G1；Fanuc 允許 G2/G3 但本版只支援直線，弧 → R22 warning「未展開」）；長度不足（本節或下一節 < C，或 < 圓角切線長）→ R22 error（PS0055）；等於 → warning。展開後本節縮短、插入倒角線／圓角弧（`inserted:true`）、下一節起點後移。在 G41/G42 啟動、取消節上 → R22 error（PS0039）。
- 刀徑補正（`state.comp` 為 G41/G42）：半徑 r = `NC.tools.effectiveRadius(toolTable, opTool, d)`（有 offsets 用 radGeom+radWear，否則 tool.diameter/2，皆無 → 0 且加 needsInput 診斷 R10「需輸入 D 值」）。演算法（G17 平面，直線 + 圓弧）：
  - 啟動節：終點 = 程式終點 + 法向偏移（法向 = 下一個補正平面內移動的方向左轉（G41）或右轉（G42）× r）；若沒有下一個移動 → 依本節方向。啟動節本身長度 < r → R10 warning（顯示程式長度與淨移動）。
  - 補正中每節：計算偏移直線／圓弧（圓弧半徑 ±r，內凹半徑 **< r** → R11 error PS0038/0041（剛好等於 r 是常見寫法，補正圓弧縮成一點，不報錯））；相鄰兩偏移段的連接：外角（轉向與補正側相反）→ 插入以程式轉角為圓心、半徑 r 的圓弧（`inserted:true`）；內角 → 求交點截斷；求不到交點（溝槽比刀徑小）→ R11 error PS0041。
  - 取消節：起點 = 上一段偏移終點，終點 = 程式終點。
  - 補正中連續無平面移動節數 > lookahead-2 → R12 warning。
  - 產出 `path:'compensated'` 的 Segment 與 `programmed` 並存（同 line）。simulation 應使用 compensated（若存在該 line 的 compensated 段則以它為準）。
- `bounds`：所有非 rapid 段的 min/max（含弧的包絡）。
- 提供工具：`NC.geometry.sampleSegment(seg, tol=0.05) → Vec3[]`（弧依弦差 tol 細分）；`NC.geometry.segmentLength(seg)`；`NC.geometry.arcFromR(from, to, r, cw) → {center}`；`NC.geometry.offsetPolyline(...)` 可自行設計。
- 驗收：I/J 與 R 兩種圓弧的圓心、補正啟動節的偏移終點（下一節向 -Y 時 G41 左側 = +X）、`,C`／`,R` 展開後插入段的長度、G91 圓弧、固定循環展開的 `drill` 段數、外角補正後半徑變成 R+r，全部用 golden test 驗收，見 `test/geometry.test.mjs`。

## 4. `tools.js` — `NC.tools`

### 4.1 刀具型式（`ToolType`）

型式總表在 `NC.tools.TYPE_INFO`，22 種。每一項有 `name`（CSV 中文名，也是 `TYPE_NAMES` 的值）、
`ui`（下拉選單顯示名，沒寫就用 `name`）、`group`、`profile`（模擬足跡形狀）、`angle`（預設刀尖角）、
`extra`（直徑以外要現場補的欄位）、`undercut`、`desc`。要加刀具型式只改這張表，
`TYPE_NAMES`／`TOOL_TYPES`／別名表／面板下拉選單／模擬足跡都跟著它走。

| 群 | 型式 | 中文名 | 足跡 | 預設角度 | 要補的欄位 |
| --- | --- | --- | --- | --- | --- |
| 銑削 | `endmill` | 平銑刀（平刀） | 圓盤 | — | |
| | `ballmill` | 球刀 | 球端 | — | |
| | `bullnose` | 圓鼻刀 | 圓盤 | — | `cornerRad` |
| | `facemill` | 面銑刀 | 圓盤 | — | |
| | `radiusmill` | 外R成型刀 | 圓盤 | — | `cornerRad` |
| | `chamfer` | V型倒角刀 | 錐尖 | 90° | |
| | `slotmill` | T型刀 | 圓盤※ | — | `neckDia` |
| | `tapermill` | 錐度刀 | 圓盤 | — | |
| | `dovetail` | 鳩尾槽刀 | 圓盤※ | 45° | `neckDia` |
| | `lollipop` | 糖球形銑刀 | 球端※ | — | `neckDia` |
| | `engrave` | 雕刻刀 | 錐尖 | 30° | |
| 鑽孔 | `drill` | 鑽頭 | 錐尖 | 118° | |
| | `reamer` | 鉸刀 | 圓盤 | — | |
| | `boring` | 搪孔刀 | 圓盤 | — | |
| | `centerdrill` | 中心鑽 | 錐尖 | 60° | `neckDia` |
| | `spot` | 點鑽 | 錐尖 | 90° | |
| | `countersink` | 沉頭孔鑽（錐孔） | 錐尖 | 90° | |
| | `counterbore` | 魚眼孔鑽（平底沉孔） | 圓盤 | — | `neckDia` |
| | `wooddrill` | 木工鑽頭 | 圓盤 | — | |
| 攻牙 | `tap` | 絲攻（右牙刀） | 不切削 | — | |
| | `taplh` | 左牙刀 | 不切削 | — | |
| 其他 | `unknown` | `?` | 圓盤 | — | |

※ `undercut: true`。`simulation.js` 用的是高度圖，做不出底切，只能用最大直徑近似；
`profileFor` 回傳的 `undercut` 旗標把這件事往外傳，不要當成模擬得準。
`Tool` 多了兩個選填欄位：`cornerRad`（角R／成型半徑）與 `neckDia`（頸徑／導柱直徑），
沒有通用預設值，一律留 `null` 等現場填。

### 4.2 函式

- `parseComment(str) → {type, diameter, angle?, pitch?, cornerRad?, source}`：`(\d+(\.\d+)?)\s*MM|M/M` → endmill（≥ 40 → facemill）；`SG-(\d+\.?\d*)` → drill；`(\d+)V` → chamfer；`M(\d+)\*P(\d+\.?\d*)` → tap（diameter = M 值、pitch；註解另外標了 `LH`／左牙 → taplh）；`(\d+)\+(\d+\.\d+)` → reamer（相加）；
  再來是關鍵字表 `COMMENT_KEYWORDS`（`DOVETAIL`／`LOLLIPOP`／`T-SLOT`／`TAPER`／`ENGRAV`／`CBORE`／`CSK`／`CENTER DRILL`／`SPOT`／`BORING`／`WOOD`／`BULLNOSE`／`CORNER R`／`BALL`…）；
  `(\d+)R(\d+\.?\d*)` → bullnose（直徑 + 角R）；其他 → unknown。
  註解裡的 `45DEG`／`60°`／`90度` 當角度、`R0.5` 當角R，不會被誤讀成直徑。
- `inferTools(tok, run) → Tool[]`：每個 M6 T（去重）；型式由註解 + 動作交叉驗證（只有 hole：G84→tap、G85→ream、其他→drill；有 G41→endmill/chamfer 依註解；facemill 由直徑≥40 或 zMin≥-0.1 且 X 行程很長）；矛盾 → 保留註解型式但 `source.type='comment'` 並由 rules R31 警告。預設：chamfer angle 90、drill angle 118、fluteLen = 3×diameter、stickout null、無註解且無切削動作 → `probe:true, type:'unknown', diameter:10, label:'T15'`；`source` 每欄標 `comment|motion|default`。`resident` 預設：T20 或 facemill → true。
- `effectiveRadius(toolTable, t, d) → number|null`：offsets 有 n=d 且 (radGeom+radWear)≠0 → 用它；否則 tool.diameter/2；皆無 → null。
- `defaultOffsets(tools, dList) → OffsetEntry[]`：每個用到的 D 號，radGeom = 對應刀直徑/2（source 'default'）。D 對應刀：用該 D 的作業的刀。
- `estimateStock(runs, geometry, tools) → Stock`：以 feed/arc/drill 包絡 + 刀半徑外擴，Z max = max(0, 最高切削 Z)，Z min = 最深切削 Z - 5，取整到 1 mm；`source:'estimated'`。
- `mergeUserTable(inferred, saved) → ToolTable`：saved 的 `source.user` 欄位覆蓋推測。
- `save(key, table)` / `load(key)` / `exportJSON(table)` / `importJSON(str)`：localStorage 包 try/catch；key = programKey。
- `toCSV(table)` / `fromCSV(str)`：欄位（程式,T,程式註解,推測型式,推測直徑mm,用途,最深Z,請填_型式確認,請填_直徑mm,請填_刀尖或倒角角度,請填_刃長mm,請填_伸出長mm,請填_角R半徑mm,請填_頸徑mm,用到的D號,請填_各D補正值,備註）。
  角R／頸徑兩欄排在「請填_」那一段的最後：匯出一律帶表頭、`fromCSV` 也以欄名對應，所以插欄不影響舊檔案讀取。
- 驗收：`parseComment('SG-12.')` → drill 12；`'M4*P0.7'` → tap 4 pitch 0.7；`'6+0.014'` → reamer 6.014；`'10V'` → chamfer 10；`'100MM'` → facemill 100；
  `'12R0.5'` → bullnose 12 角R 0.5；`'CENTER DRILL 3'` → centerdrill 角度 60；`'M8*P1.25LH'` → taplh。inferTools 的把數（以 M6 去重）與「沒有註解也沒有切削動作 → `probe:true`」的判定，用 golden test 驗收，見 `test/tools.test.mjs`。

## 5. `simulation.js` — `NC.sim`

- `create(stock, cell) → Sim`：`nx = ceil((max.x-min.x)/cell)+1`，格網是**節點式**：格 (ix,iy) 的中心 = `origin + (ix·cell, iy·cell)`，`origin = stock.min`（見整合決議 19）。height 初始 = stock.max.z；fixtures 也寫進 height（當作不可切的材料，高度 = fixture max.z，並記錄 mask）。
- `run(sim, scenarioResult, toolTable, settings, opts) → Promise<SimResult>`：`opts = {fromOpIndex?, onProgress?(0..1), yieldEveryMs?=16}`。以 `await new Promise(r=>setTimeout(r,0))` 分批讓出。依 Segment 順序：對 rapid 段先做碰撞檢查（足跡下任一格高度 > 段的最低 Z + 0.01 → R27 error 事件，附 line、pos；refReturn 段跳過），再不改材料；feed/arc/drill 段：沿段依 cell/2 取樣，每個取樣點蓋章足跡（min）。足跡：endmill/facemill/reamer 圓盤；drill 錐尖（角度）；chamfer 倒錐；tap 不改材料；unknown 圓盤。使用 compensated 段（若同 line 有）。
- 每個 op 結束存 snapshot（Float32Array 複本；為省記憶體只存 `ops.length` 份，若 > 25 個 op 則只存每個 op 的最後）。`fromOpIndex` 時從對應 snapshot 開始。
- 切削量事件：feed 段若「移除體積 / 段長」對應的平均切深 × 刀徑 > 門檻（全刃寬 × > 1.5×刀徑深）→ R28 warning「重切削」；G1 向下段在材料內且 feed > plungeFeedMax → R28 warning；G0 向下終點低於該處高度 → R27 error。
- 時間：feed 段 長度/feed；rapid 長度/rapidRate；hole 展開段同上；dwell 秒數；`perOp` 與 `total`。
- 驗收：側面銑掉之後的高度、沒動到的區域維持頂面高度、孔位深度、面銑刀在工件外下刀不該報 R27、實心推估素材下的 G0 深下刀應報 R27，全部用 golden test 驗收，見 `test/simulation.test.mjs`。

## 6. `rules.js` — `NC.rules`

- `registry: Rule[]`，`Rule = {id, title, severity, phase:'run'|'geometry'|'sim'|'cross', check(ctx) → Diagnostic[]}`；`run(ctx) → Diagnostic[]`，`ctx = {tok, scenarios:{off:ScenarioResult,on?:..., multiIgnored?:...}, toolTable, stock, settings}`；`settings.disabledRules` 過濾。
- rules.js 負責：R05（多斜線）、R06（情境差異：比較 off/on 每個 skipped 節後續第一個動作的 kind/Z/位置；跳過後在切深 G1/G0 且該處有材料（若有 sim 用 height）→ error，否則 warning；並比較最終 heightmap 差異格數 → info）、R07（被跳過節含模態字）、R10–R12 的補充（geometry 已出者不重複）、R14（D≠T、H≠T info；D0/H0 warning）、R15（|有效半徑 − 直徑/2| > dToleranceMm → warning；chamfer 例外）、R19（循環中每個 XY 節都鑽：列出 hole 數 info；G80 後又 G8x 無 R/Z → error）、R20（R 點 < 0 且該處未開孔（sim 有時查 height）→ warning／needsInput）、R24（G91 區段內有 `/` 節 → warning；M0/M6/M30 前仍 G91 → info）、R25（切削時 spindle M5 或 rpm null → error；M6/M0 前無 M5 依設定 → warning/info）、R26（G05.1 成對、Q1 中 M6/G28 未先 Q0 → warning、Q1 中循環 → info、G05.1 節含其他字 → error）、R29（預選 T ≠ 下一 M6 T → warning；M6 T = 主軸刀 → info；程式末預選 → info）、R30（刀庫：暫時只在 settings.magazine 存在時檢查，否則略過）、R31（同 T 號跨程式註解不一致需多程式 → 本版只做「註解型式 vs 動作型式矛盾」warning；`probe` 刀 info「無註解且無切削，可能是定位器刀位」）、R33（softLimits 有時檢查）、R34（重複層：找連續 N 節（N≥5）除 Z 值外完全相同的區塊群組，比對各群組差異 → info）、R35（Vc、mm/rev、啄鑽次數 > 40 → info；L/D > 6 → warning 需刃長）、R36（sim 有時：相鄰區域最終高度差 < 0.5 且 > 0.02 → warning）、R37（第四軸 A，見 §13.4）。
- 每條規則的 message 白話、detail 說明後果與建議、fanucAlarm 若有。
- 驗收：各規則的命中位置與嚴重度用 golden test 驗收，見 `test/rules.test.mjs`。那支測試另外釘住兩件事：實際程式跑出來的每一筆 `error` 都要說得出為什麼（逐筆列在測試裡），以及沒有素材模擬資料時，任何需要知道「當下材料長什麼樣」的判斷都不准升到 error。

## 7. `analyze.js` — `NC.analyze(request, onStage?) → Promise<AnalysisResult>`

順序：tokenize → 對每個 scenario interpret + buildSegments → inferTools + mergeUserTable + defaultOffsets → estimateStock（request.stock 為 null 時）→ rules.run（無 sim）→ 若 sim.enabled：對 `off` 與 `on` 各跑 sim（`onStage('sim', scenario, progress)`）→ rules 再跑一次 phase 'sim'/'cross'（加入 sim 事件）→ 合併去重（同 ruleId+line+scenario+message 只留一個）、依 severity(error>warning>needsInput>info) 再 line 排序。另提供 `NC.analyzeSync(request)`（不含 sim）。

## 8. UI（`js/ui/*.js`）

- `editor.js` — `NC.ui.createEditor(container) → Editor`：textarea + 左側 gutter（行號、錯誤標記）+ 右側行旁資訊欄（每行執行後 `G0/G1 · G90/91 · G41 D · F · Z`，由 app 提供 `lineInfo(line) → string`）；`setText(text)`, `getText()`, `onChange(cb)`（300 ms debounce）, `setDiagnostics(diags)`, `setLineInfo(fn)`, `highlightLine(n)`, `scrollToLine(n)`, `onCursorLine(cb)`, `getSelectionLines() → [a,b]`, `replaceLines(a,b,text)`。捲動同步：gutter/info 欄用同一個 scrollTop。折疊功能本版不做。
- `view2d.js` — `NC.ui.createView2D(canvas) → View`：`setData({segments, sim, stock, toolTable, scenario})`, `setMode('top'|'sectionX'|'sectionY')`, `setSection(v)`, `highlightLine(n)`, `highlightTool(t|null)`, `setVisible({rapid, feed, stock, tools:Set})`, `onPick((line, seg) => …)`, `fit()`；滑鼠滾輪縮放、拖曳平移、hover 顯示座標與深度。俯視：素材以色階（頂面淺、深處深）畫 heightmap（`putImageData` 縮放），路徑：rapid 虛線灰、feed 依刀具色、compensated 用實線、programmed 用細線；剖面：畫該位置的高度折線與素材輪廓。
- `panels.js` — `NC.ui.panels`：`toolTable(container, {table, onChange})`（每列：T、註解、型式下拉、直徑、角度、D 號、半徑形狀、半徑摩耗、來源標籤；直徑↔D 連動規則；常駐刀星號；probe 標記）、`diagnostics(container, {items, onJump, filter})`、`modal(container, state, extra)`、`ops(container, {ops, onJump})`、`stock(container, {stock, onChange})`、`toolbar` 的 block skip 選單（off/on/multiIgnored）與情境差異切換。
- `app.js` — 狀態：`{text, fileName, settings, toolTable, stock, scenario, result}`；開檔：`<input type=file>` + 整頁拖放（`dragover`/`drop`），解碼先 UTF-8（fatal）失敗改 `TextDecoder('big5')`；存檔：`Blob` 下載，檔名 = 原檔名（無副檔名亦可）；`localStorage` 存刀具表（key = programNumber 或檔名）與設定；編輯 → 300 ms 後 `NC.analyzeSync`（更新路徑、診斷、模態），1 s 後 `NC.analyze`（含 sim）並用版本號丟棄過時結果；四個面板的選取同步（行 ↔ 段 ↔ 刀 ↔ 診斷）。內建「載入範例」選單（`js/ui/samples.js` 內嵌四支程式文字，由整合者用腳本產生）。
- `index.html` — 版面：頂列工具列；左 45% 編輯器（上）+ 模態面板（下）；右 55% 視圖（上，含俯視/剖面切換、剖面滑桿、模擬到第 N 把刀滑桿、顯示勾選）+ 分頁面板（刀具表 / 錯誤清單 / 作業摘要 / 素材與設定）。`css/app.css` 自訂，淺色為主，錯誤紅／警告琥珀／資訊藍／需輸入黃。
- 不依賴任何外部資源（無 CDN、無 Google Fonts）。

## 9. 測試載入器

`test/load.mjs` 匯出 `loadNC() → NC`（以 `vm.runInThisContext` 依序載入 `js/core/*.js`）與 `fixture(name) → string`。UI 模組不在 Node 測。

## 10. 提案區

需要改契約時，請寫在 `docs/proposals/<module>.md`（不要直接改本檔或 ns.js），由整合者決定。

## 11. 整合決議（2026-08-27，整合者裁定，已實作）

1. **G83 餘隙方向**：退回 R 後快速下到「上次孔底上方 0.5 mm」再進給（原契約字面「深度 − 0.5」是筆誤）。
2. **R11 內凹半徑**：`< r` 才報 error；`= r`（Ø4 銑刀走 `,R2.` 的內圓角就是這種）為合法寫法，不報。
3. **倒角刀／中心鑽的補正量**：`type` 為 `chamfer`／`spot` 時，`tools.effectiveRadius` 與 `defaultOffsets` **不得**用公稱直徑/2 當預設（10V 會變成 r=5，把 `,R2.1` 內圓角全部誤判成 PS0041）。沒有使用者輸入的 D 值時回傳 `null`／`radGeom=0`，由 geometry 出 R10 `needsInput`「需輸入 D 值」。修正前四支程式共 9 筆假 error，修正後為 3 筆 needsInput。
4. **geometry 的 fallback**：`NC.tools.effectiveRadius` 存在時，其回傳的 `null`／`0` 是明確答案，geometry **不可**再退回 `diameter/2` 猜值；本地 fallback 只在 `NC.tools` 未載入時使用。
5. **固定循環內部的快速段**（`sub` 有值且 XY 不動，如 G83 退刀／再進入）**不做 R27 碰撞檢查**——刀具是在自己剛鑽出的孔內上下移動，材料模型上鑽尖錐面未切到的孔壁會造成誤報。
6. **`expandHole(action, ctx?)`**：ctx 提供目前位置與 F；回傳段不含 `id/line/opIndex/tool`，由 `buildSegments` 補上。
7. **`bounds`** 同時包含 programmed 與 compensated 段（對素材推估與視圖 fit 較安全）。
8. **外角接合**依 NIST 用圓弧（`inserted:true`，圓心 = 程式轉角）。
9. **`kindGuess` 順序**：chamfer（註解含 V）優先於 contour；`-0.1 ≤ zMin < 0` 判為 face。
10. **R22**（`,C`/`,R` 在非切削節）由 interpreter 發，rules.js 不重複。
11. **R08**（缺 F）在同一個「無 F」狀態只報一次。
12. **`after === before`**：skipped／空節共用同一個 ModalState 物件，下游不得就地修改。
13. **M 碼動作順序**：M3/M4/M8 在移動前、M5/M9 在移動後（`G0Z10.M5` 先走再停）。
14. **`Action.z` / `hole` 的 R 點**：ns.js typedef 已補註記；實作以 `action.z` 與 `action.r`（kind='hole' 時為 R 點）提供。

### 第二輪（整合階段，2026-08-27 傍晚）

15. **推估素材的判定一律不報 error**：`stock.source === 'estimated'` 時，依賴素材模型的規則（R20／R27／R28／R36）的 `error` 降成 `warning`。推估素材是「切削包絡外擴一個刀半徑」，程式本來就不清那一圈料，工件外的合法 G0 橫移會看起來像在犁材料。用猜出來的輸入報紅字，現場只會學會忽略紅字。
16. **推估素材的 warning 也要附註**：同一批規則的 `warning` 保留嚴重度，但 `detail` 一樣附上「此判定依據推估素材…」，並標 `estimatedStock: true`。（實測有一支程式的 87 筆 R28「高速下刀」全部來自面銑刀在工件外下刀，附註後現場才知道要先填素材再看。）
17. **R17 多軸 G28 依 Z 高度分級**：`G91G28Y0.Z0.` 這種「同時回 Y、Z」多半是刻意把工作台送到前方方便卸料，執行時 Z 早就拉高了。因此 interpreter 在該診斷附上 `pos`（執行前位置）與 `multiAxis:true`，由 `analyze` 判斷：`pos.z ≥ stock.max.z + 5` → 降成 `info`，否則維持 `warning`（Z 只比素材頂面高 3 mm 的那種就維持 warning）。interpreter 不需要知道素材。
18. **刀具數以 M6 去重後為準**（§4 驗收原本的數字是筆誤），要和刀具表 CSV 的列數對得起來。
19. **SimResult 的格網是節點式**：格 (ix,iy) 的中心 = `origin + (ix·cell, iy·cell)`，查表用 `Math.round`。ns.js 原本寫「左下角」與實作差半格，已改註解（§5、`ns.js` 的 `SimResult.origin`）。view2d／view3d 一律照節點式畫。
20. **診斷的降級要發生在排序之前**：`analyze.finalizeDiagnostics()` = 降級 → 去重 → 依 severity/line 排序 → 重新編號與分組。先排序再降級的話，一整排「本來是 error」的 warning 會卡在清單最前面，把真正的 error 埋掉（實測有一筆真 error 原本被推到第 42 筆）。
21. **診斷分組**：每則診斷帶 `groupKey`／`groupCount`／`groupFirst`／`groupLines`（同一原因、只是行號不同的歸一組；訊息中的數字先正規化再比對）。**逐行的診斷仍然全部保留**，編輯器 gutter 要逐行標記；只有錯誤清單面板預設把同組摺成一列、標 `×N`，展開後列出全部行號可點跳轉，並提供「逐行列出」勾選攤平。實測 156 筆 → 30 組。
22. **`NC.util.fmt` 去尾 0 的 bug 已修**：舊寫法 `fmt(-80.5)` 會得到 `'-80.500'`。改為 `.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')`。所有訊息裡的座標與深度因此變成 `Z-2.5` 而不是 `Z-2.500`（`test/rules.test.mjs` 的期待字串已同步更新）。
23. **本版不加的欄位**（提案裡問過、決定維持 ns.js 現狀）：`Tool.note`（CSV 的備註欄不往返保存）、`OffsetEntry.sourceWear`（半徑形狀與摩耗共用一個來源標記）、`Tool.dList`（刀 ↔ D 的對應一律從 `Operation.dList` 取，app 呼叫 `panels.toolTable` 時要傳 `ops`）。
24. **追認各模組提案裡的實作解讀**（提案有問、行為正確，維持原樣）：
    - R21：G84／G74 啟動節沒有 F 且模態 F 也是 null → `error`（PS0011）；有沿用的模態 F → `warning`（機台不會警報，但攻牙沿用前一段的 F 幾乎一定錯）。契約只寫 error，分兩級更貼近現場。
    - G30 視同 G28；G53 視為工件座標的 G0；G10／G92 不產生移動（G92 帶座標時 R02 info「不模擬」）。
    - `motion` 還是 null 就出現座標字 → 視為 G0，並發一次 R02 warning。
    - R12 的「連續無平面移動節數」只計有內容的節（有 action，或 F/S/D/H/comp/motion/G90-91 有變化），空行與純註解行不計。
    - `mergeUserTable`：存檔裡有、但目前程式沒有用到的刀不會出現在結果（換程式時不會帶進不相干的刀）。
25. **已知不做（下一版）**：(a) 完全落在素材 XY 之外的治具不會進高度圖，所以鉗口撞刀抓不到——要把格網範圍改成「素材 ∪ 治具」的包絡；(b) G18/G19 平面的圓弧、G92/G10 座標系位移、G53 機械座標、G95 每轉進給的換算；(c) `,C`／`,R` 接在 G2/G3 上的展開。

## 12. 整合決議（第二輪，2026-08-27 夜）

26. **推估素材下的碰撞判定，改用「成品輪廓區」而不是「切削包絡」**（`analyze.partRegionOf`）。
    切削包絡含面銑刀掃掠，而面銑刀走的範圍比工件寬得多，包絡就跟著被撐大，
    於是工件外的干涉點被判成「在切削範圍內」而留紅字——但成品輪廓根本沒那麼大。
    成品輪廓區優先取刀徑補正段（G41/G42 的刀心路徑）**再往內縮一個刀半徑**（刀心路徑比成品外形外偏 r），
    沒有補正段時退而取「低於頂面 2 mm 以上」的切削段。
27. **干涉點的材料若是「未加工的毛胚頂面」（`pos.z ≈ stock.max.z`），推估素材下一律降級**
    （`analyze.isUncutStockTop`）。程式從沒在那裡切過，代表那塊料完全來自推估。
    R06 的 `pos.z` 是刀尖 Z 不是材料高度，所以排除在這條之外。
28. **`estimateStock` 的 XY 改以「深度切削範圍 + 5 mm 餘量」收斂**（`tools.deepCutRegion`）。
    面銑／刮面（距頂面 2 mm 內）不列入——刀盤掃過空氣不代表那裡有料。
    推估素材因此大幅收斂，比用切削包絡算出來的小很多，也才接近手算的毛胚尺寸。
29. 以上三條合併後：golden fixtures 在 **block skip 開關「關」（正常生產）下 error = 0**；
    開關「開」時只剩少數幾筆真 error，型態都一樣——「跳過分層之後口袋沒挖到底，
    後面的刀卻在更深的 Z 橫越過去」。
    `test/analyze.test.mjs` 有回歸測試把這三條釘住。
30. **推翻先前「那個 G0 下刀點必須維持 error」的裁定**：該干涉點落在成品輪廓之外，
    且那裡的材料是未加工的毛胚頂面。程式由 G0 全深下刀、
    切深橫越中央的寫法可知毛坯是前工程半成品。把「取決於毛胚」的事說成確定的撞刀，
    和漏報一樣會讓現場不信任紅字 → 降為 warning 並明講需要什麼資料。
31. **R30 新增「大徑刀與相鄰刀位互撞」檢查**（error）。現場真實事故：大直徑面銑刀
    和隔壁刀位的刀在刀庫旋轉時互撞、刀子飛出來。刀庫視為環狀（第 1 號的隔壁是最後一號）。
    `magazine` 形狀：`{size, pots:{T→刀位}, resident:[T], largeToolDiameter, largeToolNeighbors}`。

32. **新增「刀庫」分頁**（`panels.magazine(container, {magazine, toolTable, usedTools, onChange})`）：
    啟用開關、刀位總數／大徑刀門檻／單邊淨空數、環狀刀位圖（>36 刀位改格狀）、T→刀位表格、
    衝突即時顯示。設定存 `localStorage` 的 `ncPreview.machine`（**機台層級，不跟程式號走**）。
33. **刀具表加 CSV 匯入／匯出**：匯出補 UTF-8 BOM（Excel 才不會亂碼），匯入只吃 `source==='user'` 的欄位，
    並擋掉不合理的值（直徑／刃長／伸出長 >0 且 ≤1000、角度 0–180、半徑形狀不可為負），
    被擋或無法解析的格子要點名告知，不可以顯示「匯入成功」了事。CSV 可直接拖進刀具表面板。

## 13. 第四軸（A）

### 13.1 現場配置（2026-08-28 由現場照片與 Yuan 確認）

立式加工中心的工作台上放一台**臥式旋轉分度頭**，三爪夾頭面朝 -X、中心線水平且平行 X 軸。
所以 **A 軸繞 X 軸旋轉**（標準定義），工件是夾在夾頭上的圓柱／棒料，刀具從 +Z 垂直下來切側面。
現場的用法是「三軸程式 A 就是 0，四軸程式就是 XYZA」——也就是**分度**（轉到角度停住再切），
不是 A 與 XYZ 同動的連續四軸。工作台上另一個平放的夾頭不會轉，不是第五軸。

### 13.2 為什麼分三個層次

| | 做到什麼 | 狀態 |
|---|---|---|
| 層次一 **認得 A、不騙人** | 讀進角度、標在每個動作與段上、A 軸專屬檢查、畫面明講「工件旋轉未套用」 | 已完成 |
| 層次二 **把路徑畫在工件上** | 座標轉換 → 展開圖（圓柱攤平）＋ 3D 圓棒 | 已完成（見 §13.7） |
| 層次三 真四軸素材模擬 | 體素／dexel 模型，殘料與碰撞 | 未做 |

分水嶺在**素材模型**，不在路徑。路徑只是座標轉換（層次二做完了，數學見 §13.7）；
但 `simulation.js` 的素材是 **heightmap（XY 格子存一個 Z）**，是 2.5D 的——
工件一轉，同一個 XY 格子就對應到工件的不同部位，這個模型從根本上表達不了四軸。
所以四軸程式**畫得出路徑、算不出殘料**：展開圖與 3D 圓棒可以信，素材殘料／碰撞／時間不能信。
要補上那一塊得換成體素或 dexel，那是層次三。

### 13.3 本版（層次一）的規則

**不做任何工件旋轉的座標轉換。** Segment 的 XYZ 一律是程式座標，`a` 只是「畫這一段時 A 在幾度」的標記。
這一點必須在畫面上講清楚（見 13.5），因為靜靜地把 A 吃掉、畫出一張漂亮但錯誤的圖，比什麼都不做更危險。

- 位址固定 `A`。`B`／`C` 出現時發一次 R02 warning「本工具只認得第四軸 A」，不模擬。
  `G65`／`G66` 這種 `blocksMotion` 的節裡 `A` 是巨集引數 #1，不算第四軸。
- `ModalState.a`（度）；G90 絕對、G91 增量都適用；`G28 A0.` 視為回到 A0。
- 移動類動作**一律**帶 `a`（該動作結束時的角度）；動作**期間**有轉動時另外帶 `aFrom`。
  三軸程式的 `a` 恆為 0，所以 `rotary.used` 一定要用「有沒有出現過 A 字組」判斷，不能拿 `act.a !== undefined` 判。
- **只有 A 在動的節**（XYZ 都沒寫）→ `kind:'rotate'` 動作，`from === to`。
  geometry 不產生線段（跟 dwell 一樣落到 marker），但動作要留著——R37 靠它檢查轉動時的刀尖高度。
- **固定循環中只寫一個 `A90.` 也要鑽一個孔**。這是四軸分度鑽孔的標準寫法
  （`G81 X10.Y0.Z-5.R2.F100.` 之後接 `A90.` `A180.`）。不把 `hasRot` 算進循環的觸發條件，
  這種節會整行消失，孔數、素材與時間全部少報。
- `R04`（無小數點）也查 `A`，但單位是**度**不是 mm：DPI=0 時 `A90` 讀成 0.09 度，分度等於沒做，
  所有角度的加工會疊在同一面上。訊息要講「度」。
- `Run.rotary`（`RotarySummary`）：`used` / `axis` / `mode` / `angles` / `rotateLines` / `simLines`。
  `mode` 的判定：**只有 `linear`／`arc` 動作帶 `aFrom`**（XYZ 與 A 真的同時進給）才算 `simultaneous`。
  `G1` 模態下單獨轉 A（`G1A90.F500.`）是旋轉進給，路徑上仍然是分度，危不危險交給 R37 的刀尖高度那條判；
  固定循環的「轉到位再鑽」更是分度。判太寬的話整支程式會被標成「畫不出來」，把真正的分度資訊蓋掉。
- `rotateLines` 長度 0（寫了 `A0.` 但從頭到尾沒轉）→ **路徑完全正確，一則提醒都不准出**。
  現場的三軸程式就是這樣寫的。

### 13.4 R37「第四軸（A）」

`phase: 'run'`。`rotary.used` 且 `rotateLines` 非空才動作。

| 子檢查 | 嚴重度 | 說明 |
|---|---|---|
| 總體標示 | warning | 分度：「路徑是照工件不轉畫的」；連續四軸：「本工具畫不出來」。`detail` 要分別列出「仍然有效」與「不要採信」的項目 |
| 轉動時刀尖太低 | error / warning | 門檻是素材頂面；刀尖 Z < 0 → error，0 ≤ Z ≤ 頂面 → warning。`hole` 只看 `from.z`（`to.z` 是退刀後高度，不是轉動當下的高度）。G99 分度（只退到 R 點就轉）要在 `detail` 裡點名 |
| 補正中轉 A | error | G41/G42 生效中轉動，補正方向會跟著錯（PS0041） |
| 結束沒回 A0 | warning | A 是模態的，M30 不會歸零，下一支程式整批分度偏掉 |
| 分度順序 | info | 「A0（第 3 行）→ A90（第 4 行）→ …」，每一段是一個獨立加工面 |

**R19 的連鎖修正**：孔位重複的比對 key 要含角度（`rotary.used && rotateLines` 非空時）。
同一個 XY 在不同角度是圓周上不同的孔，不是重複——不修的話一支正常的四軸分度程式會冒出一整排假 warning。

### 13.5 UI

- 頂列第三條橫幅 `rotaryBanner`（`nc-banner-warn`，點一下跳到錯誤清單）。
  這條最不能省：現場多半是先看圖才看清單，圖旁邊沒有這句話等於默認那張圖可以信。
- `panels.modal` 在 A ≠ 0 時多列一行「第四軸 A__°」。恆為 0 的三軸程式不列，免得變成雜訊。

### 13.6 本版沒做、下一版再看

1. **層次二（分度視圖）**：需要 `settings.rotary.center`（迴轉中心在工件座標的 Y/Z）。
   照這台的裝夾慣例，預設值是 Y0/Z0 對到夾頭中心線、X0 在工件端面，做成設定項讓現場修正。
   還缺一支**現場真的跑過的四軸程式**當 golden 驗收基準——`private/T.NC` 是隨手寫的測試檔
   （`O0000`、程式名 `(T)`、`Z-1..` 兩個小數點，而且 XY 與 A 同時變化，對照實際裝夾說不通），
   它只能驗「A 有沒有被讀進來」，驗不了座標轉換。
2. **分度前的夾緊／鬆開**（M10/M11 或 M50/M51，依機台廠而異）：要做成 `settings.rotary.clampM`，
   沒設定就不檢查。硬轉會過載，是真實風險，但 M 碼不確定就檢查一定誤報。
3. **A 軸行程限制**：`settings.rotary.limits`。無限旋轉的分度盤不需要，有限行程的搖籃才要。
4. **`G07.1` 圓筒插補**：目前在 `UNSUPPORTED_G` 裡標 warning 不模擬，維持。

### 13.7 層次二：把路徑畫在工件上

**核心是一個座標轉換**（`geometry.rotary`，core 層，兩個視圖共用）。
A 繞 X 軸轉、迴轉中心線平行 X 且位在 `(center.y, center.z)`；工件轉 +A 等價於刀具繞工件轉 −A，
所以把刀尖繞中心線反轉 A 度就是「工件上真的被切到的位置」：

```
dy = y − Cy ;  dz = z − Cz
y' = Cy + dy·cos A + dz·sin A
z' = Cz − dy·sin A + dz·cos A     x' = x
```

`center` 預設 `(0, 0)`——四軸裝夾慣例是 G54 的 Y0／Z0 對到夾頭中心線；現場對不上時由
`settings.rotary.center` 覆寫。**`Segment.from/to` 不會被改動**，那仍然是程式座標；
要看工件上的樣子一律走 `NC.geometry.rotary` 的函式。

API：`point(p, aDeg, center)`、`samples(seg, opts)`（A 有轉時依 `STEP_DEG`=3 度細分成折線）、
`unrollPoint(pw, center)` → `{x, theta, r}`、`unrollSegments(segments, opts)`、`estimateRadius(segments, opts)`。

**展開圖**（`view2d` 的 `unroll` 模式）把圓柱表面攤平：橫軸 X（軸向 mm），縱軸角度。
定案的幾個決策，改動前先看理由：

1. **縱軸座標用弧長（θ×R），不是角度**。兩軸都是 mm 才能沿用整個視圖的等比例縮放；
   直接拿「度」當縱座標的話，50 mm 對上 270 度會被壓成一條線。刻度標籤仍然標角度（程式寫的是角度），
   所以 `drawRulersUnroll` 是獨立的一份，不與 `drawRulers` 共用。
2. **θ 要對齊到程式寫的 A 值那一圈**。`atan2` 給的是 −180…180，A270 會變成 −90；
   現場寫 A270 就想在圖上看到 270，所以整條折線平移到最接近 `seg.a` 的那一圈
   （整條加同一個 360 倍數，折線內部的連續性不受影響）。折線內部另外做 unwrap，跨 ±180 不會出現假的垂直線。
3. **bounds 只算切削段**（排除 `rapid` 與 `refReturn`），與 §3 的 `GeometryResult.bounds` 同一個語意。
   從換刀點下來的 G0 起點在 Z150，算進去整張圖會被壓成一條線。
4. 展開圖按鈕**只在 `rotary.used && rotateLines.length` 時啟用**；三軸程式攤平之後是一條沒有資訊的橫線。

**3D 圓棒**（`view3d`）：`setData({rotary:{center, radius?}})` 一給就
(a) 路徑走 `rotary.samples` 換算到工件座標，
(b) 素材從方塊線框換成圓棒線框（`buildCylinderLines`；半徑取 `estimateRadius`，軸向範圍取切削段 X 加餘量），
(c) **不建 heightmap 成品**——那在四軸下是把所有角度疊在一起的錯誤模型，寧可不畫。
取景（`sceneBounds`）在四軸時**不把 rapid 算進 XY 包絡**：刀停在高處、工件在轉，
換算之後那是一圈半徑等於刀高的大圓弧，算進去會把工件擠成一個小點。那條弧仍然畫出來（它是真實的相對運動）。

### 13.8 還沒做

1. **`settings.rotary` 沒有設定面板欄位**（`center`／`radius` 目前只能從程式碼給，同 `softLimits` 的處境）。
   半徑用推估：取切削段離中心最遠的距離，落在工件表面附近（下刀是從表面開始的），畫出來的圓棒粗細只是示意。
2. **素材殘料與碰撞**（層次三）。要換成體素／dexel。
3. 分度前的夾緊／鬆開 M 碼、A 軸行程限制——同 §13.6，等現場給機台廠的 M 碼與行程再做。
