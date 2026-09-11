import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  eligibleVerifyStages,
  gateHoldsDone,
  implStageIndex,
  normalizeLoadedWorkflow,
  DRIVER_FLOW,
  DRIVER_STAGES,
  RESERVED_KEYS,
  WORKFLOW_PROMPT_RESERVED_KEYS,
  shouldSwitchModel,
  stripVerifyFields,
  validateStages,
  verifyGateCap,
  WorkflowValidationError,
  type WfStage,
  type WorkflowConfig,
} from "./workflow.js";


const IMPL_FLOW: WfStage[] = [
  { key: "planning", label: "Plan", icon: "📋" },
  { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" },
  { key: "curl", label: "Curl", icon: "🌐" },
  { key: "done", label: "Done", icon: "✓" },
];
const RESEARCH_FLOW: WfStage[] = [
  { key: "investigating", label: "Inv", icon: "🔍" },
  { key: "plan", label: "Plan", icon: "📝" },
  { key: "done", label: "Done", icon: "✓" },
];

test("implStageIndex: finds the role:impl stage, or the 'implementing' key as fallback", () => {
  assert.equal(implStageIndex(IMPL_FLOW), 1);
  assert.equal(implStageIndex([{ key: "implementing", label: "I", icon: "x" }]), 0); // back-compat, no role
  assert.equal(implStageIndex(RESEARCH_FLOW), -1);
});

test("shouldSwitchModel: implementer launch switches at the impl stage", () => {
  assert.equal(shouldSwitchModel(true, false, IMPL_FLOW, "implementing"), true);
});

test("shouldSwitchModel: F2 — fires at a LATER stage too (skipped implementing poll)", () => {
  assert.equal(shouldSwitchModel(true, false, IMPL_FLOW, "curl"), true);
  assert.equal(shouldSwitchModel(true, false, IMPL_FLOW, "done"), true);
});

test("shouldSwitchModel: does NOT fire before the impl stage", () => {
  assert.equal(shouldSwitchModel(true, false, IMPL_FLOW, "planning"), false);
});

test("shouldSwitchModel: B1 — PR/research (switchEnabled=false) never switches", () => {
  assert.equal(shouldSwitchModel(false, false, IMPL_FLOW, "implementing"), false);
});

test("shouldSwitchModel: research flow (no impl stage) never switches even if enabled", () => {
  assert.equal(shouldSwitchModel(true, false, RESEARCH_FLOW, "plan"), false);
});

test("shouldSwitchModel: idempotent — already switched → false", () => {
  assert.equal(shouldSwitchModel(true, true, IMPL_FLOW, "implementing"), false);
});

test("shouldSwitchModel: synthetic 'verify' stageKey (not in stages) counts as at/after impl", () => {
  assert.equal(shouldSwitchModel(true, false, IMPL_FLOW, "verify"), true);
  // an unknown, non-verify stageKey does not fire
  assert.equal(shouldSwitchModel(true, false, IMPL_FLOW, "bogus"), false);
});

test("validateStages: strips verifyCmd by default (git-tracked path — RCE guard, B3)", () => {
  const out = validateStages({
    stages: [{ key: "curl", label: "Curl", icon: "🌐", verifyCmd: "npm test", maxRetries: 3 } as WfStage],
    verifyAfter: null,
  });
  assert.equal(out.stages[0].verifyCmd, undefined); // stripped
  assert.equal(out.stages[0].maxRetries, undefined);
});

test("validateStages: preserves verifyCmd + clamps maxRetries when allowVerifyCmd=true (gitignored repo override)", () => {
  const out = validateStages(
    {
      stages: [
        { key: "curl", label: "Curl", icon: "🌐", verifyCmd: "  npm test  ", maxRetries: 99 } as WfStage,
        { key: "build", label: "Build", icon: "🔧", verifyCmd: "make" } as WfStage,
        { key: "done", label: "Done", icon: "✓" },
      ],
      verifyAfter: null,
    },
    { allowVerifyCmd: true }
  );
  assert.equal(out.stages[0].verifyCmd, "npm test"); // trimmed + preserved
  assert.equal(out.stages[0].maxRetries, 10); // clamped to 10
  assert.equal(out.stages[1].verifyCmd, "make");
  assert.equal(out.stages[1].maxRetries, 2); // default when verifyCmd present but maxRetries absent
  assert.equal(out.stages[2].verifyCmd, undefined); // no verifyCmd → no maxRetries
  assert.equal(out.stages[2].maxRetries, undefined);
});

test("validateStages: blank verifyCmd is dropped even when allowed", () => {
  const out = validateStages(
    { stages: [{ key: "curl", label: "Curl", icon: "🌐", verifyCmd: "   " } as WfStage], verifyAfter: null },
    { allowVerifyCmd: true }
  );
  assert.equal(out.stages[0].verifyCmd, undefined);
});

test("validateStages: a stage with no verifyCmd is byte-identical to before (back-compat)", () => {
  const out = validateStages({
    stages: [{ key: "planning", label: "Plan", icon: "📋", instruction: "x" }],
    verifyAfter: null,
  });
  assert.deepEqual(out.stages[0], { key: "planning", label: "Plan", icon: "📋", instruction: "x" });
});

test("validateStages: conserva executor válido, descarta uno inválido y sanea model", () => {
  const out = validateStages({
    stages: [
      { key: "planning", label: "Plan", icon: "📋", executor: "codex", model: "  gpt-5.1-codex  " },
      { key: "curl", label: "Curl", icon: "🌐", executor: "basura", model: "opus; rm -rf /" },
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: null,
  });
  assert.equal(out.stages[0].executor, "codex");
  assert.equal(out.stages[0].model, "gpt-5.1-codex");
  assert.equal(out.stages[1].executor, undefined);
  assert.equal(out.stages[1].model, undefined);
  assert.deepEqual(out.stages[2], { key: "done", label: "Done", icon: "✓", instruction: "" });
});

test("validateStages: conserva entradas declarativas válidas y recorta sus etiquetas", () => {
  const out = validateStages({
    stages: [{ key: "planning", label: "Plan", icon: "📋" }],
    verifyAfter: null,
    inputs: [{ key: "ticket", label: "  Ticket  ", placeholder: "CU-42", required: true }],
  });
  assert.deepEqual(out.inputs, [{ key: "ticket", label: "Ticket", placeholder: "CU-42", required: true }]);
});

test("validateStages: descarta entradas sin label, con key inválida, reservada o duplicada", () => {
  const out = validateStages({
    stages: [{ key: "planning", label: "Plan", icon: "📋" }],
    verifyAfter: null,
    inputs: [
      { key: "sin-label" },
      { key: "Ticket ID", label: "Inválida" },
      { key: "steps", label: "Reservada" },
      { key: "ticket", label: "Primera" },
      { key: "ticket", label: "Segunda" },
    ],
  });
  assert.deepEqual(out.inputs, [{ key: "ticket", label: "Primera" }]);
  assert.ok(WORKFLOW_PROMPT_RESERVED_KEYS.includes("steps"));
});

const GATED: WfStage[] = [
  { key: "planning", label: "Plan", icon: "📋" },
  { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" },
  { key: "curl", label: "Curl", icon: "🌐", verifyCmd: "npm test", maxRetries: 2 },
  { key: "done", label: "Done", icon: "✓" },
];

test("verifyGateCap: caps at an unpassed gate the worker reached (B2 — no false-green)", () => {
  // furthest = done, but curl's gate hasn't passed → displayed stage capped at curl (NOT done)
  assert.equal(verifyGateCap(GATED, "done", () => false), "curl");
  // curl passed → no cap, done shows through
  assert.equal(verifyGateCap(GATED, "done", (k) => k === "curl"), null);
  // worker only reached implementing (before the gate) → no cap
  assert.equal(verifyGateCap(GATED, "implementing", () => false), null);
  // no stage reached → no cap
  assert.equal(verifyGateCap(GATED, null, () => false), null);
});

test("eligibleVerifyStages: a gate becomes eligible only once the worker LEFT it", () => {
  // worker still AT curl (furthest=curl) → not left yet → not eligible
  assert.deepEqual(eligibleVerifyStages(GATED, "curl", () => null), []);
  // worker reached done (past curl) → curl gate eligible
  const e = eligibleVerifyStages(GATED, "done", () => null);
  assert.equal(e.length, 1);
  assert.equal(e[0].key, "curl");
  assert.equal(e[0].maxRetries, 2);
});

test("eligibleVerifyStages: a resolved gate (passed/failed) is not eligible again", () => {
  assert.deepEqual(eligibleVerifyStages(GATED, "done", (k) => (k === "curl" ? "passed" : null)), []);
  assert.deepEqual(eligibleVerifyStages(GATED, "done", (k) => (k === "curl" ? "failed" : null)), []);
});

test("gateHoldsDone: an unpassed gate (incl. pending/in-flight on a TERMINAL stage) blocks done — no false-green", () => {
  assert.equal(gateHoldsDone(true, null), true); // check not started / in-flight → NOT done
  assert.equal(gateHoldsDone(true, "pending"), true);
  assert.equal(gateHoldsDone(true, "failed"), true);
  assert.equal(gateHoldsDone(true, "passed"), false); // only a pass releases it
  assert.equal(gateHoldsDone(false, null), false); // stage without a verifyCmd is unaffected
  assert.equal(gateHoldsDone(false, "pending"), false);
});

test("stripVerifyFields: removes verifyCmd/maxRetries (single-source B3 strip for git-tracked load)", () => {
  const clean = stripVerifyFields({ key: "curl", label: "Curl", icon: "🌐", verifyCmd: "rm -rf /", maxRetries: 3, role: "impl" });
  assert.equal((clean as any).verifyCmd, undefined);
  assert.equal((clean as any).maxRetries, undefined);
  assert.equal((clean as any).key, "curl"); // everything else preserved
  assert.equal((clean as any).role, "impl");
});

test("eligibleVerifyStages: a terminal gate is eligible when reached", () => {
  const flow: WfStage[] = [
    { key: "impl", label: "Impl", icon: "⌨️" },
    { key: "done", label: "Done", icon: "✓", verifyCmd: "make check" },
  ];
  const e = eligibleVerifyStages(flow, "done", () => null);
  assert.equal(e.length, 1);
  assert.equal(e[0].key, "done");
});

test("validateStages: preserves role:'impl' and drops other role values", () => {
  const out = validateStages({
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" } as WfStage,
      { key: "curl", label: "Curl", icon: "🌐", role: "bogus" as any },
    ],
    verifyAfter: null,
  });
  assert.equal(out.stages[1].role, "impl");
  assert.equal(out.stages[0].role, undefined);
  assert.equal(out.stages[2].role, undefined);
});

// ---- T11: dos contratos separados — strict (editar/guardar) vs tolerante (cargar) ----

const VALID_TWO_STAGES = {
  stages: [
    { key: "planning", label: "Plan", icon: "📋" },
    { key: "done", label: "Done", icon: "✓" },
  ],
  verifyAfter: null as string | null,
};

test("T11.80 strict: verifyAfter que no casa con ninguna etapa lanza con path 'verifyAfter' y las keys válidas en el mensaje", () => {
  assert.throws(
    () => validateStages({ ...VALID_TWO_STAGES, verifyAfter: "typo" }, { strict: true }),
    (e: unknown) => {
      assert.ok(e instanceof WorkflowValidationError);
      assert.equal(e.path, "verifyAfter");
      assert.equal(e.code, "VERIFY_AFTER_NOT_FOUND");
      assert.match(e.message, /planning/);
      assert.match(e.message, /done/);
      return true;
    }
  );
});

test("T11.81 strict: role:'admin' lanza con path 'stages[0].role'", () => {
  assert.throws(
    () =>
      validateStages(
        { stages: [{ key: "planning", label: "Plan", icon: "📋", role: "admin" as any }], verifyAfter: null },
        { strict: true }
      ),
    (e: unknown) => {
      assert.ok(e instanceof WorkflowValidationError);
      assert.equal(e.path, "stages[0].role");
      assert.equal(e.code, "INVALID_ROLE");
      return true;
    }
  );
});

test("T11.82 strict: dos etapas con la misma key lanzan con path 'stages[1].key'", () => {
  assert.throws(
    () =>
      validateStages(
        {
          stages: [
            { key: "planning", label: "Plan", icon: "📋" },
            { key: "planning", label: "Otro plan", icon: "📋" },
          ],
          verifyAfter: null,
        },
        { strict: true }
      ),
    (e: unknown) => {
      assert.ok(e instanceof WorkflowValidationError);
      assert.equal(e.path, "stages[1].key");
      assert.equal(e.code, "DUPLICATE_KEY");
      return true;
    }
  );
});

test("T11.83 strict: label:'' o icon:'' tras trim lanzan con su propia ruta", () => {
  assert.throws(
    () => validateStages({ stages: [{ key: "planning", label: "  ", icon: "📋" }], verifyAfter: null }, { strict: true }),
    (e: unknown) => {
      assert.ok(e instanceof WorkflowValidationError);
      assert.equal(e.path, "stages[0].label");
      assert.equal(e.code, "LABEL_REQUIRED");
      return true;
    }
  );
  assert.throws(
    () => validateStages({ stages: [{ key: "planning", label: "Plan", icon: " " }], verifyAfter: null }, { strict: true }),
    (e: unknown) => {
      assert.ok(e instanceof WorkflowValidationError);
      assert.equal(e.path, "stages[0].icon");
      assert.equal(e.code, "ICON_REQUIRED");
      return true;
    }
  );
});

test("T11.84 strict: una key que slug() cambiaría lanza proponiendo la versión slugueada, en vez de mutar en silencio", () => {
  assert.throws(
    () => validateStages({ stages: [{ key: "Build Step", label: "Build", icon: "🔧" }], verifyAfter: null }, { strict: true }),
    (e: unknown) => {
      assert.ok(e instanceof WorkflowValidationError);
      assert.equal(e.path, "stages[0].key");
      assert.equal(e.code, "KEY_NOT_SLUG");
      assert.match(e.message, /build-step/);
      return true;
    }
  );
});

test("T11.85 strict: verifyCmd con allowVerifyCmd=false lanza VERIFY_CMD_NOT_ALLOWED explicando que el archivo es git-tracked", () => {
  assert.throws(
    () =>
      validateStages(
        { stages: [{ key: "curl", label: "Curl", icon: "🌐", verifyCmd: "npm test" } as WfStage], verifyAfter: null },
        { strict: true }
      ),
    (e: unknown) => {
      assert.ok(e instanceof WorkflowValidationError);
      assert.equal(e.path, "stages[0].verifyCmd");
      assert.equal(e.code, "VERIFY_CMD_NOT_ALLOWED");
      assert.match(e.message, /git-tracked/);
      return true;
    }
  );
});

test("T11.86 strict: una entrada válida devuelve el config normalizado, idéntico salvo trim", () => {
  const out = validateStages(
    { stages: [{ key: "planning", label: "  Plan  ", icon: " 📋 ", instruction: "x" }], verifyAfter: null },
    { strict: true }
  );
  assert.deepEqual(out, { stages: [{ key: "planning", label: "Plan", icon: "📋", instruction: "x" }], verifyAfter: null });
});

test("T11.87 tolerante: normalizeLoadedWorkflow con verifyAfter inválido arranca con verifyAfter=null, sin lanzar", () => {
  const out = normalizeLoadedWorkflow({
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: "typo",
  });
  assert.equal(out.verifyAfter, null);
  assert.equal(out.stages.length, 2);
});

test("T11.88 tolerante: normalizeLoadedWorkflow con key duplicada conserva la primera, sin lanzar", () => {
  const out = normalizeLoadedWorkflow({
    stages: [
      { key: "planning", label: "Primera", icon: "📋" },
      { key: "planning", label: "Segunda", icon: "🔧" },
    ],
    verifyAfter: null,
  });
  assert.equal(out.stages.length, 1);
  assert.equal(out.stages[0].label, "Primera");
});

test("T11.89 tolerante: normalizeLoadedWorkflow elimina verifyCmd del archivo global y arranca", () => {
  const out = normalizeLoadedWorkflow({
    stages: [{ key: "curl", label: "Curl", icon: "🌐", verifyCmd: "npm test", maxRetries: 3 }],
    verifyAfter: null,
  });
  assert.equal(out.stages[0].verifyCmd, undefined);
  assert.equal(out.stages[0].maxRetries, undefined);
});

test("T11.91 tolerante: un workflow.json de ejemplo con TODAS las tolerancias a la vez carga sin excepción", () => {
  assert.doesNotThrow(() => {
    const out = normalizeLoadedWorkflow({
      stages: [
        { key: "Build Step", label: "", icon: "" }, // key sin slug + label/icon en blanco
        { key: "Build Step", label: "Duplicada", icon: "🔧" }, // key duplicada tras sluguear
        { key: "curl", label: "Curl", icon: "🌐", verifyCmd: "npm test" }, // verifyCmd en archivo global
        { key: "_meta", label: "no debería sobrevivir", icon: "x" }, // prefijo "_" descartado
      ],
      verifyAfter: "no-existe",
    });
    assert.ok(out.stages.length >= 1);
    assert.equal(out.verifyAfter, null);
    assert.equal(out.stages.some((s) => s.verifyCmd), false);
    assert.equal(out.stages.some((s) => s.key === "meta"), false);
  });
});


test("DRIVER_STAGES: ninguna key choca con RESERVED_KEYS", () => {
  for (const s of DRIVER_STAGES) assert.equal(RESERVED_KEYS.includes(s.key), false, s.key);
});

test("DRIVER_STAGES: ninguna etapa lleva role:'impl'", () => {
  assert.equal(DRIVER_STAGES.some((s) => s.role === "impl"), false);
});

// TRAMPA REAL: implStageIndex cae al match por KEY ("implementing") cuando nadie declara
// role:"impl" (workflow.ts:164). Omitir el role NO basta para evitar el switch de modelo —
// el driver tiene una etapa keyeada "implementing" y por lo tanto SÍ es candidata.
// Lo que de verdad protege son los dos guards del lanzamiento driver, verificados abajo.
test("implStageIndex: encuentra 'implementing' por key aunque no haya role:'impl'", () => {
  assert.equal(implStageIndex(DRIVER_STAGES), 2);
});

test("DRIVER_STAGES: ninguna etapa lleva verifyCmd (los gates P2 son del engine, no del driver)", () => {
  assert.equal(DRIVER_STAGES.some((s) => s.verifyCmd), false);
});

// El guard REAL nº1: launchDriverLive persiste switchEnabled:false (models.json), así que
// sobrevive a un reinicio del server — que es cuando worker.mode todavía no se reconstruyó.
test("shouldSwitchModel: switchEnabled=false lo apaga en TODAS las etapas driver", () => {
  for (const s of DRIVER_STAGES) {
    assert.equal(shouldSwitchModel(false, false, DRIVER_STAGES, s.key), false, s.key);
  }
});

// Y esto documenta por qué ese guard es imprescindible: con switchEnabled=true el switch SÍ
// dispararía en implementing y más allá, tecleando /model en el pane activo de la ventana.
test("shouldSwitchModel: con switchEnabled=true dispararía desde 'implementing' (por eso el guard)", () => {
  assert.equal(shouldSwitchModel(true, false, DRIVER_STAGES, "planning"), false);
  assert.equal(shouldSwitchModel(true, false, DRIVER_STAGES, "implementing"), true);
  assert.equal(shouldSwitchModel(true, false, DRIVER_STAGES, "done"), true);
});
