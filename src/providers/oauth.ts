import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
}

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const b64u = (b: Buffer) => b.toString("base64url");

/**
 * Google "installed app" OAuth: PKCE + loopback redirect. No client secret is embedded;
 * the user creates a Desktop OAuth client id in Google Cloud and supplies it.
 * `openUrl` is injected (Electron's shell.openExternal) so this stays UI-agnostic.
 */
export async function signInWithGoogle(
  clientId: string,
  scopes: string[],
  openUrl: (url: string) => Promise<void> | void,
  fetchImpl: typeof fetch = fetch,
): Promise<Tokens> {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const state = b64u(randomBytes(16));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.searchParams.get("state") !== state || !u.searchParams.get("code")) {
        res.writeHead(400).end("Sign-in failed. You can close this tab.");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end("Signed in. You can close this tab.");
      const port = (server.address() as { port: number }).port;
      server.close();
      clearTimeout(timer);
      resolve({ code: u.searchParams.get("code")!, redirectUri: `http://127.0.0.1:${port}` });
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Google sign-in timed out"));
    }, 5 * 60_000);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: "code",
        scope: scopes.join(" "), code_challenge: challenge, code_challenge_method: "S256",
        state, access_type: "offline", prompt: "consent",
      });
      void openUrl(`${AUTH}?${q}`);
    });
  });

  return exchange(fetchImpl, { client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" });
}

export async function refreshTokens(clientId: string, t: Tokens, fetchImpl: typeof fetch = fetch): Promise<Tokens> {
  if (t.expires_at - 60_000 > Date.now()) return t;
  if (!t.refresh_token) throw new Error("Session expired; sign in again");
  const fresh = await exchange(fetchImpl, { client_id: clientId, refresh_token: t.refresh_token, grant_type: "refresh_token" });
  return { ...fresh, refresh_token: fresh.refresh_token ?? t.refresh_token };
}

async function exchange(f: typeof fetch, params: Record<string, string>): Promise<Tokens> {
  const res = await f(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Google token endpoint ${res.status}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + j.expires_in * 1000 };
}
