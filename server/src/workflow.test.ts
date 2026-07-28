import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  eligibleVerifyStages,
  gateHoldsDone,
  implStageIndex,
  liveMapFor,
  DRIVER_FLOW,
  DRIVER_STAGES,
  RESERVED_KEYS,
  shouldSwitchModel,
  stepperFor,
  stripVerifyFields,
  validateStages,
  verifyGateCap,
  type WfStage,
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
    true
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
    true
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

// ---- Modo Driver: el flow fijo debe mapear bien contra la maquinaria del workflow ----

test("DRIVER_FLOW: verifyAfter null ⇒ stepperFor NO inserta el paso sintético 'verify'", () => {
  // Si se colara, pollLive dispararía spawnVerifier y crearía una sesión tmux aparte,
  // anulando en silencio el modelo de 4 panes.
  const stepper = stepperFor(DRIVER_STAGES, DRIVER_FLOW.verifyAfter);
  assert.equal(DRIVER_FLOW.verifyAfter, null);
  assert.equal(stepper.length, DRIVER_STAGES.length);
  assert.equal(stepper.some((s) => s.key === "verify"), false);
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

test("liveMapFor(DRIVER_FLOW): 'done' cierra la tarjeta; las intermedias la dejan corriendo", () => {
  const map = liveMapFor(DRIVER_STAGES, DRIVER_FLOW.verifyAfter);
  assert.deepEqual(
    { task: map.get("done")!.task, worker: map.get("done")!.worker },
    { task: "done", worker: "done" }
  );
  for (const k of ["planning", "plan-review", "implementing", "diff-review", "verifying"]) {
    assert.equal(map.get(k)!.task, "running", k);
    assert.equal(map.get(k)!.worker, "busy", k);
  }
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
