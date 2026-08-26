import * as nodePty from "node-pty";
import { isSafeTerminalSession } from "./session-name.js";

export const MAX_PTY_INPUT_BYTES = 16 * 1024; // T6, KB electron-desktop:94 (bajado de 64 KiB)
const MAX_COLUMNS = 500;
const MAX_ROWS = 200;

export type PtyManagerErrorCode =
  | "INVALID_SESSION"
  | "INVALID_PANE"
  | "INVALID_DIMENSIONS"
  | "INVALID_PAYLOAD"
  | "TERMINAL_READ_ONLY"
  | "PTY_NOT_FOUND";

export class PtyManagerError extends Error {
  constructor(readonly code: PtyManagerErrorCode) {
    super(code);
    this.name = "PtyManagerError";
  }
}

export interface PtyProcess {
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  resize(columns: number, rows: number): void;
  write(data: string): void;
  kill(): void;
}

export interface PtySpawnOptions {
  cwd?: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
  name?: string;
}

export interface PtyFactory {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
}

/** The terminal must use the same tmux target as the inventory backend. */
export interface PtyManagerOptions {
  tmuxBinary?: string;
  /** Name passed to `tmux -L` for an explicitly selected server (E2E and diagnostics). */
  tmuxSocket?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ReadOnlyPtyOptions {
  session: string;
  cols: number;
  rows: number;
  cwd?: string;
}

export interface PtyHandle {
  id: string;
  session: string;
  readOnly: boolean;
}

export interface PtySubscriptions {
  onData?(data: string): void;
  onExit?(event: { exitCode: number; signal?: number }): void;
}

interface ManagedPty {
  handle: PtyHandle;
  process: PtyProcess;
}

function tmuxAttachPrefix(socket: string | undefined, inheritedTmux: string | undefined): string[] {
  if (socket) return [socket.startsWith("/") ? "-S" : "-L", socket];
  // `TMUX` is `socket-path,pid,client-index`.  An attach inherits neither the current
  // terminal nor its nesting restriction, but it must still select that same server.
  const inheritedSocket = inheritedTmux?.split(",", 1)[0]?.trim();
  return inheritedSocket?.startsWith("/") ? ["-S", inheritedSocket] : [];
}

function terminalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  // A child `tmux attach` launched from a process already inside tmux refuses to nest unless
  // this is removed. The socket, when applicable, is supplied explicitly above.
  delete clean.TMUX;
  return clean;
}

function validateDimensions(columns: number, rows: number): void {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || columns > MAX_COLUMNS || rows < 1 || rows > MAX_ROWS) {
    throw new PtyManagerError("INVALID_DIMENSIONS");
  }
}

// T6: elimina bytes NUL antes de escribir (mismo criterio que el endpoint HTTP de T5) y
// valida el tamaño DESPUÉS del filtro — el límite protege al PTY real, no un conteo de bytes
// que el propio filtro va a reducir.
function sanitizePayload(data: string): string {
  if (typeof data !== "string") throw new PtyManagerError("INVALID_PAYLOAD");
  const filtered = data.split("\x00").join("");
  if (Buffer.byteLength(filtered, "utf8") > MAX_PTY_INPUT_BYTES) throw new PtyManagerError("INVALID_PAYLOAD");
  return filtered;
}

const nativePtyFactory: PtyFactory = {
  spawn(file, args, options) {
    const pty = nodePty.spawn(file, args, {
      ...options,
      name: options.name ?? "xterm-256color",
      env: options.env ?? globalThis.process.env,
    });
    return {
      onData: (listener) => pty.onData(listener),
      onExit: (listener) => pty.onExit(listener),
      resize: (columns, rows) => pty.resize(columns, rows),
      write: (data) => pty.write(data),
      kill: () => pty.kill(),
    };
  },
};

export class PtyManager {
  private readonly ptys = new Map<string, ManagedPty>();
  private nextId = 1;
  private readonly tmuxBinary: string;
  private readonly tmuxPrefix: string[];
  private readonly terminalEnv: NodeJS.ProcessEnv;

