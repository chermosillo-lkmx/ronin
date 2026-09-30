import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DATA_DIR } from "./data-dir.js";
import { archiveSkill, createSkill, learnedSkillsRoot, listSkills, parseSkillDocument, readSkill, skillFilePath, updateSkill } from "./skills.js";

const root = mkdtempSync(join(tmpdir(), "cowork-skills-"));
const prior = process.env.COWORK_SKILLS_ROOT;
process.env.COWORK_SKILLS_ROOT = root;
test.after(() => { rmSync(root, { recursive: true, force: true }); process.env.COWORK_SKILLS_ROOT = prior; });
const valid = "---\nname: api-review\ndescription: Review APIs\n---\n\nUse tests.\n";

test("skills require name and description frontmatter", () => {
  assert.throws(() => parseSkillDocument("---\nname: api-review\n---\n", "api-review"), /description/);
  assert.throws(() => parseSkillDocument("---\ndescription: x\n---\n", "api-review"), /name/);
});

test("skills create and read a valid local SKILL.md", () => {
  const created = createSkill({ root: "global", name: "api-review" }, valid);
  assert.equal(created.description, "Review APIs");
  assert.equal(readSkill({ root: "global", name: "api-review" }).name, "api-review");
});

test("skills package only the validated local tree as ZIP", async () => {
  const archive = await archiveSkill({ root: "global", name: "api-review" });
  assert.equal(archive.filename, "api-review.zip");
  assert.ok(archive.bytes.length > 20);
});

test("skills reject a directory symlink that escapes its root", () => {
  const outside = mkdtempSync(join(tmpdir(), "cowork-outside-"));
  try {
    mkdirSync(join(root, "escape"), { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), valid);
    rmSync(join(root, "escape"), { recursive: true, force: true });
    symlinkSync(outside, join(root, "escape"));
    assert.throws(() => readSkill({ root: "global", name: "escape" }), /abandona/);
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

function withLearnedRoot(fn: (learned: string) => void): void {
  const learned = mkdtempSync(join(tmpdir(), "cowork-learned-"));
  const previous = process.env.COWORK_LEARNED_SKILLS_ROOT;
  process.env.COWORK_LEARNED_SKILLS_ROOT = learned;
  try {
    fn(learned);
  } finally {
    if (previous === undefined) delete process.env.COWORK_LEARNED_SKILLS_ROOT;
    else process.env.COWORK_LEARNED_SKILLS_ROOT = previous;
    rmSync(learned, { recursive: true, force: true });
  }
}

test("learnedSkillsRoot usa COWORK_LEARNED_SKILLS_ROOT o <dataDir>/skills/learned", () => {
  withLearnedRoot((learned) => assert.equal(learnedSkillsRoot(), learned));
  const previous = process.env.COWORK_LEARNED_SKILLS_ROOT;
  delete process.env.COWORK_LEARNED_SKILLS_ROOT;
  try {
    assert.equal(learnedSkillsRoot(), join(DATA_DIR, "skills", "learned"));
  } finally {
    if (previous !== undefined) process.env.COWORK_LEARNED_SKILLS_ROOT = previous;
  }
});

test("la raíz learned se lista y se lee sin sourceRepo, y da la ruta real de su SKILL.md", () => {
  withLearnedRoot((learned) => {
    mkdirSync(join(learned, "migracion-reversible"));
    writeFileSync(join(learned, "migracion-reversible", "SKILL.md"), "---\nname: migracion-reversible\ndescription: Migra y prueba.\n---\n\nPasos.\n");
    assert.deepEqual(listSkills([]).filter((skill) => skill.ref.root === "learned"), [
      { ref: { root: "learned", name: "migracion-reversible" }, name: "migracion-reversible", description: "Migra y prueba.", valid: true },
    ]);
    assert.deepEqual(readSkill({ root: "learned", name: "migracion-reversible", sourceRepo: "acme-api" }).ref, { root: "learned", name: "migracion-reversible" });
    assert.equal(skillFilePath({ root: "learned", name: "migracion-reversible" }), join(realpathSync(learned), "migracion-reversible", "SKILL.md"));
    assert.throws(() => skillFilePath({ root: "learned", name: "no-existe" }), /la skill no existe/);
  });
});

test("skillFilePath lanza si la skill existe pero le falta SKILL.md", () => {
  withLearnedRoot((learned) => {
    mkdirSync(join(learned, "sin-skill"));
    assert.throws(() => skillFilePath({ root: "learned", name: "sin-skill" }), /SKILL\.md/);
  });
});

test("skillFilePath lanza si SKILL.md es un symlink que escapa su raíz", () => {
  withLearnedRoot((learned) => {
    const outside = mkdtempSync(join(tmpdir(), "cowork-outside-"));
    try {
      mkdirSync(join(learned, "con-symlink"));
      writeFileSync(join(outside, "SKILL.md"), valid);
      symlinkSync(join(outside, "SKILL.md"), join(learned, "con-symlink", "SKILL.md"));
      assert.throws(() => skillFilePath({ root: "learned", name: "con-symlink" }), /abandona/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("una skill learned no se crea ni se edita por el camino genérico", () => {
  withLearnedRoot((learned) => {
    mkdirSync(join(learned, "migracion-reversible"));
    writeFileSync(join(learned, "migracion-reversible", "SKILL.md"), "---\nname: migracion-reversible\ndescription: Migra.\n---\n");
    assert.throws(() => createSkill({ root: "learned", name: "otra" }, "---\nname: otra\ndescription: x\n---\n"), /propuesta aprobada/);
    assert.throws(() => updateSkill({ root: "learned", name: "migracion-reversible" }, "---\nname: migracion-reversible\ndescription: x\n---\n"), /store de skills aprendidas/);
  });
});
