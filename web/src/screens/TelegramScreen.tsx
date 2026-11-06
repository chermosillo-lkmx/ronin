import { useEffect, useRef, useState } from "react";
import { createTelegramGroupLink, createTelegramPairingLink, disconnectTelegram, getTelegramStatus, saveTelegramRepos, saveTelegramToken, TelegramRequestError } from "../api";
import type { TelegramStatus } from "../types";

export const TELEGRAM_POLL_MS = 2000;
const STEP_LABELS = ["Bot", "Tu usuario", "Grupo", "Repos"] as const;

const messageOf = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

function Stepper({ current }: { current: 1 | 2 | 3 | 4 | "done" }) {
  const index = current === "done" ? 5 : current;
  return <ol className="ron-tg-steps" aria-label="Pasos para conectar Telegram">{STEP_LABELS.map((label, i) => {
    const n = i + 1;
    const state = n < index ? "done" : n === index ? "now" : "";
    return <li key={label} className={state} aria-current={state === "now" ? "step" : undefined}>{state === "done" ? "✓ " : ""}{n}. {label}</li>;
  })}</ol>;
}

function LinkBox({ link, busy, onCopy, onRenew, copied }: { link: string | null; busy: boolean; onCopy: () => void; onRenew: () => void; copied: boolean }) {
  return <div className="ron-tg-link">
    {link ? <code aria-label="Enlace de Telegram">{link}</code> : <span className="ron-tg-muted">{busy ? "Generando enlace…" : "Sin enlace todavía."}</span>}
    <div className="ron-cfg-actions">
      <button className="n-btn" disabled={!link} onClick={onCopy}>{copied ? "Copiado" : "Copiar enlace"}</button>
      {link && <a className="n-btn" href={link} target="_blank" rel="noreferrer">Abrir</a>}
      <button className="n-btn" disabled={busy} onClick={onRenew}>Generar otro enlace</button>
    </div>
  </div>;
}

