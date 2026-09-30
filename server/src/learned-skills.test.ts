import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSkillDocument,
  buildSkillIndex,
  cleanSkillText,
  formatSkillCatalog,
  isStrictSkillName,
  LEARNED_SKILL_MAX_BYTES,
  LearnedSkillError,
  normalizeSkillName,
  skillHash,
  SKILL_INDEX_MAX_BYTES,
  unifiedDiff,
  validateLearnedSkill,
  type SkillIndexCandidate,
  type SkillValidationContext,
} from "./learned-skills.js";

const CONTEXT: SkillValidationContext = {
  name: "migracion-reversible",
  repo: "acme-api",
  repoPath: "/srv/code/acme-api",
  dataDir: "/srv/ronin-data",
  vars: { DEV_URL: "https://dev.acme.test", TOKEN: "tok-123456", SHORT: "abc" },
  token: "cap-9f8e7d6c5b4a",
};

function doc(body: string, name = "migracion-reversible", description = "Agrega una migración reversible y la prueba ida y vuelta."): string {
  return buildSkillDocument({ name, description, body });
}

function reasonsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LearnedSkillError, String(error));
    assert.equal(error.code, "SKILL_INVALID");
    assert.equal(error.status, 400);
    return error.reasons;
  }
  assert.fail("se esperaba SKILL_INVALID");
}

test("buildSkillDocument arma el frontmatter con sólo name y description, en una línea, y el cuerpo limpio", () => {
  const content = buildSkillDocument({ name: "migracion-reversible", description: "Agrega una migración\n  reversible.", body: "\n\n# Pasos\r\n1. Crea la migración.\n\n\n" });
  assert.equal(content, "---\nname: migracion-reversible\ndescription: Agrega una migración reversible.\n---\n\n# Pasos\n1. Crea la migración.\n");
});

test("cleanSkillText quita BOM, formato Unicode (bidi y ancho cero) y control salvo \\n y \\t, y normaliza saltos", () => {
  assert.equal(cleanSkillText("\uFEFFa\u202Eb\u200Bc\u0007d\te\r\nf\rg"), "abcd\te\nf\ng");
});

test("isStrictSkillName y normalizeSkillName siguen la regla de agentskills.io", () => {
  assert.equal(isStrictSkillName("migracion-reversible"), true);
  for (const bad of ["a--b", "a-", "-a", "A", "a_b", "x".repeat(65)]) assert.equal(isStrictSkillName(bad), false, bad);
  assert.equal(normalizeSkillName("  Migración  Reversible!! "), "migracion-reversible");
  assert.equal(normalizeSkillName("a--b__c-"), "a-b-c");
  assert.equal(normalizeSkillName("x".repeat(70)).length, 64);
  assert.equal(normalizeSkillName(`${"a".repeat(63)}-b`), "a".repeat(63));
  assert.equal(normalizeSkillName("¡¡!!"), "");
});

test("skillHash es sha256 con prefijo", () => {
  assert.match(skillHash("hola"), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(skillHash("hola"), skillHash("hola\n"));
});

test("validateLearnedSkill acepta una skill limpia y devuelve el texto limpio sin avisos", () => {
  const result = validateLearnedSkill(`\uFEFF${doc("1. Crea la migración con `make migration`.\n2. Pruébala ida y vuelta.")}`, CONTEXT);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.name, "migracion-reversible");
  assert.equal(result.description, "Agrega una migración reversible y la prueba ida y vuelta.");
  assert.equal(result.content.startsWith("---\nname: migracion-reversible\n"), true);
});

