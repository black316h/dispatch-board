# 派工看板（Dispatch Board）

小團隊現場派工/排程工具。用 LINE 打字或網頁按鈕新增工作，技師用手機開網頁看當週派工，按負責人分色、多日工程橫跨標示、同一人撞期自動亮「⚠ 衝突」。

## 架構

```
LINE 打字 ─────┐
               ├──→ Apps Script（免費後端）──→ Google Sheet ──讀──→ GitHub Pages 看板
網頁「＋新增」──┘
```

- **Google Sheet** — 資料庫，所有派工都是一列。
- **Apps Script** — 免費後端，接 LINE webhook 與網頁新增，負責解析、寫入。LINE 文字用雲端 Gemini 解析（免逗號、聽得懂相對日期）；失敗會自動退回規則解析。
- **GitHub Pages** — 只負責顯示（唯讀），讀 Sheet 發布的 CSV。

> 這層註定是雲端的：LINE 要從公網送訊息進來，後端不能放在 air-gapped 內網。內部 CAD／庫存維持離線，只有「誰去哪」這層上雲。

## 檔案結構

```
dispatch/
├── index.html            # 前端看板 → 上傳 GitHub Pages（公開）
├── apps-script/
│   └── Code.gs           # 後端 → 貼到 Google Apps Script（不公開原始碼）
├── README.md
└── .gitignore
```

## 需要準備

- Google 帳號（Sheet + Apps Script）
- LINE Official Account / Messaging API channel（免費）
- Gemini API key（Google AI Studio 免費取得，可選；不填則用規則解析）
- GitHub 帳號（放 Pages）

## 設定與部署

### A. Google Sheet
1. 新增一張試算表，第一列標題照欄序：`日期  結束  客戶  地點  類型  負責人  狀態  備註`
2. 記下網址 `/d/` 後面那串 = **SHEET_ID**。
3. 檔案 → 共用 → **發布到網路** → 選工作表、格式 **CSV** → 發布 → 複製連結（給 index.html 用）。

### B. Apps Script（後端）
1. 到 <https://script.new>，把 `apps-script/Code.gs` 內容貼進去。
2. **專案設定（齒輪）→ 指令碼屬性**，新增：
   | 名稱 | 值 |
   |---|---|
   | `SHEET_ID` | 你的 Sheet ID |
   | `SHEET_NAME` | 分頁名稱（例：工作表1） |
   | `LINE_TOKEN` | LINE Channel access token（B 步驟拿到後再填） |
   | `GEMINI_KEY` | Gemini API key（可留空） |
3. **部署 → 新增部署作業 → 網頁應用程式**，執行身分＝你自己，存取權＝**任何人**，複製 `…/exec` 網址。
   > 金鑰都在指令碼屬性，不在程式碼裡，所以這支檔案可以安全進 git。

### C. LINE
1. LINE Developers 建一個 Messaging API channel。
2. Messaging API 設定 → 發 **Channel access token**，填回指令碼屬性的 `LINE_TOKEN`，重新部署 Apps Script。
3. **Webhook URL** 填 Apps Script 的 `…/exec`，開啟「使用 Webhook」，關掉「自動回覆」。
4. 用 QR code 把這個官方帳號加為好友。

### D. GitHub Pages（前端）
1. 編輯 `index.html` 最上面兩行：
   - `SHEET_CSV_URL` = A 步驟的 CSV 連結
   - `APPS_SCRIPT_URL` = B 步驟的 `…/exec` 網址
2. 推上 GitHub，Settings → Pages 開啟，網址給技師。

## Sheet 欄位

| 欄 | 必填 | 說明 |
|---|---|---|
| 日期 | ✔ | 開始日，`2026-06-15` |
| 結束 | | 多日才填；單日留空 |
| 客戶 | ✔ | 建議用代號（A公司）避免外洩客戶名 |
| 地點 | | 例：台中 |
| 類型 | | 維修／配線／安裝／調機／試車 |
| 負責人 | ✔ | 看板據此分色與偵測撞期 |
| 狀態 | | 待辦／進行中／完成 |
| 備註 | | |

## LINE 用法

直接打，不用逗號：

- `明天 客戶A 維修 阿明`
- `下週三 客戶B 台中 配線 阿華`
- `7/1到7/3 客戶C 高雄 安裝 阿強`

打 `說明` 會回傳格式提示。機器人會回一則確認訊息（reply 不吃推播額度）。

## 在 Claude Code 裡開發

把這個資料夾用 Claude Code 開啟，之後改東西用講的就好，例如：

- 「index.html 看板加上『只看今天、只看我的工作』的預設視圖」
- 「Code.gs：已完成的工作自動標灰、排到最後」
- 「幫我 git commit 並 push」 → GitHub Pages 收到 push 會自動重新部署

`Code.gs` 在 Google 雲端，若想連後端也納入版本控管，可用 Google `clasp` 把它跟本資料夾雙向同步。

## 安全 / 隱私

- 金鑰只放 Apps Script 指令碼屬性，**不要寫進會公開的檔案**。
- `index.html` 裡的 CSV 連結與 `/exec` 網址會出現在公開頁面上（前端必然如此）。客戶名建議用代號；網址只貼在內部群組、不外流。
