import { useCallback, useEffect, useState } from "react";
import { createLocalSkill, downloadLocalSkill, getRepoConfig, getRepos, listLocalSkills, listSkillProposals, readLocalSkill, saveLocalSkill, saveRepoSkillAssociations } from "../../api";
import type { SkillDocument, SkillProposalSummary, SkillRef, SkillSummary } from "../../types";
import { SkillProposalsPanel } from "./SkillProposals";

export type SkillsTab = "skills" | "proposals";

/** "learned · v2 · 4 usos" para las aprendidas; la raíz para el resto. */
export function skillMetaLabel(skill: SkillSummary): string {
  if (skill.ref.root !== "learned") return skill.ref.root;
  const parts = ["learned"];
  if (skill.version) parts.push(`v${skill.version}`);
  if (skill.uses !== undefined) parts.push(`${skill.uses} ${skill.uses === 1 ? "uso" : "usos"}`);
  return parts.join(" · ");
}

export function SkillListItem({ skill, selected, onSelect }: { skill: SkillSummary; selected: boolean; onSelect: () => void }) {
  return <button className={selected ? "selected" : ""} onClick={onSelect}>
    <strong>{skill.name}{skill.integrity === "modified" && <b className="ronin-skill-review" title="Modificada fuera de Ronin: no entra al índice hasta reaprobarla">⚠ Revisar</b>}</strong>
    <span>{skillMetaLabel(skill)}</span>
    <small className={skill.valid ? "ok" : "bad"}>{skill.valid ? skill.description : skill.error}</small>
  </button>;
}

export function SkillsTabs({ tab, count, onTab }: { tab: SkillsTab; count: number; onTab: (tab: SkillsTab) => void }) {
  return <div className="ron-skills-tabs" role="tablist">
    <button type="button" role="tab" aria-selected={tab === "skills"} className={tab === "skills" ? "on" : ""} onClick={() => onTab("skills")}>Skills</button>
    <button type="button" role="tab" aria-selected={tab === "proposals"} className={tab === "proposals" ? "on" : ""} onClick={() => onTab("proposals")}>{`Propuestas (${count})`}</button>
  </div>;
}

