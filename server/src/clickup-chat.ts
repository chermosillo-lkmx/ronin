import { classifyDM } from "./classify.js";
import { clickupToken } from "./settings.js";
import { launchAdhoc } from "./engine.js";

const API2 = "https://api.clickup.com/api/v2";
const API3 = "https://api.clickup.com/api/v3";

async function cu(url: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: clickupToken() } });
  if (!res.ok) throw new Error(`ClickUp chat ${res.status} on ${url}`);
  return res.json();
}

interface ChatMessage {
  id: string;
  content: string;
  user_id: string;
  date: number;
}

let workspaceId = "";
let myId = "";

async function initChat(): Promise<void> {
  const me = await cu(`${API2}/user`);
  myId = String(me?.user?.id ?? "");
  const teams = await cu(`${API2}/team`);
  workspaceId = String(teams?.teams?.[0]?.id ?? "");
}

async function getDmChannels(): Promise<string[]> {
  const data = await cu(`${API3}/workspaces/${workspaceId}/chat/channels?limit=100`);
  return (data?.data ?? [])
    .filter((c: any) => c.type === "DM" || c.type === "GROUP_DM")
    .map((c: any) => c.id as string);
}

async function getMessages(channelId: string): Promise<ChatMessage[]> {
  const data = await cu(`${API3}/workspaces/${workspaceId}/chat/channels/${channelId}/messages?limit=20`);
  return (data?.data ?? []).map((m: any) => ({
    id: String(m.id),
    content: String(m.content ?? ""),
    user_id: String(m.user_id ?? ""),
    date: Number(m.date) || 0,
  }));
}

// per-channel last-seen ms; messages older are ignored
const lastSeen = new Map<string, number>();
const processed = new Set<string>();

async function pollOnce(): Promise<void> {
  const channels = await getDmChannels();
  for (const ch of channels) {
    const since = lastSeen.get(ch) ?? Date.now();
    let maxDate = since;
    let msgs: ChatMessage[] = [];
    try {
      msgs = await getMessages(ch);
    } catch {
      continue;
    }
    // new, from someone else (not me), unprocessed — oldest first
    const fresh = msgs
      .filter((m) => m.date > since && m.user_id !== myId && !processed.has(m.id))
      .sort((a, b) => a.date - b.date);
    for (const m of fresh) {
      processed.add(m.id);
      maxDate = Math.max(maxDate, m.date);
      const c = await classifyDM(m.content);
      if (c.isTask) {
        console.log(`[claude-cowork] DM → tarea (${c.complexity}): ${(c.task || m.content).slice(0, 70)}`);
        await launchAdhoc(c.task || m.content, c.task, "monorepo", c.complexity === "complex");
      }
    }
    for (const m of msgs) maxDate = Math.max(maxDate, m.date);
    lastSeen.set(ch, maxDate);
  }
}

/** Start polling ClickUp DMs; classify new messages and launch detected tasks. */
export async function startDmPoller(intervalMs: number): Promise<void> {
  if (!clickupToken()) {
    console.warn("[claude-cowork] DM poller: sin token de ClickUp, omitido");
    return;
  }
  try {
    await initChat();
  } catch (e) {
    console.warn(`[claude-cowork] DM poller init falló: ${(e as Error).message}`);
    return;
  }
  console.log(`[claude-cowork] DM poller activo (cada ${Math.round(intervalMs / 1000)}s, user ${myId})`);
  setInterval(() => {
    pollOnce().catch((e) => console.warn(`[claude-cowork] DM poll: ${e.message}`));
  }, intervalMs);
}
