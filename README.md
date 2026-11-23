# 桃園活動雷達

收集桃園各地的活動、展覽、表演、親子課程，放在一個手機網頁 App 裡；有新活動、或收藏的活動快開放報名時，iPhone 和電腦都會跳通知。

## 怎麼運作

```
GitHub Actions（每 30 分鐘）──抓 10 個來源──▶ data/events.json（存回這個 repo）
                                                    │
Render 免費主機（server/）◀──每 5 分鐘讀一次──────────┘
  ├─ 網頁 App（public/）：活動列表、搶報名、收藏、手動加入、設定
  ├─ 每分鐘檢查：新活動通知、收藏活動的報名提醒 ──▶ Web Push ──▶ iPhone／電腦
  └─ 訂閱、收藏、手動加入的活動 ──▶ 私密 GitHub Gist（免費主機沒有硬碟）
cron-job.org（每分鐘打 /api/tick）讓免費主機不要睡著，提醒才會準時
```

## 第一版的資料來源

| 來源 | 內容 |
|---|---|
| 桃園觀光導覽網 | 市府節慶活動 |
| 觀光署活動 | 全國節慶資料庫（篩桃園） |
| 藝文設施管理中心 | 桃園展演中心、中壢藝術館、光影文化館、藝文廣場、A8、陽光劇場 |
| 文化部藝文活動 | 全國藝文資料庫（篩桃園） |
| 桃園市府線上報名 | 文化局、農業局、客家局、原民局、婦幼局、地政局 |
| 親子館報名 | 桃園育兒資源網，含開放報名時間和剩餘名額 |
| 水務局參訪預約 | 水の秘密基地（每月 15 日 10:00 開放下個月） |
| 中原文創園區 | 園區活動 |
| KKTIX | 售票活動 |
| Accupass | 手作、講座 |

同一個活動出現在好幾個來源會自動合併。抓不到的（FB、IG 小店）用 App 裡的「新增」貼文字手動加入。

## 本機開發

```bash
npm install
npm run scrape            # 抓一次，寫到 data/
node tools/make-icons.js  # 重做圖示（需要時）
npm test
npm run dev               # http://localhost:8787
```

推播要有 VAPID 金鑰：`node -e "console.log(require('web-push').generateVAPIDKeys())"`，放到 `.env.local`，
用 `node --env-file=.env.local server/server.js` 啟動。本機沒設 Gist 時，狀態存在 `data-local/state.json`。

## 上線步驟

1. **GitHub**：把這個資料夾推到一個**公開**的 repo（公開 repo 的 Actions 不限時數）。到 Actions 分頁按「抓取活動 → Run workflow」先跑一次。
2. **Gist**：到 https://gist.github.com 建一個 **Secret gist**，檔名 `state.json`、內容 `{}`。網址最後那串就是 `GIST_ID`。
3. **Token**：GitHub → Settings → Developer settings → Fine-grained tokens（或 classic token）只勾 **gist** 權限，得到 `GIST_TOKEN`。
4. **Render**：New → Blueprint，選這個 repo（會讀 `render.yaml`），填環境變數：
   - `EVENTS_URL` = `https://raw.githubusercontent.com/<帳號>/<repo>/main/data/events.json`
   - `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`（上面產生的，換了金鑰所有人都要重新開啟通知）
   - `GIST_ID`、`GIST_TOKEN`
   - `MANUAL_KEY`（選填，手動加入的密碼）
5. **cron-job.org**：免費註冊，新增排程每 1 分鐘打 `https://<你的網址>.onrender.com/api/tick`。

## iPhone 怎麼收到通知

iOS 16.4 以上。用 Safari 打開網址 → 分享 → 加入主畫面 → 從主畫面圖示打開 → 設定 → 開啟通知。
刪掉主畫面圖示的話訂閱會失效，要重新加入。

## 限制

- 通知時間：新活動最慢約 30–45 分鐘（抓取間隔＋讀取快取）；收藏活動的報名提醒在 1 分鐘內。
- 市府網站短時間連太多次會擋，抓取程式同一個網站每次請求間隔 1.5 秒。
- 網站改版時，對應的抓取程式要跟著修；「設定 → 資料來源」可以看到哪個來源失敗。
