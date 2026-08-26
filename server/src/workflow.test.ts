import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  eligibleVerifyStages,
  gateHoldsDone,
  implStageIndex,
  liveMapFor,
  normalizeLoadedWorkflow,
  spliceFlow,
  toGraph,
  DRIVER_FLOW,
  DRIVER_STAGES,
  RESERVED_KEYS,
  shouldSwitchModel,
  stepperFor,
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

// ---- T12: grafo derivado (toGraph) — sólo dibuja lo que el engine ya recorre por índice ----

const ABC: WfStage[] = [
  { key: "a", label: "A", icon: "a" },
  { key: "b", label: "B", icon: "b" },
  { key: "c", label: "C", icon: "c" },
];

test("T12.92 toGraph: 3 etapas, verifyAfter:null → 3 nodos, 2 aristas de secuencia", () => {
  const g = toGraph({ stages: ABC, verifyAfter: null });
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(g.nodes.map((n) => n.key), ["a", "b", "c"]);
  const seq = g.edges.filter((e) => e.kind === "sequence");
  assert.equal(seq.length, 2);
  assert.deepEqual(seq.map((e) => [e.from, e.to]), [["a", "b"], ["b", "c"]]);
});

test("T12.93 toGraph: verifyAfter:'b' → nodo sintético 'verify' + arista de bifurcación b→verify", () => {
  const g = toGraph({ stages: ABC, verifyAfter: "b" });
  assert.ok(g.nodes.some((n) => n.key === "verify"));
  const branch = g.edges.find((e) => e.kind === "verify");
  assert.deepEqual(branch && [branch.from, branch.to], ["b", "verify"]);
});

test("T12.94 toGraph: una etapa con verifyCmd → self-loop de reintento con maxRetries + marca de gate", () => {
  const gated: WfStage[] = [
    { key: "a", label: "A", icon: "a" },
    { key: "curl", label: "Curl", icon: "🌐", verifyCmd: "npm test", maxRetries: 4 },
  ];
  const g = toGraph({ stages: gated, verifyAfter: null });
  const retry = g.edges.find((e) => e.kind === "retry");
  assert.deepEqual(retry && [retry.from, retry.to, retry.maxRetries], ["curl", "curl", 4]);
  assert.equal(g.nodes.find((n) => n.key === "curl")?.gate, true);
  assert.equal(g.nodes.find((n) => n.key === "a")?.gate, undefined);
});

test("T12.95 toGraph: una etapa con role:'impl' sale marcada", () => {
  const g = toGraph({ stages: IMPL_FLOW, verifyAfter: null });
  assert.equal(g.nodes.find((n) => n.key === "implementing")?.role, "impl");
  assert.equal(g.nodes.find((n) => n.key === "planning")?.role, undefined);
});

test("T12.96 toGraph: es puro y no lee disco (misma entrada, misma salida, dos llamadas seguidas)", () => {
  const cfg = { stages: ABC, verifyAfter: "b" };
  assert.deepEqual(toGraph(cfg), toGraph(cfg));
});

// ---- T13: spliceFlow — hot-apply sin falso verde (nunca huérfano un sentinel ya escrito) ----

