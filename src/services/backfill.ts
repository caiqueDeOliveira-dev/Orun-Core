import type Database from "better-sqlite3";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncableTable } from "./outbox";

const TABLES: SyncableTable[] = [
  "agents",
  "conversations",
  "messages",
  "usage_events",
  "tts_usage",
  "automations",
];

const BATCH_SIZE = 500;

export interface BackfillProgress {
  table: SyncableTable;
  pushed: number;
  total: number;
}

/**
 * One-time migration: pushes every existing row in the local SQLite tables
 * up to Supabase, in batches, BEFORE the regular sync loop starts.
 *
 * Run this once, manually, the first time you turn sync on. Do NOT run it
 * on every app start — it re-upserts everything every time, which is
 * harmless but wasteful once the regular SyncService has taken over.
 *
 * Usage:
 *   await backfill(db, supabase, (p) => console.log(`${p.table}: ${p.pushed}/${p.total}`));
 */
export async function backfill(
  db: Database.Database,
  supabase: SupabaseClient,
  onProgress?: (progress: BackfillProgress) => void
) {
  for (const table of TABLES) {
    const total = (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
    let pushed = 0;

    // Batch by rowid range so we don't hold a huge result set in memory
    // for tables with a lot of history (messages, usage_events).
    while (pushed < total) {
      const rows = db
        .prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(BATCH_SIZE, pushed) as any[];

      if (rows.length === 0) break;

      // Supabase columns must match exactly — drop any local-only columns
      // (e.g. a legacy autoincrement id) that don't exist in the Postgres
      // schema before upserting. Adjust this per your real local schema.
      const cleaned = rows.map((row) => sanitizeForSupabase(row));

      const { error } = await supabase.from(table).upsert(cleaned, { onConflict: "id" });
      if (error) {
        throw new Error(`Backfill failed on ${table} (offset ${pushed}): ${error.message}`);
      }

      pushed += rows.length;
      onProgress?.({ table, pushed, total });
    }
  }

  // After a full backfill, bookmark "now" for every table so the regular
  // SyncService's incremental pull doesn't immediately re-fetch everything
  // it just received (it already matches).
  const now = new Date().toISOString();
  const upsertMeta = db.prepare(
    `INSERT INTO sync_meta (table_name, last_pulled_at) VALUES (?, ?)
     ON CONFLICT(table_name) DO UPDATE SET last_pulled_at = excluded.last_pulled_at`
  );
  const tx = db.transaction(() => {
    for (const table of TABLES) upsertMeta.run(table, now);
  });
  tx();
}

/** Strip fields that don't map 1:1 to the Postgres schema (extend as needed). */
function sanitizeForSupabase(row: Record<string, any>) {
  const { rowid, ...rest } = row;
  return rest;
}
