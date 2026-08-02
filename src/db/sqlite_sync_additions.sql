-- Orun OS — SQLite additions for hybrid sync
-- Run these against your EXISTING sqlite.db. They only ADD columns/tables —
-- nothing here touches your current data or the rowid-based ordering fix.
--
-- Already ran an earlier version of this script (before `next_attempt_at`
-- existed)? Just run this one line on its own, then skip to the rest:
--   ALTER TABLE sync_queue ADD COLUMN next_attempt_at TEXT;

-- 1) Add sync bookkeeping columns to existing tables.
--    SQLite has no "ADD COLUMN IF NOT EXISTS", so wrap each in your migration
--    runner's "if not exists" check, or run once and ignore duplicate-column
--    errors on re-run.

ALTER TABLE conversations ADD COLUMN updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'));
ALTER TABLE conversations ADD COLUMN deleted_at TEXT;

ALTER TABLE messages ADD COLUMN updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'));
ALTER TABLE messages ADD COLUMN deleted_at TEXT;

-- If your `messages` table doesn't already have a per-conversation sequence
-- column (the rowid fix used SQLite's own rowid, which doesn't exist in
-- Postgres) add one now — it becomes the real ordering key going forward:
ALTER TABLE messages ADD COLUMN seq INTEGER;

-- 2) Outbox — every local write that must eventually reach Supabase gets
--    queued here instead of calling the network directly. Classic outbox
--    pattern: reliable even if the sync worker is offline or the app is
--    force-quit mid-write.
CREATE TABLE IF NOT EXISTS sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,          -- 'conversations' | 'messages' | 'usage_events' | 'tts_usage' | 'automations' | 'agents'
  record_id TEXT NOT NULL,           -- uuid, matches the row's `id` in both stores
  op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  payload TEXT,                      -- JSON snapshot of the row at enqueue time (null for delete)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,              -- exponential backoff: NULL means "try on the next cycle"
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_created_at ON sync_queue (created_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_next_attempt ON sync_queue (next_attempt_at);

-- 3) Pull bookmark — last time each table was successfully pulled FROM
--    Supabase, so incremental pulls only fetch rows changed since then.
CREATE TABLE IF NOT EXISTS sync_meta (
  table_name TEXT PRIMARY KEY,
  last_pulled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
);
