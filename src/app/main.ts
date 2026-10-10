import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDayBrief, buildEndOfDay, projectStatuses, renderDayBrief, renderEndOfDay, renderProjects, rollover,
} from "../core/briefing.ts";
import { addDays } from "../core/dates.ts";
import { narrate } from "../core/llm.ts";
import { Store } from "../core/store.ts";
import type { CalendarEvent, EmailMessage, Task } from "../core/types.ts";
import { GmailProvider, GOOGLE_SCOPES } from "../providers/gmail.ts";
import { localProviders, type Provider } from "../providers/index.ts";
import { JiraProvider, normalizeSite } from "../providers/jira.ts";
import { MICROSOFT_SCOPES, MicrosoftProvider } from "../providers/microsoft.ts";
import { GOOGLE_OAUTH, MICROSOFT_OAUTH, refreshTokens, signInWithOAuth, type Tokens } from "../providers/oauth.ts";
import { SlackProvider } from "../providers/slack.ts";
import { WhatsAppProvider } from "../providers/whatsapp.ts";

type View = "day" | "projects" | "eod";
interface Config {
  googleClientId?: string;
  microsoftClientId?: string;
  jira?: { site: string; email: string }; // the API token lives in the keychain
  whatsapp?: { files: string[]; me: string };
  enabled: Record<string, boolean>;
}

const dir = () => app.getPath("userData");
const secretPath = (name: string) => join(dir(), `${name}.bin`);

/* Secrets (OAuth tokens, API key) are encrypted with the OS keychain via safeStorage. */
function saveSecret(name: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS secure storage is unavailable; refusing to save secrets in plain text");
  writeFileSync(secretPath(name), safeStorage.encryptString(value));
}
function loadSecret(name: string): string | undefined {
  try {
    return existsSync(secretPath(name)) ? safeStorage.decryptString(readFileSync(secretPath(name))) : undefined;
  } catch {
    return undefined;
  }
}

let config: Config = { enabled: {} };
const configPath = () => join(dir(), "config.json");
const saveConfig = () => writeFileSync(configPath(), JSON.stringify(config, null, 2));

let store: Store;
let emails: EmailMessage[] = [];
let events: CalendarEvent[] = [];
let tomorrow: CalendarEvent[] = [];
let lastSync: string | undefined;

/** Returns a function that yields a fresh access token, refreshing and re-saving as needed. */
function tokenGetter(secret: string, clientId: string, tokenUrl: string): () => Promise<string> {
  return async () => {
    const cur = JSON.parse(loadSecret(secret)!) as Tokens;
    const next = await refreshTokens(clientId, cur, fetch, tokenUrl);
    if (next !== cur) saveSecret(secret, JSON.stringify(next));
    return next.access_token;
  };
}

function allProviders(): Provider[] {
  const list = localProviders();
  if (config.googleClientId && loadSecret("google")) {
    list.push(new GmailProvider(tokenGetter("google", config.googleClientId, GOOGLE_OAUTH.tokenUrl)));
  }
  if (config.microsoftClientId && loadSecret("microsoft")) {
    list.push(new MicrosoftProvider(tokenGetter("microsoft", config.microsoftClientId, MICROSOFT_OAUTH.tokenUrl)));
  }
  const slack = loadSecret("slack");
  if (slack) list.push(new SlackProvider(slack));
  const jiraToken = loadSecret("jira");
  if (config.jira && jiraToken) list.push(new JiraProvider({ ...config.jira, token: jiraToken }));
  if (config.whatsapp?.files.length) list.push(new WhatsAppProvider(config.whatsapp.files, config.whatsapp.me));
  return list;
}

async function sync(): Promise<{ added: number; errors: string[] }> {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const since = addDays(dayStart, -3);
  const errors: string[] = [];
  const mail: EmailMessage[] = [];
  const ev: CalendarEvent[] = [];
  const tm: CalendarEvent[] = [];
  let added = 0;

  for (const p of allProviders()) {
    if (config.enabled[p.id] === false) continue;
    try {
      if (p.fetchEmails) mail.push(...(await p.fetchEmails(since)));
      if (p.fetchTasks && p.taskSource) {
        // Only reached when the fetch succeeded, so a failure can never mark tasks done by mistake.
        const r = store.syncExternal(p.taskSource, await p.fetchTasks(), now);
        added += r.added;
      }
      if (p.fetchEvents) {
        const all = await p.fetchEvents(dayStart, addDays(dayStart, 2));
        const tmStart = addDays(dayStart, 1).getTime();
        ev.push(...all.filter((e) => new Date(e.start).getTime() < tmStart));
        tm.push(...all.filter((e) => new Date(e.start).getTime() >= tmStart));
      }
    } catch (err) {
      errors.push(`${p.label}: ${(err as Error).message}`);
    }
  }
  emails = mail;
  events = ev;
  tomorrow = tm;
  added += store.ingestEmails(mail, now);
  store.save();
  lastSync = now.toISOString();
  return { added, errors };
}

