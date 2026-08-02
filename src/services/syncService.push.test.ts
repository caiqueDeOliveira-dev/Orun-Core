import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { freshDb, fakeSupabase } from "../test/helpers";
import { SyncService } from "./syncService";
import { enqueueUpsert } from "./outbox";

describe("SyncService — push", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("pushes a queued upsert to Supabase and removes it from the queue on success", async () => {
    db.prepare("INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)").run(
      "c1",
      "Teste",
      new Date().toISOString()
    );
    enqueueUpsert(db, "conversations", "c1", { id: "c1", title: "Teste", updated_at: new Date().toISOString() });

    const pushed: Array<{ table: string; row: any }> = [];
    const supabase = fakeSupabase({
      onUpsert: (table, row) => {
        pushed.push({ table, row });
        return { error: null };
      },
    });

    await new SyncService(db, supabase as any, 1000).runOnce();

    expect(pushed).toHaveLength(1);
    expect(pushed[0].table).toBe("conversations");
    expect(pushed[0].row.id).toBe("c1");

    const remaining = (db.prepare("SELECT COUNT(*) as c FROM sync_queue").get() as any).c;
    expect(remaining).toBe(0);
  });

  it("pushes items ordered by table dependency (agents/conversations before messages/etc), not raw queue order", async () => {
    // Enqueue deliberately out of order.
    enqueueUpsert(db, "messages", "m1", { id: "m1", updated_at: new Date().toISOString() });
    enqueueUpsert(db, "usage_events", "u1", { id: "u1", updated_at: new Date().toISOString() });
    enqueueUpsert(db, "conversations", "c1", { id: "c1", updated_at: new Date().toISOString() });
    enqueueUpsert(db, "agents", "a1", { id: "a1", updated_at: new Date().toISOString() });

    const order: string[] = [];
    const supabase = fakeSupabase({
      onUpsert: (table) => {
        order.push(table);
        return { error: null };
      },
    });

    await new SyncService(db, supabase as any, 1000).runOnce();

    expect(order.indexOf("agents")).toBeLessThan(order.indexOf("conversations"));
    expect(order.indexOf("conversations")).toBeLessThan(order.indexOf("messages"));
  });

  it("a failed push schedules a future retry via exponential backoff, and doesn't retry before then", async () => {
    enqueueUpsert(db, "conversations", "c1", { id: "c1", updated_at: new Date().toISOString() });

    const supabase = fakeSupabase({
      onUpsert: () => ({ error: { message: "network down (simulated)" } }),
    });
    const sync = new SyncService(db, supabase as any, 1000);

    await sync.runOnce();
    const afterFirstFailure = db.prepare("SELECT * FROM sync_queue WHERE record_id = ?").get("c1") as any;
    expect(afterFirstFailure.attempts).toBe(1);
    expect(afterFirstFailure.next_attempt_at).not.toBeNull();
    expect(new Date(afterFirstFailure.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // Immediately running again should NOT retry yet — backoff hasn't elapsed.
    await sync.runOnce();
    const afterSecondCycle = db.prepare("SELECT * FROM sync_queue WHERE record_id = ?").get("c1") as any;
    expect(afterSecondCycle.attempts).toBe(1);
  });

  it("marks an item as a dead letter after MAX_ATTEMPTS, and retryFailed() resets it", async () => {
    enqueueUpsert(db, "conversations", "c1", { id: "c1", updated_at: new Date().toISOString() });
    db.prepare("UPDATE sync_queue SET attempts = 8 WHERE record_id = 'c1'").run();

    const supabase = fakeSupabase();
    const sync = new SyncService(db, supabase as any, 1000);

    expect(sync.getDeadLetters()).toHaveLength(1);

    sync.retryFailed();
    const reset = db.prepare("SELECT * FROM sync_queue WHERE record_id = ?").get("c1") as any;
    expect(reset.attempts).toBe(0);
    expect(reset.next_attempt_at).toBeNull();
    expect(reset.last_error).toBeNull();
    expect(sync.getDeadLetters()).toHaveLength(0);
  });
});
