import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./atomic.js";
import { isSafeSessionName } from "./session-name.js";

const MAX_TITLE_LENGTH = 120;

export interface SessionPresentation {
  title: string;
  repo: string | null;
}

export interface SessionPresentationInput {
  title: unknown;
  repo: unknown;
}

export class SessionPresentationError extends Error {
  constructor(readonly code: "SESSION_INVALID" | "TITLE_INVALID" | "REPO_UNKNOWN") {
    super(code);
    this.name = "SessionPresentationError";
  }
}

function readPresentations(file: string): Record<string, SessionPresentation> {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const result: Record<string, SessionPresentation> = {};
    for (const [session, raw] of Object.entries(value)) {
      if (!isSafeSessionName(session) || !raw || typeof raw !== "object") continue;
      const item = raw as Partial<SessionPresentation>;
      if (typeof item.title !== "string") continue;
      if (item.repo !== null && typeof item.repo !== "string") continue;
      result[session] = { title: item.title, repo: item.repo ?? null };
    }
    return result;
  } catch {
    return {};
  }
}

function normalize(input: SessionPresentationInput, repos: string[]): SessionPresentation {
  if (typeof input.title !== "string") throw new SessionPresentationError("TITLE_INVALID");
  const title = input.title.trim();
  if (title.length > MAX_TITLE_LENGTH || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new SessionPresentationError("TITLE_INVALID");
  }
  const rawRepo = typeof input.repo === "string" ? input.repo.trim() : "";
  if (rawRepo && !repos.includes(rawRepo)) throw new SessionPresentationError("REPO_UNKNOWN");
  return { title, repo: rawRepo || null };
}

export interface SessionPresentationStore {
  get(session: string): SessionPresentation | null;
  list(sessions: string[]): Record<string, SessionPresentation>;
  save(session: string, input: SessionPresentationInput): SessionPresentation;
}

/** Metadata local de presentación: no modifica el nombre, layout ni opciones de tmux. */
export function createSessionPresentationStore(file: string, listRepos: () => string[]): SessionPresentationStore {
  return {
    get(session) {
      return readPresentations(file)[session] ?? null;
    },
    list(sessions) {
      const persisted = readPresentations(file);
      return Object.fromEntries(sessions.flatMap((session) => persisted[session] ? [[session, persisted[session]]] : []));
    },
    save(session, input) {
      if (!isSafeSessionName(session)) throw new SessionPresentationError("SESSION_INVALID");
      const presentation = normalize(input, listRepos());
      const persisted = readPresentations(file);
      if (!presentation.title && !presentation.repo) delete persisted[session];
      else persisted[session] = presentation;
      writeJsonAtomic(file, persisted);
      return presentation;
    },
  };
}
