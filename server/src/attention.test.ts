import { strict as assert } from "node:assert";
import { test } from "node:test";
import { detectDecision, paneAttention, rollupAttention } from "./attention.js";
import { TALL_CLAUDE_PANE } from "./claude-pane.fixture.js";

const CLAUDE_IDLE = [
  "Claude Code",
  "❯ ",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

test("paneAttention: reconoce los spinners actuales de Claude como working", () => {
  assert.equal(paneAttention(`· Schlepping… (16m 55s · ↓ 19.9k tokens)\n${CLAUDE_IDLE}`).level, "working");
  assert.equal(paneAttention(`✢ Beboppin'… (22s · ↓ 631 tokens · thinking with high effort)\n${CLAUDE_IDLE}`).level, "working");
});

test("paneAttention: un Claude acabado con caja vacía sigue idle", () => {
  assert.equal(paneAttention(`✻ Cogitated for 4m 11s · done 11:50 AM\n${CLAUDE_IDLE}`).level, "idle");
});

test("paneAttention: un Claude arriba de 68 filas vacías sigue idle, no shell", () => {
  assert.deepEqual(paneAttention(TALL_CLAUDE_PANE), { level: "idle" });
});

test("detectDecision: extrae la pregunta de un diálogo numerado real", () => {
  const pane = [
    "Do you want to make this edit to sessions.ts?",
    "❯ 1. Yes",
    "  2. Yes, allow all edits during this session",
    "  3. No, and tell Claude what to do differently (esc)",
  ].join("\n");
  assert.deepEqual(detectDecision(pane), {
    question: "Do you want to make this edit to sessions.ts?",
    options: ["Yes", "Yes, allow all edits during this session", "No, and tell Claude what to do differently (esc)"],
  });
  assert.deepEqual(paneAttention(pane), { level: "decision", question: "Do you want to make this edit to sessions.ts?" });
});

test("detectDecision: descarta un borrador numerado delimitado por reglas horizontales", () => {
  const pane = [
    "¿Qué quieres que haga después?",
    "────────────────────────────────────────────────────────────",
    "❯ 1. el job",
    "  2. haz el PR pero",
    "────────────────────────────────────────────────────────────",
    "  86e30j7mq  ⎇ CU-86e30j7mq/bulk-unlink-event-loop*  ▓░░░░ 38%",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ].join("\n");

  assert.equal(detectDecision(pane), null);
  assert.notEqual(paneAttention(pane).level, "decision");
});

test("detectDecision: limpia el marco de una AskUserQuestion capturada de tmux", () => {
  const pane = [
    "←  ☐ Write en dev  ☐ translated_*  ✔ Submit  →",
    "",
    "  │ Para probar el AC de `language=en` necesito encender el feature en dev sobre bu-818. ¿Cómo lo hago?",
    "",
    "❯ 1. UPDATE directo + revertir    ┌──────────────────────────────────────────────┐",
    "  2. PATCH con JWT M2M            │ UPDATE language_business_settings            │",
    "  3. Otro negocio, no bu-818      │  WHERE business_id = 'bu-818';               │",
    "  4. Déjalo sin probar            └──────────────────────────────────────────────┘",
    "",
    "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel",
  ].join("\n");

  assert.deepEqual(detectDecision(pane), {
    question: "Para probar el AC de `language=en` necesito encender el feature en dev sobre bu-818. ¿Cómo lo hago?",
    options: ["UPDATE directo + revertir", "PATCH con JWT M2M", "Otro negocio, no bu-818", "Déjalo sin probar"],
  });
});

test("detectDecision: conserva el diálogo al inicio de un pane alto con cola vacía", () => {
  const pane = [
    "¿Qué camino seguimos?",
    "❯ 1. UPDATE directo + revertir",
    "  2. PATCH con JWT M2M",
    ...Array<string>(50).fill(""),
  ].join("\n");

  assert.deepEqual(detectDecision(pane), {
    question: "¿Qué camino seguimos?",
    options: ["UPDATE directo + revertir", "PATCH con JWT M2M"],
  });
});

test("detectDecision: detecta una decisión aunque una captura antigua tenga una fila envuelta", () => {
  const pane = [
    "│ Para probar el AC de `language=en` necesito encender el feature en dev sobre b",
    "u-818. ¿Cómo lo hago?",
    "",
    "❯ 1. UPDATE directo + revertir",
    "  2. PATCH con JWT M2M",
  ].join("\n");

  // Sin -J el texto puede salir truncado; -J en buildCaptureArgs es la mitigación real. Aun así,
  // preferimos alertar con texto imperfecto antes que callar una sesión que está esperando input.
  assert.notEqual(detectDecision(pane), null);
});

test("detectDecision: no trunca guiones ni barras normales dentro de una opción", () => {
  const pane = [
    "¿Qué camino seguimos?",
    "❯ 1. PATCH con JWT M2M - reversible | auditado",
  ].join("\n");

  assert.deepEqual(detectDecision(pane), {
    question: "¿Qué camino seguimos?",
    options: ["PATCH con JWT M2M - reversible | auditado"],
  });
});

test("detectDecision: no confunde el input ni el picker slash sin números con una decisión", () => {
  assert.equal(detectDecision(`${CLAUDE_IDLE}\n❯ texto a medio teclear`), null);
  assert.equal(detectDecision(`${CLAUDE_IDLE}\n❯ /model sonnet`), null);
});

test("detectDecision: reconoce la confirmación genérica y/n", () => {
  assert.deepEqual(detectDecision("Aplicar el cambio ahora? [y/n]"), { question: "Aplicar el cambio ahora? [y/n]", options: [] });
});

test("paneAttention: distingue shell y pane desaparecido", () => {
  assert.equal(paneAttention("cesar@host repo % ").level, "shell");
  assert.equal(paneAttention(null).level, "gone");
});

test("rollupAttention: decisión gana a working y working a idle", () => {
  assert.deepEqual(rollupAttention(new Map([
    ["%1", `· Schlepping… (16m 55s · ↓ 19.9k tokens)\n${CLAUDE_IDLE}`],
    ["%2", "Do you want to make this edit to sessions.ts?\n❯ 1. Yes"],
  ])), { level: "decision", paneId: "%2", question: "Do you want to make this edit to sessions.ts?" });
  assert.deepEqual(rollupAttention(new Map([
    ["%1", CLAUDE_IDLE],
    ["%2", `✢ Beboppin'… (22s · ↓ 631 tokens · thinking with high effort)\n${CLAUDE_IDLE}`],
  ])), { level: "working", paneId: "%2" });
});
