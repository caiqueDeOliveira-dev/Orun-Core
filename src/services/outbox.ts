import type Database from "better-sqlite3";

export type SyncableTable =
  | "agents"
  | "conversations"
  | "messages"
  | "usage_events"
  | "tts_usage"
  | "automations";

/**
 * Call this right after any local INSERT/UPDATE (upsert) in your existing
 * repository code. It does NOT touch the network — it just queues the
 * intent. The sync worker (syncService.ts) drains this queue in the
 * background, so writes stay instant and offline-safe.
 *
 * Usage in your existing message-insert code:
 *   db.prepare("INSERT INTO messages (...) VALUES (...)").run(...);
 *   enqueueUpsert(db, "messages", message.id, message);
 */
export function enqueueUpsert(db: Database.Database, table: SyncableTable, recordId: string, row: unknown) {
  db.prepare(
    `INSERT INTO sync_queue (table_name, record_id, op, payload) VALUES (?, ?, 'upsert', ?)`
  ).run(table, recordId, JSON.stringify(row));
}

/**
 * Call after a local soft-delete (UPDATE ... SET deleted_at = ...).
 * Hard deletes are avoided on purpose — a tombstone (deleted_at set) is what
 * lets the other "device" (or a future Supabase-only client) know to remove
 * the row too, instead of just silently never seeing it again.
 */
export function enqueueDelete(db: Database.Database, table: SyncableTable, recordId: string) {
  db.prepare(
    `INSERT INTO sync_queue (table_name, record_id, op, payload) VALUES (?, ?, 'delete', NULL)`
  ).run(table, recordId);
}

/**
 * Safely allocates the next `seq` for a message in a conversation.
 * better-sqlite3 calls are synchronous, so this read-then-use is safe as
 * long as the INSERT happens right after, in the same synchronous call
 * stack — don't `await` anything between calling this and the INSERT, or
 * two concurrent async callers (e.g. two provider streams replying at once)
 * could read the same value and collide against the
 * UNIQUE(conversation_id, seq) constraint from the Supabase schema.
 *
 * Usage:
 *   const seq = nextMessageSeq(db, conversationId);
 *   db.prepare("INSERT INTO messages (id, conversation_id, seq, ...) VALUES (?, ?, ?, ...)").run(id, conversationId, seq, ...);
 *   enqueueUpsert(db, "messages", id, { id, conversation_id: conversationId, seq, ... });
 */
export function nextMessageSeq(db: Database.Database, conversationId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?`)
    .get(conversationId) as { next: number };
  return row.next;
}

