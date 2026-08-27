import { realpathSync } from "node:fs";
import { commitAdopt, type AdoptInput, type CommitAdoptDeps, type CommitAdoptOutcome } from "./adopt.js";
import { resolveCwd } from "./repos.js";
import { trustedRoots } from "./repo-roots.js";
import { listAllSessions } from "./sessions.js";
import { cycleDirForSession } from "./stages.js";
import { clearAdoptedMark, readAdoptedMark, serializePerSession, setAdoptedMark } from "./tmux.js";
import { resolveFlow } from "./workflow.js";

/** Deliver an initial workflow request after the CLI is ready to receive it. */
export async function sendWhenReady(session: string, prompt: string): Promise<void> {
  const { sendText } = await import("./tmux.js");
  await sendText(session, prompt, true);
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
