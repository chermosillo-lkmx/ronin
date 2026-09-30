# Ronin — Skills que se aprenden

**Fecha:** 2026-09-30 · **Estado:** borrador para revisión · **Autor:** Cesar Hermosillo

## 1. Propósito

La memoria por repo (spec 2026-09-29) guarda datos sueltos: qué comando corre las pruebas o qué trampa
tiene el entorno. Lo que no guarda es el **procedimiento** que funcionó. Un ejemplo sería "cómo
agregar una migración reversible y probarla", que una sesión resolvió en varios pasos y la siguiente
vuelve a descubrir desde cero. La idea viene de Hermes Agent: las skills nacen de la experiencia, se
refinan con el uso y se comparten en el formato `SKILL.md` de agentskills.io. Cuando una sesión termina
bien, Ronin propone una skill reutilizable. El usuario la lee completa, la aprueba, la edita o la
descarta, y la skill aprobada entra en el catálogo de skills que Ronin ya tiene.

**Criterios de éxito:**
1. Solo se propone una skill automáticamente si el flujo terminó, todos sus gates deterministas (`verifyCmd`) pasaron y la destilación juzgó el procedimiento reutilizable. Cada sesión genera como máximo una propuesta.
2. Nada se escribe en el catálogo sin aprobación explícita. Para aprobar, el cliente debe presentar el hash del texto completo que mostró.
3. Si ya existe una skill aprendida parecida, se propone una **actualización con diff**, no un duplicado.
4. Toda sesión nueva de un repo recibe un índice de 1 KB como máximo con las skills asociadas: nombre, descripción y ruta, sin el cuerpo. Ese índice queda registrado en `launch.json`.
5. Ninguna skill aprobada contiene secretos, rutas absolutas ni valores de `vars` del repo. Los validadores son deterministas y no dependen del modelo.
6. `scope=agent` no ve ni acepta las herramientas MCP de skills. El token compartido sigue siendo un riesgo residual, igual que en la memoria.

## 2. Decisiones

| Decisión | Elección | Por qué |
|---|---|---|
| Disparo | Flujo completo **y** al menos un `verifyCmd` con estado `passed` **y** ningún gate `failed` **y** la destilación marca `reusable` | Una skill es "lo que funcionó": sin un gate determinista no hay prueba de que funcionó. |
| Llamadas a `claude -p` | **Dos fases.** El triaje va dentro de la llamada de memoria como un campo `skill` opcional. La redacción es una segunda llamada, que solo ocurre si el triaje la pide. | En el caso común (sin skill) el costo extra es de unos cientos de tokens de salida. Solo la redacción recibe el texto de la skill existente para refinarla. |
| Dónde aterrizan | Una raíz nueva, `learned`, en `<dataDir>/skills/learned/<name>/SKILL.md` | Queda fuera del repo, como la memoria. Tampoco va a `~/.claude/skills`, porque Claude Code la cargaría en todas las sesiones, incluso fuera de Ronin. Así Ronin controla la exposición. |
| Nombre | Lo propone el modelo. El servidor lo normaliza a slug con la regla estricta de agentskills.io (`^[a-z0-9]+(-[a-z0-9]+)*$`, 64 caracteres como máximo). | Así la skill se puede compartir tal cual; la regla actual de Ronin permite `--` y `-` al final, y el estándar no. |
| Colisiones | Si el nombre coincide con una skill `learned`, la propuesta se convierte en una actualización de esa skill. Si coincide con una skill `global` o de repo, se agrega un sufijo `-2`, `-3`… y se avisa. | La primera regla es el "refinar en vez de duplicar" de Hermes. La segunda evita pisar skills del usuario. |
| Refinamiento | El triaje recibe el catálogo `learned` y las skills que se ofrecieron a la sesión. Puede marcar `updates: <name>`. La propuesta guarda `baseHash` y la UI muestra el diff. | Es el "refinado con el uso": una sesión que siguió una skill y la mejoró propone el cambio. |
| Versionado | `version` entera en `learned.json` y las 5 versiones anteriores en `history/`. El frontmatter no cambia. | Deja espacio para una reversión futura sin salirse del formato estándar. |
| Uso en sesiones | Un **índice** (nombre, descripción, ruta) antepuesto al prompt, junto al bloque de memoria, con las skills asociadas al repo. | Ronin hoy no inyecta skills: la asociación por repo existe, pero el inspector dice "Sin inyección de prompt". El índice funciona con claude, codex y agy, y sigue la divulgación progresiva del estándar. |
| Aprobación | Siempre manual, y el hash del texto mostrado es obligatorio. No existe una opción de autoaprobación. | Una skill es guía ejecutable: su riesgo es mayor que el de una línea de memoria. |

