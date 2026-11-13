import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlockbotError } from "../../src/index.js";
import { BrowserConnection } from "../../adapters/mcp/src/browser-connection.js";
import { waitFor } from "./support.js";
import { noteResponse } from "../fixtures/note.js";
import { SerialCoordinator } from "../../adapters/mcp/src/serial-coordinator.js";
import {
  runDiagnostic,
  failureDiagnostic,
} from "../../adapters/mcp/src/diagnostics.js";
import {
  BrowserAuthenticationError,
  BrowserConnectionError,
  openBrowserSession,
  type BrowserFactory,
  type BrowserSession,
} from "../../adapters/mcp/src/browser-runtime.js";

const directories: string[] = [];
const connections: BrowserConnection[] = [];
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(options: { now?: () => number; setupMs?: number } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "flockbot-browser-unit-"));
  directories.push(profile);
  const responses: Record<string, unknown> = {
    "user/userData": { success: true, userID: 201 },
    dashboard: '<div id="fnReactHolder"></div>',
    "navigation/groups": {
      groups: [{ ID: 102, name: "Volunteers", shortname: "volunteers" }],
    },
    "network/getMetadata": { everyoneGroupID: 101 },
    "group/101/getSubscriberCount": { subscriberCount: "7" },
    "group/102/addToGroupByAdmin": {
      success: true,
      privateContact: "fictional@example.test",
    },
  };
  const requests: { path: string; method: string; body?: string }[] = [];
  const isOpen = vi.fn(() => true);
  const finishSignIn = vi.fn(async () => undefined);
  const session: BrowserSession = {
    request: vi.fn(async (path, method = "GET", body) => {
      requests.push({ path, method, ...(body === undefined ? {} : { body }) });
      const response = responses[path];
      if (response instanceof Error) throw response;
      if (typeof response === "function") return response();
      if (response === undefined) throw new Error("Missing fictional fixture");
      return response;
    }),
    signIn: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    finishSignIn,
    isOpen,
  };
  const factory = vi.fn<BrowserFactory>(async () => session);
  const coordinator = new SerialCoordinator();
  const create = () => {
    const connection = new BrowserConnection({
      profile,
      factory,
      pollMs: 5,
      setupMs: options.setupMs ?? 5000,
      coordinator,
      ...(options.now ? { now: options.now } : {}),
    });
    connections.push(connection);
    return connection;
  };
  const connection = create();
  return {
    profile,
    responses,
    requests,
    session,
    isOpen,
    factory,
    finishSignIn,
    connection,
    create,
  };
}

async function ready(connection: BrowserConnection) {
  expect(await connection.connect("example-parish")).toEqual({
    state: "pending",
    parish: "example-parish",
  });
  await waitFor(async () =>
    expect(await connection.status()).toEqual({
      state: "ready",
      parish: "example-parish",
    }),
  );
}

