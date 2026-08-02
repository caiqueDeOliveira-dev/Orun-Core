import Database from "better-sqlite3";

/**
 * A fresh in-memory SQLite database with the same shape as what
 * `sqlite_sync_additions.sql` would produce on top of a real app schema —
 * enough columns/tables for the sync engine to exercise its real logic,
 * without depending on the actual Orun OS app schema.
 */
export function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, seq INTEGER, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE usage_events (id TEXT PRIMARY KEY, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE tts_usage (id TEXT PRIMARY KEY, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE automations (id TEXT PRIMARY KEY, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT,
      record_id TEXT,
      op TEXT,
      payload TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      attempts INTEGER DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT
    );
    CREATE TABLE sync_meta (table_name TEXT PRIMARY KEY, last_pulled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z');
  `);
  return db;
}

export interface FakeSupabaseOptions {
  /** Called on every `.upsert()` — throw or return `{ error }` to simulate failure. */
  onUpsert?: (table: string, row: any) => { error: any } | Promise<{ error: any }>;
  /** Called on every soft-delete `.update({deleted_at}).eq('id', id)`. */
  onDelete?: (table: string, id: string) => { error: any } | Promise<{ error: any }>;
  /** Returns rows for a `.select().gt('updated_at', since).order().limit(n)` pull query. */
  onPull?: (table: string, since: string, limit: number) => { data: any[]; error: any } | Promise<{ data: any[]; error: any }>;
}

/**
 * Minimal fake Supabase client — just enough of the `.from(table)` chain
 * shape that SyncService/backfill actually call, so tests exercise the real
 * push/pull/backoff/pagination logic without hitting a network.
 */
export function fakeSupabase(options: FakeSupabaseOptions = {}) {
  return {
    from(table: string) {
      return {
        upsert: async (row: any) => {
          if (options.onUpsert) return options.onUpsert(table, row);
          return { error: null };
        },
        update: (_patch: any) => ({
          eq: async (_col: string, id: string) => {
            if (options.onDelete) return options.onDelete(table, id);
            return { error: null };
          },
        }),
        select: () => ({
          gt: (_col: string, since: string) => ({
            order: () => ({
              limit: async (n: number) => {
                if (options.onPull) return options.onPull(table, since, n);
                return { data: [], error: null };
              },
            }),
          }),
        }),
      };
    },
  };
}
