import { randomBytes, randomInt } from "node:crypto";
import { deriveSessionName } from "../mcp-session-port.js";
import { McpToolError, type McpSessionPort, type McpSessionStatus } from "../mcp-sessions.js";
import type { ReportKind, ReportMeta } from "../reports.js";
import { SessionLaunchError, type ManagedSessionLaunchInput, type SessionLaunchErrorCode } from "../session-launch.js";
import { isSafeSessionName } from "../session-name.js";
import type { InlineButton, Update } from "./api.js";
import { authorizeUpdate } from "./authorize.js";
import { draftCommentReply } from "./comment.js";
import { interpretMessage, wrapThirdParty, type Intent, type InterpretCatalog } from "./interpret.js";
import { redactSecrets, type Outbound } from "./outbound.js";
import type { CommentDraft, Proposal, SentQuestion, TelegramState, TelegramStore } from "./store.js";

export const PROPOSAL_TTL_MS = 60 * 60 * 1000;
/** Un aviso de fin de sesión puede tocarse días después; pasado esto, su botón deja de servir. */
export const SUMMARY_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 8 * 1024;
/** Por encima, el texto va por `sendLong` y los botones en un mensaje aparte. */
const MAX_INLINE_CHARS = 3800;
const MAX_BUTTON_LABEL_CHARS = 60;
const MAX_LISTED_REPORTS = 10;
const MAX_LOGGED_ERROR_CHARS = 200;
/** La instrucción de 🔨 Convertir es fija: el nombre de la sesión nunca sale del comentario de un tercero. */
const CONVERT_INSTRUCTION = "Atiende el comentario de terceros adjunto.";

const NOTICE = {
  general: "Esto no es el tema de un repo. Escribe tu orden en el tema del repo; aquí solo funcionan /reporte diario, /reporte semanal, /reportes y /estado.",
  expired: "Esa propuesta caducó o ya no está vigente. Escribe la orden de nuevo.",
  invalidButton: "Ese botón ya no es válido.",
  noWorkflows: "No hay workflows en el catálogo, así que no puedo proponer una sesión.",
  tooLong: "La petición supera 8 KB con el texto de terceros, así que no cabe. Recórtala y envíala de nuevo.",
  interpretFailed: "No pude interpretar tu mensaje con Claude. Revisa que claude esté disponible en la Mac e intenta de nuevo.",
  notUnderstood: "No entendí el mensaje. Reformúlalo o di qué hacer en el repo.",
  draftFailed: "No pude redactar la respuesta. Intenta de nuevo.",
  adjustFailed: "No pude redactar el ajuste. Responde otra vez a la solicitud para reintentar.",
  busy: "Eso ya se está procesando; no apliqué este mensaje.",
  alreadyAnswered: "Esa pregunta ya tiene una respuesta; no entregué esto.",
  summaryGone: "Ese resumen ya no está disponible.",
  reportUsage: "Usa /reporte diario, /reporte semanal o /reporte <nombre> de la lista de /reportes.",
  reportNotFound: "No encontré ese reporte. Revisa los nombres con /reportes.",
  reportListFailed: "No pude leer la lista de reportes.",
  noReports: "Aún no hay reportes.",
  statusFailed: "No pude leer el estado de las sesiones.",
  noSessions: "No hay sesiones seguidas por Telegram.",
  catchAll: "Algo falló al procesar eso. Intenta de nuevo.",
} as const;

const LAUNCH_NOTICE: Partial<Record<SessionLaunchErrorCode, string>> = {
  REPO_UNKNOWN: "Ese repo ya no está configurado en Ronin.",
  REPO_UNAVAILABLE: "No encontré la carpeta del repo en esta Mac.",
  WORKFLOW_NOT_FOUND: "Ese workflow ya no existe en el catálogo.",
  SESSION_ALREADY_EXISTS: "Ya existe una sesión con ese nombre.",
  BASE_BRANCH_UNRESOLVED: "No pude resolver la rama base del repo.",
};

