import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CalendarEvent, EmailMessage } from "../core/types.ts";
import type { Provider } from "./types.ts";

const run = promisify(execFile);

/**
 * Windows desktop Outlook via COM (PowerShell). Works with classic Outlook only —
 * "new Outlook" has no COM interface; use a Graph/IMAP provider for that.
 */
const MAIL_PS = (limit: number) => `
$ErrorActionPreference = 'Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
$items = $ns.GetDefaultFolder(6).Items
$items.Sort('[ReceivedTime]', $true)
$out = @(); $i = 0
foreach ($m in $items) {
  if ($i -ge ${limit}) { break }; $i++
  if ($m.Class -ne 43) { continue }
  $out += [pscustomobject]@{
    id = $m.EntryID; subject = $m.Subject; from = "$($m.SenderName) <$($m.SenderEmailAddress)>"
    receivedAt = $m.ReceivedTime.ToUniversalTime().ToString('o'); isUnread = [bool]$m.UnRead
    threadId = $m.ConversationID
    body = $m.Body.Substring(0, [Math]::Min(4000, $m.Body.Length))
  }
}
ConvertTo-Json -InputObject @($out) -Compress`;

const CAL_PS = (fromIso: string, toIso: string) => `
$ErrorActionPreference = 'Stop'
$ol = New-Object -ComObject Outlook.Application
$items = $ol.GetNamespace('MAPI').GetDefaultFolder(9).Items
$items.IncludeRecurrences = $true
$items.Sort('[Start]')
$from = [datetime]::Parse('${fromIso}').ToLocalTime(); $to = [datetime]::Parse('${toIso}').ToLocalTime()
$filter = "[Start] < '" + $to.ToString('g') + "' AND [End] > '" + $from.ToString('g') + "'"
$out = @()
foreach ($e in $items.Restrict($filter)) {
  $out += [pscustomobject]@{
    id = $e.EntryID; title = $e.Subject; location = $e.Location; allDay = [bool]$e.AllDayEvent
    start = $e.Start.ToUniversalTime().ToString('o'); end = $e.End.ToUniversalTime().ToString('o')
  }
}
ConvertTo-Json -InputObject @($out) -Compress`;

const ps = async (script: string) =>
  (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { maxBuffer: 20 * 1024 * 1024 })).stdout.trim();

export function parseOutlookMail(json: string, since: Date): EmailMessage[] {
  const rows = JSON.parse(json || "[]") as {
    id: string; subject: string; from: string; receivedAt: string; isUnread: boolean; threadId: string; body: string;
  }[];
  return rows
    .filter((r) => new Date(r.receivedAt) >= since)
    .map((r) => ({
      id: r.id, provider: "outlook", threadId: r.threadId, from: r.from, to: [], subject: r.subject,
      body: r.body, receivedAt: r.receivedAt, isUnread: r.isUnread, isSent: false,
    }));
}

export function parseOutlookEvents(json: string): CalendarEvent[] {
  return (JSON.parse(json || "[]") as CalendarEvent[]).map((e) => ({ ...e, location: e.location || undefined }));
}

export class OutlookProvider implements Provider {
  id = "outlook";
  label = "Outlook (desktop)";
  async fetchEmails(since: Date) {
    return parseOutlookMail(await ps(MAIL_PS(80)), since);
  }
  async fetchEvents(from: Date, to: Date) {
    return parseOutlookEvents(await ps(CAL_PS(from.toISOString(), to.toISOString())));
  }
}
