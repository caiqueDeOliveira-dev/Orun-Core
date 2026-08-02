import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { freshDb, fakeSupabase } from "../test/helpers";
import { SyncService } from "./syncService";

describe("SyncService — pull", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("upserts a new remote row into the local table", async () => {
    const remoteRow = { id: "c2", title: "Do Supabase", updated_at: new Date().toISOString(), deleted_at: null };
    const supabase = fakeSupabase({
      onPull: (table) => (table === "conversations" ? { data: [remoteRow], error: null } : { data: [], error: null }),
    });

    await new SyncService(db, supabase as any, 1000).runOnce();

    const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get("c2") as any;
    expect(row).toBeTruthy();
    expect(row.title).toBe("Do Supabase");
  });

  it("stores an actual SQL NULL for null fields, not the string 'null'", async () => {
    // Regression test: typeof null === "object" in JS, so a naive
    // `typeof v === "object" ? JSON.stringify(v) : v` check would turn
    // `deleted_at: null` into the string "null".
    const remoteRow = { id: "c3", title: "X", updated_at: new Date().toISOString(), deleted_at: null };
    const supabase = fakeSupabase({
      onPull: (table) => (table === "conversations" ? { data: [remoteRow], error: null } : { data: [], error: null }),
    });

    await new SyncService(db, supabase as any, 1000).runOnce();

    const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get("c3") as any;
    expect(row.deleted_at).toBeNull();
  });

  it("last-write-wins: does not overwrite a local row that is newer than the incoming remote row", async () => {
    const newerLocalTime = new Date(Date.now() + 60_000).toISOString();
    db.prepare("INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)").run(
      "c4",
      "Local mais novo",
      newerLocalTime
    );

    const staleRemoteRow = {
      id: "c4",
      title: "Remoto mais antigo (não deveria vencer)",
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    const supabase = fakeSupabase({
      onPull: (table) => (table === "conversations" ? { data: [staleRemoteRow], error: null } : { data: [], error: null }),
    });

    await new SyncService(db, supabase as any, 1000).runOnce();

    const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get("c4") as any;
    expect(row.title).toBe("Local mais novo");
  });

  it("overwrites a local row when the remote row is newer", async () => {
    db.prepare("INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)").run(
      "c5",
      "Local antigo",
      new Date(Date.now() - 60_000).toISOString()
    );

    const newerRemoteRow = { id: "c5", title: "Remoto mais novo", updated_at: new Date().toISOString(), deleted_at: null };
    const supabase = fakeSupabase({
      onPull: (table) => (table === "conversations" ? { data: [newerRemoteRow], error: null } : { data: [], error: null }),
    });

    await new SyncService(db, supabase as any, 1000).runOnce();

    const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get("c5") as any;
    expect(row.title).toBe("Remoto mais novo");
  });

  it("paginates through a backlog larger than one page in a single cycle", async () => {
    const remoteRows = Array.from({ length: 1200 }, (_, i) => ({
      id: `r${i}`,
      title: `Row ${i}`,
      updated_at: new Date(Date.now() + i).toISOString(),
      deleted_at: null,
    }));

    let pageCount = 0;
    const supabase = fakeSupabase({
      onPull: (table, since, limit) => {
        if (table !== "conversations") return { data: [], error: null };
        pageCount++;
        const remaining = remoteRows.filter((r) => r.updated_at > since);
        return { data: remaining.slice(0, limit), error: null };
      },
    });

    await new SyncService(db, supabase as any, 1000).runOnce();

    const count = (db.prepare("SELECT COUNT(*) as c FROM conversations").get() as any).c;
    expect(count).toBe(1200);
    expect(pageCount).toBe(3); // 500 + 500 + 200
  });

  it("bookmarks sync_meta so a later cycle only pulls rows newer than the last pull", async () => {
    const firstRow = { id: "c6", title: "Primeira", updated_at: "2026-01-01T00:00:00.000Z", deleted_at: null };
    let callArgs: Array<{ since: string }> = [];

    const supabase = fakeSupabase({
      onPull: (table, since) => {
        if (table !== "conversations") return { data: [], error: null };
        callArgs.push({ since });
        // Only return the row on the very first call (since starts at epoch).
        if (since === "1970-01-01T00:00:00.000Z") return { data: [firstRow], error: null };
        return { data: [], error: null };
      },
    });

    const sync = new SyncService(db, supabase as any, 1000);
    await sync.runOnce();
    await sync.runOnce();

    // Second cycle's pull for `conversations` should use the bookmarked
    // timestamp from the first row, not the epoch default again.
    const conversationCalls = callArgs;
    expect(conversationCalls[0].since).toBe("1970-01-01T00:00:00.000Z");
    expect(conversationCalls[1].since).toBe(firstRow.updated_at);
  });
});
