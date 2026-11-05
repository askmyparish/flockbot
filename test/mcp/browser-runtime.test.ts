import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserConnection } from "../../adapters/mcp/src/browser-connection.js";
import { SerialCoordinator } from "../../adapters/mcp/src/serial-coordinator.js";
import {
  openBrowserSession,
  type BrowserFactory,
} from "../../adapters/mcp/src/browser-runtime.js";
import { createFlocknoteServer } from "../../adapters/mcp/src/flocknote-server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** Every page/API request is fulfilled here. DNS is disabled in the browser too. */
async function fixture() {
  const profile = mkdtempSync(join(tmpdir(), "flockbot-real-browser-"));
  const origin = "https://example-parish.flocknote.com";
  const visits: { path: string; method: string }[] = [];
  const state = {
    launches: 0,
    expired: false,
    authFailure: "http401",
    rejectWrite: false,
    redirect: false,
    oversized: false,
    external: 0,
    restoredParishPage: false,
  };
  let context: BrowserContext;
  const factory: BrowserFactory = (options) =>
    openBrowserSession(options, async (directory, settings) => {
      state.launches++;
      context = await chromium.launchPersistentContext(directory, {
        ...settings,
        headless: true,
        // Fictional test profiles must not touch a real OS credential store.
        ignoreDefaultArgs: [],
        chromiumSandbox: false,
        args: [
          ...(settings?.args ?? []),
          "--host-resolver-rules=MAP * ~NOTFOUND",
        ],
      });
      if (context.pages().some((page) => page.url().startsWith(origin)))
        state.restoredParishPage = true;
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) {
          state.external++;
          await route.abort();
          return;
        }
        const path = url.pathname.slice(1);
        visits.push({ path, method: request.method() });
        const json = (body: unknown) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(body),
          });
        if (path === "") {
          await route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><button id="login">Fictional sign-in</button><script>document.querySelector("button").onclick=()=>fetch("/fictional-sign-in", {method:"POST"})</script>',
          });
        } else if (path === "fictional-sign-in") {
          state.expired = false;
          // Deliberately a session cookie, without Expires or Max-Age.
          await route.fulfill({
            body: "ok",
            headers: {
              "Set-Cookie":
                "Flocknote=fictional-browser-session; Path=/; Secure; HttpOnly; SameSite=Lax",
            },
          });
        } else if (path === "user/userData") {
          const cookie = await request.headerValue("cookie");
          await json(
            !state.expired &&
              cookie?.includes("Flocknote=fictional-browser-session")
              ? { success: true, userID: 201, email: "private@example.test" }
              : { success: true, userID: null, authorized: false },
          );
        } else if (state.expired) {
          if (state.authFailure === "json")
            await json({ success: false, authorized: false });
          else if (state.authFailure === "html")
            await route.fulfill({
              contentType: "text/html",
              body: "<!doctype html><html><form>Fictional sign-in</form></html>",
            });
          else
            await route.fulfill({
              status: state.authFailure === "http403" ? 403 : 401,
              body: "",
            });
        } else if (path === "dashboard") {
          await route.fulfill({
            contentType: "text/html",
            body: '<div id="fnReactHolder"></div>',
          });
        } else if (path === "navigation/groups") {
          await json({
            groups: [{ ID: 102, name: "Volunteers", shortname: "volunteers" }],
          });
        } else if (path === "network/getMetadata") {
          await json({ everyoneGroupID: 101 });
        } else if (path === "group/101/getSubscriberCount") {
          if (state.redirect)
            await route.fulfill({
              status: 302,
              headers: { Location: "https://outside.invalid/" },
            });
          else if (state.oversized)
            await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({
                subscriberCount: 4,
                padding: "x".repeat(1024 * 1024),
              }),
            });
          else await json({ subscriberCount: 4 });
        } else if (path === "group/102/addToGroupByAdmin") {
          if (state.rejectWrite) await route.abort();
          else
            await json({
              success: true,
              privateContact: "private@example.test",
            });
        } else await route.abort();
      });
      return context;
    });
  const connection = new BrowserConnection({
    profile,
    factory,
    pollMs: 20,
    setupMs: 15_000,
    coordinator: new SerialCoordinator(),
  });
  cleanup.push(async () => {
    await connection.close();
    rmSync(profile, { recursive: true, force: true });
  });
  async function signIn() {
    await connection.connect("example-parish");
    const signIn = context.pages().find((page) => page.url() === `${origin}/`);
    expect(signIn).toBeDefined();
    await signIn?.locator("#login").click();
    await vi.waitFor(
      async () =>
        expect(await connection.status()).toMatchObject({ state: "ready" }),
      { timeout: 10_000 },
    );
  }
  return {
    profile,
    connection,
    visits,
    state,
    signIn,
    context: () => context,
    origin,
  };
}

