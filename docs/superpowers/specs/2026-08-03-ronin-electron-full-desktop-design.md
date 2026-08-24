# Ronin · aplicación Electron multiplataforma con todas las superficies Nocturne — Diseño

**Fecha:** 2026-08-03  
**Origen:** /Users/cesarhermosillo/Downloads/UI mockups para app Electron.zip (Ronin.dc.html) y la base actual de Ronin.  
**Estado:** diseño aprobado por el operador.

## Objetivo

Convertir Ronin de dashboard web local a una aplicación Electron de escritorio que conserve el tablero de tareas como pantalla inicial y haga operativas todas las funciones visibles en el mockup:

1. Sesiones tmux: inventario, filtro, detalle, panes, lanzamiento y distinción gestionada/ajena.
2. Adopción explícita de una sesión ajena.
3. Terminales nativas con cuadrícula de panes, foco, sincronización de tamaño y broadcast.
4. Editor de loops en grafo, stepper y JSON, con lanzamiento y aplicación controlada en caliente.
5. Ejecución, consulta, reintento y delegación de fallos de pruebas.
6. Exploración, validación y edición de skills locales.
7. Preflight de entorno y barra de estado viva.
8. Nueva sesión desde una galería de workflows y paleta de comandos (⌘K).

La entrega se distribuye inicialmente sin firma para macOS arm64/x64, Windows y Linux. Firma y notarización se posponen, pero Preflight comunica su estado.

## Decisiones de producto

| Decisión | Resultado |
|---|---|
| Inicio | El tablero ClickUp/Jira/GitLab sigue siendo la vista inicial; las superficies del mockup se añaden a la navegación de escritorio. |
| Terminal | xterm.js en el renderer y node-pty en el proceso principal; ttyd deja de ser requisito de escritorio. |
| Sesiones ajenas | Sólo lectura hasta confirmar adopción, repo, workflow y pane candidato. |
| Datos | Express y su estado son la fuente de verdad para workers, tareas, workflows y reportes; React no duplica la lógica. |
| Packaging | electron-builder genera paquetes sin firma por plataforma y reconstruye módulos nativos para Electron. |
| Seguridad | contextIsolation activado, nodeIntegration desactivado y una API IPC con allowlist y validación tipada. |

### Alternativas descartadas

- Envolver el dashboard en Chromium: no proporciona terminal nativa ni comprueba node-pty empaquetado.
- Reescribir Express y el motor tmux en Electron: duplicaría una orquestación ya probada.
- Permitir escritura en cualquier sesión listada: un clic podría alterar trabajo ajeno y contradice la adopción explícita.

## Arquitectura

    Electron main
      ├─ arranca/supervisa Express en loopback
      ├─ administra PTYs locales y clientes tmux mediante node-pty
      ├─ expone IPC validado por preload
      └─ crea BrowserWindow segura
              │
              ├─ React/Vite renderer ── HTTP + SSE ──► Express / API
              └─ xterm.js ── IPC / MessagePort ─────► PTY / tmux local

| Capa | Responsabilidad |
|---|---|
| desktop/main | Ciclo de Electron, backend hijo, PTY, preferencias de ventana y empaquetado. |
| desktop/preload | Contrato mínimo y tipado, sin acceso de Node desde la UI. |
| server | Sesiones, adopción, workflows, skills, pruebas, preflight, workers, seguridad y SSE. |
| web | Navegación, componentes Nocturne, estados de carga/error e interacción de cada superficie. |

El proceso principal espera la respuesta de salud del backend antes de cargar la ventana. Si éste cae, la aplicación presenta un error recuperable, registra diagnóstico y ofrece reintentar o cerrar; no presenta datos caducos como si fueran actuales.

## Diseño de superficies

### Shell y tablero

La ventana conserva el mockup: barra superior con repo/ciclo/preflight/coste, navegación lateral compacta, área principal y barra de estado. Tablero se agrega como primer ítem para preservar flujos actuales. ⌘K alcanza vistas, sesión actual y acciones seguras.

La barra inferior muestra conectividad, número de sesiones/panes, ciclo activo, gates esperando, atajo de comandos y versión. Un contador sin fuente real se muestra como —, nunca se inventa.

### Sesiones y adopción

Sesiones conserva el inventario actual y añade:

- filtro por nombre y agrupación gestionadas / ajenas;
- detalle de repo, ciclo, etapa, antigüedad, panes y rol;
- selección de pane antes de actuar;
- Nueva sesión: galería de workflows guardados que explica agentes, gates y coste estimado y crea sesión, cycle dir y layout con IDs tmux %N, nunca índices;
- Adoptar: confirma repo, rol, workflow y pane; crea el cycle dir y registra la sesión sin mover, rediseñar ni matar panes.

Una sesión ajena sólo permite inspección mediante list-panes y capture-pane, más una terminal de lectura. Input, broadcast, lanzamiento y cambio de layout se rechazan tanto en UI como servidor hasta adoptar.

### Terminales nativas

Terminales muestra cuadrícula de panes para la sesión seleccionada. Cada celda identifica pane %N, rol, modelo y estado (working, idle, shell o gone). El foco se refleja en el encabezado y la cuadrícula se sincroniza después del resize.

El renderer usa xterm.js y Electron main inicia/gestiona un cliente tmux local mediante node-pty. La salida viaja por puertos dedicados, el teclado sólo llega a destinos validados y las dimensiones se aplican al terminal. Focus pane utiliza los IDs %N que el backend verificó. Broadcast requiere confirmación, lista sus destinos y no existe para sesiones ajenas. Cerrar una pestaña mata sólo su PTY cliente, no la sesión tmux.

