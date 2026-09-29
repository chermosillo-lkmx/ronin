# Ronin — Memoria por repo

**Fecha:** 2026-09-29 · **Estado:** aprobado en conversación · **Autor:** Cesar Hermosillo

## 1. Propósito

Hoy cada sesión de Ronin empieza sin saber lo que aprendieron las sesiones anteriores en el mismo repo:
qué comando corre las pruebas, qué trampa hay en el entorno, qué prefiere el usuario. La idea viene de
agentes como Hermes: una **memoria persistente por repo** que Ronin destila al terminar cada sesión.
El usuario la aprueba y cada sesión nueva la recibe al arrancar.

**Criterios de éxito:**
1. Al terminar un flujo, Ronin propone entre 0 y 5 aprendizajes. Nada entra en la memoria sin aprobación del usuario.
2. Toda sesión nueva de un repo con memoria activa recibe un bloque de 2 KB como máximo con los aprendizajes aprobados. Ese bloque queda registrado en `launch.json`.
3. Los aprendizajes de arquitectura no se inyectan: se sugieren a la siguiente regeneración de la knowledge base.
4. Los agentes lanzados por Ronin (`scope=agent`) no pueden leer ni modificar la memoria.

## 2. Decisiones

| Decisión | Elección |
|---|---|
| Dónde vive | Fuera del repo, en el directorio de datos de Ronin. Es personal, no ensucia el repo ni los PRs, y no se comparte con el equipo por git. |
| Quién escribe | Ronin la destila con `claude -p` al terminar la sesión. El usuario aprueba, edita o descarta cada entrada. |
| Relación con la KB | Son separadas y hay un puente. La KB es una foto de cómo está hecho el código y se regenera desde él. La memoria guarda lo aprendido al trabajar, que el código no dice. |
| Inyección | Un bloque antepuesto al prompt de arranque (enfoque A). Funciona igual con claude, codex y agy. El refuerzo con archivo nativo (`CLAUDE.local.md`/`AGENTS.md`) queda para después, si la compactación de contexto resulta un problema real. |

## 3. Almacenamiento

- **Archivo:** uno por repo, `<dataDir>/memory/<repo>.json`. `dataDir` es `COWORK_DATA_DIR`, o por defecto el directorio de datos de Ronin (en la app de escritorio, `userData/data`).
- **Escritura:** atómica, con `atomic.ts`, igual que `settings` y `repo-config`.
- **Formato:**

```json
{ "repo": "acme-api", "enabled": true, "entries": [
  { "id": "m_8f3k2a", "text": "Tests: usar `make test-unit`, no `pytest` suelto",
    "kind": "comando", "source": "cowork-csv-retry", "createdAt": 1790000000000,
    "updatedAt": 1790000000000, "status": "active", "uses": 3 } ],
  "kbSuggestions": [ { "id": "k_2d9x1q", "text": "...", "source": "...", "createdAt": 1790000000000 } ] }
```

- **Tipos de entrada (`kind`):** `comando`, `trampa`, `preferencia`, `decision` o `arquitectura`. Las de tipo `arquitectura` nunca quedan `active`: al aprobarlas pasan a `kbSuggestions`.
- **Estados (`status`):** `pending` (propuesta), `active` o `discarded`. Las descartadas se conservan para que la destilación no vuelva a proponer lo mismo.
- **Estado de la destilación por sesión:** en `<dataDir>/memory/state.json`, con los valores `running`, `done`, `failed` o `skipped`, más la fecha y el error si lo hubo. Garantiza que cada sesión se destile una sola vez, aunque Ronin se reinicie.
- **Módulo nuevo `server/src/memory.ts`:** funciones puras (armado del bloque, validación, deduplicación) más el store.

## 4. Inyección

- **Cuándo.** Al lanzar una sesión (`session-launch.ts`), si la memoria está habilitada (`COWORK_MEMORY` distinto de `0` y `enabled` del repo en `true`) y hay entradas `active`, se antepone este bloque al prompt que recibe el worker:

  ```
  Memoria del repo acme-api (aprendizajes aprobados por el usuario; verifícalos si algo no cuadra):
  - [comando] Tests: usar `make test-unit`, no `pytest` suelto
  - [trampa] ...
  ```

