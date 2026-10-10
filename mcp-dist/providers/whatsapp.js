import { readFile } from "node:fs/promises";
import { basename } from "node:path";
/**
 * WhatsApp has no official API for personal accounts, and automating WhatsApp Web violates its
 * terms (accounts get banned). This provider instead reads the plain-text files produced by
 * WhatsApp's own  Chat → ⋮ → Export chat → Without media  (Android and iOS formats).
 * Re-export a chat whenever you want fresher data.
 */
// Header: optional "[", d/m/y, time with optional seconds and AM/PM, optional "]" and " - "
const HEADER = /^\[?(\d{1,4})[/.](\d{1,2})[/.](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\]?\s*(?:-\s*)?([\s\S]*)$/;
const MEDIA = /^(<media omitted>|<attachment:.*>|.*\b(image|video|audio|sticker|gif|document) omitted|this message was deleted|you deleted this message|null)$/i;
const clean = (s) => s.replace(/[‎‏‪-‮]/g, "").replace(/[  ]/g, " ");
/** Decide day/month order from the data: any first number > 12 means d/m, any second > 12 means m/d. */
function detectOrder(lines, fallback) {
    let dmy = 0;
    let mdy = 0;
    for (const raw of lines) {
        const m = HEADER.exec(clean(raw));
        if (!m || m[1].length > 2)
            continue; // ISO-like y/m/d handled separately
        if (+m[1] > 12)
            dmy++;
        if (+m[2] > 12)
            mdy++;
    }
    return dmy > mdy ? "dmy" : mdy > dmy ? "mdy" : fallback;
}
export function parseWhatsAppChat(text, fallbackOrder = "dmy") {
    const lines = text.split(/\r?\n/);
    const order = detectOrder(lines, fallbackOrder);
    const out = [];
    let cur;
    for (const raw of lines) {
        const line = clean(raw);
        const m = HEADER.exec(line);
        if (m) {
            let [, a, b, c] = m;
            let y, mo, d;
            if (a.length === 4)
                [y, mo, d] = [+a, +b, +c];
            else {
                [d, mo] = order === "dmy" ? [+a, +b] : [+b, +a];
                y = +c < 100 ? 2000 + +c : +c;
            }
            let h = +m[4];
            const ap = m[7]?.toLowerCase().replace(/\./g, "");
            if (ap === "pm" && h < 12)
                h += 12;
            if (ap === "am" && h === 12)
                h = 0;
            const at = new Date(y, mo - 1, d, h, +m[5], m[6] ? +m[6] : 0);
            const rest = m[8];
            const sep = rest.indexOf(": ");
            if (!Number.isNaN(at.getTime()) && sep > 0) {
                cur = { at, sender: rest.slice(0, sep).trim(), text: rest.slice(sep + 2) };
                out.push(cur);
            }
            else {
                cur = undefined; // system line ("X added Y", encryption notice): ends the previous message
            }
        }
        else if (cur) {
            cur.text += `\n${line}`; // continuation of a multi-line message
        }
    }
    return out.filter((m) => !MEDIA.test(m.text.trim()) && m.text.trim().length > 0);
}
const hash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++)
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
};
/** "WhatsApp Chat with Alice.txt" → "Alice" */
export const chatNameFromFile = (path) => basename(path).replace(/\.txt$/i, "").replace(/^WhatsApp Chat (with|-)\s*/i, "").trim() || "chat";
export function whatsappToMessages(chat, msgs, myName, since) {
    const me = myName.trim().toLowerCase();
    const recent = msgs.filter((m) => m.at >= since);
    const lastIdx = msgs.length - 1;
    return recent.map((m) => {
        const mine = !!me && m.sender.toLowerCase() === me;
        return {
            id: `${chat}:${m.at.getTime()}:${hash(m.sender + m.text)}`,
            provider: "whatsapp",
            threadId: `wa:${chat}`,
            from: m.sender,
            to: mine ? [chat] : [],
            subject: chat,
            body: m.text.slice(0, 4000),
            receivedAt: m.at.toISOString(),
            // The last message in the chat is "waiting on me" if someone else wrote it.
            isUnread: !mine && msgs[lastIdx] === m,
            isSent: mine,
        };
    });
}
export class WhatsAppProvider {
    id = "whatsapp";
    label = "WhatsApp (exported chats)";
    files;
    myName;
    read;
    constructor(files, myName, read = (p) => readFile(p, "utf8")) {
        this.files = files;
        this.myName = myName;
        this.read = read;
    }
    async fetchEmails(since) {
        const out = [];
        for (const f of this.files) {
            const msgs = parseWhatsAppChat(await this.read(f));
            out.push(...whatsappToMessages(chatNameFromFile(f), msgs, this.myName, since));
        }
        return out;
    }
}
