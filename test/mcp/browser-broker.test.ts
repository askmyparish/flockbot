import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import {
  afterAll,
  beforeAll,
  describe,
  it,
  vi,
  type TestContext,
} from "vitest";
import { BrowserService } from "../../adapters/mcp/src/browser-broker.js";
import { run, waitFor } from "./support.js";

const profiles = new Set<string>();
// Only the private sockets published in these fictional profiles are permitted.
vi.mocked(net.Socket.prototype.connect).mockRestore();
const connect = net.Socket.prototype.connect;
vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
  this: net.Socket,
  ...args: unknown[]
) {
  const path = (args[0] as { path?: unknown })?.path;
  const permitted = [...profiles].some((profile) => {
    try {
      return (
        JSON.parse(readFileSync(join(profile, "broker.json"), "utf8"))
          .address === path
      );
    } catch {
      return false;
    }
  });
  if (!permitted)
    throw new Error("Unexpected socket in an offline broker test.");
  return Reflect.apply(connect, this, args) as net.Socket;
});

let entry: string;
let directory: string;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "flockbot-broker-entry-"));
  entry = join(directory, "worker.mjs");
  const playwright = resolve("node_modules/playwright/index.mjs");
  await build({
    entryPoints: ["test/mcp/fixtures/browser-broker-worker.ts"],
    outfile: entry,
    bundle: true,
    alias: { playwright },
    external: [playwright],
    platform: "node",
    target: "node22",
    format: "esm",
    logLevel: "silent",
    banner: {
      js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
    },
  });
});
async function fixture({ onTestFinished, expect }: TestContext) {
  const profile = mkdtempSync(join(tmpdir(), "flockbot-broker-fixture-"));
  profiles.add(profile);
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
  let launches = 0;
  const launch = () => {
    launches++;
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", entry, profile, "broker"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  };
  const create = () => new BrowserService({ entry, profile, launch });
  const service = create();
  onTestFinished(async () => {
    for (const name of ["hold", "hold-count", "signed-out"])
      rmSync(join(profile, name), { force: true });
    await service.shutdown();
    await waitFor(() =>
      expect(existsSync(join(profile, "broker.json"))).toBe(false),
    );
    profiles.delete(profile);
    rmSync(profile, { recursive: true, force: true });
  });
  const events = () =>
    existsSync(join(profile, "events"))
      ? readFileSync(join(profile, "events"), "utf8").trim().split("\n")
      : [];
  return { profile, service, create, launch, events, launches: () => launches };
}

describe.skipIf(process.platform === "win32")(
  "shared local browser owner over private IPC",
  { concurrent: true },
  () => {
    it("lists every visible page of a named group through private IPC", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      await expect(f.service.groupMembers({})).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(f.launches()).toBe(0);
      const first = await f.service.groupMembers({ groupName: "Volunteers" });
      expect(first).toMatchObject({
        groupId: "102",
        returnedCount: 100,
        hasMore: true,
        nextOffset: 100,
      });
      const last = await f.service.groupMembers({
        groupId: first.groupId,
        offset: first.nextOffset ?? undefined,
        fields: ["joinedOn"],
      });
      expect(last).toMatchObject({
        offset: 100,
        members: [{ id: "401", joinedOn: "2026-03-05" }],
        returnedCount: 1,
        hasMore: false,
        nextOffset: null,
      });
      expect(JSON.stringify([first, last])).not.toMatch(/alex@|555/);
      expect(JSON.stringify(first)).not.toContain("joinedOn");
      expect(
        f.events().filter((event) => event.startsWith("POST group/102/people")),
      ).toEqual([
        "POST group/102/people?ajax",
        "POST group/102/people/100?ajax&more",
      ]);
      expect(f.events()).not.toContain("GET user/userData");
    });

    it("lists subscriptions and checks explicit/unknown membership through actual IPC", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      await expect(f.service.isMember("301", {})).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(f.launches()).toBe(0);
      const groups = await f.service.memberGroups("301");
      expect(groups).toMatchObject({
        userId: "301",
        groups: [{ id: "101" }, { id: "102" }],
        complete: false,
        truncated: false,
      });
      expect(JSON.stringify(groups)).not.toMatch(/Pref|superAdmin|Proxy/);
      expect(await f.service.isMember("301", { groupId: "102" })).toMatchObject(
        { membership: "member" },
      );
      expect(await f.service.isMember("301", { groupId: "103" })).toMatchObject(
        { membership: "not_member" },
      );
      expect(await f.service.isMember("301", { groupId: "104" })).toMatchObject(
        { membership: "unknown" },
      );
      expect(f.events()).toEqual([
        "launch",
        ...Array.from({ length: 4 }, () => "POST user/301/groups"),
      ]);
    });

    it("reads selected member contacts over actual private IPC with no preflight", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      await expect(
        f.service.member("301", ["email", "email"]),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(f.launches()).toBe(0);
      expect(await f.service.member("301", ["email"])).toEqual({
        id: "301",
        firstName: "Alex",
        lastName: "Rivera",
        email: {
          value: "alex@example.test",
          verified: false,
          isBadEmail: true,
        },
      });
      expect(f.events()).toEqual(["launch", "POST user/301/profile"]);
      expect(await f.service.member("301")).toEqual({
        id: "301",
        firstName: "Alex",
        lastName: "Rivera",
      });
    });

    it("rejects invalid member search before starting a browser owner", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      await expect(
        f.service.findMembers({ searchTerm: "Alex", limit: 0 }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(f.launches()).toBe(0);
      expect(f.events()).toEqual([]);
    });

    it("routes member search through actual private IPC without authentication preflight", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      const result = await f.service.findMembers({
        searchTerm: "Alex Rivera",
        groupId: "101",
        fields: ["joinedOn"],
      });
      expect(result).toMatchObject({
        exactMatchUserId: "301",
        complete: true,
        members: [
          {
            id: "301",
            firstName: "Alex",
            lastName: "Rivera",
            joinedOn: "2026-03-05",
          },
        ],
      });
      expect(JSON.stringify(result)).not.toMatch(/alex@|555/);
      expect(f.events()).toEqual([
        "launch",
        "POST group/101/people?ajax",
        "POST group/101/filter",
      ]);
    });

    it("reports busy rather than cancelled when connect waits for an active operation", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      writeFileSync(join(f.profile, "hold-count"), "fictional");
      const count = f.service.count("101");
      try {
        await waitFor(() =>
          expect(f.events().includes("GET group/101/getSubscriberCount")).toBe(
            true,
          ),
        );
        await expect(
          f.create().connect("example-parish"),
        ).rejects.toMatchObject({ code: "connection_busy" });
      } finally {
        rmSync(join(f.profile, "hold-count"), { force: true });
        await count;
      }
      expect(await f.service.status()).toMatchObject({ state: "ready" });
    });

    it("reports busy promptly to parish tools during interactive sign-in", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      writeFileSync(join(f.profile, "signed-out"), "fictional");
      await f.service.connect("example-parish");
      expect(await f.create().status()).toMatchObject({ state: "pending" });
      await expect(f.create().count("101")).rejects.toMatchObject({
        code: "connection_busy",
      });
      expect(f.events().includes("GET group/101/getSubscriberCount")).toBe(
        false,
      );
    });

    it("reports cancelled for an in-flight read and keeps the owner usable", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      writeFileSync(join(f.profile, "hold-count"), "fictional");
      const controller = new AbortController();
      const pending = f.service.count("101", { signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "operation_cancelled",
      });
      try {
        await waitFor(() =>
          expect(f.events().includes("GET group/101/getSubscriberCount")).toBe(
            true,
          ),
        );
        controller.abort();
        await rejected;
      } finally {
        rmSync(join(f.profile, "hold-count"), { force: true });
      }
      expect(await f.service.count("101")).toBe(7);
      expect(f.launches()).toBe(1);
    });

    it("does not report a successful stop when the owner drops its reply", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      const address = `/tmp/fb-${randomBytes(16).toString("hex")}.sock`;
      const server = net.createServer((socket) =>
        socket.once("data", () => socket.destroy()),
      );
      await new Promise<void>((resolve) => server.listen(address, resolve));
      writeFileSync(
        join(f.profile, "broker.json"),
        JSON.stringify({
          version: 1,
          runtime: "0".repeat(64),
          address,
          key: randomBytes(32).toString("hex"),
        }),
        { mode: 0o600 },
      );
      try {
        await expect(f.service.shutdown()).rejects.toMatchObject({
          code: "broker_unavailable",
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(join(f.profile, "broker.json"), { force: true });
      }
    });

    it("cancels a caller promptly while shared owner startup continues safely", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      let starting = false;
      const service = new BrowserService({
        entry,
        profile: f.profile,
        launch: () => {
          starting = true;
        },
      });
      const controller = new AbortController();
      let settled = false;
      const call = service
        .count("101", { signal: controller.signal })
        .finally(() => {
          settled = true;
        });
      const rejected = expect(call).rejects.toMatchObject({
        code: "operation_cancelled",
      });
      try {
        await waitFor(() => expect(starting).toBe(true));
        controller.abort();
        await waitFor(() => expect(settled).toBe(true), { timeout: 500 });
      } finally {
        f.launch();
        await waitFor(() =>
          expect(existsSync(join(f.profile, "broker.json"))).toBe(true),
        );
        await rejected;
      }
      expect(await f.service.count("101")).toBe(7);
      expect(f.events().filter((event) => event.startsWith("GET "))).toEqual([
        "GET group/101/getSubscriberCount",
      ]);
    });

    it("starts one owner for simultaneous cold clients", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      expect(
        await Promise.all([f.service.count("101"), f.create().count("101")]),
      ).toEqual([7, 7]);
      expect(f.launches()).toBe(1);
      expect(f.events().filter((event) => event === "launch")).toHaveLength(1);
    });
    it("shares one browser across actual client processes, caches groups and protects the socket", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      expect(await f.service.count("101")).toBe(7);
      const clients = await Promise.all([
        run(entry, [f.profile, "add"], process.env),
        run(entry, [f.profile, "count"], {
          ...process.env,
          TMPDIR: join(f.profile, "another-temp"),
        }),
      ]);
      expect(clients.map(({ status }) => status)).toEqual([0, 0]);
      expect(JSON.parse(clients[0]?.stdout ?? "null")).toEqual({
        success: true,
      });
      const before = f.events().length;
      expect(
        await f.create().addMemberByName("Volunteers", {
          firstName: "Sam",
          lastName: "Lee",
          email: "sam@example.test",
        }),
      ).toEqual({ success: true });
      expect(f.events().slice(before)).toEqual([
        "POST group/102/addToGroupByAdmin",
      ]);
      expect(f.events().filter((line) => line === "launch")).toHaveLength(1);
      expect(f.launches()).toBe(1);
      const descriptor = JSON.parse(
        readFileSync(join(f.profile, "broker.json"), "utf8"),
      );
      expect(statSync(descriptor.address).mode & 0o777).toBe(0o600);
      expect(statSync(join(f.profile, "broker.json")).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(f.service)).not.toContain(descriptor.key);
    });

    it("rejects unauthenticated, replayed and arbitrary operations without an upstream write", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      await f.service.groups();
      const descriptor = JSON.parse(
        readFileSync(join(f.profile, "broker.json"), "utf8"),
      );
      const payload = JSON.stringify({
        nonce: randomBytes(32).toString("hex"),
        request: { action: "count", groupId: "101" },
      });
      const mac = createHmac("sha256", Buffer.from(descriptor.key, "hex"))
        .update(payload)
        .digest("hex");
      const frame = `${JSON.stringify({ payload, mac })}\n`;
      const send = (bytes: string) =>
        new Promise<string>((done, reject) => {
          const socket = new net.Socket();
          let reply = "";
          socket.on("data", (chunk) => {
            reply += chunk;
          });
          socket.on("error", reject);
          socket.on("close", () => done(reply));
          socket.connect({ path: descriptor.address }, () =>
            socket.write(bytes),
          );
        });
      // Keep the writable half open until the response; an early FIN is cancellation.
      expect(await send(frame.replace(mac, "0".repeat(64)))).toBe("");
      await send(frame);
      const before = f.events().length;
      expect(await send(frame)).toBe("");
      const arbitrary = JSON.stringify({
        nonce: randomBytes(32).toString("hex"),
        request: { action: "fetch", url: "https://outside.invalid" },
      });
      const signed = createHmac("sha256", Buffer.from(descriptor.key, "hex"))
        .update(arbitrary)
        .digest("hex");
      expect(
        await send(`${JSON.stringify({ payload: arbitrary, mac: signed })}\n`),
      ).toBe("");
      expect(f.events()).toHaveLength(before);
      expect(f.events().some((line) => line.startsWith("POST"))).toBe(false);
    });

    it("reports a disconnected submitted write as unknown, drains it once and keeps later work serialized", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      await f.service.groups();
      writeFileSync(join(f.profile, "hold"), "fictional");
      const controller = new AbortController();
      const write = f.service.addMember(
        "102",
        { firstName: "Alex", lastName: "Rivera", email: "alex@example.test" },
        { signal: controller.signal },
      );
      const rejected = expect(write).rejects.toMatchObject({
        outcome: "unknown",
      });
      await waitFor(() =>
        expect(f.events().some((line) => line.startsWith("POST"))).toBe(true),
      );
      controller.abort();
      await rejected;
      let settled = false;
      const next = f
        .create()
        .count("101")
        .then((value) => {
          settled = true;
          return value;
        });
      await new Promise((done) => setTimeout(done, 50));
      expect(settled).toBe(false);
      rmSync(join(f.profile, "hold"));
      expect(await next).toBe(7);
      expect(f.events().filter((line) => line.startsWith("POST"))).toHaveLength(
        1,
      );
    });

    it("restarts after idle shutdown without discarding the saved connection", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      await f.service.count("101");
      await waitFor(
        () => expect(existsSync(join(f.profile, "broker.json"))).toBe(false),
        { timeout: 4000 },
      );
      expect(f.events().at(-1)).toBe("close");
      expect(await f.service.count("101")).toBe(7);
      expect(f.events().filter((line) => line === "launch")).toHaveLength(2);
      expect(f.launches()).toBe(2);
    });

    it("recovers a crashed owner only for a new operation and never replays its write", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      await f.service.groups();
      writeFileSync(join(f.profile, "hold"), "fictional");
      const pending = f.service.addMember("102", {
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "broker_unavailable",
        outcome: "unknown",
      });
      await waitFor(() =>
        expect(f.events().some((line) => line.startsWith("POST"))).toBe(true),
      );
      process.kill(
        Number(readFileSync(join(f.profile, "owner.pid"), "utf8")),
        "SIGKILL",
      );
      await rejected;
      rmSync(join(f.profile, "hold"));
      expect(await f.service.count("101")).toBe(7);
      expect(f.events().filter((line) => line.startsWith("POST"))).toHaveLength(
        1,
      );
      expect(f.events().filter((line) => line === "launch")).toHaveLength(2);
    });

    it("fails closed for a descriptor readable by other users", async (context) => {
      const { expect } = context;
      const f = await fixture(context);
      await f.service.count("101");
      chmodSync(join(f.profile, "broker.json"), 0o644);
      await expect(f.create().count("101")).rejects.toMatchObject({
        code: "profile_unavailable",
      });
      chmodSync(join(f.profile, "broker.json"), 0o600);
    });
  },
);

// The workers have exited before the shared bundled entry is removed.
afterAll(() => rmSync(directory, { recursive: true, force: true }));
