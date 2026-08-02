import type Database from "better-sqlite3";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { SyncableTable } from "./outbox";

const SYNCABLE_TABLES: SyncableTable[] = [
  "agents",
  "conversations",
  "messages",
  "usage_events",
  "tts_usage",
  "automations",
];

// Push order matters: a `message` references a `conversation`, and both
// `usage_events`/`messages` can reference `agents`. If the outbox drains
// strictly FIFO, a message enqueued right after its (also-pending) parent
// conversation could reach Supabase first and hit a foreign key violation.
// This priority makes push process parents before children regardless of
// queue order, so that class of failure doesn't happen in normal operation.
const TABLE_PUSH_PRIORITY: Record<SyncableTable, number> = {
  agents: 0,
  conversations: 1,
  messages: 2,
  usage_events: 2,
  tts_usage: 2,
  automations: 2,
};

const PAGE_SIZE = 500;
const MAX_ATTEMPTS = 8; // beyond this, an item is "dead" — surfaced, not retried automatically
const BASE_DELAY_MS = 15_000; // 15s
const MAX_DELAY_MS = 60 * 60_000; // cap backoff at 1h

function backoffDelay(attempts: number) {
  return Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
}

/**
 * Hybrid sync engine. SQLite stays the source of truth for the app's normal
 * read/write path (instant, works offline). This engine runs on an interval
 * in the Electron main process and does two things:
 *
 *  1. PUSH — drains `sync_queue` (rows written locally) up to Supabase,
 *     with exponential backoff on failure and a dead-letter cutoff.
 *  2. PULL — fetches rows changed in Supabase since the last pull, paginated
 *     so a large backlog doesn't take many cycles to catch up.
 *
 * Conflict resolution: last-write-wins by `updated_at`. Fine for a
 * single-user app used from one device at a time.
 *
 * Optional Realtime: call `enableRealtime()` to also react to Postgres
 * changes over websocket, so cross-device updates arrive in near-real-time
 * instead of waiting for the next poll cycle. Polling keeps running
 * regardless — Realtime is a latency improvement, not a replacement (it can
 * silently miss events during a dropped connection; polling is the safety net).
 */
