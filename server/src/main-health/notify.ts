import type { Incident } from "./incident.js";

interface NotifyStore {
  readToken(): string | null;
  readConfig(): { chatId?: number; topics: Record<string, number> };
}

interface NotifyApi {
  sendMessage(message: { chatId: number; threadId?: number; text: string }): Promise<unknown>;
}

interface NotifyRuntime {
  getApi(): NotifyApi | null;
}

export interface MainHealthNotifierDeps {
  store: NotifyStore;
  runtime: NotifyRuntime;
}

export interface MainHealthNotifier {
  opened(incident: Incident): Promise<void>;
  closed(incident: Incident): Promise<void>;
}

/**
 * Adaptador pequeño sobre la runtime existente: no crea otra API ni conserva el token.
 * El texto es deliberadamente fijo y no incluye logs, resumen ni atribución del incidente.
 */
export function createMainHealthNotifier(deps: MainHealthNotifierDeps): MainHealthNotifier {
  async function send(incident: Incident, action: "abierto" | "cerrado"): Promise<void> {
    let token: string | null;
    let config: ReturnType<NotifyStore["readConfig"]>;
    let api: NotifyApi | null;
    try {
      token = deps.store.readToken();
      config = deps.store.readConfig();
      api = deps.runtime.getApi();
    } catch {
      return;
    }
    if (!token || typeof config.chatId !== "number" || !api) return;
    const threadId = config.topics[incident.repo];
    const text = action === "abierto"
      ? `🔴 Incidente abierto en ${incident.repo} (${incident.firstRedSha.slice(0, 7)}).`
      : `🟢 Incidente cerrado en ${incident.repo} (${incident.firstRedSha.slice(0, 7)}).`;
    await api.sendMessage({
      chatId: config.chatId,
      ...(typeof threadId === "number" ? { threadId } : {}),
      text,
    });
  }

  return {
    opened: (incident) => send(incident, "abierto"),
    closed: (incident) => send(incident, "cerrado"),
  };
}
