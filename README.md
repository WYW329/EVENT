# 活動雷達

收集各地的活動、展覽、表演、親子課程，放在一個手機網頁 App 裡；有新活動、或收藏的活動快開放報名時，iPhone 和電腦都會跳通知。

網址：https://event-radar.taoyuan-events.workers.dev

## 怎麼運作

```
GitHub Actions（每 30 分鐘）──抓 10 個來源──▶ data/events.json（存回這個 repo）
                                                    │
Cloudflare Worker（src/）◀──從 GitHub 讀──────────────┘
  ├─ 網頁 App（public/）：活動列表、搶報名、收藏、設定
  ├─ 每分鐘排程：新活動通知、收藏活動的報名提醒 ──▶ Web Push ──▶ iPhone／電腦
  └─ 訂閱、收藏 ──▶ Cloudflare D1 資料庫
```

## 資料來源

| 來源 | 內容 |
|---|---|
| 桃園觀光導覽網 | 市府節慶活動 |
| 觀光署活動 | 全國節慶資料庫（篩桃園） |
| 藝文設施管理中心 | 6 個場館的節目；入場方式（索票＝免費）、開放索票日 |
| 文化部藝文活動 | 全國藝文資料庫（篩桃園） |
| 桃園市府線上報名 | 文化局、農業局、客家局、原民局、婦幼局、地政局 |
| 親子館報名 | 桃園育兒資源網，含開放報名時間和剩餘名額 |
| 水務局參訪預約 | 水の秘密基地（每月 15 日 10:00 開放下個月） |
| 中原文創園區 | 園區活動 |
| KKTIX | 售票活動，含開賣時間和票價 |
| Accupass | 手作、講座 |

同一個活動出現在好幾個來源會自動合併。一個活動可以有好幾個類別，免費的會多一個「免費」類別。

## 本機開發

```bash
npm install
npm run scrape   # 抓一次，寫到 data/
npm test
npm run dev      # wrangler dev，http://localhost:8787
```

本機要有 `.dev.vars`（內容 `VAPID_PRIVATE_KEY=...`），本機資料庫第一次要建表：
`npx wrangler d1 execute event-radar --local --file=schema.sql`。
觸發排程：`curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`。

## 部署

```bash
npx wrangler login     # 只要第一次
npx wrangler deploy
```

- 推播公鑰寫在 `wrangler.toml`，私鑰是 secret：`npx wrangler secret put VAPID_PRIVATE_KEY`。換了金鑰所有人都要重新開啟通知。
- 資料表在 `schema.sql`，改了要對線上執行：`npx wrangler d1 execute event-radar --remote --file=schema.sql`。
- 活動資料不用部署：GitHub Actions 更新 repo 裡的 `data/` 後，Worker 下一分鐘就會讀到。

## iPhone 怎麼收到通知

iOS 16.4 以上。用 Safari 打開網址 → 分享 → 加入主畫面 → 從主畫面圖示打開 → 設定 → 開啟通知。
刪掉主畫面圖示的話訂閱會失效，要重新加入。

## 限制

- 新活動通知最慢約 30–45 分鐘（抓取間隔）；收藏活動的報名提醒在 1 分鐘內。
- 市府網站短時間連太多次會擋，抓取程式同一個網站每次請求間隔 1.5 秒。
- 網站改版時對應的抓取程式要跟著修；「設定 → 資料來源」可以看到哪個來源失敗。
- Cloudflare 免費方案每次執行的運算時間很短，所以抓取放在 GitHub Actions，Worker 只負責網頁和通知。
