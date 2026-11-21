import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Credentials } from "../../../src/index.js";

/** What one password attempt established. Fixed values; never upstream text. */
export type SignInResult =
  | "signed_in"
  | "credentials_rejected"
  | "password_unavailable"
  | "unavailable"
  | "failed";

export interface PageRequest {
  readonly method: string;
  readonly path: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly fetchSite: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

export interface PageResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SignInPageOptions {
  /** Parish subdomain shown to the user; the caller has already validated it. */
  readonly parish: string;
  /** Receives the typed credentials once per attempt and must not retain them. */
  readonly signIn: (credentials: Credentials) => Promise<SignInResult>;
  readonly maxAttempts?: number;
}

const MAX_BODY_BYTES = 8 * 1024;

const MESSAGES: Readonly<
  Record<Exclude<SignInResult, "signed_in"> | "incomplete" | "busy", string>
> = {
  credentials_rejected:
    "Flocknote did not accept that email and password. Check both and try again.",
  password_unavailable:
    "Flocknote did not offer password sign-in for that email address. Check the address. Logins that use an emailed code are not supported yet.",
  unavailable: "Flocknote could not be reached. Wait a moment and try again.",
  failed:
    "Sign-in did not complete because Flocknote's response was not recognized. Try again.",
  incomplete: "Enter your email address and your password.",
  busy: "A sign-in attempt is already in progress. Wait for it to finish.",
};

const STYLE = `
:root { color-scheme: light dark; --page: #f4f5f7; --card: #fff; --text: #1b1f24; --muted: #5b6470; --line: #d3d8df; --accent: #1f5fbf; --accent-text: #fff; --alert: #a12622; --alert-surface: #fdecea; --ok: #1d6b3a; }
@media (prefers-color-scheme: dark) { :root { --page: #14171c; --card: #1d2128; --text: #eceef1; --muted: #a3acb8; --line: #3a414c; --accent: #6ea8ff; --accent-text: #0d1117; --alert: #ffb4ab; --alert-surface: #3b1f1d; --ok: #7bd69b; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: start center; padding: 48px 16px; background: var(--page); color: var(--text); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { width: 100%; max-width: 420px; padding: 32px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
.brand { margin: 0 0 20px; font-size: 14px; font-weight: 600; letter-spacing: 0.02em; color: var(--muted); }
h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.25; }
.lead { margin: 0 0 24px; color: var(--muted); }
.lead strong { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
.alert { margin: 0 0 20px; padding: 12px 14px; border-radius: 8px; background: var(--alert-surface); color: var(--alert); }
label { display: block; margin: 0 0 6px; font-size: 14px; font-weight: 600; }
input { display: block; width: 100%; margin: 0 0 18px; padding: 10px 12px; font: inherit; color: var(--text); background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
input:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
button { width: 100%; padding: 11px 16px; font: inherit; font-weight: 600; color: var(--accent-text); background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
.notes { margin: 24px 0 0; padding: 16px 0 0 18px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.notes li + li { margin-top: 6px; }
.done { margin: 0; color: var(--ok); font-weight: 600; }
`;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? "",
  );
}

