import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { SkillProposalDetail } from "../../types.js";
import { diffLineClass, initialReadOnMount, proposalActions, reachedEnd, SkillProposalsPanel, SkillProposalView, warningLabel } from "./SkillProposals.js";

const CONTENT = "---\nname: migracion-reversible\ndescription: Migra.\n---\n\n1. Crea la migración.\n<!-- no borres esto -->\n";

function detail(overrides: Partial<SkillProposalDetail> = {}): SkillProposalDetail {
  return {
    id: "s_1", kind: "new", name: "migracion-reversible", repo: "acme-api", source: "cowork-mig", description: "Migra.",
    warnings: [], createdAt: 1, changes: "", content: CONTENT, contentHash: "sha256:abc", ...overrides,
  };
}

test("SkillProposalView muestra el SKILL.md en crudo (un comentario HTML queda visible) y los avisos resaltados", () => {
  const html = renderToString(createElement(SkillProposalView, { detail: detail({ warnings: ["comentario-html", "url-externa"] }) }));
  assert.match(html, /<pre[^>]*class="ron-skill-raw"[^>]*>---\nname: migracion-reversible/);
  assert.match(html, /&lt;!-- no borres esto --&gt;/);
  assert.match(html, /class="ron-skill-warning comentario-html"[^>]*>⚠ Tiene un comentario HTML \(no se vería renderizado\)</);
  assert.match(html, /⚠ Tiene una URL externa/);
  assert.match(html, /skill nueva/);
  assert.doesNotMatch(html, /ron-skill-diff/);
});

test("SkillProposalView de una actualización muestra el resumen de cambios y el diff por línea", () => {
  const diff = "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,2 +1,2 @@\n 1. Crea la migración.\n-2. Viejo.\n+2. Nuevo.\n";
  const html = renderToString(createElement(SkillProposalView, { detail: detail({ kind: "update", changes: "Agrega el rollback", diff, base: { content: "x", hash: "sha256:b" } }) }));
  assert.match(html, /actualización/);
  assert.match(html, /Agrega el rollback/);
  assert.match(html, /<span class="del">-2\. Viejo\.\n<\/span><span class="add">\+2\. Nuevo\.\n<\/span>/);
  assert.match(html, /<span class="hunk">@@ -1,2 \+1,2 @@/);
});

test("Aprobar sólo se habilita al llegar al final del texto; Descartar está disponible", () => {
  const unread = renderToString(createElement(SkillProposalView, { detail: detail() }));
  assert.match(unread, /<button[^>]*disabled=""[^>]*>✅ Aprobar<\/button>/);
  assert.match(unread, /Baja hasta el final del texto/);
  assert.match(unread, /<button[^>]*>❌ Descartar<\/button>/);
  assert.doesNotMatch(unread, /disabled=""[^>]*>❌ Descartar/);
  const read = renderToString(createElement(SkillProposalView, { detail: detail(), initialRead: true }));
  assert.doesNotMatch(read, /disabled=""[^>]*>✅ Aprobar/);
  const busy = renderToString(createElement(SkillProposalView, { detail: detail(), initialRead: true, initialBusy: true }));
  assert.match(busy, /disabled=""[^>]*>❌ Descartar/);
});

test("final F1: Editar y aprobar y Guardar y aprobar exigen la misma lectura hasta el final que Aprobar", () => {
  const unread = renderToString(createElement(SkillProposalView, { detail: detail() }));
  assert.match(unread, /<button[^>]*disabled=""[^>]*>✏️ Editar y aprobar<\/button>/);
  assert.match(unread, /Baja hasta el final del texto para habilitar Aprobar y Editar\./);
  const read = renderToString(createElement(SkillProposalView, { detail: detail(), initialRead: true }));
  assert.match(read, /<button[^>]*>✏️ Editar y aprobar<\/button>/);
  assert.doesNotMatch(read, /disabled=""[^>]*>✏️ Editar y aprobar/);
  const editingUnread = renderToString(createElement(SkillProposalView, { detail: detail(), initialEditing: CONTENT }));
  assert.match(editingUnread, /<textarea[^>]*class="ron-skill-raw"/);
  assert.match(editingUnread, /<button[^>]*disabled=""[^>]*>Guardar y aprobar<\/button>/);
  const editingRead = renderToString(createElement(SkillProposalView, { detail: detail(), initialRead: true, initialEditing: CONTENT }));
  assert.match(editingRead, /<button[^>]*>Guardar y aprobar<\/button>/);
  assert.doesNotMatch(editingRead, /disabled=""[^>]*>Guardar y aprobar/);
});

test("proposalActions: Aprobar manda el contentHash mostrado; Editar manda el contenido; Descartar, sólo la acción", async () => {
  const calls: unknown[][] = [];
  const api = { resolveSkillProposal: async (...args: unknown[]) => { calls.push(args); return { proposal: { id: "s_1", status: "approved" } } as never; } };
  const actions = proposalActions(detail(), api as never);
  await actions.approve();
  await actions.edit("---\nname: migracion-reversible\n---\n");
  await actions.discard();
  assert.deepEqual(calls, [
    ["s_1", "approve", { contentHash: "sha256:abc" }],
    ["s_1", "edit", { content: "---\nname: migracion-reversible\n---\n" }],
    ["s_1", "discard"],
  ]);
});

