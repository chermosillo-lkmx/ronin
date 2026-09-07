import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SettingsScreen, type SettingsScreenData } from "./SettingsScreen.js";

const FIXTURE: SettingsScreenData = {
  repos: {
    defaultPath: "/code",
    repos: [
      { key: "con-kb", path: "/code/con-kb" },
      { key: "sin-kb", path: "/code/sin-kb" },
    ],
  },
  engine: { tool: "codex", model: "gpt-5" },
  checks: [
    { key: "claude", label: "claude CLI", level: "fail", detail: "no encontrado" },
    { key: "codex", label: "codex CLI", level: "ok", detail: "/opt/homebrew/bin/codex · 1.0" },
    { key: "agy", label: "agy CLI", level: "ok", detail: "/usr/local/bin/agy · 1.0" },
  ],
  knowledgeBases: {
    "con-kb": { exists: true, relativePath: "knowledge-base", files: 28, bytes: 1887436, candidates: [] },
    "sin-kb": { exists: false, relativePath: "", files: 0, bytes: 0, candidates: ["kb"] },
  },
};

test("SettingsScreen lista estados de KB y cambia la acción principal por repositorio", () => {
  const html = renderToString(createElement(SettingsScreen, { initial: FIXTURE }));

  assert.match(html, /con-kb/);
  assert.match(html, /knowledge-base/);
  assert.match(html, /28 archivos/);
  assert.match(html, /Compartir zip/);
  assert.match(html, /sin-kb/);
  assert.match(html, /Sin knowledge base/);
  assert.match(html, />Crear</);
});

test("SettingsScreen deshabilita un motor ausente y deja disponible uno instalado", () => {
  const html = renderToString(createElement(SettingsScreen, { initial: FIXTURE }));

  assert.match(html, /aria-label="Elegir claude"[^>]*disabled=""/);
  assert.match(html, /aria-label="Elegir codex"(?![^>]*disabled="")/);
});

test("DesktopApp declara la vista settings y su acceso en el rail", () => {
  const source = readFileSync(new URL("../DesktopApp.tsx", import.meta.url), "utf8");

  assert.match(source, /\| "settings"/);
  assert.match(source, /label="Configuración"/);
  assert.match(source, /view === "settings" && <SettingsScreen/);
});
