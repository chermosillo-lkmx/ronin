import { bootstrapDesktop, type DesktopDependencies } from "./bootstrap.js";
import { writeFileSync } from "node:fs";

export interface SmokeApp {
  exit(code: number): void;
  resultFile?: string;
}

function writeResult(file: string | undefined, result: { status: "pass" | "fail"; error?: string }): void {
  if (!file) return;
  try {
    writeFileSync(file, JSON.stringify(result), "utf8");
  } catch {
    // The smoke result is diagnostic only; the process exit code remains authoritative.
  }
}

export interface SmokeCheckResult {
  url: unknown;
  root: unknown;
  health: unknown;
  isolated: unknown;
  terminalBridge: unknown;
  terminalWindow: unknown;
  terminalPane: unknown;
  roninShell: unknown;
  sessionOpen: unknown;
  interactiveTerminal: unknown;
  sessionActions: unknown;
  sessionPresentation: unknown;
  normalTerminalLaunch: unknown;
  tmuxPaneGrid: unknown;
}

// T9: nombres fijos que `run-electron-smoke.mjs` prepara en el socket AISLADO antes de
// lanzar Electron (COWORK_TMUX_SOCKET, T0.8) — el renderer sólo los consume por HTTP/IPC,
// nunca toca tmux directamente.
export const SMOKE_WINDOW_SESSION = "cowork-smoke-window";
export const SMOKE_PANE_SESSION = "cowork-smoke-pane";

// M6: antes `roninDesktop` vivía en la lista de globals PROHIBIDOS del renderer, así que un
// bridge de terminal que funciona de verdad hacía FALLAR el smoke, y uno roto lo hacía pasar
// — el criterio exigía justo lo contrario de lo que T0.5 arregla. `isolated` cubre
// require/process/ronin/electron (el aislamiento sigue intacto); `terminalBridge` es su
// propia comprobación, separada, de que `window.roninDesktop.terminal.open` existe.
// `terminalWindow`/`terminalPane` (T9) EJERCITAN de verdad las dos superficies — un doble no
// puede cubrir esto: hace falta la app real, el proxy real y tmux real.
export function evaluateSmokeResult(result: SmokeCheckResult): boolean {
  return (
    result.url === "app://ronin/" &&
    result.root === true &&
    result.health === true &&
    result.isolated === true &&
    result.terminalBridge === true &&
    result.terminalWindow === true &&
    result.terminalPane === true &&
    result.roninShell === true &&
    result.sessionOpen === true &&
    result.interactiveTerminal === true &&
    result.sessionActions === true &&
    result.sessionPresentation === true &&
    result.normalTerminalLaunch === true &&
    result.tmuxPaneGrid === true
  );
}

