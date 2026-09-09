import type { RepoOverrideConfig, WorkflowConfig } from "../types";
import { armVerifyCmds, type ArmDeps } from "./harness-arm";
import type { WorkflowDraftState } from "./workflow-draft";

function verifyCmdTargets(draft: WorkflowDraftState): Array<{ stageKey: string; cmd: string }> {
  const savedCommands = new Map(draft.saved.stages.map((stage) => [stage.key, stage.verifyCmd?.trim()]));
  return draft.stages.flatMap((stage) => {
    const cmd = stage.verifyCmd?.trim();
    return cmd && cmd !== savedCommands.get(stage.key) ? [{ stageKey: stage.key, cmd }] : [];
  });
}

export async function confirmWorkflowSave<T>(
  draft: WorkflowDraftState,
  repo: string | null,
  deps: Omit<ArmDeps, "apply">,
  save: () => Promise<T>,
): Promise<T | null> {
  if (repo === null) return save();
  const targets = verifyCmdTargets(draft);
  if (targets.length === 0) return save();
  const result = await armVerifyCmds(targets, repo, { ...deps, apply: () => {} });
  return result === "applied" ? save() : null;
}

export function workflowPayload(draft: WorkflowDraftState): WorkflowConfig {
  return {
    stages: draft.stages,
    verifyAfter: draft.verifyAfter,
    ...(draft.inputs ? { inputs: draft.inputs } : {}),
  };
}

function withoutVerifyFields(stage: WorkflowConfig["stages"][number]): WorkflowConfig["stages"][number] {
  const sanitized = { ...stage };
  delete sanitized.verifyCmd;
  delete sanitized.maxRetries;
  return sanitized;
}

export function globalWorkflowPayload(draft: WorkflowDraftState): WorkflowConfig {
  return {
    ...workflowPayload(draft),
    stages: draft.stages.map(withoutVerifyFields),
  };
}

export interface RepoConfigInput {
  workflow: WorkflowConfig | null;
  vars: Record<string, string>;
  startCommand: string;
  setupCommand?: string;
  kbPath?: string;
  plannerModel: string;
  workerModel: string;
  inheritWorkflow: boolean;
}

export function repoPayload(
  draft: WorkflowDraftState,
  entry: RepoOverrideConfig | null,
  inheritWorkflow: boolean,
): RepoConfigInput {
  return {
    workflow: inheritWorkflow ? null : workflowPayload(draft),
    vars: entry?.vars ?? {},
    startCommand: entry?.startCommand ?? "",
    setupCommand: entry?.setupCommand ?? "",
    kbPath: entry?.kbPath ?? "",
    plannerModel: entry?.plannerModel ?? "",
    workerModel: entry?.workerModel ?? "",
    inheritWorkflow,
  };
}
