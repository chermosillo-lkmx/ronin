import { randomBytes } from "node:crypto";

export const MAX_BACKEND_LOG_BYTES = 32 * 1024;
const START_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

export type BackendErrorCode =
  | "BACKEND_EXITED"
  | "BACKEND_PROTOCOL_ERROR"
  | "BACKEND_START_TIMEOUT"
  | "BACKEND_CLOSE_TIMEOUT";

export class BackendSupervisorError extends Error {
  constructor(readonly code: BackendErrorCode) {
    super(code);
    this.name = "BackendSupervisorError";
  }
}

export interface UtilityChild {
  stdout?: { on(event: "data" | "end", listener: (chunk?: Uint8Array) => void): unknown };
  stderr?: { on(event: "data" | "end", listener: (chunk?: Uint8Array) => void): unknown };
  on(event: "message" | "exit", listener: (value?: unknown) => void): unknown;
  once?(event: "exit", listener: (value?: unknown) => void): unknown;
  kill(): void;
}

export interface HealthResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface BackendSupervisorDependencies {
  fork(entry: string, options: { stdio: "pipe"; env: NodeJS.ProcessEnv }): UtilityChild;
  fetch(url: string, options?: { headers?: Record<string, string> }): Promise<HealthResponse>;
  sleep(ms: number): Promise<void>;
  now(): number;
  createToken(): string;
  entry: string;
  env?: NodeJS.ProcessEnv;
  onExit?: () => void;
}

type BackendMessage = { type: "ronin-backend-listening"; version: 1; port: number };

function isBackendMessage(message: unknown): message is BackendMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Record<string, unknown>;
  return candidate.type === "ronin-backend-listening" && candidate.version === 1 && isStructuralPort(candidate.port);
}

export function isStructuralPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

class AnsiStripper {
  private state: "normal" | "esc" | "csi" = "normal";

  write(text: string, output: (value: string) => void): void {
    for (const character of text) {
      if (this.state === "normal") {
        if (character === "\u001b") this.state = "esc";
        else output(character);
      } else if (this.state === "esc") {
        this.state = character === "[" ? "csi" : "normal";
      } else if (character >= "@" && character <= "~") {
        this.state = "normal";
      }
    }
  }
}

class CredentialRedactor {
  private pending = "";
  private discardingLine = false;
  private readonly credentials = ["authorization", "api-key", "api_key", "password", "secret", "cookie", "token", "bearer"];

  write(text: string, output: (value: string) => void): void {
    for (const character of text) {
      if (this.discardingLine) {
        if (character === "\n" || character === "\r") {
          this.discardingLine = false;
          output(character);
        }
        continue;
      }

      this.pending += character;
      const lower = this.pending.toLowerCase();
      if (this.credentials.some((credential) => lower.includes(credential))) {
        this.pending = "";
        this.discardingLine = true;
        output("<redacted>");
        continue;
      }
      while (this.pending.length > 32) {
        output(this.pending[0]!);
        this.pending = this.pending.slice(1);
      }
    }
  }

  finish(output: (value: string) => void): void {
    if (!this.discardingLine) output(this.pending);
    this.pending = "";
    this.discardingLine = false;
  }
}

class SanitizedStream {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly ansi = new AnsiStripper();
  private readonly redactor = new CredentialRedactor();

  constructor(private readonly output: (value: string) => void) {}

  write(chunk: Uint8Array): void {
    this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  finish(): void {
    this.consume(this.decoder.decode());
    this.redactor.finish(this.output);
  }

  private consume(text: string): void {
    this.ansi.write(text, (value) => this.redactor.write(value, this.output));
  }
}

function trimUtf8Tail(value: string, maximumBytes: number): string {
  let tail = value;
  while (Buffer.byteLength(tail, "utf8") > maximumBytes) {
    const first = Array.from(tail)[0];
    tail = tail.slice(first.length);
  }
  return tail;
}

function defaultDependencies(): Omit<BackendSupervisorDependencies, "fork" | "entry"> {
  return {
    fetch: (url, options) => fetch(url, options) as Promise<HealthResponse>,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    createToken: () => randomBytes(32).toString("hex"),
  };
}

export class BackendSupervisor {
  private child: UtilityChild | undefined;
  private childExited = false;
  private token = "";
  private portValue: number | undefined;
  private tail = "";
  private closePromise: Promise<void> | undefined;
  private attempt = 0;
  private closeRequested = false;

