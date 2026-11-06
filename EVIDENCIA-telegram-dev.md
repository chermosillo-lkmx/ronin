# EVIDENCIA — Telegram en Ronin

Rama `feat/telegram-ronin` · base `eebbc6c` · HEAD de código `57715c4`

## Veredicto

**Lo automatizado pasa. La prueba de punta a punta con Telegram real NO se ha hecho** y ningún
criterio de éxito se da por cumplido. Requiere el token de un bot nuevo y un segundo usuario de
Telegram, que aporta César; no se creó ningún bot ni se llamó a Telegram.

## Evidencia automatizada

Corridas desde el worktree `.claude/worktrees/feat-telegram-ronin`:

| Comando | Resultado |
|---|---|
| `npm test -w server` | 1228 pruebas, 1228 pasan, 0 fallan (una sola corrida; sin reintento) |
| `npm test -w web` | 276 pruebas, 276 pasan, 0 fallan |
| `npm run build:server` | `tsc -p tsconfig.build.json` sin errores |
| `npm run build -w web` | build de Vite correcto (85 módulos) |

Nota: el ledger registra una prueba intermitente del server previa a esta rama; no se manifestó en
esta corrida.

Las pruebas del módulo `server/src/telegram/` y de la pantalla ✈ usan un cliente de Telegram simulado
y un `claude` simulado; no hablan con Telegram ni con un modelo real.

## Criterios de éxito (spec §10) — todos pendientes

Con Ronin abierto en la Mac y César en la calle:

1. PENDIENTE: requiere bot real. Escribir en el tema de un repo que revise un ticket con cierto workflow, confirmar con ✅ y que la sesión arranque en ese repo.
2. PENDIENTE: requiere bot real. Recibir una pregunta del agente en ese tema, contestarla desde el celular y que el agente continúe.
3. PENDIENTE: requiere bot real. Recibir el aviso de fin de sesión.
4. PENDIENTE: requiere bot real. Pegar un comentario y recibir una respuesta en menos de un par de minutos.
5. PENDIENTE: requiere bot real. Pedir el reporte diario y leerlo en el celular.
6. PENDIENTE: requiere bot real. Un segundo usuario agregado al grupo escribe y toca botones sin provocar ningún efecto.
7. PENDIENTE: requiere bot real. Kitsune sigue funcionando sin cambios y sus sesiones no generan mensajes en este bot.
8. PENDIENTE: requiere bot real. Una sesión lanzada desde la app de Ronin le pregunta algo y César la contesta desde el celular.
9. PENDIENTE: requiere bot real. Tocar un botón de una pregunta ya superada no le entrega nada al agente.

## Otros pendientes (solo verificables con Telegram real)

- PENDIENTE: requiere bot real. Que el enlace `startgroup` entregue `/start@<bot> <código>` al grupo (T8).
- PENDIENTE: requiere bot real. Que `getChatMember` exponga `can_manage_topics` para el bot admin (T8).
- PENDIENTE: requiere bot real. Que un prompt de interpretación real con `claude` se comporte como se espera; hasta ahora solo corrió contra dobles (T4).
- PENDIENTE: requiere la app abierta con un bot real. Que los pasos 2 a 4 del wizard y el diálogo Desconectar se vean bien en pantalla; hoy solo hay pruebas SSR y fetch simulado (T9).
- PENDIENTE: requiere bot real. Con un `.env` de prueba en un repo, confirmar que la respuesta a un comentario no puede leerlo (paso 2 del brief).
