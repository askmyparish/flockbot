import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { errors } from "zapier-platform-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMembershipVerificationApp,
  MEMBERSHIP_TEST_CONSENT,
  type MembershipTestPlan,
} from "../../adapters/zapier/src/membership-verification.js";
import { createCandidateApp } from "../../adapters/zapier/src/app.js";
import {
  sessionFromToken,
  type Transport,
  type TransportResponse,
} from "../../src/index.js";

const email = "controlled@example.test";
function plan(): MembershipTestPlan {
  return {
    subdomain: "example-parish",
    networkId: "201",
    groupId: "102",
    emailDigest: createHash("sha256").update(email).digest("hex"),
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60_000,
  };
}
function bundle() {
  return {
    authData: {
      subdomain: "example-parish",
      testEmail: email,
      sessionData: JSON.stringify({
        version: 1,
        state: sessionFromToken("example-parish", "fictional-cookie"),
      }),
    } as Record<string, string>,
    inputData: { consent: MEMBERSHIP_TEST_CONSENT } as Record<string, unknown>,
  };
}
function json(data: unknown, status = 200): TransportResponse {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(data),
  };
}
function fixture(
  overrides: Partial<MembershipTestPlan> = {},
  behavior: Partial<{
    identity: unknown;
    authentication: unknown;
    write: () => Promise<TransportResponse>;
    group: string;
    fallback: boolean;
  }> = {},
) {
  const calls: Parameters<Transport>[0][] = [];
  const transport = vi.fn<Transport>(async (request) => {
    calls.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/user/userData")
      return json(behavior.authentication ?? { success: true, userID: 301 });
    if (path === "/dashboard")
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        body: behavior.fallback
          ? '<div id="fnReactHolder"></div>'
          : `<div class="group_item" data-groupid="${behavior.group ?? "102"}" data-shortname="test"><span class="group_name">Test</span></div>`,
      };
    if (path === "/navigation/groups")
      return json({ groups: [{ ID: 102, name: "Test", shortname: "test" }] });
    if (path === "/network/getMetadata")
      return json(
        behavior.identity ?? { networkID: 201, everyoneGroupID: 101 },
      );
    if (request.method === "POST")
      return behavior.write ? behavior.write() : json({ success: true });
    throw new Error("unexpected-private-upstream-sentinel");
  });
  const app = createMembershipVerificationApp(
    { ...plan(), ...overrides },
    transport,
  );
  return {
    app,
    calls,
    transport,
    invoke: (input = bundle()) =>
      app.creates.add_member_test.operation.perform({ errors }, input),
  };
}
afterEach(() => vi.useRealTimers());

