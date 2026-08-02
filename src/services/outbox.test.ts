import { describe, it, expect } from "vitest";
import { freshDb } from "../test/helpers";
import { enqueueUpsert, enqueueDelete, nextMessageSeq } from "./outbox";

describe("enqueueUpsert / enqueueDelete", () => {
  it("enqueueUpsert inserts an 'upsert' row with the JSON payload", () => {
    const db = freshDb();
    enqueueUpsert(db, "conversations", "c1", { id: "c1", title: "Teste" });

    const row = db.prepare("SELECT * FROM sync_queue WHERE record_id = ?").get("c1") as any;
    expect(row.table_name).toBe("conversations");
    expect(row.op).toBe("upsert");
    expect(JSON.parse(row.payload)).toEqual({ id: "c1", title: "Teste" });
    expect(row.attempts).toBe(0);
  });

  it("enqueueDelete inserts a 'delete' row with a null payload", () => {
    const db = freshDb();
    enqueueDelete(db, "conversations", "c1");

    const row = db.prepare("SELECT * FROM sync_queue WHERE record_id = ?").get("c1") as any;
    expect(row.op).toBe("delete");
    expect(row.payload).toBeNull();
  });

  it("each call adds its own row — enqueueing doesn't dedupe", () => {
    const db = freshDb();
    enqueueUpsert(db, "conversations", "c1", { id: "c1" });
    enqueueUpsert(db, "conversations", "c1", { id: "c1", title: "updated" });

    const count = (db.prepare("SELECT COUNT(*) as c FROM sync_queue").get() as any).c;
    expect(count).toBe(2);
  });
});

describe("nextMessageSeq", () => {
  it("returns 1 for the first message in a conversation", () => {
    const db = freshDb();
    expect(nextMessageSeq(db, "conv1")).toBe(1);
  });

  it("returns the next integer after existing messages", () => {
    const db = freshDb();
    db.prepare("INSERT INTO messages (id, conversation_id, seq) VALUES (?, ?, ?)").run("m1", "conv1", 1);
    db.prepare("INSERT INTO messages (id, conversation_id, seq) VALUES (?, ?, ?)").run("m2", "conv1", 2);
    expect(nextMessageSeq(db, "conv1")).toBe(3);
  });

  it("is scoped per conversation — a different conversation starts at 1 regardless of others", () => {
    const db = freshDb();
    db.prepare("INSERT INTO messages (id, conversation_id, seq) VALUES (?, ?, ?)").run("m1", "conv1", 1);
    db.prepare("INSERT INTO messages (id, conversation_id, seq) VALUES (?, ?, ?)").run("m2", "conv1", 2);
    expect(nextMessageSeq(db, "conv2")).toBe(1);
  });
});