describe("browser-owned local connection", () => {
  it("withholds group-list links for provisional identities without extra requests", async () => {
    const f = fixture();
    await ready(f.connection);
    f.responses["group/101/notes?ajax&more"] = {
      groupID: 101,
      more: false,
      notes: [
        "published",
        "draft",
        "scheduled",
        "autosaved",
        "unrecognized",
      ].map((status, i) => ({ ID: 801 + i, status })),
    };
    f.requests.length = 0;
    const result = await f.connection.groupNotes({ groupId: "101" });
    expect(result.notes.map(({ url }) => url)).toEqual([
      "https://example-parish.flocknote.com/note/801",
      null,
      null,
      null,
      null,
    ]);
    expect(f.requests).toEqual([
      { path: "group/101/notes?ajax&more", method: "GET" },
    ]);
  });

  it.each([
    ["deleted", false, "deleted"],
    ["scheduled", false, "unsupported_status"],
    ["published", true, "ambiguous_identity"],
  ] as const)(
    "withholds links for unavailable notes (%s, duplicate %s)",
    async (status, duplicate, reason) => {
      const f = fixture();
      await ready(f.connection);
      const response = noteResponse();
      response.noteInfo.status = status;
      response.noteInfo.duplicate = duplicate;
      f.responses["composer/editNote"] = response;
      f.requests.length = 0;
      expect(await f.connection.note({ noteId: "801" })).toMatchObject({
        url: null,
        reason,
        completeness: "unavailable",
      });
      expect(f.requests).toEqual([
        {
          path: "composer/editNote",
          method: "POST",
          body: "noteID=801&fromComposer=1",
        },
      ]);
    },
  );

  it("coalesces startup failure rather than reporting a sign-in window before it opens", async () => {
    const f = fixture();
    await ready(f.connection);
    let finishCount = (_value: unknown) => {};
    f.responses["group/101/getSubscriberCount"] = () =>
      new Promise((resolve) => {
        finishCount = resolve;
      });
    const count = f.connection.count("101");
    await waitFor(() =>
      expect(
        f.requests.some(
          (request) => request.path === "group/101/getSubscriberCount",
        ),
      ).toBe(true),
    );
    const first = f.connection.connect("example-parish").then(
      (status) => status.state,
      (error: unknown) => (error as BrowserConnectionError).code,
    );
    const second = f.connection.connect("example-parish").then(
      (status) => status.state,
      (error: unknown) => (error as BrowserConnectionError).code,
    );
    try {
      expect(await second).toBe("connection_busy");
      expect(await first).toBe("connection_busy");
      expect(await f.connection.status()).toMatchObject({
        state: "ready",
        parish: "example-parish",
      });
    } finally {
      finishCount({ subscriberCount: "7" });
      await Promise.allSettled([count, first, second]);
    }
  });
  it("reports active reconnect as pending instead of exposing an older saved ready state while queued", async () => {
    const f = fixture();
    await ready(f.connection);
    let finishCount = (_value: unknown) => {};
    f.responses["group/101/getSubscriberCount"] = () =>
      new Promise((resolve) => {
        finishCount = resolve;
      });
    const count = f.connection.count("101");
    await waitFor(() =>
      expect(
        f.requests.some(
          (request) => request.path === "group/101/getSubscriberCount",
        ),
      ).toBe(true),
    );
    const reconnect = f.connection.connect("example-parish");
    try {
      expect(await f.connection.status()).toMatchObject({
        state: "pending",
        parish: "example-parish",
      });
    } finally {
      finishCount({ subscriberCount: "7" });
      await Promise.allSettled([count, reconnect]);
    }
  });
  it("reports busy when an operation exhausts its budget while queued", async () => {
    const f = fixture();
    await ready(f.connection);
    let finish = (_value: unknown) => {};
    f.responses["group/101/getSubscriberCount"] = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const controller = new AbortController();
    const active = f.connection.count("101", { signal: controller.signal });
    const activeRejected = expect(active).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    await waitFor(() =>
      expect(
        f.requests.some(({ path }) => path.endsWith("getSubscriberCount")),
      ).toBe(true),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const queued = f.connection.count("101");
      const busy = expect(queued).rejects.toMatchObject({
        code: "connection_busy",
      });
      await vi.advanceTimersByTimeAsync(25_000);
      await busy;
    } finally {
      vi.useRealTimers();
      controller.abort();
      finish({ subscriberCount: 7 });
      await activeRejected;
    }
    expect(
      f.requests.filter(({ path }) => path.endsWith("getSubscriberCount")),
    ).toHaveLength(1);
  });
  it.each([
    new FlockbotError("transport_failed"),
    new FlockbotError("operation_timeout"),
    new FlockbotError("upstream_rejected", 503),
    new FlockbotError("authentication_protocol_error"),
    new BrowserAuthenticationError("upstream_rejected"),
    new BrowserAuthenticationError("permission_denied"),
    new BrowserAuthenticationError("redirect_rejected"),
    new BrowserAuthenticationError("invalid_response"),
  ])(
    "keeps sign-in open through an inconclusive poll (%#)",
    async (failure) => {
      const f = fixture();
      let polls = 0;
      f.responses["user/userData"] = () => {
        polls++;
        if (polls === 1) throw failure;
        return { success: true, userID: null, authorized: false };
      };
      await f.connection.connect("example-parish");
      await waitFor(() => expect(polls).toBeGreaterThan(1));
      expect(await f.connection.status()).toMatchObject({ state: "pending" });
      expect(f.session.close).not.toHaveBeenCalled();
      f.responses["user/userData"] = { success: true, userID: 201 };
      await waitFor(async () =>
        expect(await f.connection.status()).toMatchObject({ state: "ready" }),
      );
      expect(f.factory).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a definite setup failure after connect has already returned pending", async () => {
    const f = fixture();
    f.responses["user/userData"] = {
      success: true,
      userID: 201,
      authorized: false,
    };
    expect(await f.connection.connect("example-parish")).toMatchObject({
      state: "pending",
    });
    await waitFor(async () =>
      expect(await f.connection.status()).toMatchObject({
        state: "action_required",
        setupError: "permission_denied",
      }),
    );
    expect(f.session.close).toHaveBeenCalledTimes(1);
    expect(await f.create().status()).toMatchObject({
      setupError: "permission_denied",
    });
  });

  it.each([
    "transport_failed",
    "redirect_rejected",
    "invalid_response",
  ] as const)(
    "preserves the final poll diagnostic at the setup deadline (%s)",
    async (code) => {
      const f = fixture({ setupMs: 120 });
      f.responses["user/userData"] = new FlockbotError(code);
      await f.connection.connect("example-parish");
      await waitFor(async () =>
        expect(await f.connection.status()).toMatchObject({
          state: "action_required",
          setupError: code,
        }),
      );
      expect(f.session.close).toHaveBeenCalledTimes(1);
    },
  );

  it("ends setup when the browser closes and allows another connection attempt", async () => {
    const f = fixture({ setupMs: 200 });
    f.responses["user/userData"] = {
      success: true,
      userID: null,
      authorized: false,
    };
    await f.connection.connect("example-parish");
    f.isOpen.mockReturnValue(false);
    await waitFor(async () =>
      expect(await f.connection.status()).toMatchObject({
        state: "action_required",
        setupError: "browser_unavailable",
        setupStage: "sign_in",
      }),
    );
    expect(f.session.close).toHaveBeenCalledTimes(1);
    f.isOpen.mockReturnValue(true);
    f.responses["user/userData"] = new FlockbotError("invalid_response");
    await f.connection.connect("example-parish");
    await waitFor(async () =>
      expect(await f.connection.status()).toEqual({
        state: "action_required",
        parish: "example-parish",
        setupError: "invalid_response",
      }),
    );
    f.responses["user/userData"] = { success: true, userID: 201 };
    await ready(f.connection);
    expect(await f.connection.status()).not.toHaveProperty("setupStage");
    expect(await f.connection.status()).not.toHaveProperty("setupError");
  });

  it("identifies a changed login when reconnect reaches its deadline", async () => {
    const f = fixture({ setupMs: 200 });
    await ready(f.connection);
    f.responses["user/userData"] = { success: true, userID: 202 };
    await f.connection.connect("example-parish");
    await waitFor(async () =>
      expect(await f.connection.status()).toMatchObject({
        state: "action_required",
        setupError: "connection_changed",
      }),
    );
    expect(f.session.finishSignIn).toHaveBeenCalledTimes(1);
  });

  it("reports a failure completing sign-in after an earlier transient poll recovered", async () => {
    const f = fixture();
    let polls = 0;
    f.responses["user/userData"] = () => {
      if (polls++ === 0) throw new FlockbotError("transport_failed");
      return { success: true, userID: 201 };
    };
    f.finishSignIn.mockRejectedValue(
      new BrowserConnectionError("browser_unavailable", undefined, "close"),
    );
    await f.connection.connect("example-parish");
    await waitFor(async () =>
      expect(await f.connection.status()).toMatchObject({
        state: "action_required",
        setupError: "browser_unavailable",
        setupStage: "close",
      }),
    );
  });

  it("reports busy during sign-in without waiting or submitting a write", async () => {
    const f = fixture();
    f.responses["user/userData"] = {
      success: true,
      userID: null,
      authorized: false,
    };
    await f.connection.connect("example-parish");
    const before = f.requests.length;
    await expect(
      f.connection.addMember("102", {
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
      }),
    ).rejects.toMatchObject({
      code: "connection_busy",
      outcome: "not_submitted",
    });
    expect(
      f.requests.slice(before).some(({ method }) => method === "POST"),
    ).toBe(false);
    await expect(
      f.connection.count("101", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
  });

  it("closes and deletes the profile atomically before a later queued write can reopen it", async () => {
    const f = fixture();
    await ready(f.connection);
    let finish = () => {};
    vi.mocked(f.session.close).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const forgetting = f.connection.forget();
    await waitFor(() => expect(f.session.close).toHaveBeenCalled());
    const later = f.connection.addMember("102", {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex@example.test",
    });
    const rejected = expect(later).rejects.toMatchObject({
      code: "not_configured",
      outcome: "not_submitted",
    });
    finish();
    await forgetting;
    await rejected;
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.requests.some(({ method }) => method === "POST")).toBe(false);
  });
  const member = {
    firstName: "Alex",
    lastName: "Rivera",
    email: "alex@example.test",
  };

  it("reports saved ready status without opening a browser or making a request", async () => {
    const f = fixture();
    await ready(f.connection);
    f.requests.length = 0;
    const launches = f.factory.mock.calls.length;
    f.responses["user/userData"] = new Error(
      "A ready status must not request authentication",
    );
    expect(await f.create().status()).toEqual({
      state: "ready",
      parish: "example-parish",
    });
    expect(f.requests).toHaveLength(0);
    expect(f.factory).toHaveBeenCalledTimes(launches);
  });

  it.each([
    { success: false, authorized: false },
    "<!doctype html><html><form>Fictional sign-in</form></html>",
    new BrowserAuthenticationError("upstream_rejected"),
    new BrowserAuthenticationError("permission_denied"),
  ])(
    "diagnoses a failed membership request without replaying it (%#)",
    async (response) => {
      const f = fixture();
      await ready(f.connection);
      f.responses["group/102/addToGroupByAdmin"] = response;
      f.responses["user/userData"] = {
        success: true,
        userID: null,
        authorized: false,
      };
      f.requests.length = 0;
      await expect(f.connection.addMember("102", member)).rejects.toMatchObject(
        { code: "authentication_required", outcome: "unknown" },
      );
      expect(f.requests.map(({ path, method }) => `${method} ${path}`)).toEqual(
        ["POST group/102/addToGroupByAdmin", "GET user/userData"],
      );
      expect(await f.connection.status()).toMatchObject({
        state: "action_required",
      });
      await expect(f.connection.addMember("102", member)).rejects.toMatchObject(
        { outcome: "not_submitted" },
      );
      expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
        1,
      );
    },
  );

  it.each([
    { success: false },
    {},
    new FlockbotError("upstream_rejected"),
    new FlockbotError("transport_failed"),
    new FlockbotError("operation_timeout"),
  ])(
    "does not probe authentication for ordinary membership failures (%#)",
    async (response) => {
      const f = fixture();
      await ready(f.connection);
      f.responses["group/102/addToGroupByAdmin"] = response;
      f.requests.length = 0;
      await expect(f.connection.addMember("102", member)).rejects.toMatchObject(
        { outcome: "unknown" },
      );
      expect(f.requests.map(({ path }) => path)).toEqual([
        "group/102/addToGroupByAdmin",
      ]);
      expect(await f.connection.status()).toMatchObject({ state: "ready" });
    },
  );

  it.each([
    [new FlockbotError("transport_failed"), "inconclusive"],
    [{}, "inconclusive"],
    [{ success: true, userID: 201, authorized: false }, "denied"],
    [new BrowserAuthenticationError("permission_denied"), "denied"],
  ])(
    "does not infer expiry when an auth-failure diagnostic is inconclusive (%#)",
    async (verification, authentication) => {
      const f = fixture();
      await ready(f.connection);
      f.responses["group/101/getSubscriberCount"] =
        new BrowserAuthenticationError("permission_denied");
      f.responses["user/userData"] = verification;
      f.requests.length = 0;
      const diagnostic = await runDiagnostic("subscriber_count", async () => {
        try {
          await f.connection.count("101");
        } catch (error) {
          return failureDiagnostic(error);
        }
        throw new Error("Expected failure");
      });
      expect(diagnostic).toMatchObject({
        authentication,
        final: { code: "permission_denied" },
      });
      expect(f.requests.map(({ path }) => path)).toEqual([
        "group/101/getSubscriberCount",
        "user/userData",
      ]);
      expect(await f.connection.status()).toMatchObject({ state: "ready" });
    },
  );

  it("reports auth not attempted when the deadline expires before diagnosis", async () => {
    const f = fixture();
    await ready(f.connection);
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    f.responses["group/101/getSubscriberCount"] = () => {
      now = 25_001;
      throw new BrowserAuthenticationError("permission_denied");
    };
    f.requests.length = 0;
    try {
      const diagnostic = await runDiagnostic("subscriber_count", async () => {
        try {
          await f.connection.count("101");
        } catch (error) {
          return failureDiagnostic(error);
        }
        throw new Error("Expected deadline");
      });
      expect(diagnostic).toMatchObject({
        authentication: "not_attempted",
        failure: { code: "permission_denied" },
        final: { code: "operation_timeout" },
      });
      expect(f.requests.map((r) => r.path)).toEqual([
        "group/101/getSubscriberCount",
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("diagnoses an expired dashboard before a named addition can be posted", async () => {
    const f = fixture();
    await ready(f.connection);
    f.responses.dashboard =
      "<!doctype html><html><form>Fictional sign-in</form></html>";
    f.responses["user/userData"] = {
      success: true,
      userID: null,
      authorized: false,
    };
    f.requests.length = 0;
    await expect(
      f.connection.addMemberByName("Volunteers", member),
    ).rejects.toMatchObject({
      code: "authentication_required",
      outcome: "not_submitted",
    });
    expect(f.requests.map(({ path }) => path)).toEqual([
      "dashboard",
      "user/userData",
    ]);
  });

  it("overlaps independent discovery reads and drains both before releasing coordination on failure", async () => {
    const f = fixture();
    await ready(f.connection);
    let finish: (value: unknown) => void = () => undefined;
    f.responses["navigation/groups"] = new FlockbotError("transport_failed");
    f.responses["network/getMetadata"] = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    let settled = false;
    const discovery = f.connection.groups().finally(() => {
      settled = true;
    });
    const rejected = expect(discovery).rejects.toMatchObject({
      code: "transport_failed",
    });
    try {
      await waitFor(() =>
        expect(
          f.requests.some(({ path }) => path === "network/getMetadata"),
        ).toBe(true),
      );
      const next = f.connection.count("101");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);
      expect(
        f.requests.some(({ path }) => path.endsWith("getSubscriberCount")),
      ).toBe(false);
      finish({ everyoneGroupID: 101 });
      await rejected;
      expect(await next).toBe(7);
    } finally {
      finish({ everyoneGroupID: 101 });
      await rejected;
    }
  });

  it("trusts the saved session, resolves a cold named addition in four requests and uses only one POST when warm", async () => {
    const f = fixture();
    await ready(f.connection);
    f.requests.length = 0;
    expect(await f.connection.addMemberByName(" volunteers ", member)).toEqual({
      success: true,
    });
    expect(f.requests.map(({ path }) => path)).toEqual([
      "dashboard",
      "navigation/groups",
      "network/getMetadata",
      "group/102/addToGroupByAdmin",
    ]);
    f.requests.length = 0;
    expect(await f.connection.addMemberByName("Volunteers", member)).toEqual({
      success: true,
    });
    expect(f.requests.map(({ path }) => path)).toEqual([
      "group/102/addToGroupByAdmin",
    ]);
    await f.connection.count("101");
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.session.finishSignIn).toHaveBeenCalledTimes(1);
    expect(f.session.close).not.toHaveBeenCalled();
    await f.connection.close();
    expect(f.session.close).toHaveBeenCalledTimes(1);
  });

  it("expires group discovery after 60 seconds and supports explicit refresh", async () => {
    let now = 0;
    const f = fixture({ now: () => now });
    await ready(f.connection);
    const first = await f.connection.groups();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    f.requests.length = 0;
    now = 59_999;
    await f.connection.groups();
    expect(f.requests).toHaveLength(0);
    now = 60_000;
    await f.connection.groups();
    await f.connection.groups({ refresh: true });
    expect(f.requests.filter(({ path }) => path === "dashboard")).toHaveLength(
      2,
    );
    expect(
      f.requests.filter(({ path }) => path === "user/userData"),
    ).toHaveLength(0);
  });

  it("clears group discovery after a browser restart and detects a changed login while diagnosing an auth failure", async () => {
    const f = fixture();
    await ready(f.connection);
    await f.connection.groups();
    f.isOpen.mockReturnValueOnce(false);
    f.requests.length = 0;
    await f.connection.groups();
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.requests).toHaveLength(3);
    f.responses["user/userData"] = { success: true, userID: 202 };
    f.responses["group/102/addToGroupByAdmin"] = {
      success: false,
      authorized: false,
    };
    await expect(
      f.connection.addMemberByName("Volunteers", member),
    ).rejects.toMatchObject({
      code: "connection_changed",
      outcome: "unknown",
    });
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
      1,
    );
  });

  it("rejects absent and ambiguous names before posting instead of guessing", async () => {
    const f = fixture();
    await ready(f.connection);
    await expect(
      f.connection.addMemberByName("Missing", member),
    ).rejects.toMatchObject({
      code: "group_not_found",
      outcome: "not_submitted",
    });
    f.responses["navigation/groups"] = {
      groups: [
        { ID: 102, name: "Volunteers", shortname: "volunteers" },
        { ID: 103, name: "VOLUNTEERS", shortname: "other" },
      ],
    };
    await expect(
      f.connection.addMemberByName("Volunteers", member),
    ).rejects.toMatchObject({
      code: "group_ambiguous",
      outcome: "not_submitted",
    });
    expect(f.requests.some(({ method }) => method === "POST")).toBe(false);
  });

  it("retains the serial queue after a cancelled waiter and drains writes before closing", async () => {
    const f = fixture();
    await ready(f.connection);
    let finish: (value: unknown) => void = () => undefined;
    f.responses["group/102/addToGroupByAdmin"] = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const active = new AbortController();
    const write = f.connection.addMember("102", member, {
      signal: active.signal,
    });
    const rejected = expect(write).rejects.toMatchObject({
      outcome: "unknown",
    });
    await waitFor(() =>
      expect(f.requests.some(({ method }) => method === "POST")).toBe(true),
    );
    active.abort();
    await rejected;
    const queued = new AbortController();
    const waiting = f.connection.count("101", { signal: queued.signal });
    const cancelled = expect(waiting).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    queued.abort();
    await cancelled;
    const next = f.connection.count("101");
    const closing = f.connection.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.session.close).not.toHaveBeenCalled();
    expect(
      f.requests.some(({ path }) => path.endsWith("getSubscriberCount")),
    ).toBe(false);
    finish({ success: true });
    expect(await next).toBe(7);
    await closing;
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
      1,
    );
    expect(f.session.close).toHaveBeenCalledTimes(1);
  });
  it("reports a fixed browser startup stage without copying launcher exception details", async () => {
    const failed = openBrowserSession(
      {
        profile: "unused-fictional-profile",
        origin: "https://example-parish.flocknote.com",
        interactive: false,
      },
      async () => {
        throw new Error("fictional-secret-not-for-diagnostics");
      },
    );
    await expect(failed).rejects.toMatchObject({
      code: "browser_unavailable",
      stage: "launch",
    });
    await failed.catch((error: unknown) => {
      expect(String(error)).not.toContain("fictional-secret");
      expect(JSON.stringify(error)).not.toContain("fictional-secret");
    });
  });
  it("status before setup opens no browser and writes no profile state", async () => {
    const f = fixture();
    expect(await f.connection.status()).toEqual({ state: "not_configured" });
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("authenticates interactively and reuses one stable browser profile across clients", async () => {
    const f = fixture();
    await ready(f.connection);
    const metadata = readFileSync(join(f.profile, "connection.json"), "utf8");
    expect(metadata).not.toMatch(/password|cookie|email|token/i);
    await f.connection.close();
    expect(await f.create().count("00101")).toBe(7);
    const options = f.factory.mock.calls.map(([options]) => options);
    expect(options[0]?.interactive).toBe(true);
    expect(options.slice(1).every((option) => !option.interactive)).toBe(true);
    expect(new Set(options.map((option) => option.profile)).size).toBe(1);
    expect(
      options.every(
        (option) => option.origin === "https://example-parish.flocknote.com",
      ),
    ).toBe(true);
  });

  it("returns only groups, counts and confirmed write success", async () => {
    const f = fixture();
    await ready(f.connection);
    expect(await f.connection.groups()).toEqual([
      { id: "101", name: "Everyone", shortName: "everyone", isEveryone: true },
      {
        id: "102",
        name: "Volunteers",
        shortName: "volunteers",
        isEveryone: false,
      },
    ]);
    expect(await f.connection.count("101")).toBe(7);
    expect(
      await f.connection.addMember("102", {
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
      }),
    ).toEqual({ success: true });
    expect(f.requests.filter(({ method }) => method === "POST")).toEqual([
      {
        path: "group/102/addToGroupByAdmin",
        method: "POST",
        body: "fname=Alex&lname=Rivera&email=alex%40example.test&mobile_phone=",
      },
    ]);
  });

  it("uses the same parser for a legacy dashboard", async () => {
    const f = fixture();
    await ready(f.connection);
    f.responses.dashboard =
      '<div class="group_item" data-groupid="101" data-shortname="everyone"><span class="group_name">Everyone</span></div>';
    f.requests.length = 0;
    expect(await f.connection.groups()).toHaveLength(1);
    expect(f.requests.map(({ path }) => path)).toEqual(["dashboard"]);
  });

  it("assumes ready until a read fails for auth, then confirms expiry and pauses without replaying", async () => {
    const f = fixture();
    await ready(f.connection);
    f.responses["user/userData"] = {
      success: true,
      userID: null,
      authorized: false,
    };
    f.requests.length = 0;
    expect(await f.connection.status()).toEqual({
      state: "ready",
      parish: "example-parish",
    });
    expect(f.requests).toHaveLength(0);
    f.responses["group/101/getSubscriberCount"] =
      new BrowserAuthenticationError("upstream_rejected");
    await expect(f.connection.count("101")).rejects.toMatchObject({
      code: "authentication_required",
    });
    expect(f.requests.map(({ path }) => path)).toEqual([
      "group/101/getSubscriberCount",
      "user/userData",
    ]);
    expect(await f.connection.status()).toEqual({
      state: "action_required",
      parish: "example-parish",
    });
    await expect(
      f.connection.addMember("102", {
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
      }),
    ).rejects.toMatchObject({
      code: "authentication_required",
      outcome: "not_submitted",
    });
    expect(f.requests.some(({ method }) => method === "POST")).toBe(false);
  });

  it("does not guess that a network failure or permission denial means expiry", async () => {
    const f = fixture();
    await ready(f.connection);
    f.requests.length = 0;
    f.responses["group/101/getSubscriberCount"] = new FlockbotError(
      "transport_failed",
    );
    await expect(f.connection.count("101")).rejects.toMatchObject({
      code: "transport_failed",
    });
    expect(f.requests.map(({ path }) => path)).toEqual([
      "group/101/getSubscriberCount",
    ]);
    f.responses["group/101/getSubscriberCount"] =
      new BrowserAuthenticationError("permission_denied");
    f.responses["user/userData"] = {
      success: true,
      userID: 201,
      authorized: false,
    };
    await expect(f.connection.count("101")).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(
      JSON.parse(readFileSync(join(f.profile, "connection.json"), "utf8"))
        .state,
    ).toBe("ready");
  });

  it("refuses a changed parish and preserves login pinning on an auth-failure check", async () => {
    const f = fixture();
    await ready(f.connection);
    await expect(
      f.connection.connect("different-parish"),
    ).rejects.toBeInstanceOf(BrowserConnectionError);
    f.responses["user/userData"] = { success: true, userID: 202 };
    f.responses["group/101/getSubscriberCount"] =
      new BrowserAuthenticationError("permission_denied");
    f.requests.length = 0;
    await expect(f.connection.count("101")).rejects.toMatchObject({
      code: "connection_changed",
    });
    expect(f.requests.map(({ path }) => path)).toEqual([
      "group/101/getSubscriberCount",
      "user/userData",
    ]);
  });

  it("reports a peer's setup and recovers abandoned pending state", async () => {
    const f = fixture();
    f.responses["user/userData"] = {
      success: true,
      userID: null,
      authorized: false,
    };
    await f.connection.connect("example-parish");
    expect(await f.connection.status()).toEqual({
      state: "pending",
      parish: "example-parish",
    });
    await f.connection.close();
    const file = join(f.profile, "connection.json");
    const metadata = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...metadata, state: "pending" }));
    expect(await f.create().status()).toMatchObject({
      state: "action_required",
      parish: "example-parish",
    });
  });

  it("keeps reconnect open while another login is present, then accepts the original login", async () => {
    const f = fixture();
    await ready(f.connection);
    f.responses["user/userData"] = { success: true, userID: 202 };
    await f.connection.connect("example-parish");
    expect(await f.connection.status()).toMatchObject({ state: "pending" });
    await expect(f.connection.connect("other-parish")).rejects.toMatchObject({
      code: "connection_changed",
    });
    f.responses["user/userData"] = { success: true, userID: 201 };
    await waitFor(async () =>
      expect(await f.connection.status()).toMatchObject({ state: "ready" }),
    );
  });

  it("never replays a rejected, malformed or disconnected membership submission", async () => {
    const f = fixture();
    await ready(f.connection);
    for (const reply of [
      { success: false },
      {},
      new FlockbotError("transport_failed"),
    ]) {
      f.responses["group/102/addToGroupByAdmin"] = reply;
      f.requests.length = 0;
      await expect(
        f.connection.addMember("102", {
          firstName: "Alex",
          lastName: "Rivera",
          email: "alex@example.test",
        }),
      ).rejects.toMatchObject({ outcome: "unknown" });
      expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
        1,
      );
    }
  });

  it("validates membership before opening a browser", async () => {
    const f = fixture();
    await expect(
      f.connection.addMember("../logout", {
        firstName: "Alex",
        lastName: "Rivera",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      outcome: "not_submitted",
    });
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("holds coordination after cancellation until a submitted write settles", async () => {
    const f = fixture();
    await ready(f.connection);
    let finish: (value: unknown) => void = () => undefined;
    f.responses["group/102/addToGroupByAdmin"] = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const controller = new AbortController();
    const write = f.connection.addMember(
      "102",
      { firstName: "Alex", lastName: "Rivera", email: "alex@example.test" },
      { signal: controller.signal },
    );
    const rejection = expect(write).rejects.toMatchObject({
      code: "operation_cancelled",
      outcome: "unknown",
    });
    await waitFor(() =>
      expect(f.requests.some(({ method }) => method === "POST")).toBe(true),
    );
    controller.abort();
    await rejection;
    const calls = f.factory.mock.calls.length;
    const next = f.connection.count("101");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.factory.mock.calls).toHaveLength(calls);
    finish({ success: true });
    expect(await next).toBe(7);
  });

  it("forgets the dedicated profile without retaining a usable connection", async () => {
    const f = fixture();
    await ready(f.connection);
    await f.connection.forget();
    expect(await f.create().status()).toEqual({ state: "not_configured" });
    await expect(f.connection.groups()).rejects.toMatchObject({
      code: "not_configured",
    });
  });
});