- **Tope de 2 KB en UTF-8.** Las entradas se ordenan por `uses` (de mayor a menor) y después por `updatedAt` (de más reciente a más antigua). Si no caben todas, el bloque termina con "(+N entradas omitidas)".
- **Contador de uso.** Cada entrada incluida en el bloque suma `uses += 1`.
- **Texto literal.** El bloque no pasa por `renderPrompt`, así que un `{repo}` dentro de una entrada no se sustituye.
- **Registro.** El bloque exacto queda en `launch.json` de la sesión, en el campo `memory`.

## 5. Destilación

**Disparadores**
- **Automático:** cuando `flow-progress` marca todas las etapas cumplidas y la sesión no tiene todavía un estado de destilación.
- **Manual:** `POST /sessions/:name/distill`, que también sirve para reintentar.
- **Se omite (`skipped`)** si la memoria está apagada o si no hay ninguna evidencia.

**Entrada.** Un `claude -p` con el motor de ajustes (`engineInvocation`), el mismo mecanismo que usa la generación de la KB. Su prompt es la plantilla nueva `memory`, que se puede editar en `prompts.ts` y recibe:
- la petición original y el workflow;
- la evidencia (`summary`, `research`, `verdict`), el plan y el resumen de pruebas. El total se recorta a 24 KB, conservando el final de cada archivo;
- las respuestas que el usuario dio a la sesión. Hoy no se registran, así que este spec agrega un evento `reply` a `history.jsonl` (`EventType` gana `"reply"`). Se registra en `responder_sesion` y en `POST /api/sessions/:name/panes/:paneId/keys` solo cuando se envía texto con Enter, nunca con teclas sueltas ni opciones de menú. El texto se recorta con `truncate(…, 2000)`. Se asume que no es secreto porque es texto dirigido al agente, y así lo dice la documentación;
- las entradas `active` y `discarded` actuales, para no repetirlas.

El prompt pide solo lo que el código no dice y le sirva a la próxima sesión. Lo de arquitectura va con `kind: "arquitectura"`. Si no hay nada que valga la pena, la respuesta es `{"entries": []}`.

**Salida no confiable**
- Debe cumplir este esquema: `{ entries: Array<{ text: string (1..200), kind: enum }> }` con 5 entradas como máximo. Si no lo cumple, se descarta completa y el estado queda `failed`.
- Se eliminan los caracteres de control y se colapsan los espacios.
- Se descartan duplicados, exactos o que solo difieran en mayúsculas y espacios, contra las entradas `active`, `pending` y `discarded`.
- Todo entra como `pending`. La aprobación humana es el control contra instrucciones inyectadas desde el contenido del repo.

**Concurrencia y errores**
- Hay una sola destilación en curso por repo. Las demás esperan en una cola en memoria y se reanudan tras un reinicio, porque las sesiones `done` sin estado de destilación se vuelven a detectar.
- **Timeout:** 10 minutos. Un fallo o un timeout deja el estado `failed` con el error y nunca afecta a la sesión.

## 6. Puente con la knowledge base

- Aprobar una entrada `arquitectura` la mueve a `kbSuggestions`.
- La plantilla `kb` recibe un placeholder nuevo, `{kbSuggestions}`. Si hay sugerencias, se agrega al prompt: "Sugerencias de sesiones recientes: verifícalas contra el código y, si son ciertas, incorpóralas con su cita: …".
- Si la generación de la KB termina con estado `ok`, las sugerencias usadas se eliminan. Si falla, se conservan.

## 7. API local

Usa la seguridad de siempre: origen local y token de capacidad. `:repo` debe ser un repo conocido; si no, responde 404.

