/**
 * Corre `action` sólo si no hay otra en curso con el mismo `lock` (un `useRef(false)`), y marca
 * `busy` mientras dura para que la vista deshabilite sus botones. Un segundo clic antes de que el
 * estado se pinte devuelve `undefined` sin llamar a la API. Los errores se propagan tal cual.
 */
export async function runExclusive<T>(lock: { current: boolean }, setBusy: (busy: boolean) => void, action: () => Promise<T>): Promise<T | undefined> {
  if (lock.current) return undefined;
  lock.current = true;
  setBusy(true);
  try {
    return await action();
  } finally {
    lock.current = false;
    setBusy(false);
  }
}
