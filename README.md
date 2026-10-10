# SotItOut

A Windows/macOS desktop assistant that reads your email and calendar and gives you:

- **My day** — the date and time, today's meetings, free focus blocks, who needs a reply, ranked priorities and a suggested plan that fits tasks into your free time.
- **Projects** — status (on-track / at-risk / blocked / done), deadlines, what's open or overdue, and the next thing to do per project.
- **End of day** — what got done, what carries over (with a carry-over counter that raises priority), sent emails still waiting on a reply, and tomorrow's meetings and top tasks.

Tasks are pulled out of email automatically ("can you send X by Friday" becomes a task due Friday) and matched to projects by keyword. You can also add tasks and projects by hand.

## Try it now (no install, no accounts)

Needs Node 22.18+ only.

```sh
node src/cli.ts day --demo        # my day
node src/cli.ts projects --demo   # project status
node src/cli.ts eod --demo        # end of day
npm test                          # 36 tests
```

Add `--narrate` with `ANTHROPIC_API_KEY` set for a short written summary from Claude.

## Run the desktop app

```sh
npm install
npm start          # builds with esbuild, launches Electron
npm run dist       # .dmg (macOS) / NSIS installer (Windows)
```

## Where it reads from

| Source | Gives | How | One-time setup |
|---|---|---|---|
| **WhatsApp** | messages → tasks, "waiting on you", follow-ups | Reads WhatsApp's own **Export chat → Without media** `.txt` files (Android + iOS formats) | In the app: Connections → WhatsApp → enter your name as it appears in chats → add exports. Re-export when you want fresh data. |
| **Microsoft 365 / Outlook (incl. new Outlook)** | mail, calendar, To Do tasks | Microsoft Graph, read-only, OAuth + PKCE | Entra ID → App registration → *Mobile and desktop* platform, redirect `http://localhost`; delegated permissions `Mail.Read Calendars.Read Tasks.Read User.Read offline_access`. Paste the client ID. |
| **Slack** | DMs, group DMs, @mentions | Web API with your own user token | Create a Slack app with user scopes `search:read im:read im:history mpim:read mpim:history users:read`, install it to your workspace, paste the `xoxp-` token. |
| **Jira Cloud** | issues assigned to you → tasks (due date, priority, project) | REST API v3, email + API token | Create a token at id.atlassian.com → Security → API tokens. Issues that get resolved or reassigned are marked done on the next sync. |
| **Gmail + Google Calendar** (incl. Gmail used in Chrome) | mail, calendar | Google REST APIs, read-only, OAuth + PKCE | Google Cloud *Desktop app* OAuth client ID with Gmail + Calendar APIs enabled. Browser tabs are not scraped. |
| Apple Mail (macOS) | mail | JXA via `osascript` | macOS asks for Automation permission. |
| Classic Outlook (Windows) | mail, calendar | COM via PowerShell | Classic Outlook only; use Microsoft 365 above for the new Outlook. |

### Why WhatsApp works through exports
WhatsApp has no official API for personal accounts. The unofficial routes (automating WhatsApp Web, `whatsapp-web.js` and similar) break WhatsApp's terms and can get your number banned, so they are deliberately not used. The WhatsApp Business Cloud API only serves business numbers. Exports are the safe route; the cost is that data is as fresh as your last export.

Adding another source means one file implementing `Provider` (`src/providers/types.ts`): any of `fetchEmails`, `fetchEvents`, `fetchTasks`.

## Privacy

- Everything stays on your machine: state is `state.json` in the app data folder; OAuth tokens and the API key are encrypted with the OS keychain (Electron `safeStorage`).
- Nothing is sent anywhere unless you click **Summarize with Claude**, and then only the already-generated briefing text is sent, not mailboxes.
- Email text is treated as untrusted: the UI never uses `innerHTML`, the window cannot navigate, and the summarizer prompt tells the model to treat the briefing as data.

## Layout

```
src/core        pure logic: date parsing, task extraction, scoring, planning, briefs, store
src/providers   Gmail, Apple Mail, Outlook, Google OAuth
src/app         Electron main / preload / renderer
src/cli.ts      terminal front end (also the demo)
test            node:test suites
```

## Status

| Part | State |
|---|---|
| Core engine, Gmail/Apple/Outlook output parsers, OAuth refresh, Claude call | Unit-tested (36 tests passing), type-checked |
| Electron shell (`src/app/main.ts`, `preload.ts`) | Written, **not yet run** — written in an environment that couldn't install Electron |
| Everything that talks to a real service or app: Graph/Google/Slack/Jira calls, OAuth sign-ins, Apple Mail and Outlook scripts | Written to the vendors' documented APIs, **not yet run** against real accounts. Expect small fixes (field names, scopes, Outlook's locale-dependent date filter) |

Known limits: WhatsApp exports contain no read receipts, so the last message from someone else is treated as waiting on you; Slack covers DMs and mentions, not every channel; Jira covers issues assigned to you; Microsoft To Do is read-only; task extraction is heuristic (keyword + date patterns, English only); free/busy uses only the calendars the enabled providers expose; Apple Mail reads the Inbox only and groups threads by subject.