## 3. Almacenamiento

- **Raíz nueva:** `SkillRoot` suma `"learned"`, que resuelve a `<dataDir>/skills/learned` (o a `COWORK_LEARNED_SKILLS_ROOT`, para las pruebas). La raíz reutiliza `readSkill`, `listSkills`, `updateSkill` y `archiveSkill` de `skills.ts`, así que el editor y el ZIP existentes funcionan sin cambios. Las skills `learned` son globales: no llevan `sourceRepo`.
- **Metadatos:** están en `<dataDir>/skills/learned.json`, con escritura atómica (`atomic.ts`):

```json
{ "repos": { "acme-api": { "enabled": true } },
  "skills": { "migracion-reversible": { "originRepo": "acme-api", "version": 2, "hash": "sha256:…",
      "sources": ["cowork-acme-mig", "cowork-acme-mig2"], "uses": 4, "approvedAt": 1790000000000 } },
  "proposals": [ { "id": "s_4k9z1p", "kind": "update", "name": "migracion-reversible", "repo": "acme-api",
      "source": "cowork-acme-mig2", "content": "---\nname: …", "contentHash": "sha256:…",
      "baseHash": "sha256:…", "changes": "Agrega el paso de rollback en CI", "warnings": ["url-externa"],
      "status": "pending", "createdAt": 1790000000000 } ] }
```

- **Historial:** `<dataDir>/skills/history/<name>/v<N>.md` guarda las 5 versiones anteriores de cada skill; la más vieja se elimina.
- **Estados de una propuesta:** `pending`, `approved` o `discarded`. Las descartadas conservan `name` y `description` para que el triaje no vuelva a proponerlas.
- **Integridad:** al aprobar se guarda el `sha256` del `SKILL.md`. Si el archivo en disco ya no coincide (alguien lo modificó fuera de Ronin), la skill aparece como "modificada fuera de Ronin" y **no entra al índice de lanzamiento** hasta que se apruebe de nuevo. Una edición desde el editor de Ronin (`PUT /api/skills` con raíz `learned`) actualiza el hash.
- **Estado por sesión:** la entrada de la sesión en `<dataDir>/memory/state.json` gana el subcampo `skill: { status: "running"|"done"|"failed"|"skipped", proposalId?, reason?, error? }`. Garantiza que cada sesión proponga una sola vez, aunque Ronin se reinicie, igual que la memoria.
- **Módulo nuevo `server/src/learned-skills.ts`:** reúne las funciones puras (armado del `SKILL.md`, validación, filtros de secretos y rutas, derivación del nombre, diff unificado, índice de lanzamiento) y el store. No ejecuta procesos.

## 4. Reglas de contenido

Ronin **arma el frontmatter**. El modelo devuelve `name`, `description` y `body` por separado, así que no puede colar campos como `allowed-tools`.

