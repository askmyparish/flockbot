import { AuthenticationSuspectedError as BrowserAuthenticationError } from "../../../src/errors.js";
import type { chromium, BrowserContext, Page } from "playwright";
import { FlockbotError } from "../../../src/index.js";

const ANCHOR = "/__flockbot_request_context__";
const MAX_BODY_BYTES = 1024 * 1024;

export interface BrowserSession {
  request(
    path: string,
    method?: "GET" | "POST",
    body?: string,
  ): Promise<unknown>;
  signIn(): Promise<void>;
  finishSignIn?(): Promise<void>;
  isOpen?(): boolean;
  close(): Promise<void>;
}

export interface BrowserSessionOptions {
  readonly profile: string;
  readonly origin: string;
  readonly interactive: boolean;
}

export type BrowserFactory = (
  options: BrowserSessionOptions,
) => Promise<BrowserSession>;

/**
 * Local connection failures carrying fixed codes and optional safe startup stages.
 * Browser exception text and profile contents stay outside this error contract.
 */
export class BrowserConnectionError extends Error {
  constructor(
    readonly code:
      | "browser_unavailable"
      | "profile_unavailable"
      | "not_configured"
      | "connection_busy"
      | "connection_changed"
      | "broker_unavailable",
    readonly outcome?: "not_submitted" | "unknown",
    readonly stage?: "launch" | "request_context" | "sign_in" | "close",
  ) {
    super(code);
    this.name = "BrowserConnectionError";
  }
}

export { AuthenticationSuspectedError as BrowserAuthenticationError } from "../../../src/errors.js";

/** Internal endpoints only. Neither an MCP tool nor its arguments can set a URL. */
function allowed(path: string, method: string): boolean {
  if (method === "GET")
    return (
      [
        "user/userData",
        "dashboard",
        "navigation/groups",
        "network/getMetadata",
      ].includes(path) ||
      /^group\/[A-Za-z0-9_-]+\/getSubscriberCount$/.test(path) ||
      /^group\/[A-Za-z0-9_-]+\/notes\?ajax&more$/.test(path) ||
      /^note\/[A-Za-z0-9_-]+\/(?:analyticsSummary|analytics2)\?ajax$/.test(path)
    );
  return (
    method === "POST" &&
    (/^group\/[A-Za-z0-9_-]+\/addToGroupByAdmin$/.test(path) ||
      /^note\/[A-Za-z0-9_-]+\/searchAnalytics\?ajax$/.test(path) ||
      /^group\/[A-Za-z0-9_-]+\/(?:people\?ajax|filter)$/.test(path) ||
      /^group\/[A-Za-z0-9_-]+\/people\/[1-9]\d{0,15}\?ajax&more$/.test(path) ||
      /^user\/[A-Za-z0-9_-]+\/(?:profile|groups)$/.test(path))
  );
}

/**
 * The browser owns its cookies. No cookie API, exported storage state, console
 * listener, tracing, screenshot, credential form or model-provided script.
 * A locally fulfilled blank page supplies the parish origin without loading
 * application scripts. Requests still use real browser fetch and browser cookies.
 */
