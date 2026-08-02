import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { freshDb, fakeSupabase } from "../test/helpers";
import { backfill } from "./backfill";

describe("backfill", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("pushes every pre-existing local row in batches of 500", async () => {
    const insert = db.prepare("INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)");
    const tx = db.transaction(() => {
      for (let i = 0; i < 1300; i++) insert.run(`conv${i}`, `Conversa ${i}`, new Date().toISOString());
    });
    tx();

    let totalPushed = 0;
    let batchCount = 0;
    const supabase = fakeSupabase({
      onUpsert: (table, rows) => {
        if (table === "conversations") {
          totalPushed += (rows as any[]).length;
          batchCount++;
        }
        return { error: null };
      },
    });

    await backfill(db, supabase as any);

    expect(totalPushed).toBe(1300);
    expect(batchCount).toBe(3); // 500 + 500 + 300
  });

  it("reports progress via the callback", async () => {
    const insert = db.prepare("INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)");
    const tx = db.transaction(() => {
      for (let i = 0; i < 50; i++) insert.run(`conv${i}`, `C${i}`, new Date().toISOString());
    });
    tx();

    const progressCalls: Array<{ table: string; pushed: number; total: number }> = [];
    const supabase = fakeSupabase({ onUpsert: () => ({ error: null }) });

    await backfill(db, supabase as any, (p) => progressCalls.push(p));

    const conversationProgress = progressCalls.filter((p) => p.table === "conversations");
    expect(conversationProgress.length).toBeGreaterThan(0);
    expect(conversationProgress[conversationProgress.length - 1]).toEqual({
      table: "conversations",
      pushed: 50,
      total: 50,
    });
  });

  it("bookmarks sync_meta to 'now' for every table after a full backfill completes", async () => {
    db.prepare("INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)").run(
      "c1",
      "X",
      new Date().toISOString()
    );

    const supabase = fakeSupabase({ onUpsert: () => ({ error: null }) });
    const before = Date.now();
    await backfill(db, supabase as any);
    const after = Date.now();

    const meta = db.prepare("SELECT * FROM sync_meta WHERE table_name = 'conversations'").get() as any;
    expect(meta).toBeTruthy();
    const bookmarked = new Date(meta.last_pulled_at).getTime();
    expect(bookmarked).toBeGreaterThanOrEqual(before);
    expect(bookmarked).toBeLessThanOrEqual(after);
  });

  it("throws with a descriptive error if Supabase rejects a batch, instead of silently continuing", async () => {
    db.prepare("INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)").run(
      "c1",
      "X",
      new Date().toISOString()
    );

    const supabase = fakeSupabase({ onUpsert: () => ({ error: { message: "constraint violation" } }) });

    await expect(backfill(db, supabase as any)).rejects.toThrow(/constraint violation/);
  });
});