  constructor(private readonly deps: BackendSupervisorDependencies) {}

  get port(): number | undefined { return this.portValue; }
  get logs(): string { return this.tail; }

  recoverySnapshot(): string {
    return trimUtf8Tail(this.tail.split(/\r?\n/).slice(-20).join("\n"), 4 * 1024);
  }

  async start(): Promise<void> {
    if (this.portValue) return;
    const child = this.launch();
    const deadline = this.deps.now() + START_TIMEOUT_MS;
    let exited = false;
    let protocolError = false;
    let message: BackendMessage | undefined;
    child.on("exit", () => { exited = true; });
    child.on("message", (value) => {
      if (isBackendMessage(value)) message = value;
      else protocolError = true;
    });

    try {
      while (this.deps.now() < deadline) {
        if (exited) throw new BackendSupervisorError("BACKEND_EXITED");
        if (protocolError) throw new BackendSupervisorError("BACKEND_PROTOCOL_ERROR");
        if (message) {
          const response = await this.deps.fetch(`http://127.0.0.1:${message.port}/api/health`, {
            headers: { "cache-control": "no-store", "x-ronin-boot-token": this.token },
          }).catch(() => undefined);
          if (response?.ok && response.status === 200) {
            const health = await response.json().catch(() => undefined);
            if (this.isExpectedHealth(health)) {
              this.portValue = message.port;
              return;
            }
            throw new BackendSupervisorError("BACKEND_PROTOCOL_ERROR");
          }
        }
        await this.deps.sleep(250);
      }
      throw new BackendSupervisorError("BACKEND_START_TIMEOUT");
    } catch (error) {
      await this.closeChild(child);
      if (this.child === child && this.childExited) this.child = undefined;
      throw error;
    }
  }

  async retry(): Promise<void> {
    await this.close();
    this.closePromise = undefined;
    this.child = undefined;
    this.childExited = false;
    this.portValue = undefined;
    this.tail = "";
    this.closeRequested = false;
    await this.start();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    this.closePromise = this.closeChild();
    return this.closePromise;
  }

  private launch(): UtilityChild {
    const attempt = ++this.attempt;
    this.token = this.deps.createToken();
    const child = this.deps.fork(this.deps.entry, {
      stdio: "pipe",
      env: { ...(this.deps.env ?? process.env), COWORK_DESKTOP_BOOT_TOKEN: this.token },
    });
    this.child = child;
    this.childExited = false;
    child.on("exit", () => {
      if (this.child === child) {
        const wasReady = this.portValue !== undefined;
        this.childExited = true;
        this.portValue = undefined;
        if (wasReady && !this.closeRequested) this.deps.onExit?.();
      }
    });
    const append = (value: string) => {
      if (attempt === this.attempt) this.tail = trimUtf8Tail(this.tail + value, MAX_BACKEND_LOG_BYTES);
    };
    const stdout = new SanitizedStream(append);
    const stderr = new SanitizedStream(append);
    child.stdout?.on("data", (chunk) => stdout.write(chunk ?? new Uint8Array()));
    child.stderr?.on("data", (chunk) => stderr.write(chunk ?? new Uint8Array()));
    child.stdout?.on("end", () => stdout.finish());
    child.stderr?.on("end", () => stderr.finish());
    return child;
  }

  // El token ya NO viaja en el cuerpo (P12): el supervisor lo presenta por cabecera
  // (arriba) y el server sólo confirma con `tokenOk`, nunca lo repite.
  private isExpectedHealth(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const health = value as Record<string, unknown>;
    return health.ok === true && health.version === 1 && health.service === "ronin-api" && health.tokenOk === true;
  }

  private async closeChild(child = this.child): Promise<void> {
    if (!child) return;
    let exited = child === this.child && this.childExited;
    child.once?.("exit", () => { exited = true; });
    child.kill();
    const deadline = this.deps.now() + CLOSE_TIMEOUT_MS;
    while (!exited && this.deps.now() < deadline) await this.deps.sleep(50);
    if (!exited) throw new BackendSupervisorError("BACKEND_CLOSE_TIMEOUT");
  }
}

export function createBackendSupervisor(deps: Omit<BackendSupervisorDependencies, "fetch" | "sleep" | "now" | "createToken"> & Partial<BackendSupervisorDependencies>): BackendSupervisor {
  return new BackendSupervisor({ ...defaultDependencies(), ...deps });
}