const REPORT_KINDS: Record<string, { kind: ReportKind; label: string }> = {
  diario: { kind: "daily", label: "diario" },
  semanal: { kind: "weekly", label: "semanal" },
};

export interface ReportsPort {
  generate(kind: ReportKind): Promise<{ name: string; markdown: string }>;
  list(): ReportMeta[];
  read(name: string): { markdown: string } | null;
}

type DraftInput = { repo: string; comment: string; guidance?: string; previous?: string };

export interface ConversationDeps {
  store: TelegramStore;
  outbound: Outbound;
  /** Solo detiene el indicador del botón: nunca lleva texto, los avisos van por `outbound`. */
  answerCallback(callbackId: string): Promise<void>;
  port: Pick<McpSessionPort, "catalog" | "reply">;
  launch(input: ManagedSessionLaunchInput): Promise<{ name: string }>;
  reports: ReportsPort;
  status(): Promise<McpSessionStatus[]>;
  isFollowed(name: string): boolean;
  summaryFor(session: string): string | null;
  /** Token del bot, capability y `vars`: redacción de borradores y de lo que se registra. */
  secrets: () => string[];
  interpret?: (text: string, catalog: InterpretCatalog) => Promise<Intent>;
  draftComment?: (input: DraftInput) => Promise<string>;
  now(): number;
  log(message: string): void;
}

/** A dónde va cada aviso: siempre el tema del que vino el update. */
interface Place {
  chatId: number;
  threadId?: number;
}

type NewProposal = Pick<Proposal, "repo" | "instruction" | "thirdParty" | "workflowId" | "workflowName" | "workflowChoices">;
type Claim<T> = { status: "ok"; item: T } | { status: "gone" } | { status: "busy" };
type Claimable = { claimed?: boolean; createdAt?: unknown };

const newId = (): string => randomBytes(6).toString("hex");
const sessionSuffix = (): string => randomInt(36 ** 4).toString(36).padStart(4, "0");
/** Corta sin dejar medio par sustituto, que Telegram rechazaría. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "")}…`;
const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

function buildRequest(p: Pick<Proposal, "instruction" | "thirdParty">): string {
  return p.thirdParty ? `${p.instruction}\n\n${wrapThirdParty(p.thirdParty)}` : p.instruction;
}

/** Todo lo que recibirá el agente: el ✅ aprueba lo que César vio, nunca una parte. */
function previewText(p: NewProposal): string {
  const lines = [`Repo: ${p.repo}`, `Workflow: ${p.workflowName ?? "elige uno con los botones"}`, "", "Petición:", p.instruction];
  if (p.thirdParty) lines.push("", "Texto de terceros adjunto como datos:", p.thirdParty);
  return lines.join("\n");
}

/** Crea o renueva la clave del botón "Ver resumen" de una sesión. La usa el aviso de fin de sesión. */
export function summaryButton(store: TelegramStore, session: string, now: number): InlineButton {
  let key = "";
  store.updateState((state) => {
    for (const [id, item] of Object.entries(state.summaries)) {
      if (!(now - Number(item.createdAt) <= SUMMARY_KEY_TTL_MS)) delete state.summaries[id];
    }
    const existing = Object.entries(state.summaries).find(([, item]) => item.session === session);
    if (existing) {
      key = existing[0];
      existing[1].createdAt = now;
    } else {
      key = newId();
      state.summaries[key] = { session, createdAt: now };
    }
  });
  return { text: "Ver resumen", data: `r:${key}` };
}

function proposalKeyboard(p: Pick<Proposal, "id" | "workflowId" | "workflowChoices">): InlineButton[][] {
  const edit = { text: "✏️ Editar", data: `p:${p.id}:edit` };
  const cancel = { text: "❌ Cancelar", data: `p:${p.id}:no` };
  if (p.workflowId) return [[{ text: "✅ Lanzar", data: `p:${p.id}:go` }, edit, cancel]];
  return [
    ...(p.workflowChoices ?? []).map((w, index) => [{ text: clip(w.name, MAX_BUTTON_LABEL_CHARS), data: `w:${p.id}:${index}` }]),
    [edit, cancel],
  ];
}

