import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Command,
  CommandStatus,
  Device,
  DeviceType,
  HeartbeatInput,
  SatelliteTarget,
} from "../types";
import { newUuid } from "../util/uuid";

export interface SatelliteControllerOptions {
  /** Id persistido deste dispositivo (gerado na primeira execução e salvo). */
  deviceId: string;
  deviceType: DeviceType;
}

export interface SendCommandInput {
  target: SatelliteTarget;
  action: string;
  params?: Record<string, unknown>;
  /** Nulo = broadcast para qualquer satélite do tipo `target`. */
  deviceId?: string | null;
}

/**
 * Controle dos dispositivos do ecossistema via Supabase.
 *
 * Serve os DOIS lados do modelo hub-and-spoke:
 *  - Hub (desktop/mobile): `heartbeat()`, `listDevices()`, `sendCommand()`,
 *    `getCommand()` — envia comandos e acompanha o estado de tudo.
 *  - Satélite (TV/Shield): `heartbeat()`, `pollCommands()`,
 *    `updateCommandStatus()` — reporta presença e processa só o que é seu
 *    (nunca consulta linhas de outros satélites: cegos entre si por design).
 *
 * Credenciais: usa o MESMO client Supabase da engine de sync. Deve ser
 * instanciado apenas no processo principal de cada app, com service_role
 * lida do keychain — nunca no renderer.
 */
export class SatelliteController {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly options: SatelliteControllerOptions
  ) {}

  get deviceId(): string {
    return this.options.deviceId;
  }

  get deviceType(): DeviceType {
    return this.options.deviceType;
  }

  /** Registra/renova o heartbeat deste dispositivo (upsert em `devices`). */
  async heartbeat(input: HeartbeatInput = {}): Promise<Device> {
    const now = new Date().toISOString();
    const row = {
      id: this.options.deviceId,
      tipo: this.options.deviceType,
      nome: input.nome ?? defaultName(this.options.deviceType),
      versao: input.versao ?? null,
      online: true,
      ultimo_seen: now,
      updated_at: now,
    };

    const { data, error } = await this.supabase
      .from("devices")
      .upsert(row, { onConflict: "id" })
      .select()
      .single();
    if (error) throw error;
    return data as Device;
  }

  /** Marca este dispositivo como offline (chamar no shutdown do app). */
  async markOffline(): Promise<void> {
    const { error } = await this.supabase
      .from("devices")
      .update({ online: false, ultimo_seen: new Date().toISOString() })
      .eq("id", this.options.deviceId);
    if (error) throw error;
  }

  /** Hub: lista todos os dispositivos conhecidos (online primeiro). */
  async listDevices(): Promise<Device[]> {
    const { data, error } = await this.supabase
      .from("devices")
      .select("*")
      .order("online", { ascending: false })
      .order("ultimo_seen", { ascending: false });
    if (error) throw error;
    return (data ?? []) as Device[];
  }

  /** Hub: enfileira um comando para um satélite. */
  async sendCommand(input: SendCommandInput): Promise<Command> {
    const now = new Date().toISOString();
    const row = {
      id: newUuid(),
      target: input.target,
      device_id: input.deviceId ?? null,
      action: input.action,
      params: input.params ?? {},
      status: "pending" as const,
      response: null,
      created_at: now,
      sent_at: null,
      completed_at: null,
    };

    const { data, error } = await this.supabase.from("commands").insert(row).select().single();
    if (error) throw error;
    return data as Command;
  }

  /** Qualquer lado: consulta o estado de um comando. */
  async getCommand(commandId: string): Promise<Command | null> {
    const { data, error } = await this.supabase
      .from("commands")
      .select("*")
      .eq("id", commandId)
      .maybeSingle();
    if (error) throw error;
    return (data as Command | null) ?? null;
  }

  /**
   * Satélite: busca comandos pendentes endereçados a este dispositivo
   * (ou broadcast do seu tipo). Hubs não devem chamar — usam sendCommand.
   */
  async pollCommands(): Promise<Command[]> {
    if (this.options.deviceType === "desktop" || this.options.deviceType === "mobile") {
      throw new Error(
        "pollCommands é para satélites (tv/shield). Hubs usam listDevices() + sendCommand()."
      );
    }

    const { data, error } = await this.supabase
      .from("commands")
      .select("*")
      .eq("target", this.options.deviceType as SatelliteTarget)
      .eq("status", "pending")
      .or(`device_id.is.null,device_id.eq.${this.options.deviceId}`)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []) as Command[];
  }

  /** Satélite: confirma o resultado de um comando. */
  async updateCommandStatus(commandId: string, status: CommandStatus, response?: unknown): Promise<void> {
    const patch: Record<string, unknown> = { status };
    if (status === "sent") patch.sent_at = new Date().toISOString();
    if (status === "done" || status === "failed") patch.completed_at = new Date().toISOString();
    if (response !== undefined) patch.response = response;

    const { error } = await this.supabase.from("commands").update(patch).eq("id", commandId);
    if (error) throw error;
  }
}

function defaultName(type: DeviceType): string {
  switch (type) {
    case "desktop":
      return "Orun OS (desktop)";
    case "mobile":
      return "Orun OS (mobile)";
    case "tv":
      return "Orun TV";
    case "shield":
      return "Orun Shield";
  }
}
