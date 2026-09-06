import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ActivityHeatmap } from "./ActivityHeatmap.js";

test("ActivityHeatmap names agent-reported runs in a cell title only when present", () => {
  const html = renderToString(createElement(ActivityHeatmap, {
    months: [{ label: "sep", days: 2 }],
    rows: [{
      repo: "api",
      configured: true,
      total: 4,
      cells: [
        { date: "2026-09-03", count: 3, status: "failed", agentCount: 2 },
        { date: "2026-09-04", count: 1, status: "passed", agentCount: 0 },
      ],
    }],
  }));

  assert.match(html, /title="2026-09-03 · 3 corridas · falló · 2 reportadas por el agente"/);
  assert.match(html, /title="2026-09-04 · 1 corrida · pasó"/);
  assert.doesNotMatch(html, /2026-09-04[^\"]*agente/);
});