describe("restricted hosted membership verification", () => {
  it("uses one saved session for identity, group lookup and one fixed member POST", async () => {
    const f = fixture();
    const input = bundle();
    Object.defineProperty(input.authData, "password", {
      get: () => {
        throw new Error("Password must not be read");
      },
    });
    expect(await f.invoke(input)).toEqual({ success: true });
    expect(f.calls.map((x) => new URL(x.url).pathname)).toEqual([
      "/user/userData",
      "/network/getMetadata",
      "/user/userData",
      "/dashboard",
      "/user/userData",
      "/group/102/addToGroupByAdmin",
    ]);
    const write = f.calls.at(-1);
    expect(write?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(write?.body))).toEqual({
      fname: "Flockbot",
      lname: "Verification",
      email,
      mobile_phone: "",
    });
    expect(
      f.calls.every((x) => x.headers.Cookie?.includes("fictional-cookie")),
    ).toBe(true);
  });

  it("allows the modern navigation/metadata fallback and submits once", async () => {
    const f = fixture({}, { fallback: true });
    expect(await f.invoke()).toEqual({ success: true });
    expect(f.calls.map((request) => new URL(request.url).pathname)).toEqual([
      "/user/userData",
      "/network/getMetadata",
      "/user/userData",
      "/dashboard",
      "/navigation/groups",
      "/network/getMetadata",
      "/user/userData",
      "/group/102/addToGroupByAdmin",
    ]);
    expect(f.calls.filter((request) => request.method === "POST")).toHaveLength(
      1,
    );
  });

  it.each(["setup", "test"] as const)(
    "guards the %s authentication hook before any request",
    async (hook) => {
      for (const fault of ["expiry", "email", "subdomain"]) {
        const f = fixture(
          fault === "expiry" ? { expiresAt: Date.now() - 1 } : {},
        );
        const input = bundle();
        if (fault === "email") input.authData.testEmail = "wrong@example.test";
        if (fault === "subdomain") input.authData.subdomain = "other-parish";
        const invoke =
          hook === "setup"
            ? f.app.authentication.sessionConfig.perform
            : f.app.authentication.test;
        await expect(invoke({ errors }, input)).rejects.toThrow(
          "The isolated test configuration is invalid or expired.",
        );
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { expiresAt: Date.now() - 1 },
    { expiresAt: Date.now() + 31 * 60_000 },
    { subdomain: "bad/path" },
    { networkId: "" },
    { groupId: "navigation" },
    { emailDigest: "bad" },
  ])(
    "refuses invalid deployment configuration before transport: %j",
    async (bad) => {
      const f = fixture(bad);
      await expect(f.invoke()).rejects.toThrow("invalid_configuration");
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  it.each(["subdomain", "testEmail", "sessionData", "consent", "override"])(
    "refuses invalid protected input or consent: %s",
    async (field) => {
      const f = fixture();
      const input = bundle();
      if (field === "consent") input.inputData.consent = "no";
      else if (field === "override") input.inputData.group_id = "103";
      else input.authData[field] = field === "sessionData" ? "" : "wrong";
      await expect(f.invoke(input)).rejects.toThrow("before submission");
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    { success: true, userID: 301 },
    { success: true, userID: 301, networkID: 202 },
    { success: true, userID: 301, networkID: {} },
  ])("stops on unknown or wrong metadata identity", async (identity) => {
    const f = fixture({}, { identity });
    await expect(f.invoke()).rejects.toThrow("stage=network_identity");
    expect(f.calls).toHaveLength(2);
    expect(f.calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("stops on a rejected saved session before public metadata can confirm identity", async () => {
    const f = fixture(
      {},
      { authentication: { success: true, userID: null, authorized: false } },
    );
    await expect(f.invoke()).rejects.toThrow("stage=authentication");
    expect(f.calls).toHaveLength(1);
    expect(f.calls.some((request) => request.method === "POST")).toBe(false);
  });

  it("rejects a session for another origin before transport", async () => {
    const f = fixture();
    const input = bundle();
    input.authData.sessionData = JSON.stringify({
      version: 1,
      state: sessionFromToken("other-parish", "fictional-cookie"),
    });
    await expect(f.invoke(input)).rejects.toThrow("before submission");
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("does not submit when the configured group is unavailable", async () => {
    const f = fixture({}, { group: "103" });
    await expect(f.invoke()).rejects.toThrow("before submission");
    expect(f.calls.filter((x) => x.method === "POST")).toHaveLength(0);
  });

  it.each([403, 429, 503, 200])(
    "halts a submitted rejection without replay or upstream details: %s",
    async (status) => {
      const f = fixture(
        {},
        {
          write: async () =>
            json(
              {
                success: false,
                message: `${email} fictional-cookie private-upstream-sentinel`,
              },
              status,
            ),
        },
      );
      const error = await f.invoke().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(errors.HaltedError);
      for (const secret of [
        email,
        "fictional-cookie",
        "private-upstream-sentinel",
      ])
        expect(String(error)).not.toContain(secret);
      expect(f.calls.filter((x) => x.method === "POST")).toHaveLength(1);
    },
  );

  it("halts a lost response without replay", async () => {
    const f = fixture(
      {},
      {
        write: async () => {
          throw new Error(email);
        },
      },
    );
    await expect(f.invoke()).rejects.toBeInstanceOf(errors.HaltedError);
    expect(f.calls.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("halts a submitted timeout once", async () => {
    vi.useFakeTimers();
    const f = fixture({}, { write: () => new Promise(() => {}) });
    const result = f.invoke().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await result).toBeInstanceOf(errors.HaltedError);
    expect(f.calls.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("includes time spent identifying in the total 20-second budget", async () => {
    vi.useFakeTimers();
    const f = fixture({}, { write: () => new Promise(() => {}) });
    f.transport.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return json({ success: true, userID: 301, networkID: 201 });
    });
    let settled = false;
    const result = f.invoke().catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    expect(f.calls.filter((request) => request.method === "POST")).toHaveLength(
      1,
    );
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    expect(await result).toBeInstanceOf(errors.HaltedError);
  });

  it("does not submit after expiry during the final preflight read", async () => {
    vi.useFakeTimers();
    const f = fixture({ expiresAt: Date.now() + 100 });
    let identities = 0;
    const ordinary = f.transport.getMockImplementation();
    if (!ordinary) throw new Error("Missing fixture implementation.");
    f.transport.mockImplementation(async (request) => {
      if (
        new URL(request.url).pathname === "/user/userData" &&
        ++identities === 3
      ) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return json({ success: true, userID: 301, networkID: 201 });
      }
      return ordinary(request);
    });
    const result = f.invoke().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(201);
    expect(await result).toBeInstanceOf(errors.Error);
    expect(f.calls.filter((request) => request.method === "POST")).toHaveLength(
      0,
    );
  });

  it("stops a late read after expiry without submitting", async () => {
    vi.useFakeTimers();
    const f = fixture({ expiresAt: Date.now() + 100 });
    f.transport.mockImplementationOnce(() => new Promise(() => {}));
    const result = f.invoke().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBeInstanceOf(errors.Error);
    expect(f.calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("keeps the operational entry blocked", async () => {
    const app = createCandidateApp();
    expect(Object.keys(app.creates)).toEqual(["add_member"]);
    await expect(
      app.creates.add_member.operation.perform(
        { errors },
        {
          authData: {},
          inputData: {
            group_id: "102",
            user_first_name: "Flockbot",
            user_last_name: "Verification",
            user_email: email,
          },
        },
      ),
    ).rejects.toThrow("disabled");
  });

  it("builds a separate loadable artifact with protected recipient and no contact or Storage code", async () => {
    const directory = mkdtempSync(join(tmpdir(), "membership-build-test-"));
    let artifact: string | undefined;
    try {
      const file = join(directory, "plan.json");
      writeFileSync(
        file,
        JSON.stringify({
          consent: "authorize-restricted-membership-build",
          subdomain: "example-parish",
          networkId: "201",
          groupId: "102",
          testEmail: email,
          testOnlyLoginConfirmed: true,
          fictionalRecordConfirmed: true,
        }),
        { mode: 0o600 },
      );
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "scripts/zapier/build-membership-verification.mjs",
            "--private-plan-file",
            file,
          ],
          { encoding: "utf8" },
        ),
      );
      artifact = result.directory as string;
      symlinkSync(resolve("node_modules"), join(artifact, "node_modules"));
      const require = createRequire(import.meta.url);
      const app = require(join(artifact, "dist/index.cjs"));
      const { validateApp } = require("zapier-platform-core/src/tools/schema");
      const { createAppHandler } = require("zapier-platform-core");
      const definition = await createAppHandler(join(artifact, "index.js"))({
        command: "definition",
        calledFromCli: true,
      });
      expect(definition).toBeDefined();
      expect(validateApp(app)).toEqual([]);
      expect(app.version).toBe("2.0.1");
      expect(app.flags.skipHttpPatch).toBe(true);
      expect(Object.keys(app.creates)).toEqual(["add_member_test"]);
      expect(
        app.authentication.fields.find(
          (x: { key: string }) => x.key === "testEmail",
        ),
      ).toMatchObject({ type: "password", isNoSecret: false });
      const source = readFileSync(join(artifact, "dist/index.cjs"), "utf8");
      expect(source).not.toContain(email);
      expect(source).not.toContain("store.zapier.com");
      expect(source).not.toContain("ProbeStorageClient");
    } finally {
      if (artifact) rmSync(artifact, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