| Método y ruta | Qué hace |
|---|---|
| `GET /repos/:repo/memory` | Devuelve `enabled`, `entries` (activas y pendientes), `kbSuggestions` y la vista previa del bloque con su tamaño en bytes |
| `PUT /repos/:repo/memory/enabled` `{ enabled }` | Activa o desactiva la memoria del repo |
| `POST /repos/:repo/memory` `{ text, kind }` | Agrega una entrada a mano, que entra como `active` |
| `PATCH /repos/:repo/memory/:id` `{ action: "approve"\|"discard"\|"edit", text? }` | Aprueba, descarta o edita. Editar una pendiente también la aprueba |
| `DELETE /repos/:repo/memory/:id` | Borra una entrada o una sugerencia para la KB |
| `POST /sessions/:name/distill` | Destila o reintenta. Responde 202; si ya hay una en curso para esa sesión, 409 |

**Validación:** `text` va de 1 a 200 caracteres y `kind` debe ser del enum. Si no, 400. Un `id` desconocido da 404. Todos los errores responden `{ error, code }`, como el resto de la API.

## 8. UI

- **Página del repo** (junto a la KB): una sección **Memoria** con:
  - un interruptor para activarla o desactivarla;
  - la vista previa "Esto recibe cada sesión nueva (1.2 / 2 KB)";
  - tres pestañas: *Activas* (editar y borrar), *Pendientes* (✅ aprobar, ✏️ editar y aprobar, ❌ descartar) y *Para la KB* (borrar);
  - un formulario para agregar entradas a mano.
- **Lista de sesiones:** un badge "🧠 N" junto al repo cuando tiene entradas pendientes.
- **Inspector de sesión:** el estado de la destilación (en curso, N propuestas, falló) y el botón "Destilar aprendizajes" o "Reintentar".
- La UI sigue en español, como el resto de Ronin.

## 9. MCP

Dos herramientas nuevas, disponibles **solo en el scope completo**. `scope=agent` ni las lista ni las acepta.
- `memoria_pendiente({ repo? })`: devuelve las entradas `pending`, con `id`, `repo`, `text`, `kind` y `source`.
- `resolver_memoria({ id, accion: "aprobar"|"descartar"|"editar", texto? })`: aplica la acción. Los errores (`MEMORY_NOT_FOUND`, `MEMORY_INVALID`) usan el formato de error de las herramientas existentes.

Integrarlas con Kitsune (aprobar desde Telegram) queda para un spec aparte.

## 10. Pruebas (`node --test`, TDD)

- **`memory.ts`:**
  - store: archivo nuevo, escritura atómica, transiciones de estado válidas e inválidas, repo desconocido;
  - bloque: tope de 2 KB, prioridad, nota de omitidas, `{…}` literal, contador `uses`;
  - deduplicación contra activas, pendientes y descartadas.
- **Destilación** (con un `claude -p` falso):
  - JSON válido, inválido, `[]`, más de 5 entradas, texto demasiado largo, caracteres de control;
  - una sola vez por sesión, incluso tras reiniciar;
  - cola por repo, timeout, `skipped` sin evidencia;
  - las entradas `arquitectura` van a `kbSuggestions` al aprobarlas.
- **Historial:** `responder_sesion` y `/keys` con Enter registran `reply`, recortado a 2000 caracteres; las teclas sueltas y las opciones de menú no se registran.
- **Lanzamiento:** el bloque se antepone al prompt y queda en `launch.json`; no se inyecta con `COWORK_MEMORY=0`, con el repo desactivado ni con la memoria vacía.
- **KB:** `{kbSuggestions}` en el prompt; las sugerencias se eliminan solo si la generación queda `ok`.
- **API:** cada ruta y código (200, 202, 400, 404, 409), más origen y token.
- **MCP:** las dos herramientas funcionan en el scope completo y `scope=agent` no las lista ni las acepta.
- **Web:** la sección Memoria renderiza sus tres pestañas; aprobar, editar y descartar llaman a la API correcta; el badge aparece solo con pendientes.

## 11. Fuera de alcance

- Integración con Kitsune y Telegram (spec aparte).
- Memoria dentro del repo o compartida con el equipo.
- Skills que aprenden (el siguiente spec, que se apoyará en esta memoria).
- Refuerzo con archivo nativo en el worktree (`CLAUDE.local.md`/`AGENTS.md`).
