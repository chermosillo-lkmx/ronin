import type { TmuxSessionInfo } from "../types";

const GENERIC_WARNING = "verifyCmd ejecuta shell dentro del worktree de las sesiones vivas de este repo, no en un sandbox. Y se aplica hacia atrás: un comando añadido ahora puede ejecutarse sobre una etapa terminada hace horas.";

function warningMessage(
  targets: Array<{ stageKey: string; cmd: string }>,
  reached: Array<{ session: string; stageKey: string }>,
): string {
  const commands = targets.map(({ stageKey, cmd }) => `${stageKey}: ${cmd}`).join("\n");
  const sessions = reached.length
    ? `\n\nYa alcanzadas en sesiones vivas:\n${reached.map(({ session, stageKey }) => `${session}: ${stageKey}`).join("\n")}`
    : "";
  return `${GENERIC_WARNING}\n\n${commands}${sessions}`;
}

function reachedTargets(
  sessions: TmuxSessionInfo[] | null,
  repo: string | null,
  targets: Array<{ stageKey: string; cmd: string }>,
): Array<{ session: string; stageKey: string }> {
  const targetKeys = new Set(targets.map(({ stageKey }) => stageKey));
  return (sessions ?? []).flatMap((session) => {
    if (!repo || session.presentation?.repo !== repo) return [];
    return (session.flow?.stages ?? [])
      .filter((stage) => targetKeys.has(stage.key) && stage.status !== "pending")
      .map((stage) => ({ session: session.name, stageKey: stage.key }));
  });
}

export interface ArmWarning {
  title: string;
  message: string;
  targets: Array<{ stageKey: string; cmd: string }>;
  reached: Array<{ session: string; stageKey: string }>;
}

export interface ArmDeps {
  confirm: (warning: ArmWarning) => Promise<boolean>;
  getSessions: () => Promise<TmuxSessionInfo[] | null>;
  apply: () => void;
}

export async function armVerifyCmds(
  targets: Array<{ stageKey: string; cmd: string }>,
  repo: string | null,
  deps: ArmDeps,
): Promise<"applied" | "cancelled"> {
  if (targets.length === 0) return "cancelled";
  const sessions = await deps.getSessions().catch(() => null);
  const reached = reachedTargets(sessions, repo, targets);
  const confirmed = await deps.confirm({
    title: "verifyCmd ejecuta shell",
    message: warningMessage(targets, reached),
    targets,
    reached,
  });
  if (!confirmed) return "cancelled";
  deps.apply();
  return "applied";
}