function render(view: View): string {
  const now = new Date();
  const s = store.state;
  if (view === "day") return renderDayBrief(buildDayBrief(s, events, emails, now));
  if (view === "projects") return renderProjects(projectStatuses(s, emails, now), now);
  return renderEndOfDay(buildEndOfDay(s, emails, tomorrow, now), now);
}

function registerIpc(): void {
  ipcMain.handle("brief", (_e, view: View) => render(view));
  ipcMain.handle("sync", () => sync());
  ipcMain.handle("status", () => ({
    lastSync,
    providers: allProviders().map((p) => ({ id: p.id, label: p.label, enabled: config.enabled[p.id] !== false })),
    googleClientId: config.googleClientId ?? "",
    microsoftClientId: config.microsoftClientId ?? "",
    jira: config.jira ?? null,
    whatsapp: config.whatsapp ?? { files: [], me: "" },
    hasSlack: !!loadSecret("slack"),
    hasApiKey: !!loadSecret("anthropic"),
  }));
  ipcMain.handle("tasks", () => store.state.tasks.filter((t) => t.status === "open"));
  ipcMain.handle("addTask", (_e, t: Pick<Task, "title" | "due" | "projectId">) => {
    store.addTask({ title: t.title, due: t.due || undefined, projectId: t.projectId || undefined }, new Date());
    store.save();
  });
  ipcMain.handle("setTask", (_e, id: string, status: Task["status"]) => {
    store.setTaskStatus(id, status, new Date());
    store.save();
  });
  ipcMain.handle("projects", () => store.state.projects);
  ipcMain.handle("addProject", (_e, p: { name: string; keywords: string; deadline?: string }) => {
    store.addProject({
      name: p.name,
      keywords: p.keywords.split(",").map((k) => k.trim()).filter(Boolean),
      deadline: p.deadline || undefined,
    });
    store.save();
  });
  ipcMain.handle("endDay", () => {
    const n = rollover(store.state, new Date());
    store.save();
    return n;
  });
  ipcMain.handle("toggleProvider", (_e, id: string, enabled: boolean) => {
    config.enabled[id] = enabled;
    saveConfig();
  });
  ipcMain.handle("connectGoogle", async (_e, clientId: string) => {
    const tokens = await signInWithOAuth(GOOGLE_OAUTH, clientId.trim(), GOOGLE_SCOPES, (u) => shell.openExternal(u));
    saveSecret("google", JSON.stringify(tokens));
    config.googleClientId = clientId.trim();
    saveConfig();
  });
  ipcMain.handle("connectMicrosoft", async (_e, clientId: string) => {
    const tokens = await signInWithOAuth(MICROSOFT_OAUTH, clientId.trim(), MICROSOFT_SCOPES, (u) => shell.openExternal(u));
    saveSecret("microsoft", JSON.stringify(tokens));
    config.microsoftClientId = clientId.trim();
    saveConfig();
  });
  ipcMain.handle("saveSlack", (_e, token: string) => saveSecret("slack", token.trim()));
  ipcMain.handle("saveJira", (_e, j: { site: string; email: string; token: string }) => {
    config.jira = { site: normalizeSite(j.site.trim()), email: j.email.trim() };
    saveSecret("jira", j.token.trim());
    saveConfig();
  });
  ipcMain.handle("addWhatsappFiles", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, {
      title: "Choose exported WhatsApp chats (.txt)",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "WhatsApp chat export", extensions: ["txt"] }],
    });
    if (r.canceled) return;
    const w = config.whatsapp ?? { files: [], me: "" };
    w.files = [...new Set([...w.files, ...r.filePaths])];
    config.whatsapp = w;
    saveConfig();
  });
  ipcMain.handle("setWhatsappMe", (_e, me: string) => {
    config.whatsapp = { files: config.whatsapp?.files ?? [], me: me.trim() };
    saveConfig();
  });
  ipcMain.handle("clearWhatsapp", () => {
    config.whatsapp = { files: [], me: config.whatsapp?.me ?? "" };
    saveConfig();
  });
  ipcMain.handle("setApiKey", (_e, key: string) => saveSecret("anthropic", key.trim()));
  ipcMain.handle("summarize", async (_e, view: View) => {
    const apiKey = loadSecret("anthropic");
    if (!apiKey) throw new Error("Add an Anthropic API key in Setup first");
    return narrate(render(view), { apiKey });
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 980,
    height: 760,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Mail content is untrusted: never let the window navigate away or open new ones.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  await win.loadFile(join(__dirname, "index.html"));
}

app.whenReady().then(async () => {
  try {
    config = { enabled: {}, ...JSON.parse(readFileSync(configPath(), "utf8")) };
  } catch {
    /* first run */
  }
  store = new Store(join(dir(), "state.json"));
  registerIpc();
  await createWindow();
  void sync();
  setInterval(() => void sync(), 15 * 60_000);
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && void createWindow());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