export class SyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private realtimeChannel: RealtimeChannel | null = null;
  private running = false;
  private lastSuccessAt: string | null = null;
  private lastCycleError: string | null = null;

  constructor(
    private db: Database.Database,
    private supabase: SupabaseClient,
    private intervalMs = 15_000
  ) {}

  start() {
    if (this.timer) return;
    this.runOnce().catch((err) => console.error("[sync] initial run failed", err));
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => console.error("[sync] cycle failed", err));
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.disableRealtime();
  }

  async runOnce() {
    if (this.running) return; // avoid overlapping cycles if a previous one is still draining a big backlog
    this.running = true;
    try {
      await this.push();
      await this.pull();
      this.lastSuccessAt = new Date().toISOString();
      this.lastCycleError = null;
    } catch (err: any) {
      this.lastCycleError = String(err?.message ?? err);
      throw err;
    } finally {
      this.running = false;
    }
  }

  /**
   * Snapshot of sync health, meant to be polled from the UI (e.g. every few
   * seconds via IPC) to drive a StatusChip in Developer/Settings. Cheap —
   * just SQLite COUNT queries, no network calls.
   */
  getSyncStatus() {
    const pending = (
      this.db.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE attempts < ?`).get(MAX_ATTEMPTS) as {
        c: number;
      }
    ).c;
    const deadLetterCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE attempts >= ?`).get(MAX_ATTEMPTS) as {
        c: number;
      }
    ).c;

    return {
      pending,
      deadLetterCount,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastCycleError,
      isRunning: this.running,
      realtimeEnabled: this.realtimeChannel !== null,
    };
  }

  /** Rows that hit MAX_ATTEMPTS and stopped retrying automatically. Surface these in a Developer/Settings screen. */
  getDeadLetters() {
    return this.db
      .prepare(`SELECT * FROM sync_queue WHERE attempts >= ? ORDER BY id ASC`)
      .all(MAX_ATTEMPTS) as Array<{ id: number; table_name: string; record_id: string; op: string; last_error: string | null }>;
  }

  /** Reset dead-letter items (or all failed items) to try again immediately — e.g. a "Retry sync" button. */
  retryFailed() {
    this.db.prepare(`UPDATE sync_queue SET attempts = 0, next_attempt_at = NULL, last_error = NULL`).run();
  }

  // ---- PUSH: local outbox -> Supabase, with backoff ----------------------
  private async push() {
    const nowIso = new Date().toISOString();
    const pending = this.db
      .prepare(
        `SELECT * FROM sync_queue
         WHERE attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id ASC LIMIT 200`
      )
      .all(MAX_ATTEMPTS, nowIso) as Array<{
      id: number;
      table_name: SyncableTable;
      record_id: string;
      op: "upsert" | "delete";
      payload: string | null;
      attempts: number;
    }>;

    // Parents before children (agents -> conversations -> everything else),
    // stable within each priority group so unrelated writes keep their
    // original order.
    pending.sort((a, b) => TABLE_PUSH_PRIORITY[a.table_name] - TABLE_PUSH_PRIORITY[b.table_name]);

    for (const item of pending) {
      try {
        if (item.op === "upsert") {
          const row = JSON.parse(item.payload ?? "{}");
          const { error } = await this.supabase.from(item.table_name).upsert(row, { onConflict: "id" });
          if (error) throw error;
        } else {
          const { error } = await this.supabase
            .from(item.table_name)
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", item.record_id);
          if (error) throw error;
        }
        this.db.prepare(`DELETE FROM sync_queue WHERE id = ?`).run(item.id);
      } catch (err: any) {
        const attempts = item.attempts + 1;
        const nextAttemptAt = new Date(Date.now() + backoffDelay(attempts)).toISOString();
        this.db
          .prepare(
            `UPDATE sync_queue SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`
          )
          .run(attempts, nextAttemptAt, String(err?.message ?? err), item.id);

        if (attempts >= MAX_ATTEMPTS) {
          console.error(
            `[sync] item #${item.id} (${item.table_name}/${item.record_id}) hit max attempts and is now a dead letter:`,
            err
          );
        }
      }
    }
  }

  // ---- PULL: Supabase -> local SQLite, paginated -------------------------
  private async pull() {
    for (const table of SYNCABLE_TABLES) {
      await this.pullTable(table);
    }
  }

  private async pullTable(table: SyncableTable) {
    let since =
      (
        this.db.prepare(`SELECT last_pulled_at FROM sync_meta WHERE table_name = ?`).get(table) as
          | { last_pulled_at: string }
          | undefined
      )?.last_pulled_at ?? "1970-01-01T00:00:00.000Z";

    // Loop pages until a page comes back smaller than PAGE_SIZE — this is
    // what makes a large backlog (e.g. right after backfill, or after being
    // offline a long time) catch up within a single cycle instead of one
    // page every 15s.
    for (;;) {
      const { data, error } = await this.supabase
        .from(table)
        .select("*")
        .gt("updated_at", since)
        .order("updated_at", { ascending: true })
        .limit(PAGE_SIZE);

      if (error) {
        console.error(`[sync] pull failed for ${table}`, error);
        return;
      }
      if (!data || data.length === 0) return;

      const upsertLocal = this.db.transaction((rows: any[]) => {
        for (const row of rows) this.upsertLocalRow(table, row);
      });
      upsertLocal(data);

      since = data[data.length - 1].updated_at;
      this.db
        .prepare(
          `INSERT INTO sync_meta (table_name, last_pulled_at) VALUES (?, ?)
           ON CONFLICT(table_name) DO UPDATE SET last_pulled_at = excluded.last_pulled_at`
        )
        .run(table, since);

      if (data.length < PAGE_SIZE) return; // caught up
    }
  }

  /**
   * Last-write-wins: only overwrite the local row if the remote copy is
   * newer. Adjust the column list per table to match your actual local
   * schema — this is intentionally generic so it's obvious where to edit.
   */
  private upsertLocalRow(table: SyncableTable, remote: any) {
    const local = this.db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(remote.id) as
      | { updated_at: string }
      | undefined;

    if (local && new Date(local.updated_at) >= new Date(remote.updated_at)) {
      return; // local copy is newer or equal — keep it
    }

    const columns = Object.keys(remote);
    const placeholders = columns.map(() => "?").join(", ");
    const updates = columns.map((c) => `${c} = excluded.${c}`).join(", ");

    this.db
      .prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${updates}`
      )
      .run(
        ...columns.map((c) => {
          const value = remote[c];
          if (value === null || value === undefined) return null;
          return typeof value === "object" ? JSON.stringify(value) : value;
        })
      );
  }

  // ---- Realtime (optional) -----------------------------------------------
  /**
   * Subscribe to Postgres changes over websocket so remote updates (e.g.
   * from another session) arrive within ~1s instead of waiting for the next
   * poll. Polling continues regardless — this only shortens the common case.
   */
  enableRealtime() {
    if (this.realtimeChannel) return;

    let channel = this.supabase.channel("orun-sync");
    for (const table of SYNCABLE_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => {
          // Don't trust the payload's shape blindly across Supabase versions —
          // just trigger a normal incremental pull for that table.
          this.pullTable(table).catch((err) => console.error(`[sync] realtime-triggered pull failed for ${table}`, err));
        }
      );
    }
    channel.subscribe((status: string) => {
      console.log(`[sync] realtime channel status: ${status}`);
    });
    this.realtimeChannel = channel;
  }

  disableRealtime() {
    if (this.realtimeChannel) {
      this.supabase.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }
}
