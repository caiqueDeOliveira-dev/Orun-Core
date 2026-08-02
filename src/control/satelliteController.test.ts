import { describe, it, expect, vi } from "vitest";
import { SatelliteController } from "./satelliteController";

interface Call {
  op: "upsert" | "insert" | "update" | "select";
  table: string;
  row?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  id?: string;
}

/** Thenable que resolve como { data, error } — imita o PostgrestBuilder. */
function thenable(data: unknown) {
  return {
    then(resolve: (value: unknown) => void) {
      resolve({ data, error: null });
    },
  };
}

function fakeClient() {
  const calls: Call[] = [];
  const now = new Date().toISOString();
  const device = {
    id: "dev-tv-1",
    tipo: "tv",
    nome: "Sala",
    versao: "1.0.0",
    online: true,
    ultimo_seen: now,
    created_at: now,
    updated_at: now,
  };
  const command = {
    id: "cmd-1",
    target: "tv",
    device_id: null,
    action: "power.on",
    params: {},
    status: "pending",
    response: null,
    created_at: now,
    sent_at: null,
    completed_at: null,
  };

  const from = (table: string) => ({
    upsert: (row: Record<string, unknown>) => {
      calls.push({ op: "upsert", table, row });
      return { data: [row], error: null, select: () => ({ single: async () => ({ data: row, error: null }) }) };
    },
    insert: (row: Record<string, unknown>) => {
      calls.push({ op: "insert", table, row });
      return { data: [row], error: null, select: () => ({ single: async () => ({ data: row, error: null }) }) };
    },
    update: (patch: Record<string, unknown>) => ({
      eq: (_col: string, id: string) => {
        calls.push({ op: "update", table, patch, id });
        return thenable(null);
      },
    }),
    select: () => {
      calls.push({ op: "select", table });
      if (table === "devices") {
        return { order: () => ({ order: () => thenable([device]) }) };
      }
      const query = {
        eq: () => query,
        or: () => query,
        order: () => thenable([command]),
        maybeSingle: async () => ({ data: command, error: null }),
      };
      return query;
    },
  });

  return {
    client: { from } as any,
    calls,
  };
}

const HUB_OPTS = { deviceId: "dev-desktop-1", deviceType: "desktop" as const };
const TV_OPTS = { deviceId: "dev-tv-1", deviceType: "tv" as const };

describe("SatelliteController", () => {
  it("heartbeat upserts `devices` marcando online=true com o id/tipo do dispositivo", async () => {
    const { client, calls } = fakeClient();
    const ctl = new SatelliteController(client, TV_OPTS);

    const device = await ctl.heartbeat({ nome: "Sala", versao: "1.0.0" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      op: "upsert",
      table: "devices",
      row: { id: "dev-tv-1", tipo: "tv", online: true, nome: "Sala", versao: "1.0.0" },
    });
    expect(device.id).toBe("dev-tv-1");
  });

  it("sendCommand insere em `commands` com status pending e id uuid", async () => {
    const { client, calls } = fakeClient();
    const ctl = new SatelliteController(client, HUB_OPTS);

    const cmd = await ctl.sendCommand({ target: "tv", action: "power.on", params: { hdmi: 1 } });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      op: "insert",
      table: "commands",
      row: { target: "tv", action: "power.on", status: "pending", device_id: null },
    });
    expect(cmd.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sendCommand com deviceId específico endereça o satélite certo", async () => {
    const { client, calls } = fakeClient();
    const ctl = new SatelliteController(client, HUB_OPTS);

    await ctl.sendCommand({ target: "shield", action: "volume.set", params: { level: 30 }, deviceId: "dev-shield-1" });

    expect((calls[0].row as Record<string, unknown>).device_id).toBe("dev-shield-1");
  });

  it("updateCommandStatus marca done e preenche completed_at + response", async () => {
    const { client, calls } = fakeClient();
    const ctl = new SatelliteController(client, TV_OPTS);

    await ctl.updateCommandStatus("cmd-1", "done", { powered: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "update", table: "commands", id: "cmd-1" });
    const patch = calls[0].patch as Record<string, unknown>;
    expect(patch.status).toBe("done");
    expect(patch.completed_at).toBeTruthy();
    expect(patch.response).toEqual({ powered: true });
  });

  it("updateCommandStatus marca sent e preenche sent_at", async () => {
    const { client, calls } = fakeClient();
    const ctl = new SatelliteController(client, TV_OPTS);

    await ctl.updateCommandStatus("cmd-1", "sent");

    const patch = calls[0].patch as Record<string, unknown>;
    expect(patch.status).toBe("sent");
    expect(patch.sent_at).toBeTruthy();
    expect(patch.completed_at).toBeUndefined();
  });

  it("listDevices retorna os dispositivos conhecidos", async () => {
    const { client } = fakeClient();
    const ctl = new SatelliteController(client, HUB_OPTS);

    const devices = await ctl.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].tipo).toBe("tv");
  });

  it("pollCommands lança para hubs (desktop/mobile)", async () => {
    const { client } = fakeClient();
    const ctl = new SatelliteController(client, HUB_OPTS);

    await expect(ctl.pollCommands()).rejects.toThrow(/satélites/);
  });

  it("pollCommands consulta comandos pendentes do próprio tipo/device (cegueira entre satélites)", async () => {
    const { client, calls } = fakeClient();
    const ctl = new SatelliteController(client, TV_OPTS);

    const cmds = await ctl.pollCommands();
    expect(cmds).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "select", table: "commands" });
  });

  it("markOffline atualiza online=false para este dispositivo", async () => {
    const { client, calls } = fakeClient();
    const ctl = new SatelliteController(client, TV_OPTS);

    await ctl.markOffline();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "update", table: "devices", id: "dev-tv-1" });
    expect((calls[0].patch as Record<string, unknown>).online).toBe(false);
  });
});