test("reachedEnd, diffLineClass y warningLabel", () => {
  assert.equal(reachedEnd({ scrollTop: 0, clientHeight: 200, scrollHeight: 200 }), true);
  assert.equal(reachedEnd({ scrollTop: 96, clientHeight: 100, scrollHeight: 200 }), true);
  assert.equal(reachedEnd({ scrollTop: 10, clientHeight: 100, scrollHeight: 200 }), false);
  assert.deepEqual(["+++ b", "--- a", "@@ -1 +1 @@", "+x", "-y", " z"].map(diffLineClass), ["meta", "meta", "hunk", "add", "del", "ctx"]);
  assert.equal(warningLabel("comando-destructivo"), "Tiene un comando destructivo");
  assert.equal(warningLabel("menciona-repo"), "Menciona el repo de origen");
  assert.equal(warningLabel("nombre-ajustado"), "Ronin ajustó el nombre");
});

test("final F6: los avisos nuevos tienen etiqueta en español y se resaltan en la propuesta", () => {
  assert.equal(warningLabel("ruta-sensible"), "Menciona una ruta sensible (credenciales, configuración del agente o CI)");
  assert.equal(warningLabel("exfiltracion"), "Tiene un comando que podría sacar datos del equipo");
  assert.equal(warningLabel("salta-controles"), "Pide saltarse controles o instrucciones");
  const html = renderToString(createElement(SkillProposalView, { detail: detail({ warnings: ["ruta-sensible", "exfiltracion", "salta-controles"] }) }));
  assert.match(html, /class="ron-skill-warning ruta-sensible"[^>]*>⚠ Menciona una ruta sensible/);
  assert.match(html, /class="ron-skill-warning exfiltracion"[^>]*>⚠ Tiene un comando que podría sacar datos/);
  assert.match(html, /class="ron-skill-warning salta-controles"[^>]*>⚠ Pide saltarse controles/);
});

test("F1: initialReadOnMount nunca hereda el 'leído' de un <pre> ajeno; sólo mide el propio o usa initialRead", () => {
  assert.equal(initialReadOnMount(false, null), false);
  assert.equal(initialReadOnMount(true, null), true);
  // un <pre> que ya está al fondo (contenido corto que cabe sin scroll) sí cuenta como leído
  assert.equal(initialReadOnMount(false, { scrollTop: 0, clientHeight: 200, scrollHeight: 200 }), true);
  // uno recién montado que aún no llegó al fondo, no
  assert.equal(initialReadOnMount(false, { scrollTop: 10, clientHeight: 100, scrollHeight: 400 }), false);
});

test("F1: cada propuesta nueva monta con Aprobar deshabilitado, sin importar el id anterior (el panel remonta con key={detail.id})", () => {
  const first = renderToString(createElement(SkillProposalView, { detail: detail({ id: "s_1" }) }));
  const second = renderToString(createElement(SkillProposalView, { detail: detail({ id: "s_2", name: "otra-skill" }) }));
  for (const html of [first, second]) assert.match(html, /<button[^>]*disabled=""[^>]*>✅ Aprobar<\/button>/);
});

test("F2: un 409 SKILL_STALE muestra el aviso de recarga con un botón Recargar, y no el mensaje crudo del servidor", () => {
  const html = renderToString(createElement(SkillProposalView, {
    detail: detail(), initialRead: true,
    initialError: { message: "el texto que aprobaste no coincide con la propuesta guardada", code: "SKILL_STALE" },
  }));
  assert.match(html, /La propuesta cambió; recárgala para ver el texto actual\. Si sigue sin poder aprobarse, descártala\./);
  assert.match(html, /<button[^>]*>Recargar<\/button>/);
  assert.doesNotMatch(html, /no coincide con la propuesta guardada/);
});

test("F2: otros errores muestran el mensaje del servidor tal cual, sin botón Recargar", () => {
  const html = renderToString(createElement(SkillProposalView, {
    detail: detail(), initialError: { message: "no se pudo resolver la propuesta" },
  }));
  assert.match(html, /no se pudo resolver la propuesta/);
  assert.doesNotMatch(html, /Recargar/);
});

test("SkillProposalsPanel lista las pendientes con su tipo, repo y avisos", () => {
  const html = renderToString(createElement(SkillProposalsPanel, {
    initial: [
      { id: "s_1", kind: "new", name: "migracion-reversible", repo: "acme-api", source: "cowork-mig", description: "Migra.", warnings: [], createdAt: 1 },
      { id: "s_2", kind: "update", name: "deploy-seguro", repo: "acme-web", source: "cowork-dep", description: "Despliega.", warnings: ["url-externa"], createdAt: 2 },
    ],
  }));
  assert.match(html, /migracion-reversible/);
  assert.match(html, /nueva · acme-api/);
  assert.match(html, /actualización · acme-web/);
  assert.match(html, /1 aviso/);
  assert.match(html, /Selecciona una propuesta/);
  assert.match(renderToString(createElement(SkillProposalsPanel, { initial: [] })), /No hay propuestas pendientes/);
});

function cssChecks(css: string): void {
  assert.match(css, /(?:^|\n)\.ron-skill-raw\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /(?:^|\n)\.ron-skill-diff\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere/);
}

test("final F5: el texto crudo y el diff parten tokens largos, así la puerta de lectura vertical los cubre", () => {
  cssChecks(readFileSync(new URL("../../ronin-shell.css", import.meta.url), "utf8"));
});
