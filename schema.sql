-- Cloudflare D1 資料表
CREATE TABLE IF NOT EXISTS subs (
  id TEXT PRIMARY KEY,          -- 訂閱網址的雜湊
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  prefs TEXT NOT NULL,          -- JSON
  ua TEXT,
  created TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stars (
  sub_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ev TEXT NOT NULL,             -- 收藏時的活動快照（JSON），活動資料更新時會跟著更新
  PRIMARY KEY (sub_id, event_id)
);
CREATE INDEX IF NOT EXISTS stars_event ON stars (event_id);

CREATE TABLE IF NOT EXISTS sent (
  key TEXT PRIMARY KEY,         -- 訂閱|活動|提醒種類，避免重複發
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- 配對碼同步：同一個配對碼的手機和電腦共用已讀、刪除、收藏狀態
CREATE TABLE IF NOT EXISTS sync (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL,           -- JSON：{ opened:[], deleted:[], starred:[], baseline }
  updated TEXT NOT NULL
);
