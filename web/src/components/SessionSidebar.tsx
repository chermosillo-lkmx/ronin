import type { ReactNode } from "react";
import type { TmuxSessionInfo } from "../types";

/**
 * Lista de sesiones en dos grupos, como el mockup: las gestionadas por Ronin arriba y las ajenas
 * al operador abajo. La separación no es cosmética — una sesión ajena NO recibe escritura hasta
 * que se adopte (F2), y agruparlas es lo que hace visible esa frontera antes de que exista un
 * botón capaz de cruzarla por error.
 */
export function SessionSidebar({
  sessions,
  selected,
  onSelect,
  filter,
  onFilter,
}: {
  sessions: TmuxSessionInfo[];
  selected: string | null;
  onSelect: (name: string) => void;
  filter: string;
  onFilter: (v: string) => void;
}) {
  const q = filter.trim().toLowerCase();
  const shown = q ? sessions.filter((s) => s.name.toLowerCase().includes(q)) : sessions;
  const managed = shown.filter((s) => s.kind === "managed");
  const foreign = shown.filter((s) => s.kind === "foreign");

  return (
    <aside className="ron-side">
      <div className="ron-side-filter">
        <input
          className="input"
          placeholder="Filtrar sesiones…"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
        />
      </div>

      <Group title={`gestionadas por Ronin · ${managed.length}`}>
        {managed.map((s) => (
          <Row key={s.name} s={s} active={s.name === selected} onClick={() => onSelect(s.name)} />
        ))}
        {managed.length === 0 && <div className="ron-group-empty">ninguna</div>}
      </Group>

      <Group title={`ajenas a Ronin · ${foreign.length}`}>
        {foreign.map((s) => (
          <Row key={s.name} s={s} active={s.name === selected} onClick={() => onSelect(s.name)} />
        ))}
        {foreign.length === 0 && <div className="ron-group-empty">ninguna</div>}
      </Group>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ron-group">
      <div className="ron-group-title">{title}</div>
      {children}
    </div>
  );
}

function Row({ s, active, onClick }: { s: TmuxSessionInfo; active: boolean; onClick: () => void }) {
  return (
    <button className={`ron-row ${active ? "on" : ""}`} onClick={onClick}>
      <div className="ron-row-name">{s.name}</div>
      <div className="ron-row-meta">
        {s.panes.length} pane(s)
        {s.attached ? " · adjunta" : ""}
      </div>
    </button>
  );
}