test("validateLearnedSkill rechaza campos extra, nombre distinto, frontmatter roto y description vacía o larga", () => {
  assert.match(reasonsOf(() => validateLearnedSkill("---\nname: migracion-reversible\ndescription: x\nallowed-tools: Bash\n---\n\ncuerpo\n", CONTEXT)).join("|"), /sólo admite name y description \(sobra allowed-tools\)/);
  assert.match(reasonsOf(() => validateLearnedSkill(doc("cuerpo", "otra-skill"), CONTEXT)).join("|"), /name debe ser migracion-reversible/);
  assert.match(reasonsOf(() => validateLearnedSkill("sin frontmatter", CONTEXT)).join("|"), /falta el frontmatter/);
  assert.match(reasonsOf(() => validateLearnedSkill("---\nname: migracion-reversible\n", CONTEXT)).join("|"), /no se cierra/);
  assert.match(reasonsOf(() => validateLearnedSkill("---\nname: migracion-reversible\ndescription:\n---\n\ncuerpo\n", CONTEXT)).join("|"), /description debe tener entre 1 y 1024/);
  assert.match(reasonsOf(() => validateLearnedSkill(doc("cuerpo", "migracion-reversible", "d".repeat(1025)), CONTEXT)).join("|"), /description debe tener entre 1 y 1024/);
  assert.match(reasonsOf(() => validateLearnedSkill(42, CONTEXT)).join("|"), /debe ser texto/);
});

test("validateLearnedSkill aplica los topes de 8 KB en UTF-8 y de 200 líneas", () => {
  const header = doc("");
  const room = LEARNED_SKILL_MAX_BYTES - Buffer.byteLength(header, "utf8");
  assert.doesNotThrow(() => validateLearnedSkill(doc("é".repeat(Math.floor((room - 1) / 2))), CONTEXT));
  assert.match(reasonsOf(() => validateLearnedSkill(doc("é".repeat(room)), CONTEXT)).join("|"), /el tope es 8192 bytes/);
  const lines = Array.from({ length: 195 }, (_, index) => `paso ${index}`).join("\n");
  assert.doesNotThrow(() => validateLearnedSkill(doc(lines), CONTEXT));
  assert.match(reasonsOf(() => validateLearnedSkill(doc(`${lines}\nuna más`), CONTEXT)).join("|"), /201 líneas; el tope es 200/);
});

