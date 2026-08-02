import { describe, it, expect } from "vitest";
import {
  enqueueUpsertPayloadSchema,
  enqueueDeletePayloadSchema,
  chatMessagePayloadSchema,
} from "./ipcSchemas";

describe("enqueueUpsertPayloadSchema", () => {
  it("accepts a well-formed payload", () => {
    const result = enqueueUpsertPayloadSchema.parse({
      table: "conversations",
      recordId: "c1",
      row: { id: "c1", title: "Teste" },
    });
    expect(result.table).toBe("conversations");
  });

  it("rejects a table name that isn't in the syncable list", () => {
    expect(() =>
      enqueueUpsertPayloadSchema.parse({
        table: "users_password_reset_tokens", // not a real syncable table
        recordId: "c1",
        row: {},
      })
    ).toThrow();
  });

  it("rejects a missing recordId", () => {
    expect(() =>
      enqueueUpsertPayloadSchema.parse({
        table: "conversations",
        row: {},
      })
    ).toThrow();
  });

  it("rejects an oversized row payload instead of silently truncating it", () => {
    const hugeRow = { id: "c1", blob: "x".repeat(300_000) };
    expect(() =>
      enqueueUpsertPayloadSchema.parse({
        table: "conversations",
        recordId: "c1",
        row: hugeRow,
      })
    ).toThrow(/200KB/);
  });

  it("rejects a recordId that's way too long (defensive bound)", () => {
    expect(() =>
      enqueueUpsertPayloadSchema.parse({
        table: "conversations",
        recordId: "x".repeat(500),
        row: {},
      })
    ).toThrow();
  });
});

describe("enqueueDeletePayloadSchema", () => {
  it("accepts a well-formed payload", () => {
    const result = enqueueDeletePayloadSchema.parse({ table: "messages", recordId: "m1" });
    expect(result.recordId).toBe("m1");
  });

  it("rejects an empty recordId", () => {
    expect(() => enqueueDeletePayloadSchema.parse({ table: "messages", recordId: "" })).toThrow();
  });
});

describe("chatMessagePayloadSchema", () => {
  it("accepts a valid user message", () => {
    const result = chatMessagePayloadSchema.parse({
      conversationId: "conv1",
      content: "Oi Hampton",
      role: "user",
    });
    expect(result.role).toBe("user");
  });

  it("rejects a role outside the allowed enum", () => {
    expect(() =>
      chatMessagePayloadSchema.parse({
        conversationId: "conv1",
        content: "oi",
        role: "admin", // not a valid role — this is the kind of thing a hostile payload might try
      })
    ).toThrow();
  });

  it("rejects empty message content", () => {
    expect(() =>
      chatMessagePayloadSchema.parse({ conversationId: "conv1", content: "", role: "user" })
    ).toThrow();
  });

  it("rejects content over the 50k character bound", () => {
    expect(() =>
      chatMessagePayloadSchema.parse({
        conversationId: "conv1",
        content: "a".repeat(60_000),
        role: "user",
      })
    ).toThrow();
  });
});