/** Exercises the production bootstrap once and exits only after the child backend has closed. */
export async function runSmoke(deps: DesktopDependencies, app: SmokeApp): Promise<void> {
  try {
    const controller = await bootstrapDesktop(deps, { dev: false });
    if (!controller.supervisor.port) throw new Error(`RONIN_BACKEND_NOT_READY: ${controller.supervisor.recoverySnapshot()}`);
    if (!controller.window.webContents.executeJavaScript) throw new Error("RONIN_SMOKE_NO_EXECUTOR");
    const result = (await controller.window.webContents.executeJavaScript(`
      (async () => {
        const health = await fetch('/api/health').then(async (response) => ({ ok: response.ok, body: await response.json() }));

        // GREEN(b) — superficie SECUNDARIA (attach de ventana completa, PTY crudo). Requiere
        // un handle WRITABLE: la sesión '${SMOKE_WINDOW_SESSION}' la preparó run-electron-smoke.mjs
        // con prefijo cowork- + cycle dir, así que la autoridad (T6) la resuelve "managed".
        let terminalWindow = false;
        let terminalWindowError = '';
        try {
          const handle = await window.roninDesktop.terminal.open({ session: '${SMOKE_WINDOW_SESSION}', cols: 80, rows: 24 });
          terminalWindow = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), 8000);
            const unsub = window.roninDesktop.terminal.onData(handle.id, (data) => {
              if (data.includes('RONIN_SMOKE_OK')) { clearTimeout(timer); unsub(); resolve(true); }
            });
            window.roninDesktop.terminal.write({ id: handle.id, data: 'echo RONIN_SMOKE_OK\\r' });
          });
          await window.roninDesktop.terminal.close({ id: handle.id });
        } catch (error) { terminalWindow = false; terminalWindowError = String(error?.message || error); }

        // GREEN(a) — superficie PRINCIPAL (pane-scoped), conducida desde el RENDERER por fetch
        // sobre app://ronin/api/..., ejercitando el proxy real y la inyección de la cabecera de
        // capability — justo lo que un doble no puede cubrir. '${SMOKE_PANE_SESSION}' tiene 2
        // panes (%A, %B); run-electron-smoke.mjs escribió marcadores distintos en cada uno FUERA
        // de Ronin.
        let terminalPane = false;
        try {
          const inv = await fetch('/api/sessions').then((r) => r.json());
          const session = inv.sessions.find((s) => s.name === '${SMOKE_PANE_SESSION}');
          if (!session) throw new Error('session not found in inventory: ' + JSON.stringify(inv.sessions.map((s) => s.name)));
          const [paneA, paneB] = session.panes.map((p) => p.id);
          const capA = await fetch('/api/sessions/${SMOKE_PANE_SESSION}/panes/' + encodeURIComponent(paneA) + '/capture').then((r) => r.json());
          const renderOk = capA.status === 'ok' && capA.content.includes('E2E_PANE_A') && !capA.content.includes('E2E_PANE_B');

          const keysRes = await fetch('/api/sessions/${SMOKE_PANE_SESSION}/panes/' + encodeURIComponent(paneA) + '/keys', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'echo E2E_INPUT_OK', submit: true }),
          });
          let inputOk = false;
          for (let i = 0; i < 20; i++) {
            const c = await fetch('/api/sessions/${SMOKE_PANE_SESSION}/panes/' + encodeURIComponent(paneA) + '/capture').then((r) => r.json());
            if (c.content && c.content.includes('E2E_INPUT_OK')) { inputOk = true; break; }
            await new Promise((r) => setTimeout(r, 300));
          }
          const capBAfter = await fetch('/api/sessions/${SMOKE_PANE_SESSION}/panes/' + encodeURIComponent(paneB) + '/capture').then((r) => r.json());
          const noLeak = !(capBAfter.content ?? '').includes('E2E_INPUT_OK');

          // La cabecera de capability la inyecta el proxy SIEMPRE (bootstrap.ts) — desde el
          // renderer no hay forma de mandar la petición SIN ella (justo el punto de T0.2b: el
          // cliente nunca la declara). Que keysRes.ok sea true YA prueba que el proxy real la
          // inyectó de verdad (sin eso, requireCapability habría dado 401). La mitad "ausente ->
          // 401" del gate ya está cubierta por los unit tests de requireCapability/index.test.ts.
          terminalPane = renderOk && keysRes.ok && inputOk && noLeak;
        } catch { terminalPane = false; }

        // Electron must enter the desktop shell (never the web dashboard). This also exercises
        // the real inventory rendering with the fixture created in the isolated tmux socket.
        let roninShell = false;
        try {
          for (let i = 0; i < 20; i++) {
            const titlebar = document.querySelector('.ronin-titlebar');
            const rail = document.querySelector('.ronin-rail');
            const context = document.querySelector('.ronin-context-list');
            const inspector = document.querySelector('.ronin-inspector');
            const fixtureListed = Array.from(document.querySelectorAll('.ronin-session-row code')).some((el) => el.textContent === '${SMOKE_PANE_SESSION}');
            const css = titlebar && rail && context && inspector
              ? [getComputedStyle(titlebar).height, getComputedStyle(rail).width, getComputedStyle(context).width, getComputedStyle(inspector).width]
              : [];
            if (fixtureListed && css.join(',') === '38px,52px,262px,274px') { roninShell = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        } catch { roninShell = false; }

        // El inventario no basta: el flujo del operador es pulsar una sesión y ver el pane
        // dentro de la aplicación. terminalPane de arriba comprueba el contenido del pane;
        // éste prueba el montaje real de PaneViewer/xterm después del click del usuario.
        let sessionOpen = false;
        try {
          for (let i = 0; i < 20; i++) {
            const row = Array.from(document.querySelectorAll('.ronin-session-row')).find((element) => element.querySelector('code')?.textContent === '${SMOKE_PANE_SESSION}');
            if (row instanceof HTMLElement) {
              row.click();
              await new Promise((resolve) => setTimeout(resolve, 250));
              if (document.querySelector('.ronin-terminal-stage .native-terminal .xterm')) { sessionOpen = true; break; }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch { sessionOpen = false; }

        // Los dos controles operativos deben estar presentes antes de abrir el attach. El cierre
        // se prueba por API en index.test.ts para no matar el fixture que usa el resto del smoke.
        let sessionActions = false;
        try {
          const attach = document.querySelector('[data-testid="attach-session"]');
          const close = document.querySelector('[data-testid="close-session"]');
          sessionActions = attach instanceof HTMLElement && close instanceof HTMLElement;
        } catch { sessionActions = false; }

        // El menú contextual de cada fila permite nombrar la sesión y asociarle un repo. El
        // diálogo no debe ser decorativo: se prueban los dos campos antes de cerrarlo.
        let sessionPresentation = false;
        try {
          const edit = document.querySelector('[data-testid="edit-session-presentation"]');
          if (edit instanceof HTMLElement) {
            edit.click();
            await new Promise((resolve) => setTimeout(resolve, 100));
            const title = document.querySelector('[data-testid="session-presentation-title"]');
            const repo = document.querySelector('[data-testid="session-presentation-repo"]');
            sessionPresentation = title instanceof HTMLInputElement && repo instanceof HTMLSelectElement;
            const cancel = document.querySelector('[data-testid="cancel-session-presentation"]');
            if (cancel instanceof HTMLElement) cancel.click();
          }
        } catch { sessionPresentation = false; }

        // Nueva sesión debe permitir una terminal de Claude/Codex sin depender de un workflow.
        let normalTerminalLaunch = false;
        try {
          const add = document.querySelector('.ronin-add');
          if (add instanceof HTMLElement) {
            add.click();
            await new Promise((resolve) => setTimeout(resolve, 100));
            const terminalMode = document.querySelector('[data-testid="session-mode-terminal"]');
            if (terminalMode instanceof HTMLElement) terminalMode.click();
            await new Promise((resolve) => setTimeout(resolve, 50));
            const agent = document.querySelector('[data-testid="session-agent"]');
            const workflow = document.querySelector('[data-testid="session-workflow"]');
            normalTerminalLaunch = agent instanceof HTMLSelectElement && workflow === null;
            const cancel = Array.from(document.querySelectorAll('.ronin-new-session button')).find((button) => button.textContent === 'Cancelar');
            if (cancel instanceof HTMLElement) cancel.click();
          }
        } catch { normalTerminalLaunch = false; }

        // La acción visible abre un attach PTY, no sólo el visor de captura por pane.
        let interactiveTerminal = false;
        try {
          const openTerminal = document.querySelector('[data-testid="attach-session"]');
          if (openTerminal instanceof HTMLElement) {
            openTerminal.click();
            for (let i = 0; i < 20; i++) {
              if (document.querySelector('.ronin-session-native-attach .xterm')) { interactiveTerminal = true; break; }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
        } catch { interactiveTerminal = false; }

        // Terminales debe hacer visibles todos los panes de la sesión. Los snapshots se limpian
        // en xterm entre polls, por lo que este montaje no acumula scrollback.
        let tmuxPaneGrid = false;
        try {
          const terminalsTab = document.querySelector('[aria-label="Terminales"]');
          if (terminalsTab instanceof HTMLElement) {
            terminalsTab.click();
            for (let i = 0; i < 20; i++) {
              const grid = document.querySelector('[data-testid="tmux-pane-grid"]');
              const panes = grid?.querySelectorAll('.ronin-terminal-cell .xterm').length ?? 0;
              if (grid && panes === 2 && !document.querySelector('.ronin-terminal-layout-attach')) { tmuxPaneGrid = true; break; }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
        } catch { tmuxPaneGrid = false; }

        return {
          url: location.href,
          root: document.querySelector('#root')?.textContent?.trim().length > 0,
          health: health.ok && health.body?.ok === true,
          isolated: ['require', 'process', 'ronin', 'electron'].every((key) => !(key in window)),
          terminalBridge: typeof window.roninDesktop?.terminal?.open === 'function',
          terminalWindow,
          terminalPane,
          roninShell,
          sessionOpen,
          interactiveTerminal,
          sessionActions,
          sessionPresentation,
          normalTerminalLaunch,
          tmuxPaneGrid,
          terminalWindowError,
        };
      })()
    `)) as SmokeCheckResult;
    if (!evaluateSmokeResult(result)) throw new Error(`RONIN_SMOKE_ASSERTION_FAILED ${JSON.stringify(result)}`);
    await controller.shutdown();
    writeResult(app.resultFile, { status: "pass" });
    console.log("RONIN_SMOKE:PASS");
    app.exit(0);
  } catch (error) {
    writeResult(app.resultFile, { status: "fail", error: error instanceof Error ? error.message : String(error) });
    console.error("RONIN_SMOKE:FAIL");
    app.exit(1);
  }
}
