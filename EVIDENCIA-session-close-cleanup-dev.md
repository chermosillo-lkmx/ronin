# EVIDENCIA — «Cerrar sesión» limpia lo que la sesión creó (worktree, rama, cycle dir, contenedores)

Repo `claude-cowork` (remote `chermosillo-lkmx/ronin`). Base `17395d9` → PR [#7](https://github.com/chermosillo-lkmx/ronin/pull/7)
mergeado en `main` como `3610652` (squash de 5 commits). Ticket: no hay. Ciclo: `/tmp/cowork-cycle-session-close-cleanup-20260910/`.

## Veredicto
**Implementado, mergeado y verificado en DEV con docker real y en la UI.** Codex (`gpt-5.6-sol`, ventana `codex-close`) implementó
S1–S4 por RGR; Main revisó cada diff, corrigió tres cosas y cazó un defecto de UX en la prueba de navegador.

## Antes / causa
`DELETE /api/sessions/:name` (`index.ts:637-645`) sólo mataba tmux, a propósito (comentario `:634-636`; copy del diálogo «Los archivos,
worktrees y evidencia no se borrarán»). Lo que una sesión gestionada crea (`session-launch.ts`): worktree `~/.cowork/worktrees/<hash>/<n>`
en rama `ronin/<n>`, cycle dir `/tmp/cowork-cycle-<n>`, y lo que el worker lance dentro (contenedores). Ya existían las piezas con la guarda
correcta: `removeWorktree` (conserva trabajo sin integrar) y `removeCycleDir`; faltaba orquestarlas desde el cierre.

## Cambios
- `server/src/session-cleanup.ts` + test (7): `cleanupSession(name, deps)` → reporte `{kind, worktree, cycleDir, containers}`. Gestionada:
  contenedores (etiqueta `cowork.session=<n>` o nombre `<n>-…`/`<n>_…`, nunca substring) → worktree+rama (guarda) → cycle dir (se conserva
  si el worktree se conservó). Ajena/terminal: repo intacto, sólo cycle dir. Docker ausente → `skipped`. Nunca lanza.
- `index.ts`: `DELETE` con `{confirm, cleanup:true}` mata y luego limpia; responde el reporte; un fallo de limpieza viaja en `cleanup.error`
  sin fallar el cierre. Seams `sessions.{hasSession,killSession,cleanupSession}`. Sin `cleanup`: comportamiento anterior (test de control).
- Web: `closeTmuxSession(name, {cleanup:true})`, tipo `SessionCleanupReport`, diálogo con copy por tipo de sesión y modal de reporte
  con «Listo». README + `skills/tmux-worker-loop/SKILL.md`: etiquetar contenedores.

Correcciones de Main sobre codex: (a) el copy afirmaba rama `cowork/<n>` y la real es `ronin/<n>` → texto sin nombre de rama, test
corregido; (b) el cliente no toleraba `cleanup.error` → lo muestra sin fingir reporte; (c) **hallazgo en la UI**: el reporte vivía en el
diálogo y el inventario (5 s) desmontaba el diálogo al desaparecer la sesión — nadie lo veía; ahora lo guarda `SessionWorkspace` y se pinta
en todas sus ramas (pin en test).

## Suites
web 206 → **213/213** · server 619 → **630/630** · builds OK. Ronin `run-mtwf1xse-b035edb0` (unit/web), `run-mtwf21qq-94dc012f` (api/server).

## DEV (`evidence/curl.md`, `evidence/dev-probe.{sh,out}`) — servidor de la rama en 8790, repo/worktree-home/data dir de scratch, docker real
| AC | Resultado |
|---|---|
| AC1 gestionada limpia (`POST /api/sessions` real + contenedor etiquetado + señuelo `<n>otro`) | 200 `removed/removed/[1]`; worktree, cycle dir, tmux y contenedor fuera; **señuelo intacto** |
| AC2 con archivo sin commitear en el worktree | `worktree.kept "tiene trabajo sin integrar"`, `cycleDir.kept`; contenedor sí borrado; worktree sigue |
| AC3 sesión tmux ajena | `kind:foreign`, `none/none`; repo con 0 cambios |
| AC4 sin docker | unitario (`ENOENT` → `skipped`) |
| AC5 UI | diálogo nuevo → confirmar → modal «Sesión cerrada · Worktree eliminado · Cycle dir eliminado · 1 contenedor eliminado» (`evidence/ac5-*.jpg`) |
| AC6 control | `DELETE {confirm}` → `{ok:true}` a secas |
Nota: las gestionadas exigen prefijo `cowork-` (`MANAGED_SESSION_PREFIX_REQUIRED`); el guion se ajustó.

## Limpieza de esta sesión
Hecha: sesiones/worktrees/cycle dirs/contenedores de prueba eliminados; servidores 8790/5180 parados; ventana `codex-close` cerrada;
worktree `/private/tmp/wt-session-cleanup` y rama `feat/session-close-cleanup` (local y remota) eliminados; scratch `close-probe` borrado.

## Pendientes
1. Los workers (skill tmux-worker-loop) todavía no etiquetan sus contenedores: hasta que lo hagan, sólo se recogen los nombrados `<sesión>-…`.
2. Compose projects y volúmenes no se tocan (sólo contenedores).