La aplicación se adjunta a las sesiones reales: no las simula ni reinicia agentes. Si no puede crear un PTY, explica la causa y deja la sesión intacta.

### Loops y nueva ejecución

El editor lee y persiste workflows configurados del repo en tres representaciones del mismo modelo:

- Grafo: etapas, gates, ramas y retornos; permite conexiones válidas, layout automático y zoom.
- Stepper: lista editable de rol, modelo, objetivo, artefacto, gate y reintentos.
- JSON: editor validado; sus errores señalan ruta y regla y nunca reemplazan el workflow guardado.

Lanzar usa sólo un workflow validado. Si hay una sesión viva, la edición se guarda pero afecta únicamente etapas aún no empezadas. Una etapa disparada no se cambia retroactivamente. verifyCmd mantiene sus reglas actuales de allowlist y origen no versionado.

### Pruebas

Pruebas refleja ejecuciones reales: rango temporal, totales por resultado, duración, cobertura si el runner la da, inestables, rejilla, suites y panel de fallos con salida relevante.

Sus acciones son correr todas, correr fallidas, reintentar una suite y enviar un fallo a un worker gestionado. Cada acción registra inicio, streaming, resultado y código de salida. No ejecuta comandos arbitrarios: usa la configuración de pruebas del repo y explica si falta.

### Skills

Skills descubre las raíces permitidas ~/.claude/skills, <repo>/.claude/skills y <repo>/skills. Muestra alcance, descripción, estado y validación de frontmatter. Puede leer y editar SKILL.md dentro de esas raíces, validar antes de guardar y activar/desactivar metadata de Ronin. Nunca borra archivos.

Paths con .., enlaces que escapen la raíz o frontmatter sin name/description se rechazan y se explican.

### Preflight

Preflight corre al arrancar y bajo petición. Muestra rutas/versiones de tmux, CLI configurado, PATH de login, backend, node-pty, arquitectura y firma. La falta de firma es una advertencia prevista; la falta de node-pty, tmux o backend bloquea su función correspondiente. Cada check ofrece detalle accionable y reintento.

## Contratos y errores

| Situación | Comportamiento | Responsable |
|---|---|---|
| Backend no inicia | Error visible, reintento y sin datos supuestamente vivos. | Electron main + shell |
| node-pty no carga | Preflight bloquea la terminal y explica arquitectura/paquete. | main + preflight |
| Session/pane inexistente | Error tipado, celda gone y ningún fallback ambiguo. | preload/main/server |
| Sesión ajena intenta escritura | Rechazo antes de send-keys y acción Adoptar visible. | server + main + React |
| JSON inválido | Error por campo; no persiste ni permite lanzar. | server + editor |
| Runner falla | Guarda salida acotada, código de salida y habilita reintento. | servicio de pruebas |
| Skill inválido/path fuera de raíz | No escribe y explica la regla de validación. | servicio de skills |
| Build sin certificado | Paquete válido sin firma y aviso de Gatekeeper/SmartScreen. | packaging + preflight |

## Estructura prevista

    desktop/
      main/        # ciclo Electron, backend y PTY
      preload/     # IPC limitada y tipos
      renderer/    # entrada/build Electron de React
      tests/       # lifecycle, IPC y PTY con dobles
    web/src/
      screens/     # sesiones, terminales, workflows, pruebas, skills, preflight
      components/  # shell, palette, grid terminal y editor
    server/src/
      sessions.ts, adopt.ts, workflow*.ts, test-runs.ts, skills.ts, preflight.ts

Los nombres concretos se ajustan al patrón del repositorio durante el plan. App.tsx no se convierte en un monolito: las vistas y componentes se separan.

## Pruebas y criterios de aceptación

Cada conducta se desarrolla RED → GREEN → REFACTOR, con RGR que registre fallo esperado, cambio mínimo y suites verdes.

| Criterio | Evidencia |
|---|---|
| El tablero previo conserva sus acciones | Tests actuales y smoke de navegación Electron. |
| Ocho superficies del mockup navegan con datos reales | E2E de navegación y contratos API por vista. |
| Sesiones externas son sólo lectura | Tests negativos: no hay send-keys, broadcast o launch. |
| Adopción usa %N y no altera layout ajeno | Tests parser/plan e integración tmux aislada. |
| Terminal acepta input, output y resize | Tests de lifecycle PTY y E2E con comando controlado. |
| Editor conserva workflows válidos y rechaza JSON inseguro | Tests de validación, persistencia y hot-apply futuro. |
| Pruebas reflejan un comando real y retienen fallos | Tests servicio y E2E de reintento. |
| Skills no abandonan raíces permitidas | Tests de traversal, symlink y frontmatter inválido. |
| Preflight detecta node-pty y paquete sin firma | Tests de registro y snapshots de UI. |
| Los destinos producen artefactos | Builds CI separados macOS arm64/x64, Windows y Linux. |

Electron usa dobles de PTY/tmux donde una sesión real no sea determinista y, como mínimo, un smoke empaquetado por plataforma. Servidor y renderer siguen testeándose fuera de Electron para mantener diagnósticos localizables.

## Entrega, reversión y diferido

- Desarrollo conserva npm run dev web y añade comandos explícitos de Electron, build y empaquetado.
- Se generan DMG/ZIP para macOS, instalador/portable para Windows y AppImage/deb para Linux, todos sin firma. La matriz nativa corre por sistema operativo; no se confía en cross-compilation frágil.
- Revertir el escritorio elimina su distribución; dashboard web y Express siguen ejecutables. No se migran ni destruyen datos de tareas, workflows, sesiones o skills.
- Firma, notarización, publicación automática, telemetría de coste y acceso remoto quedan diferidos.

