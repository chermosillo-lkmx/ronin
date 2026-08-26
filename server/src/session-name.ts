// Sin dependencias a propósito: lo importan tanto `sessions.ts` (clasificación, sólo lectura)
// como `stages.ts` (cycleDirForSession, que SÍ escribe) y, con F2, `adopt.ts`. Charset actual
// conservado (`@` incluido — nombres ajenos reales lo usan); tope {1,80} del KB
// (electron-desktop:94) — nada que Ronin genere se acerca a 80 (engine.ts:342-357).
const SESSION_NAME_PATTERN = /^[A-Za-z0-9._@-]+$/;
const MAX_SESSION_NAME_LENGTH = 80;

export function isSafeSessionName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_SESSION_NAME_LENGTH &&
    SESSION_NAME_PATTERN.test(name) &&
    !name.includes("..")
  );
}
