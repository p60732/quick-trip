# 說走就走－出發吧

路過找吃、給一個地點就排出吃喝玩行程、3–6 人一起揪團規劃。

- 前端：GitHub Pages（`index.html` + `group.js`），不用付費 API
- 揪團後端：Google Apps Script + Google 試算表（`gas/Code.gs`），每月 $0

## 不用帳號就能用的
路過找吃、直接出發（填單 → 提示詞 → 貼回 → 行程表）、吃喝玩偏好、用餐模板、我的行程、當天模式、編輯、分享匯出。資料存在這支手機。

## 揪團（要登入）
清單加點、按讚 → 開團人挑點、請自己的 AI 排 → 貼回 → 候補 → 定案 → 分工 → 分帳結清 → 封存。

## 部署

### 1. 後端（Google Apps Script）
1. 新建一個 Google 試算表，取名「出發吧資料」
2. 擴充功能 → Apps Script，把 `gas/Code.gs` 整份貼進去，存檔
3. 上方函式選 `setup` → 執行（第一次要授權）。執行紀錄會印出「第一個帳號的邀請碼」，先記下來
4. 部署 → 新增部署作業 → 齒輪選「網頁應用程式」
   - 執行身分：我
   - 誰可以存取：所有人
5. 複製「網頁應用程式網址」（…/exec 結尾）
6. 函式選 `installTriggers` → 執行，開啟每週一 03:00 備份（保留 8 份，失敗寄信）

### 2. 前端（GitHub Pages）
1. 打開 `index.html`，把最上面的 `const API_URL = '';` 改成剛剛的網址
2. 整個資料夾推到 GitHub repo `letsgo`，Settings → Pages 選 main 分支根目錄
3. 打開 `https://<帳號>.github.io/letsgo/#join/<第一個帳號的邀請碼>`，建立你的帳號
4. iPhone：Safari 分享 → 加入主畫面

### 之後改後端
改 Code.gs 後：部署 → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署。網址不會變。

## 可以調的設定（試算表的 Settings 分頁）
| key | 預設 | 意思 |
| --- | --- | --- |
| maxUsers | 60 | 全站帳號上限，滿了邀請連結會顯示名額已滿 |
| maxOwnedTrips | 3 | 每人同時開幾個進行中的團 |
| maxPeople | 6 | 每團最多幾人 |
| sessionDays | 60 | 多久沒用要重新登入 |
| restoreDays | 30 | 取消的團幾天內可以還原 |

停用某個帳號：Users 分頁把那個人的 `disabled` 改成 TRUE。

## 本機測試
- `node test/apitest.js`：在 Node 裡模擬 Apps Script 跑後端測試（含分帳算法）
- `node test/mockgas.js`：本機開 http://localhost:8766 ，前端自動接上模擬後端，可以開兩個瀏覽器當不同人測
