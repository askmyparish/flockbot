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
import { searchMetadata, searchRow } from "../fixtures/member-search.js";
import { profileResponse } from "../fixtures/member-profile.js";
import { membershipResponse } from "../fixtures/member-groups.js";
import { rosterPage, rosterRow } from "../fixtures/group-members.js";

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
    searchForms: [] as string[],
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
        } else if (
          (path === "group/101/people" || path === "group/102/people") &&
          url.search === "?ajax" &&
          request.method() === "POST"
        ) {
          await json({
            ...searchMetadata(),
            ...rosterPage(
              Array.from({ length: 100 }, (_, i) =>
                rosterRow(301 + i, "Alex", `Example${i}`),
              ),
              path === "group/102/people",
              path === "group/102/people" ? 102 : 101,
            ),
          });
        } else if (
          path === "group/102/people/100" &&
          url.search === "?ajax&more" &&
          request.method() === "POST"
        ) {
          await json(rosterPage([rosterRow(401)], false, null));
        } else if (
          (path === "group/101/filter" || path === "group/102/filter") &&
          request.method() === "POST"
        ) {
          state.searchForms.push(request.postData() ?? "");
          await json({
            success: true,
            results: [
              {
                ...searchRow(),
                date:
                  path === "group/102/filter" ? "Apr 6, 2026" : "Mar 5, 2026",
              },
            ],
            resultCount: 1,
          });
        } else if (path === "user/301/profile" && request.method() === "POST") {
          await json(profileResponse());
        } else if (path === "user/301/groups" && request.method() === "POST") {
          const response = membershipResponse();
          response.data.subscribedGroups = response.data.subscribedGroups.map(
            (group) =>
              group.groupID === 102
                ? { ...group, groupName: "Volunteers" }
                : group,
          );
          await json(response);
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
    it("lists a named group across pages through browser fetch and MCP", async () => {
      const f = await fixture();
      await f.signIn();
      await f.connection.groups();
      f.visits.length = 0;
      const server = createFlocknoteServer(f.connection);
      const client = new Client({
        name: "fictional-roster-workflow",
        version: "1",
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      cleanup.unshift(() => client.close());
      const first = await client.callTool({
        name: "group_members",
        arguments: { groupName: "Volunteers" },
      });
      expect(first.structuredContent).toMatchObject({
        ok: true,
        groupId: "102",
        returnedCount: 100,
        hasMore: true,
        nextOffset: 100,
      });
      const last = await client.callTool({
        name: "group_members",
        arguments: { groupId: "102", offset: 100, fields: ["joinedOn"] },
      });
      expect(last.structuredContent).toMatchObject({
        ok: true,
        offset: 100,
        members: [{ id: "401", joinedOn: "2026-03-05" }],
        returnedCount: 1,
        hasMore: false,
        nextOffset: null,
      });
      expect(JSON.stringify([first, last])).not.toMatch(/alex@|555/);
      expect(JSON.stringify(first)).not.toContain("joinedOn");
      expect(f.visits).toEqual([
        { path: "group/102/people", method: "POST" },
        { path: "group/102/people/100", method: "POST" },
      ]);
      expect(f.state.external).toBe(0);
      expect(f.state.launches).toBe(1);
    }, 60_000);

    it("finds a person, reads selected contact details and checks subscriptions through actual browser fetch and MCP", async () => {
      const f = await fixture();
      await f.signIn();
      await f.connection.groups();
      f.visits.length = 0;
      const server = createFlocknoteServer(f.connection);
      const client = new Client({
        name: "fictional-member-workflow",
        version: "1",
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      cleanup.unshift(() => client.close());
      const found = await client.callTool({
        name: "find_members",
        arguments: { searchTerm: "Alex Rivera" },
      });
      expect(found.structuredContent).toMatchObject({
        ok: true,
        complete: true,
        exactMatchUserId: "301",
        members: [{ id: "301", firstName: "Alex", lastName: "Rivera" }],
      });
      expect(JSON.stringify(found)).not.toMatch(/alex@|555/);
      const joined = await client.callTool({
        name: "find_members",
        arguments: {
          searchTerm: "alex@example.test",
          groupName: "Volunteers",
          fields: ["email", "joinedOn"],
        },
      });
      expect(joined.structuredContent).toMatchObject({
        ok: true,
        groupId: "102",
        exactMatchUserId: "301",
        members: [{ id: "301", joinedOn: "2026-04-06" }],
      });
      const userId = String(
        (found.structuredContent as Record<string, unknown>).exactMatchUserId,
      );
      const person = await client.callTool({
        name: "member",
        arguments: { userId, fields: ["email"] },
      });
      expect(person.structuredContent).toMatchObject({
        ok: true,
        member: {
          id: userId,
          email: {
            value: "alex@example.test",
            verified: false,
            isBadEmail: true,
          },
        },
      });
      expect(JSON.stringify(person)).not.toMatch(/555|pending|canEdit/);
      const groups = await client.callTool({
        name: "member_groups",
        arguments: { userId },
      });
      expect(groups.structuredContent).toMatchObject({
        ok: true,
        userId,
        groups: [
          { id: "101", name: "Everyone" },
          { id: "102", name: "Volunteers" },
        ],
        complete: false,
        truncated: false,
      });
      const named = await client.callTool({
        name: "is_member",
        arguments: { userId, groupName: "Volunteers" },
      });
      expect(named.structuredContent).toMatchObject({
        ok: true,
        userId,
        groupId: "102",
        membership: "member",
      });
      for (const [groupId, membership] of [
        ["103", "not_member"],
        ["104", "unknown"],
      ]) {
        const result = await client.callTool({
          name: "is_member",
          arguments: { userId, groupId },
        });
        expect(result.structuredContent).toMatchObject({
          ok: true,
          userId,
          groupId,
          membership,
        });
      }
      expect(f.visits).toEqual([
        { path: "group/101/people", method: "POST" },
        { path: "group/101/filter", method: "POST" },
        { path: "group/102/people", method: "POST" },
        { path: "group/102/filter", method: "POST" },
        { path: "user/301/profile", method: "POST" },
        ...Array.from({ length: 4 }, () => ({
          path: "user/301/groups",
          method: "POST",
        })),
      ]);
      expect(
        Object.fromEntries(new URLSearchParams(f.state.searchForms[0])),
      ).toEqual({
        "request[and][0][or][0][and][0][filterID]": "17",
        "request[and][0][or][0][and][0][isNegated]": "false",
        "request[and][0][or][0][and][0][inputs][searchTerm]": "Alex Rivera",
        includeInactive: "false",
      });
      const diagnostic = await client.callTool({
        name: "member_communication_status",
        arguments: { userId, groupId: "102" },
      });
      expect(diagnostic.structuredContent).toMatchObject({
        ok: true,
        membership: "member",
        email: {
          preference: "enabled",
          contactPresent: true,
          verified: false,
          isBadEmail: true,
        },
        sms: {
          preference: "disabled",
          contactPresent: true,
          verified: true,
          stopReplied: null,
        },
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(/alex@|555|userInfo/);
      expect(f.visits.slice(-2)).toEqual([
        { path: "user/301/groups", method: "POST" },
        { path: "user/301/profile", method: "POST" },
      ]);
      expect(f.state.external).toBe(0);
      expect(f.state.launches).toBe(1);
    }, 60_000);

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
      const groups = await client.callTool({ name: "groups" });
      expect(groups.structuredContent).toMatchObject({
        ok: true,
        groups: [{ id: "101" }, { id: "102" }],
      });
      await f.connection.close();
      const count = await client.callTool({
        name: "subscriber_count",
        arguments: { groupId: "101" },
      });
      expect(count.structuredContent).toEqual({
        ok: true,
        groupId: "101",
        subscriberCount: 4,
      });
      await f.connection.close();
      const member = await client.callTool({
        name: "add_member",
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
