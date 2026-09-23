# 說走就走小旅行

選一個想去的點 → 網頁產生提示詞 → 貼到 Claude → 把回答貼回來 → 排成含交通、景點、餐廳、預算、住宿的時間表，每站附 Google 地圖與導航連結。

- 純前端、無後端、無金鑰；行程只存在自己瀏覽器的 localStorage。
- 積木：js/logic.js（純函式：提示詞、解析、預算、地圖連結）／js/ui.js（畫面，只用 textContent）。
- 測試：node tests/logic.test.js（規則層）、node tests/ui.test.js（Playwright）。
- 改完 CSS/JS 後跑 node build.js 更新 ?v= 內容雜湊。
