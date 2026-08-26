import { contextBridge, ipcRenderer } from "electron";
import type { TerminalCloseRequest, TerminalOpenRequest, TerminalResizeRequest, TerminalWriteRequest } from "../main/ipc.js";
import type { PtyHandle } from "../main/pty.js";

/**
 * P6 (verificado en vivo): el compilado de este archivo importaba en runtime otro módulo
 * local del proyecto (../main/ipc.js). Bajo `sandbox: true` Electron no deja que el preload
 * cargue un archivo local así — el bridge entero se caía en silencio y nada lo detectaba
 * porque el test de origen sólo miraba el `.ts` fuente. Los imports de arriba son de sólo
 * TIPO (se borran al compilar, sin efecto en runtime); estos 6 literales SON
 * `TERMINAL_IPC_CHANNELS` de `desktop/main/ipc.ts` copiados a mano — session-name.ts (T0.4)
 * es el patrón, `index.test.ts` trae aquí la paridad.
 */
const TERMINAL_IPC_CHANNELS = {
  open: "terminal.open",
  resize: "terminal.resize",
  write: "terminal.write",
  close: "terminal.close",
  data: "terminal.data",
  exit: "terminal.exit",
} as const;

export interface RoninDesktopTerminalApi {
  open(request: TerminalOpenRequest): Promise<PtyHandle>;
  resize(request: TerminalResizeRequest): Promise<void>;
  write(request: TerminalWriteRequest): Promise<void>;
  close(request: TerminalCloseRequest): Promise<void>;
  onData(id: string, listener: (data: string) => void): () => void;
  onExit(id: string, listener: (event: { exitCode: number; signal?: number }) => void): () => void;
}

export interface RoninDesktopApi {
  terminal: RoninDesktopTerminalApi;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPtyId(value: unknown): value is string {
  return typeof value === "string" && /^pty-\d+$/.test(value);
}

function subscribeData(id: string, listener: (data: string) => void): () => void {
  if (!isPtyId(id)) return () => {};
  const handler = (_event: unknown, payload: unknown) => {
    if (isRecord(payload) && payload.id === id && typeof payload.data === "string") listener(payload.data);
  };
  ipcRenderer.on(TERMINAL_IPC_CHANNELS.data, handler);
  return () => ipcRenderer.removeListener(TERMINAL_IPC_CHANNELS.data, handler);
}

function subscribeExit(id: string, listener: (event: { exitCode: number; signal?: number }) => void): () => void {
  if (!isPtyId(id)) return () => {};
  const handler = (_event: unknown, payload: unknown) => {
    if (!isRecord(payload) || payload.id !== id || typeof payload.exitCode !== "number") return;
    listener({
      exitCode: payload.exitCode,
      ...(typeof payload.signal === "number" ? { signal: payload.signal } : {}),
    });
  };
  ipcRenderer.on(TERMINAL_IPC_CHANNELS.exit, handler);
  return () => ipcRenderer.removeListener(TERMINAL_IPC_CHANNELS.exit, handler);
}

const terminal: RoninDesktopTerminalApi = {
  open: (request) => ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.open, request) as Promise<PtyHandle>,
  resize: (request) => ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.resize, request) as Promise<void>,
  write: (request) => ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.write, request) as Promise<void>,
  close: (request) => ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.close, request) as Promise<void>,
  onData: subscribeData,
  onExit: subscribeExit,
};

const api: RoninDesktopApi = { terminal };
contextBridge.exposeInMainWorld("roninDesktop", api);

declare global {
  interface Window {
    roninDesktop: RoninDesktopApi;
  }
}
