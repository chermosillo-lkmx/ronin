import type { PtyHandle, PtyManager, PtySubscriptions, ReadOnlyPtyOptions } from "./pty.js";
import { isSafeTerminalSession } from "./session-name.js";

export interface TerminalOpenRequest {
  session: string;
  cols: number;
  rows: number;
}

export interface TerminalResizeRequest {
  id: string;
  cols: number;
  rows: number;
}

export interface TerminalWriteRequest {
  id: string;
  data: string;
}

export interface TerminalCloseRequest {
  id: string;
}

export const TERMINAL_IPC_CHANNELS = {
  open: "terminal.open",
  resize: "terminal.resize",
  write: "terminal.write",
  close: "terminal.close",
  data: "terminal.data",
  exit: "terminal.exit",
} as const;

export const TERMINAL_IPC_INVOKE_CHANNELS = [
  TERMINAL_IPC_CHANNELS.open,
  TERMINAL_IPC_CHANNELS.resize,
  TERMINAL_IPC_CHANNELS.write,
  TERMINAL_IPC_CHANNELS.close,
] as const;

export interface IpcSenderLike {
  send(channel: string, payload: unknown): void;
  isDestroyed?(): boolean;
  once?(event: "destroyed" | "render-process-gone", listener: () => void): unknown;
}

export interface IpcMainEventLike {
  sender: IpcSenderLike;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainEventLike, payload: unknown) => unknown): void;
  removeHandler(channel: string): void;
}

export class IpcValidationError extends Error {
  constructor(readonly code: "INVALID_IPC_PAYLOAD" | "IPC_FORBIDDEN") {
    super(code);
    this.name = "IpcValidationError";
  }
}

type TerminalManager = Pick<PtyManager, "openReadOnly" | "openWritable" | "subscribe" | "resize" | "write" | "close">;

export type AuthorityResolver = (session: string) => Promise<"managed" | "foreign">;

interface ActiveTerminal {
  sender: IpcSenderLike;
  unsubscribe: () => void;
  prefixBytes: number[];
}

// T6: bytes de prefijo de tmux que se filtran del stream de escritura ANTES de llegar al PTY.
// Sin esto, un attach writable regala `C-b :` — la línea de comandos de tmux, desde la que se
// alcanzan `new-session`/`kill-session`/`run-shell`, evadiendo TODA la allowlist del server por
// un stream de bytes. Fijo al default de tmux (C-b = 0x02), NO consultado vía
// `show-options -gv prefix`: deuda documentada — si el operador remapeó el prefijo, este filtro
// queda rancio (mismo límite que el plan ya anticipa para la variante dinámica).
const DEFAULT_PREFIX_BYTES = [0x02];

function filterPrefixBytes(data: string, prefixBytes: number[]): string {
  if (prefixBytes.length === 0) return data;
  let out = "";
  for (const char of data) {
    if (!prefixBytes.includes(char.codePointAt(0) ?? -1)) out += char;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isPositiveDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPtyId(value: unknown): value is string {
  return typeof value === "string" && /^pty-\d+$/.test(value);
}

function requireSender(event: IpcMainEventLike): IpcSenderLike {
  if (!event || !event.sender || typeof event.sender.send !== "function") throw new IpcValidationError("INVALID_IPC_PAYLOAD");
  return event.sender;
}

// El attach nunca acepta un %N (T0.1, P1): la clave se quita de la allowlist en vez de
// ignorarla, así que un payload que la incluya es INCODIFICABLE, no descartado en silencio.
function parseOpenPayload(value: unknown): ReadOnlyPtyOptions {
  if (!isRecord(value) || !hasOnlyKeys(value, ["session", "cols", "rows"])) throw new IpcValidationError("INVALID_IPC_PAYLOAD");
  if (typeof value.session !== "string" || !isSafeTerminalSession(value.session)) throw new IpcValidationError("INVALID_IPC_PAYLOAD");
  if (!isPositiveDimension(value.cols) || !isPositiveDimension(value.rows)) throw new IpcValidationError("INVALID_IPC_PAYLOAD");
  return {
    session: value.session,
    cols: value.cols,
    rows: value.rows,
  };
}

function parseResizePayload(value: unknown): { id: string; cols: number; rows: number } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "cols", "rows"]) || !isPtyId(value.id) || !isPositiveDimension(value.cols) || !isPositiveDimension(value.rows)) {
    throw new IpcValidationError("INVALID_IPC_PAYLOAD");
  }
  return { id: value.id, cols: value.cols, rows: value.rows };
}

function parseWritePayload(value: unknown): { id: string; data: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "data"]) || !isPtyId(value.id) || typeof value.data !== "string") {
    throw new IpcValidationError("INVALID_IPC_PAYLOAD");
  }
  return { id: value.id, data: value.data };
}

function parseClosePayload(value: unknown): { id: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id"]) || !isPtyId(value.id)) throw new IpcValidationError("INVALID_IPC_PAYLOAD");
  return { id: value.id };
}

