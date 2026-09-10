# 參與這個專案

## 回報問題

工具頂列點「ⓘ 關於」看版本號，**回報時附上它** —— 才知道你手上是哪一版、修過的有沒有進去。

- 有 GitHub 帳號 → [開 issue](https://github.com/JLJimmyH/0827_yuan/issues/new/choose)
- 沒有 → 「關於」裡有信箱，信件模板會自動帶上版本號與瀏覽器

**不要貼完整的加工程式**，那通常是公司機密；貼出問題的那幾行就夠了。

## 開發

Node 22 以上。沒有 `package.json`、沒有 npm 相依、沒有建置流程 —— clone 下來就能跑。

```bash
cd nc-preview
node --test "test/*.test.mjs"        # 全部測試（單一模組：test/rules.test.mjs）
node tools/check-samples.mjs         # 示範程式不能有 error
node tools/shot.mjs                  # headless 截圖，順便抓 console 錯誤
```

瀏覽器直接開 `nc-preview/index.html` 就是完整的工具（`file://` 也可以）。

### 送 PR 之前

1. `node --test "test/*.test.mjs"` 全過。
2. 改過 `samples/` 的話跑 `node tools/make-samples.mjs` 重新產生 `js/ui/samples.js`（CI 會檢查這兩者同步）。
3. 改核心模組（`js/core/*`）前先讀 [`nc-preview/docs/CONTRACT.md`](nc-preview/docs/CONTRACT.md)，尤其最後一節「整合決議」—— 那些是踩過坑之後定下來的規則，不是隨手寫的偏好。

### 這個專案的兩個硬規則

- **不連外。** 沒有 CDN、沒有字型 CDN、沒有分析工具。使用者的加工程式不離開他的電腦，這是這個工具存在的前提。
- **不加 npm 相依。** 純前端、開檔案就能用；現場的電腦不一定裝得了東西、也不一定能上網。

### 測試怎麼寫

核心模組（`js/core/*`）是純函式，直接測。UI 模組（`panels`、`editor`、`view2d`、`view3d`）用測試檔裡自帶的極小假 DOM 測純邏輯，不需要瀏覽器。

`test/fixtures/` 放的是實際生產程式、不進版控；沒有那個目錄時 golden test 整組自動 skip，其餘照跑（CI 上就是這樣）。

## 授權

送出的貢獻視為以 [GPL-3.0](LICENSE) 授權。