export async function openBrowserSession(
  options: BrowserSessionOptions,
  launch?: typeof chromium.launchPersistentContext,
): Promise<BrowserSession> {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.origin !== options.origin)
    throw new FlockbotError("invalid_configuration");
  let context: BrowserContext | undefined;
  let stage: "launch" | "request_context" = "launch";
  try {
    // Status, IPC and injected sessions do not need to initialize Playwright.
    let launchBrowser = launch;
    if (!launchBrowser) {
      const { chromium } = await import("playwright");
      launchBrowser = chromium.launchPersistentContext.bind(chromium);
    }
    context = await launchBrowser(options.profile, {
      channel: "chromium",
      chromiumSandbox: true,
      // Playwright's testing defaults disable native credential protection.
      // Production profiles must retain the browser's real OS secret store.
      ignoreDefaultArgs: [
        "--password-store=basic",
        "--use-mock-keychain",
        "--unsafely-disable-devtools-self-xss-warnings",
      ],
      headless: !options.interactive,
      serviceWorkers: "block",
      acceptDownloads: false,
      timeout: 15_000,
      args: ["--restore-last-session"],
    });
    stage = "request_context";
    const browser = context;
    const page = await browser.newPage();
    await page.route(`${origin.origin}${ANCHOR}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: {
          "Content-Security-Policy":
            "default-src 'none'; connect-src 'self'; frame-ancestors 'none'",
          "Cache-Control": "no-store",
        },
        body: "<!doctype html><title>Flockbot request context</title>",
      }),
    );
    await page.goto(`${origin.origin}${ANCHOR}`, { timeout: 15_000 });
    // --restore-last-session retains session cookies across clean restarts.
    // Restored tabs are unnecessary: keep only the inert request page.
    await Promise.all(
      browser
        .pages()
        .filter((other) => other !== page)
        .map((other) => other.close()),
    );
    let signInPage: Page | undefined;
    return {
      isOpen: () =>
        !page.isClosed() &&
        (browser.browser()?.isConnected() ?? false) &&
        !(signInPage?.isClosed() ?? false),
      async request(path, method = "GET", body) {
        if (!allowed(path, method)) throw new FlockbotError("invalid_path");
        let result: {
          data?: unknown;
          error?: string;
          authentication?: boolean;
        };
        try {
          result = await page.evaluate(
            async ({ origin, path, method, body, limit }) => {
              if (location.origin !== origin)
                return { error: "invalid_response" };
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 15_000);
              try {
                const response = await fetch(`${origin}/${path}`, {
                  method,
                  credentials: "same-origin",
                  redirect: "manual",
                  cache: "no-store",
                  signal: controller.signal,
                  ...(body === undefined
                    ? {}
                    : {
                        headers: {
                          "Content-Type": "application/x-www-form-urlencoded",
                        },
                        body,
                      }),
                });
                if (
                  response.type === "opaqueredirect" ||
                  (response.status >= 300 && response.status < 400)
                )
                  return { error: "redirect_rejected", authentication: true };
                if (response.status === 401)
                  return { error: "upstream_rejected", authentication: true };
                if (response.status === 403)
                  return { error: "permission_denied", authentication: true };
                if (!response.ok) return { error: "upstream_rejected" };
                const reader = response.body?.getReader();
                if (!reader) return { error: "invalid_response" };
                let size = 0;
                let text = "";
                const decoder = new TextDecoder();
                for (;;) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  size += chunk.value.byteLength;
                  if (size > limit) {
                    controller.abort();
                    return { error: "invalid_response" };
                  }
                  text += decoder.decode(chunk.value, { stream: true });
                }
                text += decoder.decode();
                if (
                  /(?:^|\/)json(?:;|$)|\+json(?:;|$)/i.test(
                    response.headers.get("Content-Type") ?? "",
                  )
                ) {
                  try {
                    return { data: JSON.parse(text) as unknown };
                  } catch {
                    return { error: "invalid_response" };
                  }
                }
                return { data: text };
              } catch {
                return {
                  error: controller.signal.aborted
                    ? "operation_timeout"
                    : "transport_failed",
                };
              } finally {
                clearTimeout(timer);
              }
            },
            {
              origin: origin.origin,
              path,
              method,
              body,
              limit: MAX_BODY_BYTES,
            },
          );
        } catch {
          throw new FlockbotError("transport_failed");
        }
        switch (result.error) {
          case undefined:
            return result.data;
          case "redirect_rejected":
          case "permission_denied":
          case "upstream_rejected":
            if (result.authentication)
              throw new BrowserAuthenticationError(result.error);
            throw new FlockbotError(result.error);
          case "invalid_response":
          case "operation_timeout":
          case "transport_failed":
            throw new FlockbotError(result.error);
          default:
            throw new FlockbotError("invalid_response");
        }
      },
      async signIn() {
        try {
          signInPage = await browser.newPage();
          await signInPage.goto(origin.origin, {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          });
          await signInPage.bringToFront();
        } catch {
          throw new BrowserConnectionError(
            "browser_unavailable",
            undefined,
            "sign_in",
          );
        }
      },
      async close() {
        try {
          // Only the inert page should be eligible for clean session restore;
          // routine operations must not reopen the interactive website's tabs.
          await Promise.all(
            browser
              .pages()
              .filter((other) => other !== page)
              .map((other) => other.close()),
          );
          // Session restore must not navigate to Flocknote before interception
          // is attached on the next launch. Cookie persistence is browser-owned
          // and does not require retaining a parish page in the saved tabs.
          if (!page.isClosed()) await page.goto("about:blank");
          await browser.close();
        } catch {
          throw new BrowserConnectionError(
            "browser_unavailable",
            undefined,
            "close",
          );
        }
      },
      async finishSignIn() {
        await Promise.all(
          browser
            .pages()
            .filter((other) => other !== page)
            .map((other) => other.close()),
        );
        signInPage = undefined;
        // Retain the authenticated process without leaving its sign-in window in
        // front of the user. This runs only after interactive setup, not for tools.
        if (options.interactive && !page.isClosed()) {
          try {
            const cdp = await browser.newCDPSession(page);
            try {
              const { windowId } = await cdp.send("Browser.getWindowForTarget");
              await cdp.send("Browser.setWindowBounds", {
                windowId,
                bounds: { windowState: "minimized" },
              });
            } finally {
              await cdp.detach().catch(() => undefined);
            }
          } catch {
            // Window managers may refuse minimization; authentication is intact.
          }
        }
      },
    };
  } catch {
    await context?.close().catch(() => undefined);
    throw new BrowserConnectionError("browser_unavailable", undefined, stage);
  }
}