function requireOwner(active: Map<string, ActiveTerminal>, sender: IpcSenderLike, id: string): ActiveTerminal {
  const terminal = active.get(id);
  if (!terminal || terminal.sender !== sender) throw new IpcValidationError("IPC_FORBIDDEN");
  return terminal;
}

export function installTerminalIpc(
  ipcMain: IpcMainLike,
  manager: TerminalManager,
  onSenderGone?: (sender: IpcSenderLike, cb: () => void) => void,
  authority?: AuthorityResolver,
): () => void {
  const active = new Map<string, ActiveTerminal>();
  const bySender = new Map<IpcSenderLike, Set<string>>();
  const sendersWatched = new Set<IpcSenderLike>();

  // Un ⌘R deja vivo un `tmux attach` por recarga (active sólo se limpiaba en el handler
  // `close` o en el dispose de shutdown, ipc.ts:159/bootstrap.ts:153). Cada sender se vigila
  // UNA sola vez (no una vez por PTY); cuando se va, cierra TODOS sus PTYs de golpe.
  const cleanupSender = (sender: IpcSenderLike): void => {
    const ids = bySender.get(sender);
    if (!ids) return;
    bySender.delete(sender);
    for (const id of ids) {
      active.get(id)?.unsubscribe();
      active.delete(id);
      manager.close(id);
    }
  };

  const safeSend = (sender: IpcSenderLike, id: string, channel: string, payload: unknown): void => {
    if (!active.has(id) || sender.isDestroyed?.()) return;
    sender.send(channel, payload);
  };

  const open = async (event: IpcMainEventLike, payload: unknown): Promise<PtyHandle> => {
    const sender = requireSender(event);
    const options = parseOpenPayload(payload);
    // T6: la autoridad la resuelve MAIN contra el servidor, nunca un flag del renderer (que
    // parseOpenPayload ya rechaza como clave desconocida). Un resolutor que falla — backend
    // caído — cae a read-only: fail-closed, nunca al revés.
    const kind = authority ? await authority(options.session).catch((): "foreign" => "foreign") : "foreign";
    const handle = kind === "managed" ? manager.openWritable(options) : manager.openReadOnly(options);
    // Se registra en `active` ANTES de suscribirse: algunos managers (y el test que fija
    // este contrato) invocan `onData`/`onExit` de forma síncrona dentro de `subscribe()`, y
    // `safeSend` mira `active` para decidir si el terminal sigue vivo.
    const entry: ActiveTerminal = { sender, unsubscribe: () => {}, prefixBytes: DEFAULT_PREFIX_BYTES };
    active.set(handle.id, entry);
    try {
      const subscriptions: PtySubscriptions = {
        onData: (data) => safeSend(sender, handle.id, TERMINAL_IPC_CHANNELS.data, { id: handle.id, data }),
        onExit: (exit) => safeSend(sender, handle.id, TERMINAL_IPC_CHANNELS.exit, { id: handle.id, ...exit }),
      };
      entry.unsubscribe = manager.subscribe(handle.id, subscriptions);
      let ids = bySender.get(sender);
      if (!ids) {
        ids = new Set();
        bySender.set(sender, ids);
      }
      ids.add(handle.id);
      if (!sendersWatched.has(sender)) {
        sendersWatched.add(sender);
        onSenderGone?.(sender, () => cleanupSender(sender));
      }
      return handle;
    } catch (error) {
      active.delete(handle.id);
      manager.close(handle.id);
      throw error;
    }
  };
  const resize = (event: IpcMainEventLike, payload: unknown): void => {
    const sender = requireSender(event);
    const value = parseResizePayload(payload);
    requireOwner(active, sender, value.id);
    manager.resize(value.id, value.cols, value.rows);
  };
  const write = async (event: IpcMainEventLike, payload: unknown): Promise<void> => {
    const sender = requireSender(event);
    const value = parseWritePayload(payload);
    const terminal = requireOwner(active, sender, value.id);
    manager.write(value.id, filterPrefixBytes(value.data, terminal.prefixBytes));
  };
  const close = (event: IpcMainEventLike, payload: unknown): void => {
    const sender = requireSender(event);
    const value = parseClosePayload(payload);
    const terminal = requireOwner(active, sender, value.id);
    terminal.unsubscribe();
    active.delete(value.id);
    bySender.get(sender)?.delete(value.id);
    manager.close(value.id);
  };

  ipcMain.handle(TERMINAL_IPC_CHANNELS.open, open);
  ipcMain.handle(TERMINAL_IPC_CHANNELS.resize, resize);
  ipcMain.handle(TERMINAL_IPC_CHANNELS.write, write);
  ipcMain.handle(TERMINAL_IPC_CHANNELS.close, close);

  return () => {
    for (const [id, terminal] of active) {
      terminal.unsubscribe();
      manager.close(id);
    }
    active.clear();
    bySender.clear();
    sendersWatched.clear();
    for (const channel of TERMINAL_IPC_INVOKE_CHANNELS) ipcMain.removeHandler(channel);
  };
}
