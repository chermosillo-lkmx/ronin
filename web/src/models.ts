/**
 * Lista curada de modelos Claude para los selectores de la UI (Planner / Worker).
 * Fuente única: la consumen el modal de Lanzar y el editor de repo.
 *
 * `value` es exactamente el string que se manda al backend (`--model` / `/model`);
 * `""` significa "hereda el default" (del repo o global), igual que antes. Se prefieren
 * los alias porque es lo que el CLI de Claude consume nativamente y siguen al modelo más
 * reciente; los IDs fijos quedan para pinear una versión concreta.
 */

export interface ModelOption {
  value: string;
  label: string;
}

export interface ModelGroup {
  label: string;
  options: ModelOption[];
}

/** Primera opción: vacío = hereda el default. */
export const MODEL_INHERIT: ModelOption = { value: "", label: "default (hereda)" };

export const MODEL_GROUPS: ModelGroup[] = [
  {
    label: "Alias (recomendado)",
    options: [
      { value: "opus", label: "Opus 4.8 · opus" },
      { value: "sonnet", label: "Sonnet 5 · sonnet" },
      { value: "haiku", label: "Haiku 4.5 · haiku" },
      { value: "fable", label: "Fable 5 · fable" },
    ],
  },
  {
    label: "IDs fijos",
    options: [
      { value: "claude-opus-4-8", label: "Opus 4.8 · claude-opus-4-8" },
      { value: "claude-sonnet-5", label: "Sonnet 5 · claude-sonnet-5" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 · claude-haiku-4-5-20251001" },
      { value: "claude-fable-5", label: "Fable 5 · claude-fable-5" },
    ],
  },
];

/** Todos los valores conocidos (incluye `""`), para detectar valores fuera de lista. */
export function isKnownModel(value: string): boolean {
  if (value === MODEL_INHERIT.value) return true;
  return MODEL_GROUPS.some((g) => g.options.some((o) => o.value === value));
}
