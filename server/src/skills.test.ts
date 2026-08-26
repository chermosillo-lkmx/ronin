import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { archiveSkill, createSkill, parseSkillDocument, readSkill } from "./skills.js";

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
