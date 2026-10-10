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
npm test                          # 22 tests
```

Add `--narrate` with `ANTHROPIC_API_KEY` set for a short written summary from Claude.

## Run the desktop app

```sh
npm install
npm start          # builds with esbuild, launches Electron
npm run dist       # .dmg (macOS) / NSIS installer (Windows)
```

## How it reads your email

| Source | How | Notes |
|---|---|---|
| Gmail + Google Calendar (incl. Gmail used in Chrome) | Official REST APIs, read-only scopes, OAuth with PKCE | Browser tabs are **not** scraped. Create a *Desktop app* OAuth client ID in Google Cloud, enable the Gmail and Calendar APIs, paste the ID in Setup. |
| Apple Mail (macOS) | JXA via `osascript` | macOS asks for Automation permission on first run. |
| Outlook (Windows) | COM via PowerShell | **Classic Outlook only**; "new Outlook" has no COM interface. Add a Microsoft Graph provider for that. |

Providers implement a two-method interface (`src/providers/types.ts`), so adding Graph or IMAP means one new file.

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
| Core engine, Gmail/Apple/Outlook output parsers, OAuth refresh, Claude call | Unit-tested (22 tests passing), type-checked |
| Electron shell (`src/app/main.ts`, `preload.ts`) | Written, **not yet run** — written in an environment that couldn't install Electron |
| Apple Mail JXA script, Outlook PowerShell scripts, live Google OAuth round-trip | Written, **not yet run** against real apps/accounts. Expect small fixes (e.g. Outlook's locale-dependent date filter) |

Known limits: task extraction is heuristic (keyword + date patterns, English only); free/busy uses only the calendars the enabled providers expose; Apple Mail reads the Inbox only and groups threads by subject.
