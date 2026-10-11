# SotItOut

A daily brief, project tracker and end-of-day wrap-up that runs inside Claude and reads your work through the **connectors you already use**: Gmail, Google Calendar, Slack, Jira, Microsoft 365, plus WhatsApp exports.

- **`/sotitout:today`**: the date and time, today's meetings, free focus blocks, who needs a reply, ranked priorities, and a plan that fits tasks into your free time.
- **`/sotitout:projects`**: each project's health (on-track / at-risk / blocked / done), deadlines, overdue work and the next task.
- **`/sotitout:wrapup`**: what got done, what carries over (tasks that keep slipping rise in priority), messages still waiting on a reply, and tomorrow.
- **`/sotitout:setup`**: one-time chat that checks your connectors and records your projects, working hours and VIPs.

## Install (about two minutes, macOS or Windows)

You need [Claude Code](https://claude.com/claude-code) and Node.js 18+ (`brew install node` on a Mac). Add the connectors you use (Gmail, Calendar, Slack, Atlassian, Microsoft 365) in Claude's connector settings first; whichever are missing are simply skipped.

```
/plugin marketplace add CosmiX-6/sotitout
/plugin install sotitout@sotitout
/sotitout:setup
```

Then use `/sotitout:today` in the morning and `/sotitout:wrapup` when you finish. Colleagues run the same three lines; each person's data comes from **their own** connectors and stays on **their own** machine. To pick up updates: `/plugin marketplace update sotitout`.

### How it works

```
Claude connectors ──(Claude fetches mail, chat, calendar, Jira)──▶ SotItOut MCP tools ──▶ brief
 your WhatsApp exports ─────────────(import_whatsapp)────────────▶  (ranking, planning,
                                                                      projects, carry-over)
```

Claude does the fetching with each person's existing logins, so nobody registers an OAuth app or pastes an API token. The bundled MCP server (`mcp-dist/`, plain JavaScript, no dependencies) does the deterministic parts: de-duplicating tasks, scoring priority, fitting tasks into free time, project health, and remembering what carried over. State is one JSON file in the plugin's data folder (override with `SOTITOUT_DATA`).

### Using it from the Claude desktop app instead
The skills above are a Claude Code feature, but the tools work anywhere MCP does. Add to `claude_desktop_config.json`, then ask Claude: *"Fetch my calendar, mail, Slack and Jira, load them into SotItOut, and show my day_brief."*

```json
{ "mcpServers": { "sotitout": { "command": "node", "args": ["/absolute/path/to/sotitout/mcp-dist/mcp/server.js"] } } }
```

### The web app (`web/sotitout.html`)
A single-page Claude artifact that does the same job with a UI. Open it inside Claude; it reads Gmail and Google Calendar through your connectors and saves your tasks and projects privately.

| View | What it does |
|---|---|
| **Capture** | Say anything. Tasks, projects and notes are saved, meetings are created on Google Calendar and emails are saved as Gmail drafts (never sent). Everything has Undo; "Ask me first" mode is in Settings. |
| **Projects** | Health, progress and deadlines for every project, plus a deadlines list for the next 14 days. |
| **Today** | Daily summary, tasks found in your inbox, priorities, schedule with free time, who needs your reply. |
| **Wrap-up** | Completed today, carried over, sent mail awaiting replies, tomorrow, and a written wrap-up. |
| **Needs attention** | Overdue work, deadlines, double-bookings, tasks that will not fit, VIP or urgent mail. Shown on every view and from the bell. |

If an event or draft cannot be created, the page says why (with the error code) and offers **Allow access** or **Open permissions**. **Settings → Connections** shows which connector tools are allowed.

Run the end-to-end tests (headless Chromium with a mocked Claude runtime, 130 checks): `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:web`.

### Where each source comes from

| Source | Via | Notes |
|---|---|---|
| Gmail, Google Calendar | Claude connector | Needs a connector that can read mail and events. |
| Microsoft 365 / Outlook | Claude connector | Mail + calendar. |
| Slack | Claude connector | DMs and @mentions. |
| Jira | Claude connector | Assigned, unresolved issues become tasks; closed ones are marked done on the next sync. |
| **WhatsApp** | Exported chat files | No official API exists for personal accounts, and automating WhatsApp Web breaks its terms (accounts get banned). In WhatsApp: chat → ⋮ → Export chat → Without media. `/sotitout:setup` walks through it. Data is as fresh as your last export. |

### Privacy
- Message text goes to Claude exactly as the connectors would anyway; SotItOut adds no other network calls and stores only tasks, projects and settings, not mailboxes (the message cache lives in memory for the session).
- Message and chat text is treated as untrusted: the skills tell Claude never to follow instructions found inside it, and nothing is ever sent or replied to without your say-so.

### Working on it
`src/` is the source. After changing anything under `src/core`, `src/providers/whatsapp.ts` or `src/mcp`, run `npm run build:mcp` and commit `mcp-dist/`; the test suite fails if the committed build is stale. `npm test` runs 46 tests on Node 22.18+.

## Status
| Part | State |
|---|---|
| Engine, MCP tools, protocol handling, WhatsApp parser, skill/tool consistency | Tested (46 passing), including a real stdio child process and the compiled JS running without TypeScript support |
| The plugin loading inside Claude Code (`/plugin install`, skills triggering, connector tool use) | Written to the documented plugin format, **not yet run inside Claude** |
| Standalone Electron app (below) | Written, **not yet run**; kept as an alternative for people who want a window with no Claude |

---

# Optional: standalone desktop app

The same engine also ships as an Electron app that talks to the services directly (own OAuth, tokens and Slack/Jira credentials, in the OS keychain). Use it if you want a window instead of Claude.

### Try it now (no install, no accounts)

Needs Node 22.18+ only.

```sh
node src/cli.ts day --demo        # my day
node src/cli.ts projects --demo   # project status
node src/cli.ts eod --demo        # end of day
npm test                          # 46 tests
```

Add `--narrate` with `ANTHROPIC_API_KEY` set for a short written summary from Claude.

### Run the desktop app

```sh
npm install
npm start          # builds with esbuild, launches Electron
npm run dist       # .dmg (macOS) / NSIS installer (Windows)
```

### Where the standalone app reads from

| Source | Gives | How | One-time setup |
|---|---|---|---|
| **WhatsApp** | messages → tasks, "waiting on you", follow-ups | Reads WhatsApp's own **Export chat → Without media** `.txt` files (Android + iOS formats) | In the app: Connections → WhatsApp → enter your name as it appears in chats → add exports. Re-export when you want fresh data. |
| **Microsoft 365 / Outlook (incl. new Outlook)** | mail, calendar, To Do tasks | Microsoft Graph, read-only, OAuth + PKCE | Entra ID → App registration → *Mobile and desktop* platform, redirect `http://localhost`; delegated permissions `Mail.Read Calendars.Read Tasks.Read User.Read offline_access`. Paste the client ID. |
| **Slack** | DMs, group DMs, @mentions | Web API with your own user token | Create a Slack app with user scopes `search:read im:read im:history mpim:read mpim:history users:read`, install it to your workspace, paste the `xoxp-` token. |
| **Jira Cloud** | issues assigned to you → tasks (due date, priority, project) | REST API v3, email + API token | Create a token at id.atlassian.com → Security → API tokens. Issues that get resolved or reassigned are marked done on the next sync. |
| **Gmail + Google Calendar** (incl. Gmail used in Chrome) | mail, calendar | Google REST APIs, read-only, OAuth + PKCE | Google Cloud *Desktop app* OAuth client ID with Gmail + Calendar APIs enabled. Browser tabs are not scraped. |
| Apple Mail (macOS) | mail | JXA via `osascript` | macOS asks for Automation permission. |
| Classic Outlook (Windows) | mail, calendar | COM via PowerShell | Classic Outlook only; use Microsoft 365 above for the new Outlook. |

#### Why WhatsApp works through exports
WhatsApp has no official API for personal accounts. The unofficial routes (automating WhatsApp Web, `whatsapp-web.js` and similar) break WhatsApp's terms and can get your number banned, so they are deliberately not used. The WhatsApp Business Cloud API only serves business numbers. Exports are the safe route; the cost is that data is as fresh as your last export.

Adding another source means one file implementing `Provider` (`src/providers/types.ts`): any of `fetchEmails`, `fetchEvents`, `fetchTasks`.

### Privacy (standalone app)

- Everything stays on your machine: state is `state.json` in the app data folder; OAuth tokens and the API key are encrypted with the OS keychain (Electron `safeStorage`).
- Nothing is sent anywhere unless you click **Summarize with Claude**, and then only the already-generated briefing text is sent, not mailboxes.
- Email text is treated as untrusted: the UI never uses `innerHTML`, the window cannot navigate, and the summarizer prompt tells the model to treat the briefing as data.

### Layout

```
src/core        pure logic: date parsing, task extraction, scoring, planning, briefs, store
src/providers   Gmail, Apple Mail, Outlook, Google OAuth
src/app         Electron main / preload / renderer
src/cli.ts      terminal front end (also the demo)
test            node:test suites
```

### Status (standalone app)

| Part | State |
|---|---|
| Core engine, Gmail/Apple/Outlook output parsers, OAuth refresh, Claude call | Unit-tested (46 tests passing), type-checked |
| Electron shell (`src/app/main.ts`, `preload.ts`) | Written, **not yet run** — written in an environment that couldn't install Electron |
| Everything that talks to a real service or app: Graph/Google/Slack/Jira calls, OAuth sign-ins, Apple Mail and Outlook scripts | Written to the vendors' documented APIs, **not yet run** against real accounts. Expect small fixes (field names, scopes, Outlook's locale-dependent date filter) |

Known limits: WhatsApp exports contain no read receipts, so the last message from someone else is treated as waiting on you; Slack covers DMs and mentions, not every channel; Jira covers issues assigned to you; Microsoft To Do is read-only; task extraction is heuristic (keyword + date patterns, English only); free/busy uses only the calendars the enabled providers expose; Apple Mail reads the Inbox only and groups threads by subject.
