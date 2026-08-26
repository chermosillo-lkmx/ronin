import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { capturePane, sendPaneKeys } from "../api";
import { createPaneTerminal } from "./pane-terminal";
import "./NativeTerminal.css";

export interface PaneViewerProps {
  session: string;
  paneId: string;
  kind: "managed" | "foreign";
  className?: string;
}

// Superficie PRINCIPAL de terminal (§2.2 del plan): render por `capture-pane` + input
// dirigido por `send-keys -t %N`, validado en servidor. Nunca muta al sólo abrirse (P4) — a
// diferencia de NativeTerminal (la superficie secundaria, PTY crudo), esto puede montarse solo.
//
// Deliberadamente SIN FitAddon: el tamaño de esta terminal lo dicta el PANE REAL (cols/rows que
// devuelve /capture), nunca el contenedor CSS. Encoger el contenido a la fuerza para que
// "quepa" fue exactamente el bug real que encontramos en vivo — escribir un buffer de 65 filas
// en una terminal fijada a las ~24 que cabían en la caja empujaba el excedente a scrollback EN
// CADA poll (5/s), reventando el renderer en menos de un minuto. El contenedor deja que el
// usuario haga scroll/overflow en vez de deformar (plan §6.1: "letterbox, no deformar").
export function PaneViewer({ session, paneId, kind, className = "" }: PaneViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // `disposed` ANTES de usarse: un `poll()` en vuelo puede resolver después del cleanup
    // (React.StrictMode remonta en dev), y sin este guard esa escritura tardía cae sobre un
    // terminal ya destruido — xterm lanza "Cannot read properties of undefined ('dimensions')"
    // (verificado en vivo).
    let disposed = false;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      scrollback: 200, // ventana corta a propósito: cada poll ya trae la pantalla completa
      theme: { background: "#0d1117", foreground: "#d7dee8", cursor: "#7ee787" },
    });
    terminal.open(host);

    // Identidad clavada en %N y sólo en %N: si paneId se derivara de una posición en un array
    // que cambia cada poll, este efecto remontaría constantemente (SessionsScreen.tsx ya lo
    // documenta para `s.panes`, un array nuevo cada 6 s).
    const paneTerminal = createPaneTerminal({
      kind,
      session,
      paneId,
      surface: {
        clear: () => { if (!disposed) terminal.clear(); },
        write: (data) => { if (!disposed) terminal.write(data); },
        resize: (cols, rows) => { if (!disposed) terminal.resize(cols, rows); },
      },
      capture: async () => {
        const result = await capturePane(session, paneId);
        return result ? { status: result.status, content: result.content, size: result.size } : { status: "gone", content: null };
      },
      sendKeys: async ({ data }) => {
        await sendPaneKeys(session, paneId, data);
      },
    });

    const dataSubscription = terminal.onData((data) => paneTerminal.onData(data));

    // 200ms el pane enfocado (P4/§6.1 del plan) — esta pantalla siempre está "enfocada" al
    // montarse, no hay rejilla de celdas de fondo con intervalo distinto todavía.
    const POLL_MS = 200;
    const loop = async () => {
      if (disposed) return;
      await paneTerminal.poll().catch(() => {});
      if (!disposed) timer = window.setTimeout(loop, POLL_MS);
    };
    let timer = window.setTimeout(loop, 0);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      dataSubscription.dispose();
      terminal.dispose();
    };
  }, [session, paneId, kind]);

  return <div ref={hostRef} className={`native-terminal native-terminal-natural ${className}`} aria-label={`Pane ${paneId}`} />;
}
