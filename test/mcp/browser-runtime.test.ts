import {
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { filterCatalog } from "../fixtures/member-filters.js";
import { profileResponse } from "../fixtures/member-profile.js";
import { membershipResponse } from "../fixtures/member-groups.js";
import { rosterPage, rosterRow } from "../fixtures/group-members.js";
import { latestEmailResponses } from "../fixtures/latest-email.js";
import { noteSearchResponse } from "../fixtures/note-search.js";
import { noteResponse } from "../fixtures/note.js";
import { duplicationFixture } from "../fixtures/email-duplication.js";
import { recipientPage } from "../fixtures/email-recipients.js";
import {
  draftInput,
  draftResponse,
  htmlDraftInput,
  htmlDraftStored,
  blockDraftInput,
  blockDraftResponse,
  imageDraftInput,
  imageDraftResponse,
} from "../fixtures/email-draft.js";
import { safeDiagnostic } from "../../adapters/mcp/src/diagnostics.js";
import { FailureLog } from "../../adapters/mcp/src/failure-log.js";
import { BrowserService } from "../../adapters/mcp/src/browser-broker.js";
import { waitFor } from "./support.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** Every page/API request is fulfilled here. DNS is disabled in the browser too. */
async function fixture() {
  const profile = mkdtempSync(join(tmpdir(), "flockbot-real-browser-"));
  const origin = "https://example-parish.flocknote.com";
  const visits: { path: string; method: string }[] = [];
  const emailResponses: Record<string, unknown> = latestEmailResponses();
  const blocks = blockDraftResponse();
  const images = imageDraftResponse();
  const duplication = duplicationFixture();
  const state = {
    duplicate: false,
    draft: false,
    draftBlocks: false,
    draftImages: false,
    uploads: [] as {
      fields: string[];
      filename: string;
      mime: string;
      size: string;
      bytes: Uint8Array;
      cookie: string | null;
    }[],
    draftHtml: undefined as string | undefined,
    launches: 0,
    expired: false,
    authFailure: "http401",
    rejectWrite: false,
    redirect: false,
    oversized: false,
    countResponse: null as {
      status: number;
      contentType: string;
      body: string;
    } | null,
    external: 0,
    restoredParishPage: false,
    searchForms: [] as string[],
    responses: {} as Record<
      string,
      { status: number; body: string; delayMs?: number }
    >,
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
        const override = state.responses[path];
        if (override) {
          if (override.delayMs)
            await new Promise((resolve) =>
              setTimeout(resolve, override.delayMs),
            );
          await route.fulfill({
            status: override.status,
            body: override.body,
            contentType: "application/json",
          });
          return;
        }
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
        } else if (
          ["?ajax", "?ajax&more"].includes(url.search) &&
          Object.hasOwn(emailResponses, `${path}${url.search}`)
        ) {
          const value = emailResponses[`${path}${url.search}`];
          if (path.endsWith("searchAnalytics")) {
            expect(request.method()).toBe("POST");
            expect(request.postData()).toBe("s=Rivera");
          } else expect(request.method()).toBe("GET");
          if (typeof value === "string")
            await route.fulfill({ contentType: "text/html", body: value });
          else await json(value);
        } else if (state.duplicate) {
          const value = duplication.response(
            path,
            request.postData() ?? undefined,
          );
          if (typeof value === "string")
            await route.fulfill({ contentType: "text/html", body: value });
          else await json(value);
        } else if (state.draft) {
          if (path === "upload/photo/note") {
            const form = await new Response(
              new Uint8Array(request.postDataBuffer()!),
              {
                headers: { "Content-Type": request.headers()["content-type"]! },
              },
            ).formData();
            const file = form.get("qqfile") as File;
            state.uploads.push({
              fields: [...form.keys()],
              filename: file.name,
              mime: file.type,
              size: String(form.get("qqtotalfilesize")),
              bytes: new Uint8Array(await file.arrayBuffer()),
              cookie: await request.headerValue("cookie"),
            });
            expect(form.get("qquuid")).toMatch(/^[0-9a-f-]{36}$/);
            expect(form.get("qqfilename")).toBe(file.name);
          }
          const value = state.draftImages
            ? images(`${path}${url.search}`, request.postData() ?? undefined)
            : state.draftBlocks
              ? blocks(`${path}${url.search}`, request.postData() ?? undefined)
              : draftResponse(
                  `${path}${url.search}`,
                  request.postData() ?? undefined,
                  state.draftHtml,
                );
          if (typeof value === "string")
            await route.fulfill({ contentType: "text/html", body: value });
          else await json(value);
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
          await json({ success: true, networkID: 201, everyoneGroupID: 101 });
        } else if (
          path === "note/801/detailedAnalytics" &&
          url.search === "?ajax"
        ) {
          expect(request.method()).toBe("POST");
          expect(request.postData()).toBe("type=opened&page=1");
          await json(recipientPage());
        } else if (path === "composer/editNote") {
          expect(request.method()).toBe("POST");
          expect(request.postData()).toBe("noteID=801&fromComposer=1");
          await json(noteResponse());
        } else if (path === "supersearch/query" && url.search === "?ajax") {
          expect(request.method()).toBe("POST");
          const form = new URLSearchParams(request.postData() ?? "");
          expect(form.getAll("filters[]")).toEqual([
            "note",
            "event",
            "file",
            "user",
            "group",
            "comment",
          ]);
          expect(form.get("networkID")).toBe("201");
          expect(form.get("searchTerm")).toBe("choir + plans");
          await json(noteSearchResponse());
        } else if (
          path === "group/104/people" &&
          url.search === "?ajax" &&
          request.method() === "POST"
        ) {
          await json({
            ...filterCatalog(),
            groupID: "104",
            isEveryoneGroup: 0,
          });
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
          (path === "group/101/filter" ||
            path === "group/102/filter" ||
            path === "group/104/filter") &&
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
          if (state.countResponse) await route.fulfill(state.countResponse);
          else if (state.redirect)
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
    emailResponses,
    context: () => context,
    origin,
  };
}

describe.skipIf(process.env.FLOCKBOT_BROWSER_TESTS !== "1")(
  "real Chromium with offline Flocknote fixtures",
  () => {
    it("uploads image bytes as authenticated multipart through MCP without leaking file data", async () => {
      const f = await fixture();
      await f.signIn();
      f.state.draft = true;
      f.state.draftImages = true;
      const first = join(f.profile, "private-photo.jpg"),
        second = join(f.profile, "other.png");
      const jpeg = Buffer.from([
        255, 216, 255, 224, 13, 10, 0, 128, 255, 34, 65,
      ]);
      const png = Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10, 255, 0, 13, 10,
      ]);
      writeFileSync(first, jpeg);
      writeFileSync(second, png);
      const server = createFlocknoteServer(f.connection);
      const client = new Client({
        name: "fictional-image-client",
        version: "1",
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      cleanup.unshift(() => client.close());
      const result = await client.callTool({
        name: "create_email_draft",
        arguments: {
          ...imageDraftInput(first, second),
          verboseDiagnostics: true,
        },
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        verified: true,
        noteId: "803",
      });
      expect(f.state.uploads.map((x) => Buffer.from(x.bytes))).toEqual([
        jpeg,
        png,
      ]);
      expect(f.state.uploads.map((x) => [x.filename, x.mime, x.size])).toEqual([
        [
          expect.stringMatching(/^[0-9a-f-]{36}\.jpg$/),
          "image/jpeg",
          String(jpeg.length),
        ],
        [
          expect.stringMatching(/^[0-9a-f-]{36}\.png$/),
          "image/png",
          String(png.length),
        ],
      ]);
      for (const upload of f.state.uploads) {
        expect(upload.fields).toEqual([
          "qquuid",
          "qqfilename",
          "qqtotalfilesize",
          "qqfile",
        ]);
        expect(upload.cookie).toContain("Flocknote=fictional-browser-session");
      }
      expect(JSON.stringify(result)).not.toContain(first);
      expect(JSON.stringify(result)).not.toContain(jpeg.toString("base64"));
      expect(JSON.stringify(result)).not.toContain("fictional-browser-session");
      expect(f.state.external).toBe(0);
    });

    it("duplicates through real Chromium fetch without sending, uploading or rewriting modules", async () => {
      const f = await fixture();
      await f.signIn();
      f.state.duplicate = true;
      f.visits.length = 0;
      expect(
        await f.connection.duplicateEmailDraft({ noteId: "801" }),
      ).toMatchObject({
        noteId: "803",
        status: "draft",
        verified: true,
        groupIds: ["101", "102"],
      });
      expect(f.visits.map((v) => `${v.method} ${v.path}`)).toEqual([
        "POST composer/editNote",
        "GET network/getMetadata",
        "GET dashboard",
        "POST composer/duplicateNote",
        "POST composer/save2",
        "POST composer/save2",
        "POST composer/editNote",
      ]);
      expect(f.state.external).toBe(0);
    });

    it.each([draftInput, htmlDraftInput, blockDraftInput])(
      "creates an unscheduled draft through the actual browser fetch allowlist: $bodyFormat",
      async (input) => {
        const f = await fixture();
        await f.signIn();
        f.state.draft = true;
        f.state.draftBlocks = "content" in input;
        f.state.draftHtml = "bodyFormat" in input ? htmlDraftStored : undefined;
        const start = f.visits.length;
        expect(await f.connection.createEmailDraft(input)).toMatchObject({
          noteId: "803",
          verified: true,
          status: "draft",
        });
        expect(f.visits.slice(start).map((v) => v.path)).toEqual([
          "dashboard",
          "network/getMetadata",
          "network/501/writeNewNote",
          "composer/createNote",
          "composer/save2",
          "composer/saveModule",
          ...("content" in input
            ? [
                "composer/saveModule",
                "composer/saveModule",
                "composer/saveModule",
              ]
            : []),
          "composer/saveSection",
          "composer/saveLayout",
          "composer/save2",
          "composer/save2",
          "composer/editNote",
        ]);
        expect(f.state.external).toBe(0);
      },
    );
    it("runs verbose reads, writes and cancellation through MCP and a real Chromium broker process", async () => {
      const profile = realpathSync(
        mkdtempSync(join(tmpdir(), "flockbot-verbose-browser-")),
      );
      writeFileSync(
        join(profile, "connection.json"),
        JSON.stringify({
          version: 1,
          generation: randomUUID(),
          parish: "example-parish",
          userId: "201",
          state: "ready",
        }),
        { mode: 0o600 },
      );
      const entry = join(profile, "worker.mjs");
      const playwright = resolve("node_modules/playwright/index.mjs");
      await build({
        entryPoints: ["test/mcp/fixtures/verbose-browser-worker.ts"],
        outfile: entry,
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        alias: { playwright },
        external: [playwright],
        logLevel: "silent",
        banner: {
          js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
        },
      });
      // Permit only the disposable owner's authenticated Unix socket.
      const blocked = vi
        .mocked(net.Socket.prototype.connect)
        .getMockImplementation();
      vi.mocked(net.Socket.prototype.connect).mockRestore();
      const native = net.Socket.prototype.connect;
      const socket = vi
        .spyOn(net.Socket.prototype, "connect")
        .mockImplementation(function (this: net.Socket, ...args: unknown[]) {
          const expected = JSON.parse(
            readFileSync(join(profile, "broker.json"), "utf8"),
          ).address;
          if ((args[0] as { path?: string })?.path !== expected)
            throw new Error("Unexpected test socket");
          return Reflect.apply(native, this, args) as net.Socket;
        });
      const service = new BrowserService({
        entry,
        profile,
        launch: () => {
          spawn(process.execPath, [entry, profile], { stdio: "ignore" });
        },
      });
      const log = new FailureLog({
        directory: join(profile, "diagnostics-v2"),
      });
      const client = new Client({ name: "fictional-full-path", version: "1" });
      cleanup.push(async () => {
        rmSync(join(profile, "hold"), { force: true });
        await client.close();
        await service.shutdown();
        await waitFor(() =>
          expect(existsSync(join(profile, "broker.json"))).toBe(false),
        );
        socket.mockRestore();
        if (blocked)
          vi.spyOn(net.Socket.prototype, "connect").mockImplementation(blocked);
        rmSync(profile, { recursive: true, force: true });
      });
      const server = createFlocknoteServer(service, { failureLog: log });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      const reads = await Promise.all([
        client.callTool({
          name: "subscriber_count",
          arguments: { groupId: "101", verboseDiagnostics: true },
        }),
        client.callTool({
          name: "subscriber_count",
          arguments: { groupId: "102" },
        }),
      ]);
      expect(reads[0]?.structuredContent).toMatchObject({
        code: "invalid_response",
        verboseDiagnostic: { available: true, traceSaved: true },
      });
      expect(reads[1]?.structuredContent).toEqual({
        ok: true,
        groupId: "102",
        subscriberCount: 9,
      });
      expect(JSON.stringify(reads)).not.toMatch(/1,23|alex@example|EXCLUDE_ME/);
      const saved = () =>
        JSON.parse(
          readFileSync(join(profile, "diagnostics-v2/failures.jsonl"), "utf8")
            .trim()
            .split("\n")
            .at(-1) ?? "null",
        );
      expect(
        readFileSync(join(profile, "diagnostics-v2/failures.jsonl"), "utf8")
          .trim()
          .split("\n"),
      ).toHaveLength(1);
      expect(JSON.parse(saved().exchanges[0].response.json)).toEqual({
        subscriberCount: "1,23",
        email: "alex@example.test",
        PHPSESSID: "[redacted]",
      });
      const args = {
        groupId: "102",
        firstName: "Alex",
        lastName: "Example",
        email: "alex@example.test",
        verboseDiagnostics: true,
      };
      const written = await client.callTool({
        name: "add_member",
        arguments: args,
      });
      expect(written.structuredContent).toMatchObject({
        ok: true,
        verboseDiagnostic: { traceSaved: true, available: true },
      });
      const writeTrace = saved();
      expect(writeTrace.exchanges).toHaveLength(1);
      expect(JSON.parse(writeTrace.exchanges[0].request.json)).toMatchObject({
        email: ["alex@example.test"],
        fname: ["Alex"],
      });
      expect(JSON.stringify(writeTrace)).not.toContain("EXCLUDE_ME_73");
      writeFileSync(join(profile, "reject-write"), "1");
      const rejected = await client.callTool({
        name: "add_member",
        arguments: args,
      });
      expect(rejected.structuredContent).toMatchObject({
        ok: false,
        outcome: "unknown",
        verboseDiagnostic: { traceSaved: true },
      });
      writeFileSync(join(profile, "hold"), "1");
      const abort = new AbortController();
      const pending = client.callTool(
        {
          name: "subscriber_count",
          arguments: { groupId: "103", verboseDiagnostics: true },
        },
        undefined,
        { signal: abort.signal },
      );
      const rejection = expect(pending).rejects.toThrow();
      await waitFor(() =>
        expect(readFileSync(join(profile, "events"), "utf8")).toContain(
          "group/103/getSubscriberCount",
        ),
      );
      abort.abort();
      await rejection;
      await waitFor(() =>
        expect(saved()).toMatchObject({
          outcome: "failure",
          available: false,
          diagnostic: { final: { code: "operation_cancelled" } },
        }),
      );
      rmSync(join(profile, "hold"));
      // A subsequent ordinary read cannot inherit capture from the cancelled call.
      const after = await client.callTool({
        name: "subscriber_count",
        arguments: { groupId: "102" },
      });
      expect(after.structuredContent).toEqual({
        ok: true,
        groupId: "102",
        subscriberCount: 9,
      });
      for (const verboseDiagnostics of [true, false]) {
        const email = await client.callTool({
          name: "member_latest_email_status",
          arguments: { userId: "301", groupId: "101", verboseDiagnostics },
        });
        expect(email.structuredContent).toMatchObject({
          ok: false,
          code: "invalid_response",
          diagnostic: {
            failure: {
              endpoint: "group/{id}/notes",
              reason: "unexpected_html",
            },
            authentication: "authenticated",
          },
        });
        expect(JSON.stringify(email)).not.toMatch(
          /data-date|EXCLUDE_ME_73|Draft|Sent by/,
        );
        const trace = saved();
        if (verboseDiagnostics) {
          expect(trace.exchanges).toHaveLength(2);
          expect(trace.exchanges[0].response).toMatchObject({
            state: "captured",
            format: "html",
          });
          const elements = JSON.parse(
            trace.exchanges[0].response.json,
          ).elements;
          expect(
            elements
              .filter((element: { attributes: Record<string, string> }) =>
                Object.hasOwn(element.attributes, "data-date"),
              )
              .map(
                (element: { attributes: Record<string, string> }) =>
                  element.attributes["data-date"],
              ),
          ).toEqual(["1800000000", "0"]);
          expect(trace.exchanges[0].response.json).toContain("Draft");
          expect(email.structuredContent).toMatchObject({
            verboseDiagnostic: { traceSaved: true, available: true },
          });
        } else {
          expect(trace.exchanges).toBeUndefined();
          expect(JSON.stringify(trace)).not.toMatch(/data-date|Draft|Sent by/);
        }
      }
      const visits = readFileSync(join(profile, "events"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(visits).toEqual([
        { path: "group/101/getSubscriberCount", method: "GET" },
        { path: "group/102/getSubscriberCount", method: "GET" },
        { path: "group/102/addToGroupByAdmin", method: "POST" },
        { path: "group/102/addToGroupByAdmin", method: "POST" },
        { path: "group/103/getSubscriberCount", method: "GET" },
        { path: "group/102/getSubscriberCount", method: "GET" },
        { path: "group/101/notes", method: "GET" },
        { path: "user/userData", method: "GET" },
        { path: "group/101/notes", method: "GET" },
        { path: "user/userData", method: "GET" },
      ]);
      expect(existsSync(join(profile, "external"))).toBe(false);
      expect(
        readFileSync(join(profile, "diagnostics-v2/failures.jsonl"), "utf8"),
      ).not.toMatch(/EXCLUDE_ME_73|normal@example/);
    }, 60_000);

    it("captures rejected counts locally only when explicitly requested, without additional requests", async () => {
      const f = await fixture();
      await f.signIn();
      const failureLog = new FailureLog({
        directory: join(realpathSync(f.profile), "diagnostics-v2"),
      });
      const server = createFlocknoteServer(f.connection, { failureLog });
      const client = new Client({ name: "fictional-verbose", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      cleanup.unshift(() => client.close());
      for (const [verboseDiagnostics, subscriberCount, expected] of [
        [true, "1,23", null],
        [false, "2,34", null],
        [true, 7, 7],
        [true, "4,716", 4716],
      ] as const) {
        f.state.countResponse = {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            subscriberCount,
            email: "alex@example.test",
            credentials: { token: "CREDENTIAL_SENTINEL" },
          }),
        };
        f.visits.length = 0;
        const result = await client.callTool({
          name: "subscriber_count",
          arguments: { groupId: "101", verboseDiagnostics },
        });
        expect(result.structuredContent).toMatchObject(
          expected !== null
            ? { ok: true, subscriberCount: expected }
            : {
                ok: false,
                code: "invalid_response",
                diagnostic: { failure: { reason: "subscriber_count_invalid" } },
              },
        );
        expect(JSON.stringify(result)).not.toMatch(
          /alex@example|CREDENTIAL_SENTINEL|1,23|2,34|4,716/,
        );
        expect(f.visits).toEqual([
          { path: "group/101/getSubscriberCount", method: "GET" },
        ]);
        const saved = JSON.parse(
          (await failureLog.read())?.trim().split("\n").at(-1) ?? "null",
        );
        if (verboseDiagnostics) {
          expect(saved).toMatchObject({
            version: 2,
            kind: "verbose",
            traceSaved: true,
            available: true,
          });
          expect(saved.exchanges).toHaveLength(1);
          expect(JSON.parse(saved.exchanges[0].response.json)).toEqual({
            subscriberCount,
            email: "alex@example.test",
            credentials: "[redacted]",
          });
          expect(result.structuredContent).toMatchObject({
            verboseDiagnostic: {
              operationId: saved.operationId,
              traceSaved: true,
            },
          });
        } else {
          expect(saved.version).toBe(1);
          expect(JSON.stringify(saved)).not.toMatch(/alex@example|2,34/);
        }
      }
      f.state.countResponse = {
        status: 200,
        contentType: "text/html",
        body: "<form>CREDENTIAL_SENTINEL</form>",
      };
      f.visits.length = 0;
      await client.callTool({
        name: "subscriber_count",
        arguments: { groupId: "101", verboseDiagnostics: true },
      });
      const auth = JSON.parse(
        (await failureLog.read())?.trim().split("\n").at(-1) ?? "null",
      );
      expect(
        auth.exchanges.map((entry: { response: unknown }) => entry.response),
      ).toEqual([
        expect.objectContaining({ state: "captured", format: "html" }),
        { state: "omitted", reason: "authentication" },
      ]);
      expect(JSON.stringify(auth)).not.toContain("CREDENTIAL_SENTINEL");
      expect(f.visits.map((r) => r.path)).toEqual([
        "group/101/getSubscriberCount",
        "user/userData",
      ]);
      expect(f.state.external).toBe(0);
    }, 60_000);

    it("distinguishes transport, model and authentication failures without leaking or replaying", async () => {
      const f = await fixture();
      await f.signIn();
      const failureLog = new FailureLog({
        directory: join(realpathSync(f.profile), "diagnostics-v1"),
      });
      const server = createFlocknoteServer(f.connection, { failureLog });
      const client = new Client({
        name: "fictional-diagnostics",
        version: "1",
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      cleanup.unshift(() => client.close());
      for (const [body, contentType, status, reason, diagnosis] of [
        [
          '{"subscriberCount":"PRIVATE"}',
          "application/json",
          200,
          "subscriber_count_invalid",
          "not_attempted",
        ],
        [
          '{"PRIVATE":',
          "application/json",
          200,
          "invalid_json",
          "not_attempted",
        ],
        ["", "application/json", 200, "empty_response", "not_attempted"],
        ["PRIVATE", "text/plain", 503, "http_rejection", "not_attempted"],
        [
          '{"success":false}',
          "application/json",
          200,
          "success_false",
          "not_attempted",
        ],
        [
          "<form>PRIVATE</form>",
          "text/html",
          200,
          "unexpected_html",
          "authenticated",
        ],
      ] as const) {
        f.state.countResponse = { body, contentType, status };
        f.visits.length = 0;
        const result = await client.callTool({
          name: "subscriber_count",
          arguments: { groupId: "101" },
        });
        expect(result.isError).toBe(true);
        const diagnostic = safeDiagnostic(
          (result.structuredContent as Record<string, unknown> | undefined)
            ?.diagnostic,
        );
        expect(diagnostic?.failure.reason).toBe(reason);
        expect(diagnostic?.traceSaved).toBe(true);
        const saved = (await failureLog.read())
          ?.trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(saved?.at(-1)).toEqual(diagnostic);
        const stage = [
          "subscriber_count_invalid",
          "unexpected_html",
          "success_false",
        ].includes(reason)
          ? "validation"
          : "transport";
        expect(diagnostic?.failure).toMatchObject({
          stage,
          status,
          endpoint: "group/{id}/getSubscriberCount",
          method: "GET",
        });
        expect(diagnostic?.final.stage).toBe(stage);
        expect(diagnostic?.authentication).toBe(diagnosis);
        expect(diagnostic?.events[0]).toMatchObject({
          endpoint: "group/{id}/getSubscriberCount",
          method: "GET",
          status,
          contentType:
            contentType === "application/json"
              ? "json"
              : contentType === "text/html"
                ? "html"
                : "text",
        });
        if (status === 200)
          expect(diagnostic?.events[0]?.bytes).toBe(Buffer.byteLength(body));
        expect(f.visits.map((r) => r.path)).toEqual(
          diagnosis === "authenticated"
            ? ["group/101/getSubscriberCount", "user/userData"]
            : ["group/101/getSubscriberCount"],
        );
        expect(JSON.stringify(diagnostic)).not.toMatch(
          /PRIVATE|example-parish|fictional-browser-session|group\/101/,
        );
      }
      f.state.countResponse = null;
      f.state.expired = true;
      f.visits.length = 0;
      const expired = await client.callTool({
        name: "subscriber_count",
        arguments: { groupId: "101" },
      });
      expect(expired.structuredContent).toMatchObject({
        code: "authentication_required",
        diagnostic: {
          authentication: "sign_in_required",
          failure: { code: "upstream_rejected", status: 401 },
          final: { code: "authentication_required" },
        },
      });
      expect(f.visits.map((r) => r.path)).toEqual([
        "group/101/getSubscriberCount",
        "user/userData",
      ]);
      expect(
        JSON.parse(
          (await failureLog.read())?.trim().split("\n").at(-1) ?? "null",
        ),
      ).toEqual(
        (expired.structuredContent as Record<string, unknown>)?.diagnostic,
      );
      expect(f.state.external).toBe(0);
    }, 60_000);

    it("attributes parallel transport failures and delayed model validation to their actual responses", async () => {
      const f = await fixture();
      await f.signIn();
      const server = createFlocknoteServer(f.connection);
      const client = new Client({ name: "fictional-provenance", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      cleanup.unshift(() => client.close());
      for (const [
        navigationStatus,
        navigationBody,
        metadataStatus,
        metadataBody,
        endpoint,
        reason,
        stage,
      ] of [
        [
          500,
          "{}",
          200,
          '{"everyoneGroupID":101}',
          "navigation/groups",
          "http_rejection",
          "transport",
        ],
        [
          500,
          "{}",
          502,
          "{}",
          "navigation/groups",
          "http_rejection",
          "transport",
        ],
        [
          200,
          '{"success":false}',
          200,
          '{"everyoneGroupID":101}',
          "navigation/groups",
          "success_false",
          "validation",
        ],
        [
          200,
          '{"groups":"PRIVATE"}',
          200,
          '{"everyoneGroupID":101}',
          "navigation/groups",
          "navigation_groups_shape",
          "validation",
        ],
        [
          200,
          '{"groups":[]}',
          200,
          '{"everyoneGroupID":false}',
          "network/getMetadata",
          "expected_text",
          "validation",
        ],
      ] as const) {
        f.state.responses["navigation/groups"] = {
          status: navigationStatus,
          body: navigationBody,
        };
        f.state.responses["network/getMetadata"] = {
          status: metadataStatus,
          body: metadataBody,
          delayMs: 60,
        };
        f.visits.length = 0;
        const result = await client.callTool({ name: "groups", arguments: {} });
        expect(result.structuredContent).toMatchObject({
          diagnostic: {
            failure: {
              endpoint,
              reason,
              stage,
              status:
                endpoint === "navigation/groups"
                  ? navigationStatus
                  : metadataStatus,
            },
            final: { stage },
            authentication: "not_attempted",
          },
        });
        expect(f.visits.map((r) => r.path).sort()).toEqual([
          "dashboard",
          "navigation/groups",
          "network/getMetadata",
        ]);
      }
      const summary = f.emailResponses["note/801/analyticsSummary?ajax"] as {
        counts: unknown;
      };
      summary.counts = { total: -1 };
      f.visits.length = 0;
      const analytics = await client.callTool({
        name: "email_analytics",
        arguments: { groupId: "101" },
      });
      expect(analytics.structuredContent).toMatchObject({
        diagnostic: {
          failure: {
            endpoint: "note/{id}/analyticsSummary",
            stage: "validation",
            reason: "analytics_count_invalid",
            status: 200,
          },
        },
      });
      expect(f.visits.map((r) => r.path)).toEqual([
        "group/101/notes",
        "note/801/analyticsSummary",
        "note/801/analytics2",
      ]);
      f.emailResponses["group/101/notes?ajax&more"] = {
        groupID: 101,
        notes: null,
        more: true,
      };
      f.visits.length = 0;
      const malformedListing = await client.callTool({
        name: "email_analytics",
        arguments: { groupId: "101" },
      });
      expect(malformedListing.structuredContent).toMatchObject({
        ok: false,
        diagnostic: {
          failure: {
            endpoint: "group/{id}/notes",
            method: "GET",
            stage: "validation",
            reason: "expected_notes_array",
            status: 200,
          },
          authentication: "not_attempted",
        },
      });
      expect(f.visits).toEqual([{ path: "group/101/notes", method: "GET" }]);
      expect(f.state.external).toBe(0);
    }, 60_000);

    it("discovers catalog fields and choices through intercepted Chromium without exposing bundled members", async () => {
      const f = await fixture();
      await f.signIn();
      f.visits.length = 0;
      const server = createFlocknoteServer(f.connection);
      const client = new Client({
        name: "fictional-catalog-workflow",
        version: "1",
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      cleanup.unshift(() => client.close());
      const result = await client.callTool({
        name: "member_filters",
        arguments: { groupId: "104", fieldId: "membership" },
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        groupId: "104",
        includeInactive: false,
        total: 1,
        choices: [{ id: "102", label: "Choir" }],
      });
      expect(JSON.stringify(result)).not.toMatch(
        /alex@|Example|555|private-|permissions|subscribedMembers/,
      );
      expect(f.visits).toEqual([{ path: "group/104/people", method: "POST" }]);
      expect(f.state.external).toBe(0);
    }, 60_000);

    it("counts native criteria through intercepted Chromium and MCP without exposing member rows", async () => {
      const f = await fixture();
      await f.signIn();
      f.visits.length = 0;
      const server = createFlocknoteServer(f.connection);
      const client = new Client({
        name: "fictional-count-workflow",
        version: "1",
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      cleanup.unshift(() => client.close());
      const result = await client.callTool({
        name: "find_members",
        arguments: {
          mode: "count",
          groupId: "104",
          criteria: {
            any: [
              {
                all: [
                  { fieldId: "phone", operator: "verified", negated: true },
                ],
              },
            ],
          },
        },
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        mode: "count",
        resultCount: 1,
        criteriaSummary: {
          any: [
            {
              all: [
                {
                  fieldId: "phone",
                  negated: true,
                  missingValueBehavior: "excluded",
                },
              ],
            },
          ],
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /alex@|Rivera|555|"members"|exactMatchUserId/,
      );
      expect(f.visits).toEqual([
        { path: "group/104/people", method: "POST" },
        { path: "group/104/filter", method: "POST" },
      ]);
      const form = new URLSearchParams(f.state.searchForms[0]);
      expect(form.get("request[and][0][or][0][and][0][isNegated]")).toBe(
        "true",
      );
      expect(form.get("includeInactive")).toBe("false");
      expect(f.state.external).toBe(0);
    }, 60_000);

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
      const engagement = await client.callTool({
        name: "member_latest_email_status",
        arguments: { userId, groupId: "101" },
      });
      expect(engagement.structuredContent).toMatchObject({
        ok: true,
        selection: "selected",
        email: { id: "801" },
        engagement: "recorded_open",
        reason: null,
      });
      expect(JSON.stringify(engagement)).not.toMatch(
        /PRIVATE|Rivera|alex@|other@/,
      );
      expect(f.visits.slice(-5)).toEqual([
        { path: "group/101/notes", method: "GET" },
        { path: "note/801/analyticsSummary", method: "GET" },
        { path: "note/801/analytics2", method: "GET" },
        { path: "user/301/profile", method: "POST" },
        { path: "note/801/searchAnalytics", method: "POST" },
      ]);
      const aggregate = await client.callTool({
        name: "email_analytics",
        arguments: { emailId: "801" },
      });
      expect(aggregate.structuredContent).toMatchObject({
        ok: true,
        email: { id: "801" },
        counts: { opened: 17, unopened: 9, complaint: 0 },
      });
      expect(JSON.stringify(aggregate)).not.toMatch(
        /PRIVATE|Rivera|alex@|other@/,
      );
      expect(f.visits.at(-1)).toEqual({
        path: "note/801/analyticsSummary",
        method: "GET",
      });
      for (const selector of [
        { groupId: "101" },
        { groupName: " EVERYONE " },
      ]) {
        const start = f.visits.length;
        const latest = await client.callTool({
          name: "email_analytics",
          arguments: selector,
        });
        expect(latest.structuredContent).toMatchObject({
          ok: true,
          groupId: "101",
          email: { id: "801" },
          counts: { opened: 17, total: 31 },
        });
        // Group discovery is already warm in this scenario.
        expect(f.visits.slice(start)).toEqual([
          { path: "group/101/notes", method: "GET" },
          { path: "note/801/analyticsSummary", method: "GET" },
          { path: "note/801/analytics2", method: "GET" },
        ]);
        expect(JSON.stringify(latest)).not.toMatch(
          /PRIVATE|Rivera|alex@|other@|summaryCounts/,
        );
        const listingStart = f.visits.length;
        const listing = await client.callTool({
          name: "group_notes",
          arguments: selector,
        });
        expect(listing.structuredContent).toMatchObject({
          ok: true,
          groupId: "101",
          returnedCount: 2,
          hasMore: true,
          notes: [
            { id: "801", type: null },
            { id: "800", type: null },
          ],
        });
        expect(JSON.stringify(listing)).not.toMatch(
          /Rivera|alex@|other@|summaryCounts|previewURL/,
        );
        expect(f.visits.slice(listingStart)).toEqual([
          { path: "group/101/notes", method: "GET" },
        ]);
      }
      const recipientStart = f.visits.length;
      const recipients = await client.callTool({
        name: "email_recipients",
        arguments: { emailId: "801", category: "opened" },
      });
      expect(recipients.structuredContent).toMatchObject({
        ok: true,
        returnedCount: 1,
        recipients: [{ userId: "301", firstName: "Alex" }],
        hasMore: null,
        completeness: "unknown",
      });
      expect(JSON.stringify(recipients)).not.toContain("alex@example.test");
      expect(f.visits.slice(recipientStart)).toEqual([
        { path: "note/801/analyticsSummary", method: "GET" },
        { path: "note/801/detailedAnalytics", method: "POST" },
      ]);
      const noteStart = f.visits.length;
      const content = await client.callTool({
        name: "note",
        arguments: { noteId: "801" },
      });
      expect(content.structuredContent).toMatchObject({
        ok: true,
        noteId: "801",
        completeness: "complete",
        status: "published",
      });
      expect(content.structuredContent).toMatchObject({
        markdown: expect.stringContaining("## Rehearsal"),
      });
      expect(JSON.stringify(content)).not.toContain("HIDDEN_");
      const deleted = noteResponse();
      deleted.noteInfo.status = "deleted";
      f.state.responses["composer/editNote"] = {
        status: 200,
        body: JSON.stringify(deleted),
      };
      const unavailable = await client.callTool({
        name: "note",
        arguments: { noteId: "801" },
      });
      expect(unavailable.structuredContent).toMatchObject({
        completeness: "unavailable",
        reason: "deleted",
        markdown: null,
      });
      deleted.noteInfo.ID = 802;
      f.state.responses["composer/editNote"] = {
        status: 200,
        body: JSON.stringify(deleted),
      };
      const mismatch = await client.callTool({
        name: "note",
        arguments: { noteId: "801" },
      });
      expect(mismatch.structuredContent).toMatchObject({
        code: "invalid_response",
        diagnostic: {
          operation: "note",
          failure: {
            endpoint: "composer/editNote",
            reason: "note_identity_mismatch",
          },
        },
      });
      expect(JSON.stringify(mismatch)).not.toMatch(
        /HIDDEN_|Rehearsal|Sing together/,
      );
      expect(f.visits.slice(noteStart)).toEqual([
        { path: "composer/editNote", method: "POST" },
        { path: "composer/editNote", method: "POST" },
        { path: "composer/editNote", method: "POST" },
      ]);
      const searchStart = f.visits.length;
      const messages = await client.callTool({
        name: "find_notes",
        arguments: { searchTerm: "choir + plans" },
      });
      expect(messages.structuredContent).toMatchObject({
        ok: true,
        totalHits: 12,
        returnedCount: 3,
        notes: [
          { id: "803", type: "scheduled" },
          { id: "801", type: "email" },
          { id: "802", type: "sms" },
        ],
      });
      expect(JSON.stringify(messages)).not.toContain("HIDDEN_");
      expect(f.visits.slice(searchStart)).toEqual([
        { path: "network/getMetadata", method: "POST" },
        { path: "supersearch/query", method: "POST" },
      ]);
      f.state.responses["supersearch/query"] = {
        status: 200,
        body: JSON.stringify(noteSearchResponse("wrong echo")),
      };
      const failure = await client.callTool({
        name: "find_notes",
        arguments: { searchTerm: "choir + plans" },
      });
      expect(failure.structuredContent).toMatchObject({
        code: "invalid_response",
        diagnostic: {
          operation: "find_notes",
          failure: {
            endpoint: "supersearch/query",
            reason: "search_echo_mismatch",
          },
        },
      });
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