function draftKeyboard(id: string): InlineButton[][] {
  return [[{ text: "✏️ Ajustar", data: `c:${id}:adjust` }, { text: "🔨 Convertir en sesión", data: `c:${id}:convert` }]];
}

function statusLine(s: McpSessionStatus): string {
  const workflow = s.workflow ? `${s.workflow}, ${s.stage ?? "sin etapa"} (${s.stagesDone}/${s.stagesTotal})` : "sin workflow";
  return `• ${s.name}: ${workflow}${s.needsInput ? " · espera respuesta" : ""}${s.gate?.state === "failed" ? " · gate fallido" : ""}`;
}

/**
 * Decide qué llega a un agente y qué lanza una sesión. Reglas: solo el botón `q:` y Responder
 * sobre una pregunta guardada llaman `reply`; solo `p:…:go` llama `launch`, nunca `w:…`.
 * El servicio despacha sin esperar, así que todo reclamo se hace con `updateState` antes del
 * primer `await`, y ningún `e.message` llega a Telegram: puede traer stderr.
 */
export function createConversation(deps: ConversationDeps): { handle(update: Update): Promise<void> } {
  const { store, outbound } = deps;
  const interpret = deps.interpret ?? ((text, catalog) => interpretMessage(text, catalog));
  const draftComment = deps.draftComment ?? ((input) => draftCommentReply(input, { secrets: deps.secrets }));
  const reportsInFlight = new Set<ReportKind>();

  function log(message: string): void {
    try {
      deps.log(message);
    } catch {
      // Un registro roto no puede tumbar el manejo de un update.
    }
  }

  function logFailure(where: string, error: unknown): void {
    let detail = "sin detalle";
    try {
      detail = clip(redactSecrets(error instanceof Error ? error.message : String(error), deps.secrets()), MAX_LOGGED_ERROR_CHARS);
    } catch {
      // Sin secretos a la mano no se registra el mensaje.
    }
    log(`telegram: fallo en ${where}: ${detail}`);
  }

  async function notify(place: Place, text: string): Promise<void> {
    try {
      await outbound.send({ ...place, text });
    } catch (error) {
      logFailure("envío de aviso", error);
    }
  }

  // ─── Reclamos: síncronos, antes de cualquier await ────────────────────────

  const expired = (item: Claimable, ttl = PROPOSAL_TTL_MS): boolean => !(deps.now() - Number(item.createdAt) <= ttl);

  function claim<K extends "proposals" | "drafts" | "questions" | "summaries">(kind: K, id: string): Claim<TelegramState[K][string]> {
    let result: Claim<TelegramState[K][string]> = { status: "gone" };
    store.updateState((state) => {
      const items = state[kind] as unknown as Record<string, TelegramState[K][string] & Claimable>;
      const item = own(items, id);
      if (!item) return;
      if (kind !== "questions" && expired(item, kind === "summaries" ? SUMMARY_KEY_TTL_MS : PROPOSAL_TTL_MS)) {
        delete items[id];
      } else if (item.claimed) {
        result = { status: "busy" };
      } else {
        item.claimed = true;
        result = { status: "ok", item: { ...item } };
      }
    });
    return result;
  }

  function release(kind: "proposals" | "drafts" | "questions" | "summaries", id: string): void {
    store.updateState((state) => {
      const item = own(state[kind] as Record<string, Claimable>, id);
      if (item) delete item.claimed;
    });
  }

  function remove(kind: "proposals" | "drafts", id: string): void {
    store.updateState((state) => { delete state[kind][id]; });
  }

  // ─── Propuestas ───────────────────────────────────────────────────────────

  /** Guarda y muestra la propuesta. Con `replaces`, la anterior deja de existir y sus botones mueren. */
  async function createProposal(fields: NewProposal, place: Place, replaces?: string): Promise<boolean> {
    if (Buffer.byteLength(buildRequest(fields), "utf8") > MAX_REQUEST_BYTES) {
      await notify(place, NOTICE.tooLong);
      return false;
    }
    const proposal: Proposal = { ...fields, id: newId(), createdAt: deps.now() };
    store.updateState((state) => {
      if (replaces) delete state.proposals[replaces];
      for (const [id, item] of Object.entries(state.proposals)) if (expired(item)) delete state.proposals[id];
      for (const [id, item] of Object.entries(state.drafts)) if (expired(item)) delete state.drafts[id];
      state.proposals[proposal.id] = proposal;
    });
    const preview = previewText(proposal);
    const keyboard = proposalKeyboard(proposal);
    if (preview.length <= MAX_INLINE_CHARS) {
      await outbound.send({ ...place, text: preview, keyboard });
      return true;
    }
    // Si esto falla no salen los botones: nada se aprueba sin haberse mostrado completo.
    await outbound.sendLong({ ...place, title: "Propuesta de sesión", text: preview });
    await outbound.send({ ...place, text: proposal.workflowId ? "¿Lanzo la propuesta de arriba?" : "Elige el workflow de la propuesta de arriba:", keyboard });
    return true;
  }

  /** La misma propuesta, con los cambios: su id nuevo deja sin efecto los botones ya mostrados. */
  function successor(p: Proposal, changes: Partial<NewProposal>): NewProposal {
    const { repo, instruction, thirdParty, workflowId, workflowName, workflowChoices } = p;
    return {
      repo, instruction,
      ...(thirdParty ? { thirdParty } : {}),
      ...(workflowId ? { workflowId } : {}),
      ...(workflowName ? { workflowName } : {}),
      ...(workflowChoices ? { workflowChoices } : {}),
      ...changes,
    };
  }

  /** Propuesta sin workflow elegido: congela las opciones que se muestran. */
  function withWorkflowChoices(fields: NewProposal, workflows: Array<{ id: string; name: string }>): NewProposal {
    return { ...fields, workflowChoices: workflows.map(({ id, name }) => ({ id, name })) };
  }

  async function launchProposal(proposal: Proposal, workflowId: string, place: Place): Promise<void> {
    const name = `${deriveSessionName(proposal.instruction, deps.now())}-${sessionSuffix()}`;
    let launched: { name: string };
    try {
      launched = await deps.launch({
        repo: proposal.repo, workflowId, name, mode: "workflow", request: buildRequest(proposal), channel: "telegram",
      });
    } catch (error) {
      logFailure("lanzamiento", error);
      release("proposals", proposal.id);
      const specific = error instanceof SessionLaunchError ? LAUNCH_NOTICE[error.code] : undefined;
      await notify(place, `No pude lanzar la sesión.${specific ? ` ${specific}` : ""} Puedes tocar ✅ otra vez.`);
      return;
    }
    remove("proposals", proposal.id);
    await notify(place, `Sesión ${launched.name} lanzada.`);
  }

  /** Pide una redacción con Responder. La propuesta o el borrador siguen vigentes mientras tanto. */
  async function askForEdit(kind: "proposals" | "drafts", item: Proposal | CommentDraft, prompt: string, place: Place): Promise<void> {
    if (item.editMessageId !== undefined) {
      release(kind, item.id);
      return;
    }
    try {
      const sent = await outbound.send({ ...place, text: prompt, forceReply: true });
      store.updateState((state) => {
        const current = own(state[kind] as Record<string, Proposal | CommentDraft>, item.id);
        if (current) current.editMessageId = sent.message_id;
      });
    } finally {
      release(kind, item.id);
    }
  }

  async function onProposalTap(id: string, action: string | undefined, place: Place): Promise<void> {
    if (action !== "go" && action !== "edit" && action !== "no") return notify(place, NOTICE.invalidButton);
    const claimed = claim("proposals", id);
    if (claimed.status === "gone") return notify(place, NOTICE.expired);
    if (claimed.status === "busy") return;
    const proposal = claimed.item;
    if (action === "no") {
      remove("proposals", id);
      return notify(place, "Propuesta cancelada.");
    }
    if (action === "edit") return askForEdit("proposals", proposal, "Responde a este mensaje con la nueva redacción de la petición.", place);
    if (proposal.workflowId) return launchProposal(proposal, proposal.workflowId, place);
    release("proposals", id);
    await outbound.send({ ...place, text: "Falta elegir el workflow.", keyboard: proposalKeyboard(proposal) });
  }

  async function onWorkflowTap(id: string, rawIndex: string | undefined, place: Place): Promise<void> {
    const claimed = claim("proposals", id);
    if (claimed.status === "gone") return notify(place, NOTICE.expired);
    if (claimed.status === "busy") return;
    const choice = /^\d+$/.test(rawIndex ?? "") ? claimed.item.workflowChoices?.[Number(rawIndex)] : undefined;
    if (!choice) {
      release("proposals", id);
      return notify(place, NOTICE.invalidButton);
    }
    // Elegir no aprueba: solo ✅ lanza, y ahora la propuesta muestra el workflow elegido.
    const { workflowChoices: _chosen, ...current } = claimed.item;
    const fields = successor(current, { workflowId: choice.id, workflowName: choice.name });
    if (!(await createProposal(fields, place, id))) release("proposals", id);
  }

  async function onProposalEdit(proposalId: string, text: string, place: Place): Promise<void> {
    const claimed = claim("proposals", proposalId);
    if (claimed.status === "gone") return notify(place, NOTICE.expired);
    if (claimed.status === "busy") return notify(place, NOTICE.busy);
    const fields = successor(claimed.item, { instruction: text.trim() });
    if (!(await createProposal(fields, place, proposalId))) release("proposals", proposalId);
  }

  // ─── Preguntas de agentes ─────────────────────────────────────────────────

  async function replyToQuestion(key: string, question: SentQuestion, text: string, place: Place): Promise<void> {
    try {
      await deps.port.reply(question.session, text, question.questionId);
    } catch (error) {
      logFailure("respuesta a sesión", error);
      release("questions", key);
      return onReplyFailure(key, question, error, place);
    }
    await notify(place, `Respuesta entregada a ${question.session}.`);
  }

  async function onReplyFailure(key: string, question: SentQuestion, error: unknown, place: Place): Promise<void> {
    const code = error instanceof McpToolError ? error.code : undefined;
    const session = question.session;
    if (code === "SESSION_EXPECTS_OPTION" && question.options.length > 0) {
      const keyboard = question.options.map((option, index) => [{
        text: clip(`${index + 1}. ${option}`, MAX_BUTTON_LABEL_CHARS), data: `q:${key}:${index + 1}`,
      }]);
      await outbound.send({ ...place, text: `${session} espera una opción del menú; no entregué nada. Elige una:`, keyboard });
      return;
    }
    const notices: Record<string, string> = {
      QUESTION_CHANGED: `La pregunta de ${session} cambió; no entregué nada. Revisa la pregunta vigente.`,
      SESSION_NOT_WAITING: `${session} no está esperando respuesta; no entregué nada.`,
      SESSION_NOT_FOUND: `La sesión ${session} ya no existe; no entregué nada.`,
      SESSION_EXPECTS_OPTION: `${session} espera una opción del menú; no entregué nada.`,
      PAYLOAD_TOO_LARGE: `Tu respuesta es demasiado larga para ${session}; no entregué nada.`,
    };
    await notify(place, (code && own(notices, code)) || `No pude entregar la respuesta a ${session}. Intenta de nuevo.`);
  }

  async function onQuestionTap(key: string, rawNumber: string | undefined, place: Place): Promise<void> {
    const stored = own(store.readState().questions, key);
    if (!stored) return notify(place, NOTICE.invalidButton);
    const number = /^\d+$/.test(rawNumber ?? "") ? Number(rawNumber) : 0;
    if (number < 1 || number > stored.options.length) return notify(place, NOTICE.invalidButton);
    return deliverToQuestion(key, String(number), place);
  }

  function deliverToQuestion(key: string, text: string, place: Place): Promise<void> {
    const claimed = claim("questions", key);
    if (claimed.status !== "ok") return notify(place, NOTICE.alreadyAnswered);
    return replyToQuestion(key, claimed.item, text, place);
  }

  // ─── Comentarios ──────────────────────────────────────────────────────────

  async function presentDraft(fields: Pick<CommentDraft, "repo" | "comment" | "guidance" | "text">, place: Place, replaces?: string): Promise<void> {
    const draft: CommentDraft = { ...fields, id: newId(), createdAt: deps.now() };
    store.updateState((state) => {
      if (replaces) delete state.drafts[replaces];
      state.drafts[draft.id] = draft;
    });
    const keyboard = draftKeyboard(draft.id);
    if (draft.text.length <= MAX_INLINE_CHARS) {
      await outbound.send({ ...place, text: `Borrador de respuesta (Ronin no publica nada):\n\n${draft.text}`, keyboard });
      return;
    }
    await outbound.sendLong({ ...place, title: "Borrador de respuesta (Ronin no publica nada)", text: draft.text });
    await outbound.send({ ...place, text: "¿Qué hago con este borrador?", keyboard });
  }

  /** Redacta y devuelve el texto, o null si falló o salió vacío (Telegram rechaza un mensaje vacío). */
  async function tryDraft(input: DraftInput): Promise<string | null> {
    try {
      const out = await draftComment(input);
      return out.trim() ? out : null;
    } catch (error) {
      logFailure("redacción de comentario", error);
      return null;
    }
  }

  async function onComment(repo: string, comment: string, guidance: string | undefined, place: Place): Promise<void> {
    const input = { repo, comment, ...(guidance ? { guidance } : {}) };
    const out = await tryDraft(input);
    if (out === null) return notify(place, NOTICE.draftFailed);
    return presentDraft({ ...input, text: out }, place);
  }

  async function onDraftTap(id: string, action: string | undefined, place: Place): Promise<void> {
    if (action !== "adjust" && action !== "convert") return notify(place, NOTICE.invalidButton);
    const claimed = claim("drafts", id);
    if (claimed.status === "gone") return notify(place, NOTICE.expired);
    if (claimed.status === "busy") return;
    const draft = claimed.item;
    if (action === "adjust") return askForEdit("drafts", draft, "Responde a este mensaje con cómo quieres ajustar la respuesta.", place);
    let created = false;
    try {
      const { workflows } = await deps.port.catalog();
      if (workflows.length === 0) return await notify(place, NOTICE.noWorkflows);
      const fields = withWorkflowChoices({ repo: draft.repo, instruction: CONVERT_INSTRUCTION, thirdParty: draft.comment }, workflows);
      created = await createProposal(fields, place);
    } finally {
      if (created) remove("drafts", id);
      else release("drafts", id);
    }
  }

  async function onDraftAdjust(id: string, text: string, place: Place): Promise<void> {
    const claimed = claim("drafts", id);
    if (claimed.status === "gone") return notify(place, NOTICE.expired);
    if (claimed.status === "busy") return notify(place, NOTICE.busy);
    const { repo, comment, text: previous } = claimed.item;
    const out = await tryDraft({ repo, comment, guidance: text, previous });
    if (out === null) {
      release("drafts", id);
      return notify(place, NOTICE.adjustFailed);
    }
    return presentDraft({ repo, comment, guidance: text, text: out }, place, id);
  }

  // ─── Comandos ─────────────────────────────────────────────────────────────

  async function onReportCommand(arg: string | undefined, place: Place): Promise<void> {
    if (!arg) return notify(place, NOTICE.reportUsage);
    const known = own(REPORT_KINDS, arg.toLowerCase());
    if (!known) {
      let stored: { markdown: string } | null = null;
      try {
        stored = deps.reports.read(arg);
      } catch (error) {
        logFailure("lectura de reporte", error);
      }
      if (!stored) return notify(place, NOTICE.reportNotFound);
      return outbound.sendLong({ ...place, title: arg, text: stored.markdown });
    }
    if (reportsInFlight.has(known.kind)) return notify(place, `El reporte ${known.label} ya se está generando.`);
    reportsInFlight.add(known.kind);
    try {
      await notify(place, `Generando el reporte ${known.label}… puede tardar unos minutos.`);
      const report = await deps.reports.generate(known.kind);
      await outbound.sendLong({ ...place, title: report.name, text: report.markdown });
    } catch (error) {
      logFailure("reporte", error);
      await notify(place, `No pude generar el reporte ${known.label}. Intenta de nuevo.`);
    } finally {
      reportsInFlight.delete(known.kind);
    }
  }

  async function onReportList(place: Place): Promise<void> {
    let reports: ReportMeta[];
    try {
      reports = [...deps.reports.list()].sort((a, b) => b.ts - a.ts).slice(0, MAX_LISTED_REPORTS);
    } catch (error) {
      logFailure("lista de reportes", error);
      return notify(place, NOTICE.reportListFailed);
    }
    if (reports.length === 0) return notify(place, NOTICE.noReports);
    const lines = reports.map((r) => `• ${r.name}`);
    return notify(place, ["Últimos reportes (ábrelos con /reporte <nombre>):", ...lines].join("\n"));
  }

  async function onStatusCommand(place: Place): Promise<void> {
    let lines: string[];
    try {
      lines = (await deps.status()).filter((s) => deps.isFollowed(s.name)).map(statusLine);
    } catch (error) {
      logFailure("estado", error);
      return notify(place, NOTICE.statusFailed);
    }
    if (lines.length === 0) return notify(place, NOTICE.noSessions);
    return outbound.sendLong({ ...place, title: "Estado de las sesiones", text: lines.join("\n") });
  }

  /** Solo los comandos conocidos: lo demás, incluido "/estado de la app…", es texto libre. */
  function onCommand(text: string, place: Place): Promise<void> | null {
    const match = /^\/(reportes|reporte|estado)(?:@(\w+))?(?:\s+(\S.*))?$/is.exec(text.trim());
    if (!match) return null;
    const [, rawName, mention, arg] = match;
    const name = rawName.toLowerCase();
    if (name !== "reporte" && arg) return null;
    const bot = store.readConfig().botUsername;
    if (mention && bot && mention.toLowerCase() !== bot.toLowerCase()) return Promise.resolve();
    if (name === "reporte") return onReportCommand(arg?.trim(), place);
    return name === "reportes" ? onReportList(place) : onStatusCommand(place);
  }

  // ─── Texto libre ──────────────────────────────────────────────────────────

  function repoForThread(threadId: number | undefined): string | undefined {
    if (threadId === undefined) return undefined;
    return Object.entries(store.readConfig().topics).find(([, id]) => id === threadId)?.[0];
  }

  async function onOrder(text: string, place: Place): Promise<void> {
    const repo = repoForThread(place.threadId);
    if (!repo) return notify(place, NOTICE.general);
    let workflows: Array<{ id: string; name: string }>;
    let intent: Intent;
    try {
      workflows = (await deps.port.catalog()).workflows;
      intent = await interpret(text, { workflows: workflows.map(({ id, name }) => ({ id, name })) });
    } catch (error) {
      logFailure("interpretación", error);
      return notify(place, NOTICE.interpretFailed);
    }
    if (intent.kind === "unknown") return notify(place, NOTICE.notUnderstood);
    if (intent.kind === "comment") return onComment(repo, intent.comment, intent.guidance, place);
    const fields: NewProposal = { repo, instruction: intent.instruction, ...(intent.thirdParty ? { thirdParty: intent.thirdParty } : {}) };
    const workflow = workflows.find((w) => w.id === intent.workflowId);
    if (workflow) {
      await createProposal({ ...fields, workflowId: workflow.id, workflowName: workflow.name }, place);
      return;
    }
    if (workflows.length === 0) return notify(place, NOTICE.noWorkflows);
    await createProposal(withWorkflowChoices(fields, workflows), place);
  }

  // ─── Enrutado ─────────────────────────────────────────────────────────────

  /** Responder sobre un mensaje guardado; null si no lo es, y entonces es una orden nueva. */
  function onReplyTo(messageId: number, text: string, place: Place): Promise<void> | null {
    const state = store.readState();
    const question = Object.entries(state.questions).find(([, q]) => q.messageId === messageId);
    if (question) return deliverToQuestion(question[0], text, place);
    const proposal = Object.values(state.proposals).find((p) => p.editMessageId === messageId);
    if (proposal) return onProposalEdit(proposal.id, text, place);
    const draft = Object.values(state.drafts).find((d) => d.editMessageId === messageId);
    if (draft) return onDraftAdjust(draft.id, text, place);
    return null;
  }

  async function onCallback(callback: NonNullable<Update["callback_query"]>, place: Place): Promise<void> {
    // Sin await: el reclamo de abajo sigue siendo síncrono, y un botón nunca espera a este acuse.
    void deps.answerCallback(callback.id).catch((error: unknown) => logFailure("acuse de botón", error));
    const [prefix, first, second] = (callback.data ?? "").split(":");
    if (first) {
      if (prefix === "p") return onProposalTap(first, second, place);
      if (prefix === "w") return onWorkflowTap(first, second, place);
      if (prefix === "q") return onQuestionTap(first, second, place);
      if (prefix === "c") return onDraftTap(first, second, place);
      if (prefix === "r" && second === undefined) return onSummary(first, place);
    }
    return notify(place, NOTICE.invalidButton);
  }

  async function onSummary(key: string, place: Place): Promise<void> {
    const claimed = claim("summaries", key);
    if (claimed.status === "gone") return notify(place, NOTICE.summaryGone);
    if (claimed.status === "busy") return;
    const { session } = claimed.item;
    try {
      if (!isSafeSessionName(session)) return await notify(place, NOTICE.summaryGone);
      const summary = deps.summaryFor(session);
      if (!summary) return await notify(place, `No hay resumen de ${session}.`);
      await outbound.sendLong({ ...place, title: `Resumen de ${session}`, text: summary });
    } finally {
      release("summaries", key); // Solo evita el doble toque: el resumen se puede volver a pedir.
    }
  }

  async function route(update: Update, place: Place): Promise<void> {
    if (update.callback_query) return onCallback(update.callback_query, place);
    const text = update.message?.text;
    if (!text?.trim()) return;
    const replyTo = update.message?.reply_to_message?.message_id;
    const handled = (replyTo !== undefined ? onReplyTo(replyTo, text, place) : null) ?? onCommand(text, place);
    return handled ?? onOrder(text, place);
  }

  return {
    async handle(update) {
      let place: Place | undefined;
      try {
        const auth = authorizeUpdate(update, store.readConfig());
        if (!auth.ok) {
          log(`telegram: update ${update.update_id} rechazado: ${auth.reason}`);
          return;
        }
        place = auth.threadId === undefined ? { chatId: auth.chatId } : { chatId: auth.chatId, threadId: auth.threadId };
        await route(update, place);
      } catch (error) {
        logFailure("manejo de update", error);
        if (place) await notify(place, NOTICE.catchAll);
      }
    },
  };
}
