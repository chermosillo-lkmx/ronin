import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SKILL_PROPOSALS_POLL_MS, skillsBadgeLabel } from "./useSkillProposalCount.js";

test("skillsBadgeLabel sólo muestra el badge con pendientes", () => {
  assert.equal(skillsBadgeLabel(0), "");
  assert.equal(skillsBadgeLabel(3), "🧩 3");
  assert.equal(SKILL_PROPOSALS_POLL_MS, 30_000);
});

test("el botón ▤ del riel y el del encabezado llevan el badge 🧩 N (pin por fuente)", () => {
  const desktop = readFileSync(new URL("../../DesktopApp.tsx", import.meta.url), "utf8");
  assert.match(desktop, /skillsBadgeLabel\(useSkillProposalCount\(\)\)/);
  assert.match(desktop, /icon="▤" label="Skills" badge=\{skillsBadge\}/);
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  assert.match(app, /skillsBadgeLabel\(useSkillProposalCount\(\)\)/);
  assert.match(app, /▤\{skillsBadge && <b className="ronin-skills-badge">\{skillsBadge\}<\/b>\}/);
});
