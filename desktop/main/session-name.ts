// Validador único para desktop/ (T0.4): antes había DOS copias del mismo regex, una en
// pty.ts (isSafeTerminalSession) y otra inline en ipc.ts (parseOpenPayload). `desktop/` no
// puede importar `server/src/*` (tsconfig.desktop.json rootDir:"desktop"), así que esto
// DUPLICA a propósito `server/src/session-name.ts` — session-name.test.ts trae la paridad
// (compara el regex como cadena) para que las dos no diverjan en silencio.
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9._@-]+$/;
export const MAX_SESSION_NAME_LENGTH = 80;

export function isSafeTerminalSession(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_SESSION_NAME_LENGTH &&
    SESSION_NAME_PATTERN.test(name) &&
    !name.includes("..")
  );
}
