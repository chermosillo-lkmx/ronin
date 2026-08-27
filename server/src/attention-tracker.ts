import type { SessionAttention } from "./types.js";

/**
 * `since` pertenece al proceso que observa tmux: persistirlo lo convertiría en auditoría y, peor,
 * mostraría una espera vieja tras reiniciar el server. Sólo el cambio de nivel reinicia el reloj.
 */
export class AttentionTracker {
  private readonly levels = new Map<string, Pick<SessionAttention, "level" | "since">>();

  track(session: string, attention: SessionAttention, now: number): SessionAttention {
    const previous = this.levels.get(session);
    const since = previous?.level === attention.level ? previous.since : now;
    this.levels.set(session, { level: attention.level, since });
    return { ...attention, since };
  }
}