const OLD_FLOW: WorkflowConfig = {
  stages: [
    { key: "planning", label: "Plan", icon: "📋" },
    { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" },
    { key: "curl", label: "Curl", icon: "🌐" },
    { key: "done", label: "Done", icon: "✓" },
  ],
  verifyAfter: null,
};

test("T13.101 spliceFlow: conserva el prefijo hasta currentKey INCLUSIVE y toma el sufijo nuevo", () => {
  const next: WorkflowConfig = {
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" },
      { key: "security", label: "Security", icon: "🔒" }, // nueva etapa insertada DESPUÉS de implementing
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: null,
  };
  const out = spliceFlow(OLD_FLOW, next, "implementing");
  assert.equal(out.ok, true);
  assert.ok(out.ok);
  assert.deepEqual(out.stages.map((s) => s.key), ["planning", "implementing", "security", "done"]);
  // el prefijo son los objetos VIEJOS (por si el nuevo cambió algo del propio implementing/planning)
  assert.deepEqual(out.stages[1], OLD_FLOW.stages[1]);
});

test("T13.101b spliceFlow: currentKey null (nada en curso todavía) → reemplazo completo por el nuevo flow", () => {
  const next: WorkflowConfig = { stages: [{ key: "solo", label: "Solo", icon: "x" }], verifyAfter: null };
  const out = spliceFlow(OLD_FLOW, next, null);
  assert.equal(out.ok, true);
  assert.ok(out.ok);
  assert.deepEqual(out.stages.map((s) => s.key), ["solo"]);
});

test("T13.102 spliceFlow: rechaza eliminar una etapa cuyo sentinel ya existe (currentKey no sobrevive en next)", () => {
  const next: WorkflowConfig = {
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      // "implementing" fue eliminada — el worker ya la pasó (currentKey)
      { key: "curl", label: "Curl", icon: "🌐" },
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: null,
  };
  const out = spliceFlow(OLD_FLOW, next, "implementing");
  assert.equal(out.ok, false);
  assert.ok(!out.ok);
  assert.equal(out.code, "STAGE_IN_FLIGHT");
});

test("T13.102b spliceFlow: rechaza renombrar una etapa cuyo sentinel ya existe", () => {
  const next: WorkflowConfig = {
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      { key: "coding", label: "Coding", icon: "⌨️", role: "impl" }, // "implementing" renombrada a "coding"
      { key: "curl", label: "Curl", icon: "🌐" },
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: null,
  };
  const out = spliceFlow(OLD_FLOW, next, "implementing");
  assert.equal(out.ok, false);
  assert.ok(!out.ok);
  assert.equal(out.code, "STAGE_IN_FLIGHT");
});

test("T13.105 spliceFlow: añadir verifyCmd a una etapa ya pasada no la aplica (el prefijo viene del flow VIEJO)", () => {
  const next: WorkflowConfig = {
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      { key: "implementing", label: "Impl", icon: "⌨️", role: "impl", verifyCmd: "npm test" }, // nuevo verifyCmd en una etapa ya pasada
      { key: "curl", label: "Curl", icon: "🌐" },
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: null,
  };
  const out = spliceFlow(OLD_FLOW, next, "implementing");
  assert.equal(out.ok, true);
  assert.ok(out.ok);
  assert.equal(out.stages[1].verifyCmd, undefined); // el objeto preservado es el VIEJO, sin el verifyCmd nuevo
});

test("D5 (bloqueante, hallado en review): currentKey='verify' (el sintético) se ancla a verifyAfter, NO se trata como 'nada que proteger'", () => {
  const withVerify: WorkflowConfig = { ...OLD_FLOW, verifyAfter: "curl" };
  // El worker está en el verificador sintético tras "curl" — renombrar/eliminar "planning"
  // (que va ANTES de curl) debe seguir rechazándose: el worker ya pasó por ahí.
  const renamedPlanning: WorkflowConfig = {
    stages: [
      { key: "kickoff", label: "Kickoff", icon: "📋" }, // "planning" renombrada
      { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" },
      { key: "curl", label: "Curl", icon: "🌐" },
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: "curl",
  };
  const out = spliceFlow(withVerify, renamedPlanning, "verify");
  assert.equal(out.ok, false);
  assert.ok(!out.ok);
  assert.equal(out.code, "STAGE_IN_FLIGHT");
});

test("D5: currentKey='verify' con anclaje sano (nada antes de verifyAfter se toca) SÍ splicea, tomando el sufijo nuevo tras curl", () => {
  const withVerify: WorkflowConfig = { ...OLD_FLOW, verifyAfter: "curl" };
  const next: WorkflowConfig = {
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" },
      { key: "curl", label: "Curl", icon: "🌐" },
      { key: "security", label: "Security", icon: "🔒" }, // nueva etapa AGREGADA tras curl
    ],
    verifyAfter: "curl",
  };
  const out = spliceFlow(withVerify, next, "verify");
  assert.equal(out.ok, true);
  assert.ok(out.ok);
  assert.deepEqual(out.stages.map((s) => s.key), ["planning", "implementing", "curl", "security"]);
});

test("D5: un currentKey desconocido (ni etapa real ni 'verify' resoluble) se rechaza CONSERVADOR — nunca vía libre", () => {
  const out = spliceFlow(OLD_FLOW, { stages: [{ key: "solo", label: "Solo", icon: "x" }], verifyAfter: null }, "algo-que-no-existe-en-ningun-lado");
  assert.equal(out.ok, false);
  assert.ok(!out.ok);
  assert.equal(out.code, "STAGE_IN_FLIGHT");
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
