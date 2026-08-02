/** Tipos de dispositivo no ecossistema Orun (modelo hub-and-spoke). */
export type DeviceType = "desktop" | "mobile" | "tv" | "shield";

/** Alvo de comando — os satélites que o hub controla. */
export type SatelliteTarget = Extract<DeviceType, "tv" | "shield">;

/** Linha da tabela `devices` (registro + heartbeat de cada aparelho). */
export interface Device {
  id: string;
  tipo: DeviceType;
  nome: string;
  versao: string | null;
  online: boolean;
  ultimo_seen: string;
  created_at: string;
  updated_at: string;
}

export type CommandStatus = "pending" | "sent" | "acknowledged" | "done" | "failed";

/** Linha da tabela `commands` — fila hub -> satélite. */
export interface Command {
  id: string;
  target: SatelliteTarget;
  /** Nulo = broadcast para qualquer satélite do tipo `target`. */
  device_id: string | null;
  action: string;
  params: Record<string, unknown>;
  status: CommandStatus;
  response: unknown | null;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
}

/** Ações documentadas do contrato hub <-> satélite (não exaustivo). */
export const SATELLITE_ACTIONS = {
  power: ["power.on", "power.off", "power.toggle"],
  volume: ["volume.up", "volume.down", "volume.set", "mute.toggle"],
  media: ["media.play", "media.pause", "media.stop", "media.next", "media.prev", "media.seek"],
  input: ["input.switch", "app.launch"],
  status: ["status.get"],
} as const;

/** Dados enviados no heartbeat de um dispositivo. */
export interface HeartbeatInput {
  nome?: string;
  versao?: string;
}