describe.skipIf(process.env.FLOCKBOT_BROWSER_TESTS !== "1")(
  "real Chromium with offline Flocknote fixtures",
  () => {
    it.each(["sign-in tab", "browser"])(
      "ends setup after closing only the %s and permits sign-in again",
      async (target) => {
        const f = await fixture();
        await f.connection.connect("example-parish");
        const context = f.context();
        const signIn = context
          .pages()
          .find((page) => page.url() === `${f.origin}/`);
        const requestPage = context.pages().find((page) => page !== signIn);
        expect(signIn).toBeDefined();
        expect(requestPage).toBeDefined();
        expect(context.pages()).toHaveLength(2);
        if (target === "sign-in tab") {
          await signIn?.close();
          // The request tab remains open, reproducing Cmd+W on just sign-in.
          expect(requestPage?.isClosed()).toBe(false);
        } else await context.close();
        await vi.waitFor(
          async () =>
            expect(await f.connection.status()).toMatchObject({
              state: "action_required",
              setupError: "browser_unavailable",
              setupStage: "sign_in",
            }),
          { timeout: 5000 },
        );
        await f.signIn();
        expect(await f.connection.status()).toEqual({
          state: "ready",
          parish: "example-parish",
        });
        expect(f.state.external).toBe(0);
      },
      60_000,
    );

    it("keeps one Chromium process and uses only one POST for a warm named addition", async () => {
      const f = await fixture();
      await f.signIn();
      await f.connection.groups();
      f.visits.length = 0;
      expect(
        await f.connection.addMemberByName("Volunteers", {
          firstName: "Alex",
          lastName: "Rivera",
          email: "alex@example.test",
        }),
      ).toEqual({ success: true });
      expect(f.visits).toEqual([
        { path: "group/102/addToGroupByAdmin", method: "POST" },
      ]);
      expect(await f.connection.count("101")).toBe(4);
      expect(f.state.launches).toBe(1);
      expect(f.state.external).toBe(0);
      await f.connection.close();
      expect(await f.connection.count("101")).toBe(4);
      expect(f.state.launches).toBe(2);
      expect(f.state.restoredParishPage).toBe(false);
    }, 60_000);

    it("keeps a session-only cookie through browser restarts and serves structured MCP operations", async () => {
      const f = await fixture();
      await f.signIn();
      // Explicit owner shutdowns exercise cookie reuse with the production lifecycle.
      await f.connection.close();
      const server = createFlocknoteServer(f.connection);
      const client = new Client({ name: "fictional-codex", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      cleanup.unshift(() => client.close());
      const groups = await client.callTool({ name: "flocknote_groups" });
      expect(groups.structuredContent).toMatchObject({
        ok: true,
        groups: [{ id: "101" }, { id: "102" }],
      });
      await f.connection.close();
      const count = await client.callTool({
        name: "flocknote_subscriber_count",
        arguments: { groupId: "101" },
      });
      expect(count.structuredContent).toEqual({
        ok: true,
        groupId: "101",
        subscriberCount: 4,
      });
      await f.connection.close();
      const member = await client.callTool({
        name: "flocknote_add_member",
        arguments: {
          groupId: "102",
          firstName: "Alex",
          lastName: "Rivera",
          email: "alex@example.test",
        },
      });
      expect(member.structuredContent).toEqual({ ok: true, success: true });
      expect(JSON.stringify([groups, count, member])).not.toMatch(
        /fictional-browser-session|private@example/,
      );
      expect(
        readFileSync(join(f.profile, "connection.json"), "utf8"),
      ).not.toMatch(/fictional-browser-session|private@example/);
      expect(
        f.visits.filter(({ path }) => path === "fictional-sign-in"),
      ).toHaveLength(1);
      expect(f.state.external).toBe(0);
      expect(f.state.restoredParishPage).toBe(false);
      f.state.expired = true;
      expect(await f.connection.status()).toMatchObject({ state: "ready" });
      await expect(f.connection.count("101")).rejects.toMatchObject({
        code: "authentication_required",
      });
      expect(await f.connection.status()).toMatchObject({
        state: "action_required",
      });
      await f.signIn();
      expect(await f.connection.count("101")).toBe(4);
    }, 60_000);

    it.each(["http403", "json", "html"])(
      "confirms expiry only after an operation fails (%s)",
      async (mode) => {
        const f = await fixture();
        await f.signIn();
        f.visits.length = 0;
        f.state.expired = true;
        f.state.authFailure = mode;
        expect(await f.connection.status()).toMatchObject({ state: "ready" });
        expect(f.visits).toHaveLength(0);
        await expect(f.connection.count("101")).rejects.toMatchObject({
          code: "authentication_required",
        });
        expect(f.visits).toEqual([
          { path: "group/101/getSubscriberCount", method: "GET" },
          { path: "user/userData", method: "GET" },
        ]);
        expect(await f.connection.status()).toMatchObject({
          state: "action_required",
        });
        expect(f.state.external).toBe(0);
      },
      60_000,
    );

    it("never replays a membership POST after confirming an expired session", async () => {
      const f = await fixture();
      await f.signIn();
      await f.connection.groups();
      f.visits.length = 0;
      f.state.expired = true;
      f.state.authFailure = "json";
      await expect(
        f.connection.addMemberByName("Volunteers", {
          firstName: "Alex",
          lastName: "Rivera",
          email: "alex@example.test",
        }),
      ).rejects.toMatchObject({
        code: "authentication_required",
        outcome: "unknown",
      });
      expect(f.visits).toEqual([
        { path: "group/102/addToGroupByAdmin", method: "POST" },
        { path: "user/userData", method: "GET" },
      ]);
      expect(await f.connection.status()).toMatchObject({
        state: "action_required",
      });
    }, 60_000);

    it("rejects redirects and oversized responses, and never repeats a disconnected write", async () => {
      const f = await fixture();
      await f.signIn();
      f.state.redirect = true;
      await expect(f.connection.count("101")).rejects.toMatchObject({
        code: "redirect_rejected",
      });
      f.state.redirect = false;
      f.state.oversized = true;
      await expect(f.connection.count("101")).rejects.toMatchObject({
        code: "invalid_response",
      });
      f.state.rejectWrite = true;
      await expect(
        f.connection.addMember("102", {
          firstName: "Alex",
          lastName: "Rivera",
          email: "alex@example.test",
        }),
      ).rejects.toMatchObject({ outcome: "unknown" });
      expect(
        f.visits.filter(
          ({ method, path }) =>
            method === "POST" && path.endsWith("addToGroupByAdmin"),
        ),
      ).toHaveLength(1);
      expect(f.state.external).toBe(0);
    }, 60_000);
  },
);
