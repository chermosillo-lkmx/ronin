import { realpathSync } from "node:fs";
import { commitAdopt, type AdoptInput, type CommitAdoptDeps, type CommitAdoptOutcome } from "./adopt.js";
import { resolveCwd } from "./repos.js";
import { trustedRoots } from "./repo-roots.js";
import { listAllSessions } from "./sessions.js";
import { cycleDirForSession } from "./stages.js";
import { capturePaneSafe, claudeAlive, clearAdoptedMark, isBusy, PASTE_THRESHOLD_BYTES, pastePrompt, promptPending, readAdoptedMark, sendKeys, sendText, serializePerSession, setAdoptedMark } from "./tmux.js";
import { resolveFlow } from "./workflow.js";

export interface PromptDeliveryDeps {
  capturePaneSafe: typeof capturePaneSafe;
  claudeAlive: typeof claudeAlive;
  isBusy: typeof isBusy;
  promptPending: typeof promptPending;
  sendText: typeof sendText;
  pastePrompt: typeof pastePrompt;
  sendKeys: typeof sendKeys;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

const TUI_READY_ATTEMPTS = 10;
const TUI_READY_INTERVAL_MS = 300;
const PENDING_ENTER_ATTEMPTS = 2;

const defaultPromptDeliveryDeps: PromptDeliveryDeps = {
  capturePaneSafe, claudeAlive, isBusy, promptPending, sendText, pastePrompt, sendKeys,
  sleep: async (ms) => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); },
  log: (message) => console.warn(`[claude-cowork] ${message}`),
};

/**
 * Espera la primera señal de Claude antes de escribir. El timeout es deliberado: un banner que
 * cambie no puede bloquear la creación de una sesión para siempre. Si no aparece una señal de
 * CLI, se deja el motivo al operador y no se escribe: el peor caso es que el worker requiera el
 * botón del operador; entregar a ciegas puede ejecutar texto arbitrario dentro de un shell.
 */
export async function deliverPromptWhenReady(session: string, prompt: string, deps: PromptDeliveryDeps = defaultPromptDeliveryDeps): Promise<void> {
  let cliReady = false;
  for (let attempt = 0; attempt < TUI_READY_ATTEMPTS; attempt++) {
    const pane = await deps.capturePaneSafe(session);
    if (pane !== null && (deps.claudeAlive(pane) || deps.isBusy(pane))) {
      cliReady = true;
      break;
    }
    await deps.sleep(TUI_READY_INTERVAL_MS);
  }
  if (!cliReady) {
    deps.log(`COWORK_PROMPT_NOT_DELIVERED_NO_CLI:${session}`);
    return;
  }

  if (Buffer.byteLength(prompt, "utf8") > PASTE_THRESHOLD_BYTES) await deps.pastePrompt(session, prompt, true);
  else await deps.sendText(session, prompt, true);

  for (let attempt = 0; attempt < PENDING_ENTER_ATTEMPTS; attempt++) {
    const pane = await deps.capturePaneSafe(session);
    if (pane === null || !deps.promptPending(pane)) break;
    await deps.sendKeys(session, "Enter");
  }
}

/** Deliver an initial workflow request after the CLI is ready to receive it. */
export async function sendWhenReady(session: string, prompt: string): Promise<void> {
  await deliverPromptWhenReady(session, prompt);
}

/**
 * Adoption is intentionally kept independent of the retired task-worker engine. The durable
 * cycle record and tmux mark remain the source of truth consumed by the sessions inventory.
 */
export async function adoptSession(input: AdoptInput): Promise<CommitAdoptOutcome> {
  const liveSessions = await listAllSessions();
  const deps: CommitAdoptDeps = {
    inventory: () => liveSessions.map((session) => ({
      name: session.name,
      kind: session.kind,
      createdAt: session.createdAt,
      panes: session.panes.map((pane) => ({ id: pane.id })),
    })),
    listRepos: (await import("./repos.js")).listRepos,
    resolveCwd,
    allowedRoots: trustedRoots(),
    realpath: realpathSync,
    resolveFlow: (repo) => resolveFlow(undefined, repo),
    cycleDirForSession,
    liveSessionSnapshot: async (name) => {
      const session = (await listAllSessions()).find((entry) => entry.name === name);
      return session ? { createdAt: session.createdAt, panes: session.panes.map((pane) => ({ id: pane.id })) } : null;
    },
    setAdoptedMark,
    readAdoptedMark,
    clearAdoptedMark,
    registerWorker: () => undefined,
    serialize: serializePerSession,
  };
  return commitAdopt(input, deps);
}

/** Releasing adoption never terminates the operator's tmux session. */
export async function releaseAdoption(session: string): Promise<void> {
  await clearAdoptedMark(session);
}
