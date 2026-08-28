# NC 預演台

Fanuc 加工中心 G-code 的預演與檢錯工具。把 NC 程式丟進去，看到刀具路徑、素材被切成什麼樣子，以及程式裡可能出事的地方。純前端，程式檔不會離開瀏覽器。

**線上使用：https://jljimmyh.github.io/0827_yuan/**

## 用法

選內建範例，或把 NC 檔拖進視窗。右下「錯誤清單」看檢查結果 —— 36 條規則涵蓋語法、模態衝突、刀徑補正、固定循環、剛性攻牙、block skip 情境差異、撞刀風險、切削條件。

用到 G41/G42 的程式，到「刀具表」分頁填 D 值；素材尺寸沒填會用切削範圍往外推估。

完整說明（每個面板在做什麼、網址參數、架構）看 [nc-preview/README.md](nc-preview/README.md)。

## 限制

不是機台模擬器。刀長補正（H）視為 0、G54–G59 當成同一原點、只支援 G17 平面、不模擬加減速與前瞻。**上機前的 dry run 照做。**

## 本機執行

無建置流程、無套件相依。用瀏覽器直接開 `nc-preview/index.html` 就能跑（`file://` 也可以）。

```bash
cd nc-preview
node --test "test/*.test.mjs"        # 單元測試
node tools/check-samples.mjs         # 確認 samples/ 的示範程式沒有 error
```

內建的示範程式在 `nc-preview/samples/`，改過之後跑 `node tools/make-samples.mjs` 重新產生 `js/ui/samples.js`。

`nc-preview/test/fixtures/` 放的是實際生產程式，不進版控；沒有那個目錄的時候 golden test 整組自動 skip，其餘測試照跑。

模組介面規範在 [nc-preview/docs/CONTRACT.md](nc-preview/docs/CONTRACT.md)，改核心模組前先讀。
