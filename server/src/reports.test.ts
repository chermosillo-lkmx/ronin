import assert from "node:assert/strict";
import test from "node:test";
import { runReportPrompt } from "./reports.js";

test("runReportPrompt entrega al ejecutor la invocación del motor configurado", async () => {
  let received: { command?: string; args?: string[] } | undefined;
  await runReportPrompt("reporte", {
    readEngine: () => ({ tool: "agy", model: "modelo-agy" }),
    runClaudeP: async (_prompt, options) => {
      received = options;
      return "<REPORT># Informe</REPORT>";
    },
  });
  assert.deepEqual(received, { command: "agy", args: ["-p", "--model", "modelo-agy"] });
});
