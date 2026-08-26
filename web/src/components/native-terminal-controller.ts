export interface NativeTerminalOpenRequest {
  session: string;
  cols: number;
  rows: number;
}

export interface NativeTerminalHandle {
  id: string;
  session: string;
  readOnly: boolean; // T6/T8: managed puede abrir writable — deja de ser el literal `true`
}

export interface NativeTerminalBridge {
  open(request: NativeTerminalOpenRequest): Promise<NativeTerminalHandle>;
  resize(request: { id: string; cols: number; rows: number }): Promise<void>;
  write(request: { id: string; data: string }): Promise<void>;
  close(request: { id: string }): Promise<void>;
  onData(id: string, listener: (data: string) => void): () => void;
  onExit(id: string, listener: (event: { exitCode: number; signal?: number }) => void): () => void;
}

export interface TerminalSurface {
  write(data: string): void;
}

export interface NativeTerminalHandlers {
  onExit?(event: { exitCode: number; signal?: number }): void;
}

export interface NativeTerminalConnection {
  readonly ready: Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

// El attach nunca acepta un %N (T0.1, P1): la firma pierde el parámetro paneId
// en vez de aceptarlo y descartarlo, para que un llamador desactualizado falle
// a la compilación en vez de mandar una clave que el main ya rechaza.
export function createReadonlyTerminalRequest(session: string, cols: number, rows: number): NativeTerminalOpenRequest {
  return { session, cols, rows };
}

export function connectNativeTerminal(
  bridge: NativeTerminalBridge,
  surface: TerminalSurface,
  request: NativeTerminalOpenRequest,
  handlers: NativeTerminalHandlers = {},
): NativeTerminalConnection {
  let handleId: string | undefined;
  let disposed = false;
  let stopData = () => {};
  let stopExit = () => {};
  let closePromise: Promise<void> | undefined;
  const pendingWrites: string[] = [];

  const ready = bridge.open(request).then((handle) => {
    handleId = handle.id;
    if (disposed) return;
    stopData = bridge.onData(handle.id, (data) => surface.write(data));
    // T8: el exit se entrega TIPADO a quien pidió la conexión, no como texto cosmético en el
    // buffer (antes `[terminal exited: N]`) — sobre texto la UI no puede ramificar.
    stopExit = bridge.onExit(handle.id, (event) => handlers.onExit?.(event));
    for (const data of pendingWrites.splice(0)) void bridge.write({ id: handle.id, data });
  });

  return {
    ready,
    write(data) {
      if (disposed) return;
      if (handleId) void bridge.write({ id: handleId, data });
      else pendingWrites.push(data); // el teclado puede llegar antes de que `open` resuelva
    },
    resize(cols, rows) {
      return ready.then(() => {
        if (!disposed && handleId) return bridge.resize({ id: handleId, cols, rows });
      });
    },
    close() {
      closePromise ??= (async () => {
        disposed = true;
        await ready.catch(() => {});
        stopData();
        stopExit();
        if (handleId) await bridge.close({ id: handleId });
      })();
      return closePromise;
    },
  };
}
