interface Api {
  brief(v: string): Promise<string>;
  sync(): Promise<{ added: number; errors: string[] }>;
  status(): Promise<{ lastSync?: string; providers: { id: string; label: string; enabled: boolean }[]; googleClientId: string; microsoftClientId: string; jira: { site: string; email: string } | null; whatsapp: { files: string[]; me: string }; hasSlack: boolean; hasApiKey: boolean }>;
  tasks(): Promise<{ id: string; title: string; due?: string }[]>;
  addTask(t: { title: string; due?: string; projectId?: string }): Promise<void>;
  setTask(id: string, status: string): Promise<void>;
  projects(): Promise<{ id: string; name: string }[]>;
  addProject(p: { name: string; keywords: string; deadline?: string }): Promise<void>;
  endDay(): Promise<number>;
  toggleProvider(id: string, on: boolean): Promise<void>;
  connectGoogle(id: string): Promise<void>;
  connectMicrosoft(id: string): Promise<void>;
  saveSlack(t: string): Promise<void>;
  saveJira(j: { site: string; email: string; token: string }): Promise<void>;
  addWhatsappFiles(): Promise<void>;
  setWhatsappMe(me: string): Promise<void>;
  clearWhatsapp(): Promise<void>;
  setApiKey(k: string): Promise<void>;
  summarize(v: string): Promise<string>;
}
const api = (window as unknown as { api: Api }).api;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let view = "day";

// All dynamic text goes through textContent, never innerHTML: email-derived strings are untrusted.
function el(tag: string, text?: string, props: Record<string, unknown> = {}): HTMLElement {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return Object.assign(n, props);
}

async function guard(msgEl: HTMLElement, fn: () => Promise<unknown>) {
  try {
    msgEl.textContent = "";
    await fn();
  } catch (e) {
    msgEl.textContent = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  }
}

async function refresh() {
  $("out").textContent = await api.brief(view);
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));

  const [tasks, projects, st] = await Promise.all([api.tasks(), api.projects(), api.status()]);
  const list = $("tasks");
  list.replaceChildren(
    ...(tasks.length ? tasks : [{ id: "", title: "Nothing open", due: undefined }]).map((t) => {
      const row = el("div", undefined, { className: "task" });
      row.append(el("span", t.due ? `${t.title} (${t.due})` : t.title));
      if (t.id) {
        row.append(el("button", "✓", { title: "Done", onclick: async () => { await api.setTask(t.id, "done"); await refresh(); } }));
        row.append(el("button", "✕", { title: "Dismiss", onclick: async () => { await api.setTask(t.id, "dismissed"); await refresh(); } }));
      }
      return row;
    }),
  );
  $<HTMLSelectElement>("t-project").replaceChildren(el("option", "No project", { value: "" }), ...projects.map((p) => el("option", p.name, { value: p.id })));

  $("providers").replaceChildren(
    ...(st.providers.length ? st.providers : []).map((p) => {
      const label = el("label", undefined, { className: "row" });
      label.append(el("input", undefined, { type: "checkbox", checked: p.enabled, onchange: (e: Event) => api.toggleProvider(p.id, (e.target as HTMLInputElement).checked) }), el("span", p.label));
      return label;
    }),
  );
  const setVal = (id: string, v: string) => { const i = $<HTMLInputElement>(id); if (document.activeElement !== i) i.value = v; };
  setVal("g-id", st.googleClientId);
  setVal("ms-id", st.microsoftClientId);
  setVal("wa-me", st.whatsapp.me);
  setVal("jr-site", st.jira?.site ?? "");
  setVal("jr-email", st.jira?.email ?? "");
  $("wa-files").textContent = st.whatsapp.files.length ? `${st.whatsapp.files.length} chat file(s) added` : "No chats added yet. In WhatsApp: chat → ⋮ → More → Export chat → Without media.";
  $("status").textContent = st.lastSync ? `Synced ${new Date(st.lastSync).toLocaleTimeString()}` : "Not synced yet";
}

document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) =>
  b.addEventListener("click", () => { view = b.dataset.view!; $("summary").hidden = true; void refresh(); }),
);
$("sync").onclick = () => guard($("status"), async () => {
  $("status").textContent = "Syncing…";
  const r = await api.sync();
  await refresh();
  if (r.errors.length) $("status").textContent = r.errors.join(" · ");
});
$("summarize").onclick = () => guard($("setup-msg"), async () => {
  const s = $("summary");
  s.hidden = false;
  s.textContent = "Thinking…";
  try { s.textContent = await api.summarize(view); } catch (e) { s.hidden = true; throw e; }
});
$("endday").onclick = () => guard($("setup-msg"), async () => {
  const n = await api.endDay();
  $("setup-msg").textContent = `${n} task(s) carried over to tomorrow.`;
  await refresh();
});
$("t-add").onclick = () => guard($("setup-msg"), async () => {
  const title = $<HTMLInputElement>("t-title").value.trim();
  if (!title) return;
  await api.addTask({ title, due: $<HTMLInputElement>("t-due").value, projectId: $<HTMLSelectElement>("t-project").value });
  $<HTMLInputElement>("t-title").value = "";
  await refresh();
});
$("p-add").onclick = () => guard($("setup-msg"), async () => {
  const name = $<HTMLInputElement>("p-name").value.trim();
  if (!name) return;
  await api.addProject({ name, keywords: $<HTMLInputElement>("p-kw").value, deadline: $<HTMLInputElement>("p-due").value });
  ["p-name", "p-kw", "p-due"].forEach((i) => ($<HTMLInputElement>(i).value = ""));
  await refresh();
});
$("g-connect").onclick = () => guard($("setup-msg"), async () => {
  $("setup-msg").textContent = "Complete sign-in in your browser…";
  await api.connectGoogle($<HTMLInputElement>("g-id").value);
  $("setup-msg").textContent = "Google connected.";
  await api.sync();
  await refresh();
});
const val = (id: string) => $<HTMLInputElement>(id).value;
const wipe = (...ids: string[]) => ids.forEach((i) => ($<HTMLInputElement>(i).value = ""));
const syncAfter = async (msg: string) => { $("setup-msg").textContent = msg; await api.sync(); await refresh(); };
$("ms-connect").onclick = () => guard($("setup-msg"), async () => {
  $("setup-msg").textContent = "Complete sign-in in your browser…";
  await api.connectMicrosoft(val("ms-id"));
  await syncAfter("Microsoft connected.");
});
$("sl-save").onclick = () => guard($("setup-msg"), async () => {
  await api.saveSlack(val("sl-token"));
  wipe("sl-token");
  await syncAfter("Slack saved.");
});
$("jr-save").onclick = () => guard($("setup-msg"), async () => {
  await api.saveJira({ site: val("jr-site"), email: val("jr-email"), token: val("jr-token") });
  wipe("jr-token");
  await syncAfter("Jira saved.");
});
$("wa-add").onclick = () => guard($("setup-msg"), async () => { await api.addWhatsappFiles(); await syncAfter("WhatsApp chats added."); });
$("wa-save").onclick = () => guard($("setup-msg"), async () => { await api.setWhatsappMe(val("wa-me")); await syncAfter("Saved."); });
$("wa-clear").onclick = () => guard($("setup-msg"), async () => { await api.clearWhatsapp(); await refresh(); });
$("k-save").onclick = () => guard($("setup-msg"), async () => {
  await api.setApiKey($<HTMLInputElement>("k").value);
  $<HTMLInputElement>("k").value = "";
  $("setup-msg").textContent = "API key saved to the OS keychain.";
});

void refresh();
setInterval(() => void refresh(), 60_000);