export function TelegramScreen({ initial }: { initial?: TelegramStatus }) {
  const [status, setStatus] = useState<TelegramStatus | null>(initial ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [failedRepos, setFailedRepos] = useState<string[]>([]);
  const [editingRepos, setEditingRepos] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  const step = status?.step;

  const refresh = async () => {
    try { setStatus(await getTelegramStatus()); } catch (e) { setError(messageOf(e, "No pude leer el estado de Telegram.")); }
  };

  useEffect(() => { if (!initial) void refresh(); }, []); // carga una vez

  // Sondeo solo mientras se espera algo de Telegram: pasos 2 y 3.
  useEffect(() => {
    if (initial || (step !== 2 && step !== 3)) return;
    const timer = window.setInterval(() => { void getTelegramStatus().then(setStatus, () => undefined); }, TELEGRAM_POLL_MS);
    return () => window.clearInterval(timer);
  }, [step]);

  // El server consume y rota cada código: se pide una vez al entrar al paso, o cuando el usuario lo pide.
  const requestLink = (target: 2 | 3, isCurrent: () => boolean = () => true) => {
    setLink(null); setCopied(false); setLinkBusy(true);
    (target === 2 ? createTelegramPairingLink() : createTelegramGroupLink())
      .then((value) => { if (isCurrent()) setLink(value); })
      .catch((e) => { if (isCurrent()) setError(messageOf(e, "No pude generar el enlace.")); })
      .finally(() => { if (isCurrent()) setLinkBusy(false); });
  };
  useEffect(() => {
    setLink(null);
    if (initial || (step !== 2 && step !== 3)) return;
    let current = true;
    requestLink(step, () => current);
    return () => { current = false; };
  }, [step]);

  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setError("No pude copiar; selecciona el enlace y cópialo a mano."); }
  };

  const submitToken = async () => {
    const input = tokenRef.current;
    const token = input?.value.trim() ?? "";
    if (input) input.value = ""; // el token no se queda en el campo ni en el estado
    if (!token) { setError("Pega el token completo que te dio @BotFather."); return; }
    setBusy(true); setError("");
    try { await saveTelegramToken(token); await refresh(); } catch (e) { setError(messageOf(e, "No pude guardar el token.")); } finally { setBusy(false); }
  };

  const chosen = selected ?? new Set((status?.repos ?? []).filter((row) => row.hasTopic).map((row) => row.repo));
  const toggle = (repo: string) => { const next = new Set(chosen); if (next.has(repo)) next.delete(repo); else next.add(repo); setSelected(next); };
  const submitRepos = async () => {
    setBusy(true); setError(""); setFailedRepos([]);
    try {
      await saveTelegramRepos([...chosen]);
      setSelected(null); setEditingRepos(false); await refresh();
    } catch (e) {
      setError(messageOf(e, "No pude guardar los repos."));
      if (e instanceof TelegramRequestError && e.failed.length) { setFailedRepos(e.failed); await refresh(); }
    } finally { setBusy(false); }
  };

  const doDisconnect = async () => {
    setBusy(true); setError("");
    try {
      await disconnectTelegram();
      setConfirmOpen(false); setEditingRepos(false); setSelected(null); setFailedRepos([]);
      await refresh();
    } catch (e) { setError(messageOf(e, "No pude desconectar.")); setConfirmOpen(false); } finally { setBusy(false); }
  };

  const reposEditor = (cta: string) => <>
    <fieldset className="ron-tg-repos" disabled={busy}>
      <legend>Repos con tema propio en Telegram</legend>
      {(status?.repos ?? []).length === 0 && <p className="ron-tg-muted">Ronin no tiene repos configurados todavía.</p>}
      {(status?.repos ?? []).map((row) => <label key={row.repo} className="ron-tg-repo">
        <input type="checkbox" checked={chosen.has(row.repo)} onChange={() => toggle(row.repo)} aria-label={`Tema para ${row.repo}`} />
        <code>{row.repo}</code>
        <small className={chosen.has(row.repo) ? "" : "off"}>{chosen.has(row.repo) ? (row.hasTopic ? "con tema" : "se crea tema") : "sin tema"}</small>
      </label>)}
    </fieldset>
    {failedRepos.length > 0 && <div className="ron-tg-error" role="alert">
      <strong>No pude crear el tema de:</strong>
      <ul>{failedRepos.map((repo) => <li key={repo}><code>{repo}</code></li>)}</ul>
      <button className="n-btn" disabled={busy} onClick={() => void submitRepos()}>Reintentar</button>
    </div>}
    <div className="ron-cfg-actions">
      <button className="n-btn n-btn-primary" disabled={busy || (!editingRepos && chosen.size === 0)} onClick={() => void submitRepos()}>{cta}</button>
      {editingRepos && <button className="n-btn" disabled={busy} onClick={() => { setEditingRepos(false); setSelected(null); setFailedRepos([]); }}>Cancelar</button>}
    </div>
  </>;

  const group = status?.group;
  let body;
  if (!status) {
    body = <p className="ron-tg-muted">{error ? "" : "Cargando estado de Telegram…"}</p>;
  } else if (status.step === 1) {
    body = <>
      <h2>Crea tu bot</h2>
      <ol className="ron-tg-list">
        <li>En Telegram abre <b>@BotFather</b> y envíale <code>/newbot</code>.</li>
        <li>Elige un nombre y un usuario que termine en <code>bot</code>.</li>
        <li>BotFather te responde con un token. Cópialo y pégalo aquí.</li>
      </ol>
      <p className="ron-tg-note">Kitsune debe usar otro bot: Telegram solo deja que un proceso lea los mensajes de cada bot, así que este bot es nuevo y solo de Ronin.</p>
      <label className="ron-tg-field">Pega el token del bot
        <input ref={tokenRef} type="password" autoComplete="off" spellCheck={false} aria-label="Token del bot" placeholder="123456:ABC…" disabled={busy} />
      </label>
      <div className="ron-cfg-actions"><button className="n-btn n-btn-primary" disabled={busy} onClick={() => void submitToken()}>{busy ? "Validando…" : "Validar token"}</button></div>
      <p className="ron-tg-muted">El token se guarda en este equipo y nunca vuelve a mostrarse.</p>
    </>;
  } else if (status.step === 2) {
    body = <>
      <h2>Vincula tu usuario</h2>
      <p>Abre este enlace desde tu cuenta de Telegram y toca <b>Iniciar</b>. Ronin captura tu ID y solo tú podrás darle órdenes.</p>
      <LinkBox link={link} busy={linkBusy} copied={copied} onCopy={() => void copy()} onRenew={() => requestLink(2)} />
      <p className="ron-tg-wait" role="status">Esperando tu mensaje al bot{status.botUsername ? ` @${status.botUsername}` : ""}…</p>
    </>;
  } else if (status.step === 3) {
    body = <>
      <h2>Crea el grupo con Temas</h2>
      <p>Un bot no puede crear grupos, así que este paso es manual. Hazlo en este orden:</p>
      <ol className="ron-tg-list">
        <li><b>Crea el grupo</b> en Telegram desde tu celular o la app de escritorio.</li>
        <li><b>Activa Temas</b> en los ajustes del grupo (Editar, Temas).</li>
        <li>Con los Temas activos, abre el enlace para agregar al bot como administrador.</li>
      </ol>
      <LinkBox link={link} busy={linkBusy} copied={copied} onCopy={() => void copy()} onRenew={() => requestLink(3)} />
      {!group && <p className="ron-tg-wait" role="status">Esperando que agregues el bot al grupo…</p>}
      {group && <div className="ron-tg-warn" role="status">
        <p>Grupo detectado: «{group.title}».</p>
        <ul>
          {!group.isForum && <li>Los Temas están apagados. Actívalos en los ajustes del grupo.</li>}
          {!group.botIsAdmin && <li>El bot no es administrador del grupo.</li>}
          {!group.canManageTopics && <li>El bot no tiene permiso para administrar temas.</li>}
        </ul>
      </div>}
    </>;
  } else if (status.step === 4) {
    body = <>
      <p className="ron-tg-ok">● Grupo detectado: «{group?.title ?? ""}», con Temas activos y el bot como administrador.</p>
      <h2>Elige los repos</h2>
      <p>Por cada repo elegido, el bot crea un tema en el grupo.</p>
      {reposEditor("Continuar")}
    </>;
  } else {
    const withTopic = status.repos.filter((row) => row.hasTopic);
    body = <>
      <div className={`ron-tg-state ${status.connected ? "ok" : "bad"}`}><i />{status.connected ? "Conectado" : "Sin conexión"}{status.botUsername && <code>@{status.botUsername}</code>}</div>
      {group && <p className="ron-tg-muted">Grupo «{group.title}» · Temas {group.isForum ? "activos" : "apagados"} · bot {group.botIsAdmin ? "administrador" : "sin permisos de administrador"}</p>}
      {editingRepos ? reposEditor("Guardar repos") : <section className="ron-tg-repolist" aria-label="Repos con tema">
        <h3>Repos con tema</h3>
        {withTopic.length === 0 ? <p className="ron-tg-muted">Ningún repo tiene tema.</p> : <ul>{withTopic.map((row) => <li key={row.repo}><code>{row.repo}</code></li>)}</ul>}
        <button className="n-btn" onClick={() => { setSelected(null); setEditingRepos(true); }}>Cambiar repos</button>
      </section>}
      <p className="ron-tg-note">Telegram solo responde con la Mac encendida y despierta y con Ronin abierto. Si duerme o cierras Ronin, no pasa nada hasta que vuelva.</p>
      <p className="ron-tg-note">Kitsune debe usar otro bot distinto a este; dos procesos no pueden leer el mismo bot.</p>
      <div className="ron-cfg-actions"><button className="n-btn n-btn-danger" disabled={busy} onClick={() => setConfirmOpen(true)}>Desconectar</button></div>
    </>;
  }

  return <div className="ron-cfg ron-tg">
    <div className="ron-cfg-body">
      <section className="ron-cfg-section">
        <div className="ron-cfg-heading"><h2>Telegram</h2><span>{status?.step === "done" ? "Estado de la conexión" : "Conéctalo una sola vez; después esta vista muestra el estado."}</span></div>
        {status && status.step !== "done" && <Stepper current={status.step} />}
        {status?.lastError && <p className="ron-tg-error" role="alert"><b>Último error:</b> {status.lastError}</p>}
        {error && <p className="ron-tg-error" role="alert">{error}</p>}
        {body}
      </section>
    </div>
    {confirmOpen && <div className="ron-cfg-backdrop" role="presentation"><section className="ron-cfg-dialog ron-tg-confirm" role="dialog" aria-modal="true" aria-labelledby="ron-tg-confirm-title">
      <header><div><h2 id="ron-tg-confirm-title">¿Desconectar Telegram?</h2><p>Ronin olvida el token, tu usuario, el grupo y los temas. Para volver a usarlo tendrás que repetir el wizard.</p></div></header>
      <footer><button className="n-btn" onClick={() => setConfirmOpen(false)} disabled={busy} autoFocus>Cancelar</button><button className="n-btn n-btn-danger" onClick={() => void doDisconnect()} disabled={busy}>Desconectar</button></footer>
    </section></div>}
  </div>;
}