- **Frontmatter:** solo `name` y `description`, compatible con agentskills.io y con `parseSkillDocument`, que es de una línea por campo. `name` debe coincidir con la carpeta. `description` va en una sola línea, de 1 a 1024 caracteres, y dice qué hace la skill y cuándo usarla. Si se edita a mano, se rechaza cualquier otro campo (`SKILL_INVALID`).
- **Tope:** 8 KB en UTF-8 y 200 líneas en total. El estándar recomienda menos de 500 líneas; una skill generada debe ser más corta. Solo existe `SKILL.md`: no hay `scripts/` ni `references/`.
- **Limpieza:** se quitan el BOM, los caracteres de formato Unicode (`\p{Cf}`: bidi y ancho cero) y los de control, salvo `\n` y `\t`. Los saltos de línea se normalizan a `\n`.
- **Rechazo determinista** (toda la propuesta queda `failed` con el motivo):
  - Rutas absolutas: `/Users/`, `/home/`, `/tmp/cowork-cycle-`, `C:\`, la ruta real del repo y `dataDir`.
  - Patrones de secreto: llaves privadas PEM, `AKIA…`, `ghp_`/`github_pat_`, `sk-…`, `xox[bp]-`, y `password|secret|token|api_key` seguidos de `:` o `=` y un valor de 8 caracteres o más.
  - Cualquier valor de `vars` del repo que tenga 6 caracteres o más.
  - El token de capacidad.
- **Avisos que no bloquean** (la UI los resalta): `menciona-repo` (el nombre del repo o de sus rutas relativas propias), `url-externa`, `comentario-html` (texto que el markdown renderizado ocultaría), `comando-destructivo` (`rm -rf`, `git push --force`, `curl … | sh`) y `nombre-ajustado`.
- **Reutilización:** el prompt pide escribir la skill para cualquier repo con el mismo stack. Lo específico del repo va como paso condicional ("si el repo usa `make`…") o se queda en la memoria.
- Las ediciones del usuario pasan por los mismos validadores. Las reglas duras no tienen excepción.

## 5. Disparo y destilación

**Triaje (dentro de la llamada de memoria).** La plantilla `memory` recibe `{skillCatalog}` (nombre y descripción de las skills `learned`, 4 KB como máximo, más las descartadas marcadas "no repetir") y `{offeredSkills}` (las skills del índice de `launch.json`). Su salida gana un campo opcional:
`"skill": null | { "reusable": true, "name": "slug", "summary": "1..200", "updates": "<name>"|null }`.
El parseo es tolerante: un campo `skill` inválido deja solo la parte de skill en `failed`, y las entradas de memoria se aceptan igual. La llamada corre si la memoria **o** el aprendizaje de skills está activo en el repo; si la memoria está apagada, sus entradas se ignoran.

**Verificación en el servidor.** El modelo no puede saltársela. Con `flow.json` y `verify-<etapa>.json` se comprueba lo siguiente: todas las etapas tienen su centinela, al menos una etapa tiene `verifyCmd` con estado `passed`, y ninguna tiene estado `failed`. Si algo no se cumple, la parte de skill queda `skipped` y el motivo dice "sin gate determinista aprobado". También queda `skipped` si ya hay 10 propuestas pendientes en total, o si ya hay una actualización pendiente para la misma skill.

**Redacción (segunda llamada).** Usa una plantilla nueva, `skill`, editable en `prompts.ts`, con el mismo `engineInvocation` y el mismo timeout de 10 minutos. Recibe:
- la petición;
- la evidencia recortada a 24 KB (`buildEvidence`);
- el `summary` del triaje;
- el catálogo;
- en una actualización, el `SKILL.md` actual completo.

Responde `{ "name", "description", "body", "changes" }` o `{ "skip": "motivo" }`. La salida no es confiable: pasa por el esquema, la limpieza y las reglas de §4, y siempre entra como `pending`. Corre en la misma cola por repo de la destilación, justo después de la llamada de memoria.

**Manual.** `POST /sessions/:name/skill` salta el triaje y el requisito de `verifyCmd`, porque decide el usuario. Solo exige que el flujo esté completo. También sirve para reintentar.

**`COWORK_LEARNED_SKILLS=0`** apaga el triaje, la redacción y el índice de las skills `learned`.

## 6. Uso en sesiones

- **Lo que existe hoy.** Ronin no carga skills en los lanzamientos. `repo-config.skills` (las casillas de "activación por repo") se guarda, pero ni `session-launch.ts` ni `prompts.ts` lo leen. Claude Code descubre por su cuenta `~/.claude/skills` y el `.claude/skills` que venga versionado en el worktree; codex y agy no descubren nada.
- **Índice de lanzamiento.** En `session-launch.ts`, después del bloque de memoria, se antepone esto:

  ```
  Skills disponibles para acme-api (aprobadas por el usuario; lee el SKILL.md sólo si la tarea encaja):
  - migracion-reversible: Agrega una migración reversible y la prueba ida y vuelta. → <dataDir>/skills/learned/migracion-reversible/SKILL.md
  ```

  - Entran las skills **asociadas al repo** que sean válidas y, si son `learned`, íntegras.
  - Al aprobar una skill nueva, se asocia automáticamente a su `originRepo`. Asociarla a otros repos es manual, con las casillas de siempre.
  - El índice tiene un tope de 8 skills y 1 KB, aparte de los 2 KB de la memoria. Se ordena por `uses` y después por fecha de aprobación, y cierra con "(+N omitidas)" si no caben todas.
  - Es texto literal: no pasa por `renderPrompt`.
- **Registro y uso.** `launch.json` gana el campo `skills: [{ root, name, hash }]`. Cada skill incluida suma `uses += 1`. Ese registro es lo que después recibe el triaje como `{offeredSkills}` para proponer refinamientos.
- **Nunca se copian skills al worktree.** Un `git add -A` del agente las metería en el PR.

## 7. API local

Usa la seguridad de siempre: origen local y token de capacidad. Las lecturas de propuestas también exigen capacidad (`requireKbCapability`), porque su texto sale de la evidencia. Un `:repo` desconocido responde 404.

| Método y ruta | Qué hace |
|---|---|
| `GET /repos/:repo/skills/learning` · `PUT … { enabled }` | Lee o cambia el interruptor de aprendizaje del repo |
| `GET /skills/proposals?repo=` | Lista las pendientes: `id`, `kind`, `name`, `repo`, `source`, `description`, `warnings` y `createdAt` |
| `GET /skills/proposals/:id` | Devuelve `content` completo, `contentHash` y, si es una actualización, `base` (texto y hash) y `diff` unificado |
| `PATCH /skills/proposals/:id` `{ action: "approve"\|"discard"\|"edit", contentHash?, content? }` | `approve` exige un `contentHash` igual al guardado. `edit` exige `content`, lo revalida y aprueba. En una actualización, si el `SKILL.md` ya no tiene `baseHash`, responde 409 |
| `POST /sessions/:name/skill` | Propone o reintenta. Responde 202; 409 si ya hay una en curso o si el flujo está incompleto |

`GET /api/skills` suma la raíz `learned` e `integrity: "ok"|"modified"` en cada una. **Códigos:** `SKILL_INVALID` (400, con `reasons[]`), `SKILL_PROPOSAL_NOT_FOUND` (404), `SKILL_STALE` (409), `SKILL_FLOW_INCOMPLETE` (409) y `REPO_UNKNOWN` (404). Todos responden `{ error, code }`.

## 8. UI

- **Vista Skills:**
  - Una pestaña nueva, **Propuestas (N)**, junto a la lista de siempre.
  - El detalle muestra el `SKILL.md` **en crudo** (monoespaciado, sin renderizar markdown, para que un comentario HTML no esconda nada), sus avisos resaltados y, en una actualización, el diff contra la versión actual con el resumen `changes`.
  - Botones: ✅ Aprobar (se habilita al llegar al final del texto), ✏️ Editar y aprobar, ❌ Descartar.
- **Lista de skills:** la raíz `learned` lleva la versión y los usos. Las modificadas fuera de Ronin muestran "⚠ Revisar" y ofrecen reaprobar.
- **SkillsInspector:** el texto "Sin inyección de prompt" cambia a "Índice en el lanzamiento (1 KB)".
- **Página del repo** (junto a Memoria): el interruptor "Aprender skills".
- **Inspector de sesión:** el estado de la parte de skill (en curso, propuesta X, omitida por…, falló) y el botón "Proponer skill" o "Reintentar". El botón ▤ del encabezado muestra un badge "🧩 N" cuando hay pendientes.

## 9. MCP

Dos herramientas nuevas, disponibles **solo en el scope completo**. `scope=agent` ni las lista ni las acepta.
- `skills_pendientes({ repo? })`: devuelve cada propuesta con su `content` completo, `contentHash`, `diff` y `warnings`. Quien aprueba desde MCP también ve el texto entero.
- `resolver_skill({ id, accion: "aprobar"|"descartar"|"editar", hash?, contenido? })`: `aprobar` exige `hash`. Los errores (`SKILL_PROPOSAL_NOT_FOUND`, `SKILL_INVALID`, `SKILL_STALE`) usan el formato de error de las herramientas existentes.

**Riesgo residual (documentado, igual que en la memoria).** Los agentes lanzados por Ronin comparten el token de capacidad y corren con el mismo usuario del sistema operativo. Uno de ellos podría llamar a `PATCH /skills/proposals/:id`, a `PUT /api/skills` o escribir directamente en `<dataDir>/skills/learned`. El control de integridad por hash detecta la escritura directa, pero no evita el uso del token. Separar el token de los agentes queda para otro spec.

## 10. Pruebas (`node --test`, TDD)

- **`learned-skills.ts`:**
  - store: archivo nuevo, escritura atómica, transiciones de estado válidas e inválidas, historial de 5 versiones;
  - armado del frontmatter;
  - tope de 8 KB y 200 líneas;
  - limpieza de `\p{Cf}` y de caracteres de control;
  - cada patrón de secreto y de ruta absoluta, los valores de `vars` y el token;
  - cada aviso;
  - normalización del nombre, sufijo contra `global` y repo, conversión a actualización contra `learned`;
  - diff unificado;
  - integridad `modified`.
- **Triaje:**
  - `skill` válido, inválido (la memoria se acepta igual) y `null`;
  - se omite sin `verifyCmd` aprobado, con un gate `failed`, con 10 pendientes o con una actualización ya pendiente;
  - corre con la memoria apagada y el aprendizaje encendido.
- **Redacción** (con un `claude -p` falso): JSON válido, inválido y `skip`; timeout; una sola vez por sesión, incluso tras reiniciar; la cola por repo.
- **Lanzamiento:**
  - el índice se antepone después de la memoria y queda en `launch.json`;
  - tope de 1 KB y de 8 skills;
  - quedan fuera las skills modificadas y las no asociadas;
  - suma `uses`;
  - se apaga con `COWORK_LEARNED_SKILLS=0`.
- **API:**
  - cada ruta y código (200, 202, 400, 404, 409);
  - aprobar con un hash equivocado da 409;
  - una actualización cuya base cambió da 409;
  - origen y token.
- **MCP:** las dos herramientas funcionan en el scope completo y `scope=agent` no las lista ni las acepta.
- **Web:**
  - la pestaña Propuestas renderiza el texto crudo, el diff y los avisos;
  - Aprobar envía `contentHash`;
  - Editar y Descartar llaman a la ruta correcta;
  - aparecen el badge y el aviso "⚠ Revisar".

## 11. Fuera de alcance

- Autoaprobación, en cualquier forma.
- Skills con `scripts/`, `references/` o `assets/`: solo se genera `SKILL.md`.
- Promover una skill a `~/.claude/skills` o al `.claude/skills` de un repo. Por ahora se hace a mano, con el ZIP existente.
- Refinar automáticamente skills `global` o de repo: solo se refinan las `learned`.
- Revertir a una versión del historial desde la UI (el historial se guarda, pero no se expone).
- Similitud por embeddings: el parecido lo juzga el triaje con el catálogo, más la colisión de nombre.
- Integración con Kitsune y Telegram, y la separación del token de los agentes.

## 12. Preguntas abiertas

1. **¿Exigir al menos un `verifyCmd` aprobado para proponer automáticamente?** Recomendación: sí. Los workflows sin gates deterministas solo pueden proponer skills a mano. Así se evita aprender procedimientos que nadie verificó.
2. **¿El índice de lanzamiento incluye también las skills `global` y de repo asociadas, o solo las `learned`?** Recomendación: todas las asociadas. Hoy la asociación no tiene efecto, y un solo mecanismo es más fácil de entender. Hay que anunciarlo en el changelog, porque cambia el prompt de los repos que ya tienen casillas marcadas.
3. **¿El aprendizaje viene encendido por defecto en cada repo?** Recomendación: sí, como la memoria. Nada entra sin aprobación, y la segunda llamada solo ocurre cuando el triaje la pide.
4. **¿Qué pasa con una plantilla `memory` personalizada que no tiene `{skillCatalog}`?** Recomendación: no fusionarla automáticamente. El triaje simplemente no se produce, y la UI de Prompts avisa: "tu plantilla memory no incluye el triaje de skills".
