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
   * @property {boolean} lengthCompActive    G43 已在此刀生效
   */
  /**
   * 動作。interpreter 產生；geometry 轉成 Segment。
   * @typedef {Object} Action
   * @property {'rapid'|'linear'|'arc'|'hole'|'dwell'|'toolchange'|'refReturn'|'stop'|'aicc'|'spindle'|'coolant'} kind
   * @property {Vec3} [from]
   * @property {Vec3} [to]
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
  /** @typedef {'endmill'|'facemill'|'drill'|'chamfer'|'reamer'|'tap'|'spot'|'ballmill'|'unknown'} ToolType */
  /**
   * @typedef {Object} Tool
   * @property {number} t
   * @property {string} label            顯示名稱（註解或 "T15"）
   * @property {ToolType} type
   * @property {number} diameter         mm；絲攻 = 公稱直徑
   * @property {number|null} angle       鑽頭刀尖角／倒角刀夾角（度）
   * @property {number|null} fluteLen    刃長
   * @property {number|null} stickout    伸出長
   * @property {number|null} pitch       絲攻螺距
   * @property {boolean} resident        常駐刀（跨程式共用，如 T20）
   * @property {boolean} probe           可能是定位器／測距用的空刀位（無註解且無切削）
   * @property {Object<string,ValueSource>} source  每個欄位的值來源：{type,diameter,angle,fluteLen,stickout,pitch}
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
   * @property {number} cell           格距 mm
   * @property {number} nx
   * @property {number} ny
   * @property {Vec2} origin           格 (0,0) 的中心工件座標（節點式：格 (ix,iy) 的中心 = origin + (ix·cell, iy·cell)，查表用 Math.round）
   * @property {Float32Array} height   最終高度，索引 = iy*nx + ix
   * @property {number} floorZ         素材底 Z
   * @property {{afterOpIndex:number, tool:number|null, height:Float32Array}[]} snapshots
   * @property {Diagnostic[]} events   碰撞／切入事件（R27 R28 的模擬判定）
   * @property {{perOp:number[], total:number}} time   秒
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
    }),
    /** 深拷貝（純資料） */
    deepClone: (o) => JSON.parse(JSON.stringify(o)),
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
