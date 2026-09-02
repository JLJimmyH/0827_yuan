/*
 * NC 預演台 — 共用命名空間、型別定義（JSDoc）與小工具。
 * 所有模組都掛在 globalThis.NC 底下；瀏覽器用 <script src> 依序載入，Node 測試用 test/load.mjs 依序 eval。
 * 這個檔案是「契約」：其他模組不得修改這裡的 typedef；需要新增欄位請在 docs/CONTRACT.md 提案。
 */
(function (root) {
  'use strict';
  const NC = (root.NC = root.NC || {});
  NC.VERSION = '0.1.0';

  // ---------------------------------------------------------------------------
  // 基本型別
  // ---------------------------------------------------------------------------
  /** @typedef {{x:number,y:number,z:number}} Vec3 */
  /** @typedef {{x:number,y:number}} Vec2 */
  /** @typedef {'off'|'on'|'multiIgnored'} SkipScenario  off=開關關（全部執行）；on=開關開（/ 節跳過）；multiIgnored=多斜線節永遠忽略、單斜線執行 */
  /** @typedef {'error'|'warning'|'info'|'needsInput'} Severity */
  /** @typedef {'comment'|'motion'|'default'|'user'} ValueSource */

  // ---------------------------------------------------------------------------
  // tokenizer.js
  // ---------------------------------------------------------------------------
  /**
   * @typedef {Object} Word
   * @property {string} addr        大寫位址字母：G M X Y Z I J K R Q P F S T H D O N L K C…
   * @property {number} value       數值（G05.1 → 5.1；X-34. → -34）
   * @property {string} raw         原始字串（含逗號，如 ",C0.3"）
   * @property {number} col         在 text 中的起始欄位（0-based）
   * @property {boolean} hasDecimal 數字是否含小數點
   * @property {boolean} comma      是否為逗號字組（,C / ,R 選擇性倒角／圓角）
   */
  /**
   * @typedef {Object} Block
   * @property {number} line          1-based 行號，檔案第一行（通常是 %）= 1
   * @property {string} raw           原始整行（不含換行字元，保留尾隨空白）
   * @property {string} text          去掉註解、去掉前導斜線、trim 之後的內容
   * @property {string|null} comment  括號註解內容（多個以空格串接），無則 null
   * @property {number} slashes       節首連續斜線數（0 = 無）
   * @property {number|null} skipLevel  "/" 或 "/1" → 1；"/3" → 3；多斜線 → 1；無 → null
   * @property {Word[]} words
   * @property {boolean} isPercent    是否為 "%" 行
   * @property {boolean} isEmpty      無任何字組（空行、純註解、%）
   * @property {string|null} tailIgnored  非節首斜線之後被忽略的內容（Fanuc：斜線不在節首時其後到 EOB 全部忽略）
   */
  /**
   * @typedef {Object} TokenizeResult
   * @property {Block[]} blocks
   * @property {'\n'|'\r\n'} lineEnding
   * @property {number|null} programNumber   O 號
   * @property {string|null} programName     O 行的註解（如 DEMO-PLATE）
   * @property {Diagnostic[]} diagnostics    詞法層錯誤（R01 括號不平衡、非法字元…）
   */

  // ---------------------------------------------------------------------------
  // interpreter.js
  // ---------------------------------------------------------------------------
  /**
   * @typedef {Object} CycleState
   * @property {'G73'|'G74'|'G76'|'G81'|'G82'|'G83'|'G84'|'G85'|'G86'|'G87'|'G88'|'G89'} code
   * @property {number|null} r        R 點（絕對工件座標；G91 時已換算成絕對）
   * @property {number|null} z        孔底（絕對）
   * @property {number|null} q
   * @property {number|null} p
   * @property {'G98'|'G99'} retract
   * @property {number} initialZ      進入循環前的 Z（初始面）
   */
  /**
   * @typedef {Object} ModalState
   * @property {'G0'|'G1'|'G2'|'G3'|null} motion
   * @property {'G90'|'G91'} distance
   * @property {'G17'|'G18'|'G19'} plane
   * @property {'G20'|'G21'} units
   * @property {'G94'|'G95'} feedMode
   * @property {'G54'|'G55'|'G56'|'G57'|'G58'|'G59'} wcs
   * @property {'G40'|'G41'|'G42'} comp
   * @property {number} d               目前 D 號（0 = 無）
   * @property {'G43'|'G44'|'G49'} lengthComp
   * @property {number} h               目前 H 號
   * @property {CycleState|null} cycle
   * @property {'G98'|'G99'} retractMode
   * @property {number|null} feed       F（mm/min）；null = 尚未指定
   * @property {{dir:'M3'|'M4'|'M5', rpm:number|null}} spindle
   * @property {boolean} coolant
   * @property {number|null} toolInSpindle   主軸上的 T
   * @property {number|null} toolStaged      預選的 T（M6 之外的 T 字）
   * @property {boolean} aicc                G05.1 Q1
   * @property {boolean} rigidTap            M29 生效中
   * @property {number|null} rigidTapS       M29 時的 S
   * @property {Vec3} pos                    執行後位置（工件座標；刀尖 = 程式 Z，忽略 H 值）
   * @property {number} a                    第四軸 A 的角度（度）；沒有第四軸的程式恆為 0
   * @property {boolean} lengthCompActive    G43 已在此刀生效
   */
  /**
   * 動作。interpreter 產生；geometry 轉成 Segment。
   * @typedef {Object} Action
   * @property {'rapid'|'linear'|'arc'|'hole'|'dwell'|'toolchange'|'refReturn'|'stop'|'aicc'|'spindle'|'coolant'|'rotate'|'subCall'} kind
   * @property {Vec3} [from]
   * @property {Vec3} [to]
   * @property {number} [a]                第四軸角度（度）：做這個動作時 A 在幾度。移動類動作一律有
   * @property {number} [aFrom]            這個動作**期間**第四軸有轉動時的起始角度；沒轉就沒有這個欄位
   * @property {string} [axis]             rotate：轉的是哪一個位址（本版固定 'A'）
   * @property {number|null} [feed]        linear/arc：mm/min
   * @property {boolean} [nonLinear]       rapid：多軸同動（各軸獨立速率、非直線）
   * @property {Vec2} [center]             arc：圓心（G17 平面 XY）
   * @property {boolean} [cw]              arc：G2 = true
   * @property {number} [r]                arc：半徑
   * @property {{c:number}|{r:number}} [corner]  ,C / ,R：本動作與下一動作之間插入倒角／圓角（geometry 處理）
   * @property {boolean} [compStart]       本節為 G41/G42 啟動節
   * @property {boolean} [compEnd]         本節為 G40 取消節
   * @property {number} [x]                hole：孔位 X
   * @property {number} [y]                hole：孔位 Y
   * @property {number} [z]                hole：孔底 Z（絕對，已依 G90/G91 換算）
   * @property {number} [rPoint]           hole：R 點 Z（絕對）；實作亦以 `r` 提供（與 arc 的 r 同名，依 kind 判讀）
   * @property {number} [initialZ]         hole
   * @property {number} [q]                hole：啄鑽量
   * @property {number} [p]                hole：停留
   * @property {CycleState['code']} [cycle] hole
   * @property {'G98'|'G99'} [retract]     hole
   * @property {boolean} [rigid]           hole：剛性攻牙
   * @property {number} [seconds]          dwell
   * @property {number} [tool]             toolchange：換入的 T
   * @property {string[]} [axes]           refReturn：回歸的軸（如 ['Z'] 或 ['Y','Z']）
   * @property {Vec3} [via]                refReturn：中間點
   * @property {'M0'|'M1'|'M2'|'M30'} [code] stop
   * @property {boolean} [on]              aicc / coolant
   * @property {'M3'|'M4'|'M5'} [dir]      spindle
   * @property {number|null} [rpm]         spindle
   */
  /**
   * @typedef {Object} ExecutedBlock
   * @property {number} line
   * @property {boolean} skipped        此情境下被 block skip 跳過（before === after，無 actions）
   * @property {boolean} ignored        multiIgnored 情境下多斜線節永遠忽略
   * @property {ModalState} before
   * @property {ModalState} after
   * @property {Action[]} actions
   * @property {number} opIndex         所屬作業（Operation）索引；換刀前 = -1
   */
  /**
   * 作業 = 從某次 M6（或程式開頭）到下一次 M6 之間的區段。
   * @typedef {Object} Operation
   * @property {number} index
   * @property {number|null} tool       T 號
   * @property {string|null} toolComment  M6 行括號註解（如 "12MM"）
   * @property {number|null} h
   * @property {number[]} dList         用到的 D 號
   * @property {number} lineStart
   * @property {number} lineEnd
   * @property {number|null} zMin       切削（linear/arc/hole）最深 Z
   * @property {number[]} feeds
   * @property {number[]} rpms
   * @property {string[]} gCodes        用到的 G 碼（去重）
   * @property {'face'|'contour'|'pocket'|'drill'|'tap'|'ream'|'chamfer'|'unknown'} kindGuess
   */
  /**
   * @typedef {Object} Run
   * @property {SkipScenario} scenario
   * @property {ExecutedBlock[]} executed   與 blocks 一一對應（含 % 行、空行）
   * @property {Operation[]} ops
   * @property {Diagnostic[]} diagnostics   interpreter 負責的規則（見 CONTRACT）
   * @property {ModalState} finalState
   * @property {RotarySummary} rotary       第四軸摘要
   */
  /**
   * 第四軸摘要（CONTRACT §13）。
   * 注意：本版**不做**工件旋轉的座標轉換——Segment 的 XYZ 一律是程式座標，
   * `a` 只是「畫這一段時 A 在幾度」的標記。
   * @typedef {Object} RotarySummary
   * @property {boolean} used            程式裡出現過 A 字組
   * @property {string} axis             位址（本版固定 'A'）
   * @property {'none'|'index'|'simultaneous'} mode
   *   none = 沒用到；index = 分度（轉到角度停住再切）；simultaneous = A 與 XYZ 同時進給的四軸插補
   * @property {number[]} angles         用到的角度（由小到大）
   * @property {number[]} rotateLines    第四軸真的有轉動的行號；長度 0 = 全程沒轉，等同三軸程式
   * @property {number[]} simLines       A 與 XYZ 同時進給的行號
   */

  // ---------------------------------------------------------------------------
  // geometry.js
  // ---------------------------------------------------------------------------
  /**
   * @typedef {Object} Segment
   * @property {number} id
   * @property {number} line
   * @property {number} opIndex
   * @property {number|null} tool
   * @property {'rapid'|'feed'|'arc'|'drill'} kind   drill = 固定循環展開出的進給下刀（含啄鑽、攻牙、鉸孔）
   * @property {Vec3} from
   * @property {Vec3} to
   * @property {{center:Vec2,cw:boolean,r:number}} [arc]
   * @property {number|null} feed
   * @property {'programmed'|'compensated'} path   programmed = 程式路徑；compensated = 刀徑補正後刀心路徑
   * @property {boolean} [nonLinear]
   * @property {boolean} [refReturn]     G28 的移動（視為在空中）
   * @property {boolean} [inserted]      由 ,C/,R 或補正轉角插入、非程式原有
   * @property {'peck'|'retract'|'plunge'|'tapUp'} [sub]  drill 細節
   * @property {number} [a]              畫這一段時第四軸在幾度（**未**套用旋轉轉換，見 RotarySummary）
   * @property {number} [aFrom]          這一段期間第四軸有轉動時的起始角度
   */
  /**
   * @typedef {Object} GeometryResult
   * @property {Segment[]} segments
   * @property {Diagnostic[]} diagnostics   geometry 負責的規則（R10 R11 R12 R22 R23 幾何部分）
   * @property {{min:Vec3,max:Vec3}} bounds  所有 feed/arc/drill 的包絡（不含 rapid）
   */

  // ---------------------------------------------------------------------------
  // tools.js
  // ---------------------------------------------------------------------------
  /**
   * 刀具型式。分四群：銑削類、鑽孔類、攻牙類、其他。
   * 銑削：endmill 平刀｜ballmill 球刀｜bullnose 圓鼻刀｜facemill 面銑刀｜radiusmill 外R成型刀｜
   *       chamfer 倒角刀｜slotmill T型刀｜tapermill 錐度刀｜dovetail 鳩尾槽刀｜lollipop 糖球形銑刀｜engrave 雕刻刀
   * 鑽孔：drill 鑽頭｜reamer 鉸刀｜boring 搪孔刀｜centerdrill 中心鑽｜spot 點鑽｜
   *       countersink 沉頭孔鑽（錐孔）｜counterbore 魚眼孔鑽（平底沉孔）｜wooddrill 木工鑽頭
   * 攻牙：tap 右牙刀（絲攻）｜taplh 左牙刀
   * 其他：unknown 未定義
   * @typedef {'endmill'|'ballmill'|'bullnose'|'facemill'|'radiusmill'|'chamfer'|'slotmill'|'tapermill'
   *   |'dovetail'|'lollipop'|'engrave'|'drill'|'reamer'|'boring'|'centerdrill'|'spot'|'countersink'
   *   |'counterbore'|'wooddrill'|'tap'|'taplh'|'unknown'} ToolType
   */
  /**
   * @typedef {Object} Tool
   * @property {number} t
   * @property {string} label            顯示名稱（註解或 "T15"）
   * @property {ToolType} type
   * @property {number} diameter         mm；絲攻 = 公稱直徑
   * @property {number|null} angle       鑽頭刀尖角／倒角刀夾角／錐度刀與鳩尾刀的錐角（度）
   * @property {number|null} fluteLen    刃長
   * @property {number|null} stickout    伸出長
   * @property {number|null} pitch       絲攻螺距
   * @property {number|null} [cornerRad] 角 R 半徑（圓鼻刀的底部倒角、外R成型刀的成型半徑），mm
   * @property {number|null} [neckDia]   頸徑／導引柱直徑（T型刀、鳩尾槽刀、糖球形銑刀的頸；沉頭與魚眼孔鑽的導柱），mm
   * @property {boolean} resident        常駐刀（跨程式共用，如 T20）
   * @property {boolean} probe           可能是定位器／測距用的空刀位（無註解且無切削）
   * @property {Object<string,ValueSource>} source  每個欄位的值來源：{type,diameter,angle,fluteLen,stickout,pitch,cornerRad,neckDia}
   */
  /**
   * @typedef {Object} OffsetEntry
   * @property {number} n
   * @property {number} lenGeom
   * @property {number} lenWear
   * @property {number} radGeom
   * @property {number} radWear
   * @property {ValueSource} source
   */
  /**
   * @typedef {Object} ToolTable
   * @property {string} programKey       "O1001" 或檔名
   * @property {Tool[]} tools
   * @property {OffsetEntry[]} offsets   只列有用到或有值的 D/H 號
   * @property {string} updatedAt        ISO 日期
   */
  /**
   * @typedef {Object} Stock
   * @property {Vec3} min
   * @property {Vec3} max
   * @property {'user'|'estimated'} source
   * @property {{min:Vec3,max:Vec3,name?:string}[]} fixtures
   */

  // ---------------------------------------------------------------------------
  // settings / rules / simulation / analyze
  // ---------------------------------------------------------------------------
  /**
   * @typedef {Object} MachineSettings
   * @property {string} controller           '0i-D' 等，顯示用
   * @property {boolean} dpi                 3401#0：true = 計算機式小數點（無小數點 = mm）；false = 最小輸入單位
   * @property {number} maxOffsets           補正組數（預設 64）
   * @property {number} lookahead            19625 先讀節數（預設 3）
   * @property {'asSingle'|'ignoreBlock'|'alarm'} multiSlash  多斜線解讀
   * @property {number[]} skipLevelsOn       'on' 情境下哪些等級的開關是開的（預設 [1]）
   * @property {boolean} requireM5BeforeM6
   * @property {boolean} m0StopsSpindle
   * @property {number} rapidRate            mm/min，時間估算用（預設 20000）
   * @property {number} plungeFeedMax        G1 向下 F 超過此值且在材料內 → warning（預設 300）
   * @property {Vec3} refPosition            G28 參考點在工件座標的位置（顯示用，預設 {x:0,y:0,z:150}）
   * @property {{min:Vec3,max:Vec3}|null} softLimits
   * @property {string[]} disabledRules
   * @property {number} dToleranceMm         R15：D 值與刀徑/2 差異容許（預設 0.5）
   */
  /**
   * @typedef {Object} Diagnostic
   * @property {string} id            唯一（ruleId + line + 序號）
   * @property {string} ruleId        'R01'…'R36'
   * @property {number} line          1-based；0 = 整支程式
   * @property {SkipScenario} [scenario]  只在某情境發生時填
   * @property {Severity} severity
   * @property {string} message       一句白話（繁體中文）
   * @property {string} [detail]      這代表什麼／會發生什麼／建議
   * @property {string} [fanucAlarm]  'PS0041' 等
   * @property {{label:string, edits:{line:number, text:string|null}[]}} [fix]  一鍵修正：text=null 表示刪除該行
   * @property {Vec3} [pos]           相關位置（視圖高亮用）
   */
  /**
   * @typedef {Object} SimResult
   * @property {SkipScenario} scenario
   * @property {number} cell           格距 mm（＝cellX；圓棒的周向格距另見 cellY）
   * @property {number} cellX          X 向格距
   * @property {number} cellY          Y 向格距（三軸 = cell；圓棒 = 圓周 / ny，繞一圈剛好接回）
   * @property {boolean} wrapY         Y 向循環（圓棒周向；索引要繞回來）
   * @property {number} nx
   * @property {number} ny
   * @property {Vec2} origin           格 (0,0) 的中心工件座標（節點式：格 (ix,iy) 的中心 = origin + (ix·cell, iy·cell)，查表用 Math.round）
   * @property {boolean} cylinder      四軸圓棒素材（格網是 (X, 弧長)，高度是離軸心的距離）
   * @property {number} [radius]       圓棒：半徑
   * @property {{y:number,z:number}} [center]  圓棒：軸心在工件座標的 Y／Z
   * @property {number} [circumference]  圓棒：圓周
   * @property {Float32Array} height   最終高度，索引 = iy*nx + ix
   * @property {Map<number,number[]>} extra  圓棒：被挖出空洞的格的材料區間 [lo0,hi0,lo1,hi1,…]（升冪）；三軸為空 Map
   * @property {number} floorZ         素材底 Z（圓棒 = 0，軸心）；切穿的格夾在這個值 → 「沒有料」
   * @property {{afterOpIndex:number, tool:number|null, height:Float32Array, extra:Map<number,number[]>}[]} snapshots
   * @property {Diagnostic[]} events   碰撞／切入事件（R27 R28 的模擬判定）
   * @property {{perOp:number[], total:number, pre:number}} time   秒；pre = 第一個作業之前（換刀前）的時間
   * @property {Uint8Array} mask       每格所屬治具（0 = 不是治具；n = stock.fixtures[n-1]），與 Sim 共用同一份
   * @property {Stock} stock           實際用的素材
   * @property {number} removedVolume  移除的材料體積 mm³
   */
  /**
   * @typedef {Object} Scrap  廢料判定的設定。跟程式一起存在 localStorage 的素材項目裡；第一版不進 AnalysisRequest
   * @property {'auto'|'origin'|'largest'|'fixture'|'marks'} anchor  哪一塊是工件：
   *   auto＝原點 (0,0) 所在的塊，原點不在任何塊上就取最大塊；origin＝同 auto（保留給日後分家）；largest＝面積最大的塊；
   *   fixture＝四鄰碰到夾具格的塊都是工件（一塊也沒碰到 → 退回 auto）；
   *   marks＝只看記號：沒被標的塊——有任何 ⊙ 時算廢料、只有 ✕ 時算工件、完全沒記號 → 退回 auto
   * @property {{x:number,y:number,kind:'part'|'scrap'}[]} marks  圖上點的記號（工件座標）。每種 anchor 下都優先：含 ⊙(part) 一定是工件、含 ✕(scrap) 一定是廢料（同塊兩種都有 → ⊙ 贏）
   * @property {number} skinMm      剩餘厚度 ≤ 此值就當沒料（現場留薄皮再敲掉／磨掉的填 0.2～0.5）；normalizeScrap 夾在 0～1000
   * @property {number} bridgeMm    細於此寬度的連接算斷：侵蝕 round(bridgeMm/(2·cell)) 格再標號、再長回來；0 = 只看有沒有切穿。
   *   normalizeScrap 夾在 0～50（侵蝕是 O(k·n)，上限是為了不讓手滑的大數字凍住主執行緒）；
   *   核心被吃光又沒鄰塊可長回來的孤立塊會重新標號成獨立的塊——每個實料格最後都有標號
   * @property {number} minAreaMm2  小於此面積的塊不分類（label 維持 0、畫成一般材料）；normalizeScrap 夾在 0～1e6
   */
  /**
   * @typedef {Object} Chunk  一塊四鄰連通的實料
   * @property {number} label        1..N，等於在 ChunkResult.chunks 裡的索引 + 1
   * @property {number} cells        格數
   * @property {number} areaMm2      cells · cellX · cellY
   * @property {{x0:number,y0:number,x1:number,y1:number}} bbox  格中心的工件座標範圍（不外擴半格）
   * @property {number} zMin         這塊裡最低的頂面
   * @property {number} zMax
   * @property {boolean} part        true = 工件、false = 廢料
   * @property {boolean} touchesFixture  四鄰有夾具格
   * @property {'origin'|'largest'|'fixture'|'mark'|'scrapMark'|'unmarked'|'other'} why  怎麼判的（hover 提示用）：
   *   origin/largest/fixture = 依 anchor 選中的工件；mark = 有 ⊙；scrapMark = 有 ✕；unmarked = anchor 'marks' 下沒被標的塊；other = 依 anchor 沒選中 → 廢料
   */
  /**
   * @typedef {Object} ChunkResult  NC.sim.chunks 的結果
   * @property {boolean} supported   false = 四軸圓棒（其餘欄位是空值：labels null、chunks []、計數 0）
   * @property {Int32Array|null} labels  每格所屬的塊（0 = 沒料／夾具格／太小的塊），索引同 height
   * @property {Chunk[]} chunks
   * @property {number} partCount
   * @property {number} scrapCount
   * @property {number} scrapAreaMm2
   * @property {boolean|null} partTouchesFixture  任一工件塊碰到夾具；格網裡沒有夾具格、或一塊工件都沒有（partCount 0，例如每塊都被 ✕）時 null
   *   （UI 用 === false 提示「切斷後會掉落」——沒有工件就沒有東西會掉，不能是 false）
   * @property {boolean} hasFixture  格網裡有夾具格
   */
  /**
   * @typedef {Object} AnalysisRequest
   * @property {string} text
   * @property {MachineSettings} settings
   * @property {ToolTable|null} toolTable     null = 用推測
   * @property {Stock|null} stock             null = 用推估
   * @property {SkipScenario[]} scenarios     預設 ['off','on']
   * @property {{enabled:boolean, cell:number}} sim
   */
  /**
   * @typedef {Object} ScenarioResult
   * @property {Run} run
   * @property {GeometryResult} geometry
   * @property {SimResult|null} sim
   */
  /**
   * @typedef {Object} AnalysisResult
   * @property {TokenizeResult} tok
   * @property {Object<string,ScenarioResult>} scenarios   key = SkipScenario
   * @property {ToolTable} toolTable        實際使用的（推測 + 使用者合併後）
   * @property {Stock} stock                實際使用的
   * @property {Diagnostic[]} diagnostics   全部（tokenizer + interpreter + geometry + rules + sim events）去重排序後
   */

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  const EPS = 1e-6;
  NC.EPS = EPS;
  NC.util = {
    v3: (x, y, z) => ({ x, y, z }),
    clone3: (p) => ({ x: p.x, y: p.y, z: p.z }),
    eq: (a, b, eps = EPS) => Math.abs(a - b) <= eps,
    eq3: (a, b, eps = EPS) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps,
    dist2: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
    dist3: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
    round: (v, d = 4) => { const m = Math.pow(10, d); return Math.round(v * m) / m; },
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    // 去尾 0：'-80.500' → '-80.5'、'80.000' → '80'（整數不留小數點）
    fmt: (v, d = 3) => (v == null || Number.isNaN(v)) ? '—' : (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''),
    /** 產生 Diagnostic 的輔助函式 */
    diag: (ruleId, line, severity, message, extra) => Object.assign({ id: `${ruleId}:${line}:${Math.random().toString(36).slice(2, 7)}`, ruleId, line, severity, message }, extra || {}),
    /** 預設機台設定 */
    defaultSettings: () => ({
      controller: '0i-D', dpi: false, maxOffsets: 64, lookahead: 3, multiSlash: 'asSingle', skipLevelsOn: [1],
      requireM5BeforeM6: false, m0StopsSpindle: true, rapidRate: 20000, plungeFeedMax: 300,
      refPosition: { x: 0, y: 0, z: 150 }, softLimits: null, disabledRules: [], dToleranceMm: 0.5,
      /**
       * 第四軸（A 繞 X）。只有程式真的用到 A 才有作用。
       *   center  迴轉中心線在工件座標的 Y／Z。預設 (0,0) = G54 的 Y0/Z0 對到夾頭中心線（四軸裝夾慣例）；
       *           若現場把 Z0 對在圓棒最頂端，這裡要填 z = −半徑。
       *   radius  工件半徑（畫圓棒、展開圖縱軸換算用）。0 = 由程式推估。
       */
      rotary: { center: { y: 0, z: 0 }, radius: 0 },
    }),
    /** 深拷貝（純資料） */
    deepClone: (o) => JSON.parse(JSON.stringify(o)),
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
