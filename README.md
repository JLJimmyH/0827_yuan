# 銑床預演台

Fanuc 加工中心 G-code 的預演與檢錯工具。把 NC 程式丟進去，看到刀具路徑、素材被切成什麼樣子，以及程式裡可能出事的地方。純前端，程式檔不離開瀏覽器。

**線上使用：https://jljimmyh.github.io/0827_yuan/**

## 用法

選內建範例，或把 NC 檔拖進視窗。右下「錯誤清單」看結果 —— 37 條規則涵蓋語法、模態衝突、刀徑補正、固定循環、剛性攻牙、block skip 情境差異、撞刀風險、切削條件。

用到 G41／G42 的程式要在「刀具表」填 D 值；素材沒填會用切削範圍往外推估，靠素材的檢查只給警告。

**完整說明**（操作、廢料判定、四軸、網址參數、檔案結構、已知限制）看 [nc-preview/README.md](nc-preview/README.md)。

## 限制

只吃**銑床／加工中心**的 G-code，車床不支援（G 代碼體系不同）。

不是機台模擬器：刀長補正（H）視為 0、G54–G59 當成同一原點、只支援 G17 平面、不模擬加減速與前瞻。**上機前的 dry run 照做。**

## 本機執行

無建置流程、無套件相依。瀏覽器直接開 `nc-preview/index.html`（`file://` 也可以）。

```bash
cd nc-preview
node --test "test/*.test.mjs"        # 測試
node tools/check-samples.mjs         # 示範程式不能有 error
```

模組介面規範在 [nc-preview/docs/CONTRACT.md](nc-preview/docs/CONTRACT.md)，改核心模組前先讀。

## 授權

[GPL-3.0](LICENSE)。可以自由使用、修改、散布；但把修改過的版本散布出去時，必須同樣以 GPL-3.0 公開原始碼。

Copyright (C) 2026 Jimmy

## 贊助

贊助一杯咖啡讓工程師可以繼續熬夜改 code 🥹：

<a href="https://buymeacoffee.com/chenggg0605"><img src="nc-preview/img/bmc-qr.png" alt="Buy Me a Coffee QR code" width="180"></a>

[buymeacoffee.com/chenggg0605](https://buymeacoffee.com/chenggg0605)

問題回報看工具裡的「關於」（點頂列標題），或是直接從 issue 給我 ~