function respond(status: number, title: string, content: string): PageResponse {
  const nonce = randomBytes(16).toString("base64");
  return {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Nothing loads from elsewhere, runs as script, or frames this page.
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      "Cache-Control": "no-store",
      // "no-referrer" would make browsers send "Origin: null" on the form POST.
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      Connection: "close",
    },
    body: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Flockbot</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<p class="brand">Flockbot</p>
${content}
</main>
</body>
</html>
`,
  };
}

function notice(status: number, heading: string, text: string): PageResponse {
  return respond(
    status,
    heading,
    `<h1>${escapeHtml(heading)}</h1>\n<p class="lead">${escapeHtml(text)}</p>`,
  );
}

function form(parish: string, email: string, message?: string): PageResponse {
  return respond(
    200,
    "Sign in to Flocknote",
    `<h1>Sign in to Flocknote</h1>
<p class="lead">Use the email and password for <strong>${escapeHtml(parish)}.flocknote.com</strong>.</p>
${message ? `<p class="alert" role="alert">${escapeHtml(message)}</p>\n` : ""}<form method="post">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" maxlength="254" required value="${escapeHtml(email)}"${email ? "" : " autofocus"}>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required${email ? " autofocus" : ""}>
<button type="submit">Sign in</button>
</form>
<ul class="notes">
<li>This page runs on your computer. It is not Flocknote's website.</li>
<li>Your password goes only to Flocknote, over an encrypted connection. Flockbot does not save it.</li>
<li>Flockbot is independent and is not affiliated with Flocknote.</li>
</ul>`,
  );
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The sign-in page as a request handler, independent of any socket.
 * Every request must name this listener's exact authority and carry its key;
 * a submission must also come from this page. Credentials pass to `signIn`
 * once and are never echoed, stored or logged here.
 */
export function signInHandler(
  options: SignInPageOptions & {
    /** The listener's own "127.0.0.1:<port>". */
    readonly authority: string;
    readonly key: string;
  },
): (request: PageRequest) => Promise<PageResponse> {
  const maxAttempts = options.maxAttempts ?? 5;
  let attempts = 0;
  let busy = false;
  let signedIn = false;
  const refused = () =>
    notice(
      403,
      "This sign-in link is not valid",
      "Ask your assistant to connect to Flocknote again.",
    );
  const complete = () =>
    respond(
      200,
      "Signed in",
      `<h1>You're signed in</h1>\n<p class="done">You can close this tab and return to your assistant.</p>`,
    );
  const locked = () =>
    notice(
      429,
      "Too many attempts",
      "Ask your assistant to connect to Flocknote again.",
    );
  return async (request) => {
    // A rebinding page reaches this socket under its own host name.
    if (request.host !== options.authority) return refused();
    if (!sameText(request.path, `/${options.key}`)) return refused();
    if (request.method === "GET") {
      if (signedIn) return complete();
      if (attempts >= maxAttempts) return locked();
      return form(options.parish, "");
    }
    if (request.method !== "POST") return refused();
    if (
      (request.origin !== undefined &&
        request.origin !== `http://${options.authority}`) ||
      (request.fetchSite !== undefined &&
        request.fetchSite !== "same-origin") ||
      !/^application\/x-www-form-urlencoded(?:;|$)/i.test(
        request.contentType ?? "",
      )
    )
      return refused();
    if (signedIn) return complete();
    if (attempts >= maxAttempts) return locked();
    const fields = new URLSearchParams(request.body);
    const email = (fields.get("email") ?? "").trim();
    const password = fields.get("password") ?? "";
    if (
      email.length === 0 ||
      email.length > 254 ||
      password.length === 0 ||
      password.length > 1024
    )
      return form(options.parish, email.slice(0, 254), MESSAGES.incomplete);
    if (busy) return form(options.parish, email, MESSAGES.busy);
    attempts += 1;
    busy = true;
    let outcome: SignInResult;
    try {
      outcome = await options.signIn({ email, password });
    } catch {
      outcome = "failed";
    } finally {
      busy = false;
    }
    if (outcome === "signed_in") {
      signedIn = true;
      return complete();
    }
    if (attempts >= maxAttempts) return locked();
    return form(options.parish, email, MESSAGES[outcome]);
  };
}

export interface SignInPageServer {
  /** Loopback URL carrying this listener's key. Open it locally; never report it. */
  readonly url: string;
  close(): Promise<void>;
}

/** Serves one sign-in on a random loopback port until closed. */
export async function serveSignInPage(
  options: SignInPageOptions,
): Promise<SignInPageServer> {
  let handle: ((request: PageRequest) => Promise<PageResponse>) | undefined;
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) incoming.destroy();
      else chunks.push(chunk);
    });
    incoming.on("error", () => outgoing.destroy());
    incoming.on("end", () => {
      const header = (name: string) => {
        const value = incoming.headers[name];
        return typeof value === "string" ? value : undefined;
      };
      void (async () => {
        if (!handle) throw new Error();
        const response = await handle({
          method: incoming.method ?? "",
          path: incoming.url ?? "",
          host: header("host"),
          origin: header("origin"),
          fetchSite: header("sec-fetch-site"),
          contentType: header("content-type"),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        outgoing.writeHead(response.status, response.headers);
        outgoing.end(response.body);
      })().catch(() => outgoing.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: other devices on the network cannot connect.
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The sign-in page has no loopback port.");
  }
  const authority = `127.0.0.1:${address.port}`;
  const key = randomBytes(32).toString("base64url");
  handle = signInHandler({ ...options, authority, key });
  let closed: Promise<void> | undefined;
  return {
    url: `http://${authority}/${key}`,
    close() {
      closed ??= new Promise<void>((resolve) => {
        // Let an in-flight response finish, then drop whatever remains.
        const force = setTimeout(() => server.closeAllConnections(), 2000);
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      return closed;
    },
  };
}
