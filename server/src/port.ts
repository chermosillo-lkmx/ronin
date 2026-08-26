export const DEFAULT_PORT = 8787;

export class InvalidPortError extends Error {
  readonly code = "INVALID_PORT";

  constructor() {
    super("INVALID_PORT: PORT must be an integer between 1024 and 65535");
    this.name = "InvalidPortError";
  }
}

export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function resolvePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) throw new InvalidPortError();

  const port = Number(value);
  if (!isValidPort(port)) throw new InvalidPortError();
  return port;
}