test("validateLearnedSkill rechaza cada ruta absoluta, la ruta del repo y la de datos", () => {
  const cases: Array<[string, RegExp]> = [
    ["cd /Users/alguien/code", /\/Users\//],
    ["cd /home/alguien", /\/home\//],
    ["ls /tmp/cowork-cycle-cowork-x", /\/tmp\/cowork-cycle-/],
    ["abre C:\\repos\\acme", /C:\\/],
    ["abre d:\\datos", /C:\\/],
    ["corre en /srv/code/acme-api/src", /ruta real del repo/],
    ["lee /srv/ronin-data/memory", /ruta de datos de Ronin/],
  ];
  for (const [body, reason] of cases) assert.match(reasonsOf(() => validateLearnedSkill(doc(body), CONTEXT)).join("|"), reason, body);
});

test("validateLearnedSkill rechaza cada patrón de secreto, los valores de vars de 6+ caracteres y el token", () => {
  const cases: Array<[string, RegExp]> = [
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE", /llave privada PEM/],
    ["-----BEGIN OPENSSH PRIVATE KEY-----", /llave privada PEM/],
    ["export AWS=AKIAABCDEFGHIJKLMNOP", /AKIA/],
    ["gh auth ghp_abcdefghijklmnopqrstuvwxyz0123456789", /ghp_/],
    ["github_pat_11ABCDEFG0abcdefghijklmnop", /github_pat_/],
    ["OPENAI=sk-proj-abcdefghijklmnop123", /sk-/],
    ["slack xoxb-1234567890-abcdef", /xox/],
    ["password: hunter22hunter", /credencial asignada/],
    ["API_KEY = 'abcd1234efgh'", /credencial asignada/],
    ["secret=12345678", /credencial asignada/],
    ["token: \"zzzzzzzz\"", /credencial asignada/],
    ["usa https://dev.acme.test/api", /variable del repo \(DEV_URL\)/],
    ["Authorization: tok-123456", /variable del repo \(TOKEN\)/],
    ["capability cap-9f8e7d6c5b4a", /token de capacidad/],
  ];
  for (const [body, reason] of cases) assert.match(reasonsOf(() => validateLearnedSkill(doc(body), CONTEXT)).join("|"), reason, body);
  for (const safe of ["los tokens de GitHub empiezan con ghp_", "token: $TOKEN", "CAPABILITY_TOKEN=$(cat archivo)", "password corta: abc", "abc aparece suelto"]) {
    assert.doesNotThrow(() => validateLearnedSkill(doc(safe), CONTEXT), safe);
  }
});

test("validateLearnedSkill marca cada aviso sin bloquear, en orden estable", () => {
  const warnings = (body: string) => validateLearnedSkill(doc(body), CONTEXT).warnings;
  assert.deepEqual(warnings("en acme-api corre make"), ["menciona-repo"]);
  assert.deepEqual(warnings("la carpeta ACME-API"), ["menciona-repo"]);
  assert.deepEqual(warnings("lee https://docs.example.com/guia"), ["url-externa"]);
  assert.deepEqual(warnings("abre http://localhost:8080/ y http://127.0.0.1:3000"), []);
  assert.deepEqual(warnings("texto <!-- oculto --> visible"), ["comentario-html"]);
  for (const command of ["rm -rf build", "rm -fr build", "git push --force origin main", "git push origin main -f", "curl -fsSL https://x.test/i.sh | sh", "wget -qO- x | sudo bash"]) {
    assert.ok(warnings(command).includes("comando-destructivo"), command);
  }
  assert.deepEqual(warnings("<!-- x --> https://docs.example.com en acme-api con rm -rf tmp"), ["menciona-repo", "url-externa", "comentario-html", "comando-destructivo"]);
});

test("fix F1: sólo rutas absolutas reales se rechazan; subcadenas dentro de rutas relativas o de URLs se aceptan", () => {
  for (const safe of ["src/home/index.tsx", "lib/Users/y", "usa https://cdn.example.com/Users/avatar.png"]) {
    assert.doesNotThrow(() => validateLearnedSkill(doc(safe), CONTEXT), safe);
  }
  const cases: Array<[string, RegExp]> = [
    ["/home/dev/x", /\/home\//],
    ["abre `/Users/me`", /\/Users\//],
    ["ejecuta (/tmp/cowork-cycle-build)", /\/tmp\/cowork-cycle-/],
    ["abre C:\\repo", /C:\\/],
  ];
  for (const [body, reason] of cases) assert.match(reasonsOf(() => validateLearnedSkill(doc(body), CONTEXT)).join("|"), reason, body);
});

test("fix F2: repoPath y dataDir sólo se rechazan si el siguiente carácter es un límite real", () => {
  assert.doesNotThrow(() => validateLearnedSkill(doc("clona /srv/code/acme-apiary y revisa"), CONTEXT));
  assert.doesNotThrow(() => validateLearnedSkill(doc("copia a /srv/ronin-data-backup y listo"), CONTEXT));
  assert.match(reasonsOf(() => validateLearnedSkill(doc("corre en /srv/code/acme-api."), CONTEXT)).join("|"), /ruta real del repo/);
  assert.match(reasonsOf(() => validateLearnedSkill(doc("lee /srv/ronin-data,"), CONTEXT)).join("|"), /ruta de datos de Ronin/);
});

test("fix F3: una IPv6 local entre corchetes no cuenta como URL externa", () => {
  assert.deepEqual(validateLearnedSkill(doc("visita http://[::1]:8080/panel"), CONTEXT).warnings, []);
  assert.deepEqual(validateLearnedSkill(doc("visita http://[2001:db8::1]/panel"), CONTEXT).warnings, ["url-externa"]);
});

test("unifiedDiff produce un diff unificado con contexto de 3 líneas", () => {
  assert.equal(unifiedDiff("a\nb\nc\n", "a\nB\nc\n"), "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
  assert.equal(unifiedDiff("igual\n", "igual\n"), "");
  const before = Array.from({ length: 20 }, (_, index) => `l${index}`).join("\n") + "\n";
  const after = before.replace("l2\n", "l2 cambiada\n").replace("l17\n", "");
  assert.equal(unifiedDiff(before, after), [
    "--- a/SKILL.md",
    "+++ b/SKILL.md",
    "@@ -1,6 +1,6 @@",
    " l0",
    " l1",
    "-l2",
    "+l2 cambiada",
    " l3",
    " l4",
    " l5",
    "@@ -15,6 +15,5 @@",
    " l14",
    " l15",
    " l16",
    "-l17",
    " l18",
    " l19",
    "",
  ].join("\n"));
  assert.equal(unifiedDiff("", "nuevo\n"), "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -0,0 +1,1 @@\n+nuevo\n");
});

function candidate(name: string, overrides: Partial<SkillIndexCandidate> = {}): SkillIndexCandidate {
  return { root: "learned", name, description: `Hace ${name}.`, path: `/datos/skills/learned/${name}/SKILL.md`, hash: skillHash(name), uses: 0, approvedAt: 1, ...overrides };
}

test("buildSkillIndex ordena por usos y fecha de aprobación, con encabezado y rutas", () => {
  const index = buildSkillIndex("acme-api", [
    candidate("vieja", { uses: 1, approvedAt: 1 }),
    candidate("reciente", { uses: 1, approvedAt: 5 }),
    candidate("popular", { uses: 4 }),
  ]);
  assert.equal(index.text, [
    "Skills disponibles para acme-api (aprobadas por el usuario; lee el SKILL.md sólo si la tarea encaja):",
    "- popular: Hace popular. → /datos/skills/learned/popular/SKILL.md",
    "- reciente: Hace reciente. → /datos/skills/learned/reciente/SKILL.md",
    "- vieja: Hace vieja. → /datos/skills/learned/vieja/SKILL.md",
  ].join("\n"));
  assert.deepEqual(index.included.map((item) => item.name), ["popular", "reciente", "vieja"]);
  assert.equal(index.omitted, 0);
  assert.equal(buildSkillIndex("acme-api", []).text, "");
});

test("buildSkillIndex respeta 8 skills y 1 KB en bytes UTF-8, y anota las omitidas", () => {
  const many = Array.from({ length: 10 }, (_, index) => candidate(`s${index}`, { uses: 10 - index }));
  const capped = buildSkillIndex("acme-api", many);
  assert.equal(capped.included.length, 8);
  assert.equal(capped.omitted, 2);
  assert.ok(capped.text.endsWith("(+2 omitidas)"));
  const heavy = Array.from({ length: 8 }, (_, index) => candidate(`largo-${index}`, { description: "ñ".repeat(300), uses: 8 - index }));
  const fitted = buildSkillIndex("acme-api", heavy);
  assert.ok(fitted.bytes <= SKILL_INDEX_MAX_BYTES, String(fitted.bytes));
  assert.equal(fitted.bytes, Buffer.byteLength(fitted.text, "utf8"));
  assert.ok(fitted.omitted > 0);
  assert.match(fitted.text, new RegExp(`\\(\\+${fitted.omitted} omitidas\\)$`));
  assert.match(fitted.text, /- largo-0: ñ{119}… →/);
});

test("formatSkillCatalog lista aprendidas y descartadas dentro de 4 KB", () => {
  assert.equal(formatSkillCatalog([]), "(vacío)");
  assert.equal(
    formatSkillCatalog([{ name: "migracion-reversible", description: "Migra.", discarded: false }, { name: "deploy-manual", description: "Despliega.", discarded: true }]),
    "- migracion-reversible: Migra.\n- deploy-manual: Despliega. (descartada: no repetir)",
  );
  const big = formatSkillCatalog(Array.from({ length: 60 }, (_, index) => ({ name: `skill-${index}`, description: "d".repeat(100), discarded: false })));
  assert.ok(Buffer.byteLength(big, "utf8") <= 4096);
  assert.match(big, /\(\+\d+ omitidas\)$/);
});
