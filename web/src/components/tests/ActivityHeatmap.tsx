import type { HeatCell, HeatRow } from "./heatmap";

interface ActivityHeatmapProps {
  rows: HeatRow[];
  months: { label: string; days: number }[];
}

const statusLabel: Record<HeatCell["status"], string> = {
  none: "sin corridas",
  passed: "pasó",
  failed: "falló",
  error: "error",
};

function cellClass(cell: HeatCell): string {
  if (cell.status !== "passed") return `ron-tests-heat-cell ${cell.status}`;
  return `ron-tests-heat-cell passed level-${Math.min(cell.count, 4)}`;
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "corrida" : "corridas"}`;
}

export function ActivityHeatmap({ rows, months }: ActivityHeatmapProps) {
  const days = rows[0]?.cells.length ?? months.reduce((total, month) => total + month.days, 0);
  const gridStyle = { gridTemplateColumns: `repeat(${days}, 9px)` };

  return (
    <section className="card elev-sm ron-tests-heatmap" aria-label="Actividad por repositorio">
      <div className="ron-tests-heat-head">
        <div className="ron-tests-heat-title">
          <h3>Actividad por repositorio</h3>
          <span>Últimos {days} días · una celda por día</span>
        </div>
        <div className="ron-tests-heat-status-legend" aria-label="Clave de resultado">
          <span><i className="ron-tests-heat-key passed" />pasó</span>
          <span><i className="ron-tests-heat-key failed" />falló</span>
          <span><i className="ron-tests-heat-key error" />error</span>
        </div>
      </div>

      <div className="ron-tests-heat-month-row" aria-hidden="true">
        <span />
        <div className="ron-tests-heat-months" style={gridStyle}>
          {months.map((month, index) => <span key={`${month.label}-${index}`} style={{ gridColumn: `span ${month.days}` }}>{month.label}</span>)}
        </div>
        <span />
      </div>

      <div className="ron-tests-heat-rows">
        {rows.map((row) => {
          const emptyCells = row.cells.filter((cell) => cell.status === "none").length;
          return (
            <div className="ron-tests-heat-row" data-repo={row.repo} data-empty-cells={emptyCells} key={row.repo}>
              <span className={`ron-tests-heat-repo${row.configured ? "" : " unconfigured"}`} title={row.repo}>{row.repo}</span>
              <span className="ron-tests-heat-cells" style={gridStyle}>
                {row.cells.map((cell) => (
                  <i className={cellClass(cell)} key={cell.date} title={`${cell.date} · ${countLabel(cell.count)} · ${statusLabel[cell.status]}`} />
                ))}
              </span>
              <span className="ron-tests-heat-total">{countLabel(row.total)}</span>
            </div>
          );
        })}
      </div>

      <div className="ron-tests-heat-footer">
        <span>La intensidad es el número de corridas del día; el tono, el peor resultado.</span>
        <span className="ron-tests-heat-intensity" aria-label="Intensidad de corridas">
          <b>Menos</b>
          <i className="ron-tests-heat-key none" />
          <i className="ron-tests-heat-key passed level-1" />
          <i className="ron-tests-heat-key passed level-2" />
          <i className="ron-tests-heat-key passed level-3" />
          <i className="ron-tests-heat-key passed level-4" />
          <b>Más</b>
        </span>
      </div>
    </section>
  );
}
