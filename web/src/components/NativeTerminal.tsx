import { useEffect, useRef } from "react";
import { FitAddon } from "xterm-addon-fit";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import {
  connectNativeTerminal,
  createReadonlyTerminalRequest,
} from "./native-terminal-controller";
import "./NativeTerminal.css";

export interface NativeTerminalProps {
  session: string;
  paneId?: string;
  className?: string;
}

export function NativeTerminal({ session, paneId, className = "" }: NativeTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      scrollback: 5_000,
      theme: {
        background: "#0d1117",
        foreground: "#d7dee8",
        cursor: "#7ee787",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    const bridge = window.roninDesktop?.terminal;
    if (!bridge) {
      terminal.write("\r\nRonin: la terminal nativa sólo está disponible en Electron.\r\n");
      return () => terminal.dispose();
    }

    const connection = connectNativeTerminal(
      bridge,
      terminal,
      createReadonlyTerminalRequest(session, terminal.cols, terminal.rows),
      {
        onExit: (event) => {
          terminal.write(`\r\n\x1b[33mRonin: la terminal terminó (código ${event.exitCode}${event.signal ? `, señal ${event.signal}` : ""}).\x1b[0m\r\n`);
        },
      },
    );
    // T8 (B2): las teclas van al PTY crudo — esta superficie es "ventana completa": el propio
    // aviso de la UI (AdoptDialog/TerminalsScreen) dice que las teclas van al pane ACTIVO de la
    // ventana, no a uno concreto. La autoridad real (managed/foreign) la resuelve main (T6);
    // esto simplemente reenvía cada tecleo, igual que hacía disableStdin:false por sí solo antes
    // de que este componente existiera.
    const dataSubscription = terminal.onData((data) => connection.write(data));
    let disposed = false;
    const resize = () => {
      if (disposed) return;
      fit.fit();
      void connection.resize(terminal.cols, terminal.rows).catch(() => {
        terminal.write("\r\nRonin: no se pudo sincronizar el tamaño del PTY.\r\n");
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
    observer?.observe(host);
    window.addEventListener("resize", resize);
    void connection.ready.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "fallo desconocido";
      terminal.write(`\r\nRonin: no se pudo abrir la terminal (${message}).\r\n`);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      dataSubscription.dispose();
      void connection.close();
      terminal.dispose();
    };
  }, [paneId, session]);

  return <div ref={hostRef} className={`native-terminal ${className}`} aria-label={`Terminal ${paneId ?? session}`} />;
}