  constructor(private readonly factory: PtyFactory = nativePtyFactory, options: PtyManagerOptions = {}) {
    const env = options.env ?? process.env;
    this.tmuxBinary = options.tmuxBinary?.trim() || env.COWORK_TMUX_BIN?.trim() || "tmux";
    this.tmuxPrefix = tmuxAttachPrefix(options.tmuxSocket?.trim() || env.COWORK_TMUX_SOCKET?.trim(), env.TMUX);
    this.terminalEnv = terminalEnvironment(env);
  }

  // P1 (socket aislado, verificado): `attach-session -t %N` cambia la ventana activa
  // y el pane activo de TODA la sesión objetivo (w0 %0 -> w2 %2), no sólo del cliente
  // que ataca. Un `%N` nunca puede ser destino de attach: por eso la API lo rechaza
  // en vez de intentar apuntarlo. Quien quiere un pane concreto usa la vía de
  // capture-pane/send-keys (T5), que falla en vez de redirigir cuando el pane muere.
  openReadOnly(options: ReadOnlyPtyOptions): PtyHandle {
    if ((options as { paneId?: unknown }).paneId !== undefined) throw new PtyManagerError("INVALID_PANE");
    if (!isSafeTerminalSession(options.session)) throw new PtyManagerError("INVALID_SESSION");
    validateDimensions(options.cols, options.rows);

    const target = options.session;
    const process = this.factory.spawn(this.tmuxBinary, [...this.tmuxPrefix, "attach-session", "-r", "-f", "ignore-size", "-t", target], {
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      name: "xterm-256color",
      env: this.terminalEnv,
    });
    const handle: PtyHandle = {
      id: `pty-${this.nextId++}`,
      session: options.session,
      readOnly: true,
    };
    this.ptys.set(handle.id, { handle, process });
    return handle;
  }

  // T6: managed/adopted puede escribir. Sin `-r`: P2 dice que `-r` es alias de
  // `-f read-only,ignore-size`, así que perderlo pierde `ignore-size` gratis — se pone a mano.
  // Sin esto, el cliente de Ronin redimensionaría la ventana del operador (tmux.ts:234-236,
  // el mismo modo de falla que ya documentado con ttyd).
  openWritable(options: ReadOnlyPtyOptions): PtyHandle {
    if ((options as { paneId?: unknown }).paneId !== undefined) throw new PtyManagerError("INVALID_PANE");
    if (!isSafeTerminalSession(options.session)) throw new PtyManagerError("INVALID_SESSION");
    validateDimensions(options.cols, options.rows);

    const process = this.factory.spawn(this.tmuxBinary, [...this.tmuxPrefix, "attach-session", "-f", "ignore-size", "-t", options.session], {
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      name: "xterm-256color",
      env: this.terminalEnv,
    });
    const handle: PtyHandle = {
      id: `pty-${this.nextId++}`,
      session: options.session,
      readOnly: false,
    };
    this.ptys.set(handle.id, { handle, process });
    return handle;
  }

  subscribe(id: string, subscriptions: PtySubscriptions): () => void {
    const managed = this.require(id);
    const dataSubscription = subscriptions.onData ? managed.process.onData(subscriptions.onData) : undefined;
    const exitSubscription = subscriptions.onExit ? managed.process.onExit(subscriptions.onExit) : undefined;
    return () => {
      dataSubscription?.dispose();
      exitSubscription?.dispose();
    };
  }

  resize(id: string, columns: number, rows: number): void {
    validateDimensions(columns, rows);
    this.require(id).process.resize(columns, rows);
  }

  write(id: string, data: string): void {
    const filtered = sanitizePayload(data);
    const managed = this.require(id);
    if (managed.handle.readOnly) throw new PtyManagerError("TERMINAL_READ_ONLY");
    managed.process.write(filtered);
  }

  close(id: string): void {
    const managed = this.ptys.get(id);
    if (!managed) return;
    this.ptys.delete(id);
    managed.process.kill();
  }

  closeAll(): void {
    for (const id of [...this.ptys.keys()]) this.close(id);
  }

  private require(id: string): ManagedPty {
    const managed = this.ptys.get(id);
    if (!managed) throw new PtyManagerError("PTY_NOT_FOUND");
    return managed;
  }
}

export function createPtyManager(options: PtyManagerOptions = {}): PtyManager {
  return new PtyManager(nativePtyFactory, options);
}
