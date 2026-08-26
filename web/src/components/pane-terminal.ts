// Lógica pura del visor por pane (T8), sin React — mismo reparto que
// native-terminal-controller.ts. La autoridad de escritura ("managed" vs "foreign") llega
// COMO DATO de `deps.kind`, resuelto por el servidor (F2); este módulo nunca la deriva de un
// flag que el propio cliente pudiera inventar.

export type PaneTerminalState = "managed" | "foreign" | "gone";

export interface PaneCaptureResult {
  status: "ok" | "gone";
  content: string | null;
  size?: { cols: number; rows: number };
}

export interface PaneTerminalSurface {
  /** Limpia también el scrollback de la implementación de terminal. */
  clear(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

export interface PaneTerminalDeps {
  kind: "managed" | "foreign";
  session: string;
  paneId: string;
  surface: PaneTerminalSurface;
  capture(): Promise<PaneCaptureResult>;
  sendKeys(request: { session: string; paneId: string; data: string }): Promise<void>;
}

export interface PaneTerminal {
  readonly state: PaneTerminalState;
  readonly readOnly: boolean;
  onData(data: string): void;
  poll(): Promise<void>;
}

export function createPaneTerminal(deps: PaneTerminalDeps): PaneTerminal {
  let state: PaneTerminalState = deps.kind;
  // El tamaño se conserva tal como tmux lo produjo: nunca se deforma el snapshot para hacerlo
  // caber. Antes de cada repintado también se vacía el scrollback real de xterm; CSI 2J sólo
  // limpia el viewport y dejaba cientos de snapshots anteriores en el historial.
  let lastSize: { cols: number; rows: number } | undefined;
  // Bug real (verificado en vivo contra tmux): `onData` de xterm dispara UNA vez por tecla, y
  // cada llamada lanzaba su propio POST /keys independiente. Sin serializar, una petición más
  // lenta puede resolver DESPUÉS que una más rápida disparada más tarde — "echo" llegó como
  // "ehco" al pane real. La cola encadena cada envío al `.then()` del anterior, así que el
  // ORDEN DE LLEGADA queda garantizado sin importar cuánto tarde cada petición HTTP.
  let sendQueue: Promise<void> = Promise.resolve();

  return {
    get state() {
      return state;
    },
    get readOnly() {
      return state !== "managed";
    },
    onData(data: string): void {
      if (state !== "managed") return;
      sendQueue = sendQueue.then(() => deps.sendKeys({ session: deps.session, paneId: deps.paneId, data })).catch(() => {});
    },
    async poll(): Promise<void> {
      // "deja de pedir": un pane gone no vuelve a capturar en el siguiente poll.
      if (state === "gone") return;
      const result = await deps.capture();
      if (result.status === "gone" || result.content === null) {
        state = "gone";
        return;
      }
      if (result.size && (result.size.cols !== lastSize?.cols || result.size.rows !== lastSize?.rows)) {
        deps.surface.resize(result.size.cols, result.size.rows);
        lastSize = result.size;
      }
      deps.surface.clear();
      deps.surface.write(result.content);
    },
  };
}
