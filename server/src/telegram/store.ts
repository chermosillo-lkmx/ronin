import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DATA_DIR, dataPath } from "../data-dir.js";
import { writeJsonAtomic } from "../atomic.js";

export interface TelegramConfig {
  botUsername?: string;
  userId?: number;
  chatId?: number;
  topics: Record<string, number>;
  activatedAt?: string;
  pairingCode?: string;
  groupCode?: string;
  lastError?: string;
}

/** Interfaces mínimas: las tareas 5 y 6 las amplían. */
export interface Proposal {
  id: string;
}
export interface CommentDraft {
  id: string;
}
export interface FollowedSession {
  session: string;
}

export interface SentQuestion {
  session: string;
  questionId: string;
  messageId: number;
  options: string[];
  createdAt: string;
}

export interface TelegramState {
  offset?: number;
  proposals: Record<string, Proposal>;
  drafts: Record<string, CommentDraft>;
  questions: Record<string, SentQuestion>;
  sessions: Record<string, FollowedSession>;
}

export interface TelegramStore {
  readToken(): string | null;
  writeToken(token: string): void;
  clearAll(): void;
  readConfig(): TelegramConfig;
  updateConfig(patch: Partial<TelegramConfig>): TelegramConfig;
  migrateChat(oldId: number, newId: number): void;
  readState(): TelegramState;
  updateState(fn: (state: TelegramState) => TelegramState | void): TelegramState;
}

const emptyConfig = (): TelegramConfig => ({ topics: {} });
const emptyState = (): TelegramState => ({ proposals: {}, drafts: {}, questions: {}, sessions: {} });

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const record = (value: unknown): Record<string, never> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, never>) : {};

export function createTelegramStore(dir: string = DATA_DIR): TelegramStore {
  const tokenFile = dataPath("telegram-token", dir);
  const configFile = dataPath("telegram.json", dir);
  const stateFile = dataPath("telegram-state.json", dir);

  const readConfig = (): TelegramConfig => {
    const raw = readJson(configFile);
    return raw ? ({ ...raw, topics: record(raw.topics) } as TelegramConfig) : emptyConfig();
  };
  const readState = (): TelegramState => {
    const raw = readJson(stateFile);
    if (!raw) return emptyState();
    return {
      ...raw,
      proposals: record(raw.proposals),
      drafts: record(raw.drafts),
      questions: record(raw.questions),
      sessions: record(raw.sessions),
    } as TelegramState;
  };

  return {
    readToken() {
      if (!existsSync(tokenFile)) return null;
      return readFileSync(tokenFile, "utf8").trim() || null;
    },
    writeToken(token) {
      writeFileSync(tokenFile, token, { mode: 0o600 });
      chmodSync(tokenFile, 0o600); // el modo de writeFileSync solo rige al crear el archivo
    },
    clearAll() {
      for (const file of [tokenFile, configFile, stateFile]) rmSync(file, { force: true });
    },
    readConfig,
    updateConfig(patch) {
      const next = { ...readConfig(), ...patch };
      writeJsonAtomic(configFile, next);
      return next;
    },
    migrateChat(oldId, newId) {
      const config = readConfig();
      if (config.chatId !== oldId) return;
      writeJsonAtomic(configFile, { ...config, chatId: newId });
    },
    readState,
    updateState(fn) {
      const current = readState();
      const next = fn(current) ?? current;
      writeJsonAtomic(stateFile, next);
      return next;
    },
  };
}