function refKey(ref: SkillRef) { return `${ref.root}:${ref.sourceRepo ?? ""}:${ref.name}`; }
export function SkillsContext() { return <div className="ronin-context-head"><span className="ronin-eyebrow">skills</span><h2>SKILL.md locales</h2><p className="ronin-context-copy">Explora, valida y asocia skills por repositorio.</p></div>; }
export function SkillsWorkspace({ initialTab = "skills", initialProposals }: { initialTab?: SkillsTab; initialProposals?: SkillProposalSummary[] }) {
  const [tab, setTab] = useState<SkillsTab>(initialTab); const [proposalCount, setProposalCount] = useState(initialProposals?.length ?? 0);
  useEffect(() => { if (!initialProposals) void listSkillProposals().then((items) => setProposalCount(items.length)); }, []);
  const [skills, setSkills] = useState<SkillSummary[]>([]); const [selected, setSelected] = useState<SkillSummary | null>(null); const [skillDocument, setDocument] = useState<SkillDocument | null>(null); const [content, setContent] = useState(""); const [repos, setRepos] = useState<string[]>([]); const [repo, setRepo] = useState("monorepo"); const [active, setActive] = useState<SkillRef[]>([]); const [newName, setNewName] = useState(""); const [description, setDescription] = useState(""); const [creating, setCreating] = useState(false); const [note, setNote] = useState<string | null>(null);
  const reload = useCallback(async () => setSkills(await listLocalSkills()), []); useEffect(() => { void reload(); void getRepos().then((items) => { setRepos(items); setRepo(items[0] ?? "monorepo"); }); }, [reload]); useEffect(() => { if (repo) void getRepoConfig(repo).then((c) => setActive(c?.skills ?? [])); }, [repo]);
  async function choose(skill: SkillSummary) { setSelected(skill); setDocument(null); try { const next = await readLocalSkill(skill.ref); setDocument(next); setContent(next.content); } catch (e) { setNote((e as Error).message); } }
  async function save() { if (!selected) return; try { setDocument(await saveLocalSkill(selected.ref, content)); setNote("SKILL.md guardado."); const refreshed = await listLocalSkills(); setSkills(refreshed); setSelected(refreshed.find((item) => refKey(item.ref) === refKey(selected.ref)) ?? selected); } catch (e) { setNote((e as Error).message); } }
  async function toggle(ref: SkillRef, on: boolean) { const next = on ? [...active, ref] : active.filter((x) => refKey(x) !== refKey(ref)); try { setActive((await saveRepoSkillAssociations(repo, next)).skills); } catch (e) { setNote((e as Error).message); } }
  async function create() { if (!newName.trim() || !description.trim()) return setNote("Nombre y descripción son obligatorios."); try { const next = await createLocalSkill({ root: "global", name: newName.trim() }, `---\nname: ${newName.trim()}\ndescription: ${description.trim()}\n---\n\n# ${newName.trim()}\n\nDescribe aquí cuándo usar esta skill.\n`); setCreating(false); await reload(); await choose({ ref: next.ref, name: next.name, description: next.description, valid: true }); } catch (e) { setNote((e as Error).message); } }
  async function zip() { if (!selected) return; try { const blob = await downloadLocalSkill(selected.ref); const href = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = href; a.download = `${selected.name}.zip`; a.click(); URL.revokeObjectURL(href); } catch (e) { setNote((e as Error).message); } }
  return <div className="ronin-skills-workspace"><header className="ronin-view-header"><div><h1>Skills</h1><p>SKILL.md locales · validación de frontmatter</p></div><div className="ronin-header-actions"><button disabled={!selected} onClick={() => void zip()}>Empaquetar ZIP</button><button onClick={() => setCreating(true)}>+ Nueva skill</button></div></header><SkillsTabs tab={tab} count={proposalCount} onTab={setTab} />{tab === "proposals" ? <SkillProposalsPanel initial={initialProposals} onCount={setProposalCount} /> : <><div className="ronin-skills-body"><aside className="ronin-skill-list">{skills.map((skill) => <SkillListItem key={refKey(skill.ref)} skill={skill} selected={Boolean(selected && refKey(selected.ref) === refKey(skill.ref))} onSelect={() => void choose(skill)} />)}</aside><section className="ronin-skill-editor">{selected ? <><header><span className="ronin-eyebrow">{selected.ref.root}</span><h2>{selected.name}</h2></header><textarea value={content} onChange={(e) => setContent(e.target.value)} disabled={!skillDocument} /><footer><span>{note}</span>{selected.integrity === "modified" && <small className="ronin-skill-review-note">Modificada fuera de Ronin: no entra al índice hasta que la guardes aquí (pasa por las mismas reglas).</small>}<button disabled={!skillDocument} onClick={() => void save()}>{selected.integrity === "modified" ? "Guardar y reaprobar" : "Guardar"}</button></footer></> : <div className="ronin-empty-workspace"><span>SKILL.md</span><h1>Selecciona una skill</h1></div>}</section></div><section className="ronin-associations"><div><span className="ronin-eyebrow">activación por repo</span><select value={repo} onChange={(e) => setRepo(e.target.value)}>{repos.map((x) => <option key={x}>{x}</option>)}</select></div><div className="ronin-association-list">{skills.filter((x) => x.valid).map((skill) => <label key={refKey(skill.ref)}><input type="checkbox" checked={active.some((x) => refKey(x) === refKey(skill.ref))} onChange={(e) => void toggle(skill.ref, e.target.checked)} />{skill.name}</label>)}</div></section></>}{creating && <div className="ronin-inline-modal"><div><h2>Nueva skill</h2><label>Nombre<input value={newName} onChange={(e) => setNewName(e.target.value)} /></label><label>Descripción<input value={description} onChange={(e) => setDescription(e.target.value)} /></label><footer><button onClick={() => setCreating(false)}>Cancelar</button><button onClick={() => void create()}>Crear</button></footer></div></div>}</div>;
}
export function SkillsInspector() { return <div className="ronin-inspector-inner"><span className="ronin-eyebrow">skills</span><h2>Asociaciones</h2><p>Las skills asociadas a un repo entran como índice (nombre, descripción y ruta, nunca el cuerpo) en cada sesión nueva de ese repo. Una aprendida modificada fuera de Ronin no entra hasta reaprobarla.</p><span className="ronin-inspector-status managed">◆ Índice en el lanzamiento (1 KB)</span></div>; }
