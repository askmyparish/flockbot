import { inspect } from "node:util";
import { CookieJar } from "tough-cookie";
import { describe, expect, it, vi } from "vitest";
import {
  type ClientOptions,
  FlockbotClient,
  FlockbotError,
  type OperationClock,
  RequestNotSentError,
  sessionFromToken,
  type SessionState,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "../src/index.js";
import { FakeCoordinator } from "./support.js";

const subdomain = "example-parish";
const initial = () => sessionFromToken(subdomain, "fictional-old");
const credentials = {
  email: "fictional@example.test",
  password: "fictional-password",
};
const accepted = { success: true, userID: 101 };
const invalid = { success: true, userID: null, authorized: false };
const first = {
  success: true,
  allowPasswordForFirstFactor: true,
  firstFactorSuccess: false,
};

function response(
  data: unknown = accepted,
  cookie?: string,
  status = 200,
): TransportResponse {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie)
    headers.set(
      "set-cookie",
      `Flocknote=${cookie}; Domain=flocknote.com; Path=/; Secure; HttpOnly`,
    );
  return { status, headers, body: JSON.stringify(data) };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

class ManualClock implements OperationClock {
  time = 0;
  timers = new Set<{ due: number; callback: () => void }>();
  now() {
    return this.time;
  }
  schedule(delay: number, callback: () => void) {
    const timer = { due: this.time + delay, callback };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  }
  async advance(ms: number) {
    this.time += ms;
    for (const timer of [...this.timers])
      if (timer.due <= this.time) {
        this.timers.delete(timer);
        timer.callback();
      }
    await tick();
  }
}

function fixture(
  state: SessionState | null = initial(),
  extra: Partial<ClientOptions> = {},
) {
  let saved = structuredClone(state);
  let revision = 0;
  const coordinator = new FakeCoordinator();
  const sessionStore = {
    revision: vi.fn(async () => String(revision)),
    load: vi.fn(async () => structuredClone(saved)),
    save: vi.fn(async (next: SessionState, expected: string) => {
      if (expected !== String(revision))
        throw new FlockbotError("stale_session_state");
      saved = structuredClone(next);
      revision++;
    }),
    clear: vi.fn(async (expected: string) => {
      if (expected !== String(revision))
        throw new FlockbotError("stale_session_state");
      saved = null;
      revision++;
    }),
  };
  const requests: TransportRequest[] = [];
  const transport = vi.fn<Transport>(async (request) => {
    requests.push(request);
    if (request.method === "POST") {
      if (new URLSearchParams(request.body).has("password"))
        return response({ success: true, loginSuccess: true });
      return response(first, "fictional-renewed");
    }
    return response();
  });
  const provider = { load: vi.fn(async () => credentials) };
  // Independent handles share the fake server's identity lock and durable state.
  const construct = (options: Partial<ClientOptions> = {}) =>
    new FlockbotClient({
      subdomain,
      sessionStore,
      coordinator: {
        runExclusive: (...args) => coordinator.runExclusive(...args),
      },
      transport,
      credentialProvider: provider,
      policy: { maxReadRetries: 0 },
      ...extra,
      ...options,
    });
  return { construct, sessionStore, transport, provider, requests };
}

describe("coordinated session lifecycle", () => {
  it("reloads accepted sessions and peer rotations without credential reads", async () => {
    const f = fixture();
    const a = f.construct();
    await a.connect();
    f.transport.mockResolvedValueOnce(response(accepted, "fictional-peer"));
    await f.construct().get("user/userData");
    await a.connect();
    expect(f.transport.mock.calls[2]?.[0].headers.Cookie).toContain(
      "fictional-peer",
    );
    expect(f.provider.load).not.toHaveBeenCalled();
    expect(f.sessionStore.load).toHaveBeenCalledTimes(3);
    expect(f.sessionStore.save).toHaveBeenCalledOnce();
  });

  it("serializes independent clients, reloads after locking and renews once under overlap", async () => {
    const gate = deferred<TransportResponse>();
    const entered = deferred<void>();
    const f = fixture();
    f.transport.mockImplementationOnce(async () => {
      entered.resolve();
      return gate.promise;
    });
    const a = f.construct().connect();
    await entered.promise;
    const b = f.construct().connect();
    await tick();
    expect(f.transport).toHaveBeenCalledOnce();
    gate.resolve(response(invalid, "fictional-rejected"));
    await Promise.all([a, b]);
    expect(f.provider.load).toHaveBeenCalledOnce();
    expect(
      f.transport.mock.calls.filter(([r]) => r.method === "POST"),
    ).toHaveLength(2);
    expect(f.transport.mock.calls.at(-1)?.[0].headers.Cookie).toContain(
      "fictional-renewed",
    );
    expect(JSON.stringify(await f.sessionStore.load())).not.toContain(
      "fictional-rejected",
    );
  });

  it("recovers a confirmed invalid GET once and never loops after renewed rejection", async () => {
    const f = fixture();
    f.transport
      .mockResolvedValueOnce(response(invalid))
      .mockResolvedValueOnce(response(first, "fictional-renewed"))
      .mockResolvedValueOnce(response({ success: true, loginSuccess: true }))
      .mockResolvedValueOnce(response(accepted))
      .mockResolvedValueOnce(response(invalid, "fictional-rejected"));
    await expect(f.construct().get("user/userData")).rejects.toMatchObject({
      code: "authentication_required",
    });
    expect(f.provider.load).toHaveBeenCalledOnce();
    expect(f.transport).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(await f.sessionStore.load())).toContain(
      "fictional-renewed",
    );
  });

  it.each(["credentials_rejected", "action_required"] as const)(
    "persists %s across reconstructions and force-login calls",
    async (reason) => {
      const f = fixture(null);
      if (reason === "action_required")
        f.transport.mockResolvedValueOnce(
          response({ ...first, allowPasswordForFirstFactor: false }),
        );
      else
        f.transport
          .mockResolvedValueOnce(response(first, "fictional-candidate"))
          .mockResolvedValueOnce(
            response({
              ...first,
              message:
                "Sorry, that password doesn't match our records. fictional@example.test",
            }),
          );
      await expect(f.construct().connect()).rejects.toMatchObject({
        code: reason,
      });
      const attempts = f.transport.mock.calls.length;
      for (const call of [
        () => f.construct().get("dashboard"),
        () => f.construct().post("write", {}),
        () => f.construct().connect({ forcePasswordLogin: true }),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: "action_required" });
      }
      expect(f.transport).toHaveBeenCalledTimes(attempts);
      expect(f.provider.load).toHaveBeenCalledOnce();
      const blocked = await f.sessionStore.load();
      expect(blocked?.intervention).toEqual({
        configurationVersion: "initial",
        reason,
      });
      expect(JSON.stringify(blocked)).not.toContain(credentials.email);
      expect(JSON.stringify(blocked)).not.toContain(credentials.password);
      await f.construct({ configurationVersion: "revision-2" }).connect();
      expect(f.provider.load).toHaveBeenCalledTimes(2);
      expect((await f.sessionStore.load())?.intervention).toBeUndefined();
    },
  );

  it("explicit reset clears persistent intervention and advances even an empty generation", async () => {
    const f = fixture(null);
    f.transport.mockResolvedValueOnce(
      response({ ...first, allowPasswordForFirstFactor: false }),
    );
    await expect(f.construct().connect()).rejects.toMatchObject({
      code: "action_required",
    });
    const before = await f.sessionStore.revision();
    await f.construct().clearSession();
    await f.construct().clearSession();
    expect(await f.sessionStore.revision()).not.toBe(before);
    await f.construct().connect();
    expect(f.provider.load).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 429, 503])(
    "does not renew or block credentials on HTTP %s",
    async (status) => {
      const f = fixture();
      f.transport.mockResolvedValueOnce(
        response({}, "fictional-error-cookie", status),
      );
      await expect(f.construct().connect()).rejects.toMatchObject({
        code:
          status === 403
            ? "permission_denied"
            : status === 401
              ? "authentication_protocol_error"
              : "authentication_unavailable",
      });
      expect(f.provider.load).not.toHaveBeenCalled();
      expect(f.sessionStore.save).not.toHaveBeenCalled();
      await f.construct().connect();
      expect(f.provider.load).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      body: { success: true, userID: 101, authorized: false },
      code: "permission_denied",
    },
    {
      body: { success: true, userID: "unknown", authorized: false },
      code: "authentication_protocol_error",
    },
    {
      body: { success: false, userID: null, authorized: false },
      code: "authentication_protocol_error",
    },
    {
      body: { success: true, authorized: false },
      code: "authentication_protocol_error",
    },
  ])(
    "fails closed on permission or unobserved userData shapes without renewal: %j",
    async ({ body, code }) => {
      const f = fixture();
      f.transport.mockResolvedValueOnce(
        response(body, "fictional-error-cookie"),
      );
      await expect(f.construct().get("user/userData")).rejects.toMatchObject({
        code,
      });
      expect(f.provider.load).not.toHaveBeenCalled();
      expect(f.sessionStore.save).not.toHaveBeenCalled();
    },
  );

  it("does not infer invalid authentication from another endpoint's response", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(response(invalid, "fictional-rejected"));
    await expect(f.construct().get("example/read")).rejects.toMatchObject({
      code: "upstream_rejected",
    });
    expect(f.provider.load).not.toHaveBeenCalled();
    expect(f.sessionStore.save).not.toHaveBeenCalled();
  });

  it("reports generic HTTP permission denial without renewing or saving its cookie", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(response({}, "fictional-denied", 403));
    await expect(f.construct().get("dashboard")).rejects.toMatchObject({
      code: "permission_denied",
      status: 403,
    });
    expect(f.provider.load).not.toHaveBeenCalled();
    expect(f.sessionStore.save).not.toHaveBeenCalled();
  });

  it("a temporary password outage does not persist intervention", async () => {
    const f = fixture(null);
    f.transport.mockResolvedValueOnce(response({}, undefined, 503));
    await expect(f.construct().connect()).rejects.toMatchObject({
      code: "authentication_unavailable",
    });
    expect(await f.sessionStore.load()).toBeNull();
    await f.construct().connect();
    expect(f.provider.load).toHaveBeenCalledTimes(2);
  });

  it.each(["rotation", "reset"])(
    "discards a pending save after peer %s advanced state",
    async (change) => {
      const f = fixture();
      const a = f.construct();
      f.sessionStore.save.mockRejectedValueOnce(new Error("fictional-secret"));
      f.transport.mockResolvedValueOnce(
        response(accepted, "fictional-unsaved"),
      );
      await expect(a.connect()).rejects.toMatchObject({
        code: "session_save_failed",
      });
      if (change === "reset") {
        await f.construct().clearSession();
        await f.sessionStore.save(initial(), await f.sessionStore.revision());
      } else
        await f.sessionStore.save(
          sessionFromToken(subdomain, "fictional-peer"),
          await f.sessionStore.revision(),
        );
      await a.connect();
      const cookie = f.transport.mock.calls.at(-1)?.[0].headers.Cookie;
      expect(cookie).not.toContain("fictional-unsaved");
      expect(JSON.stringify(await f.sessionStore.load())).not.toContain(
        "fictional-unsaved",
      );
    },
  );

  it("reset of an empty store fences pending bootstrap instead of reviving it", async () => {
    const f = fixture(null);
    const a = f.construct();
    f.sessionStore.save.mockRejectedValueOnce(new Error("fictional outage"));
    await expect(a.connect()).rejects.toMatchObject({
      code: "session_save_failed",
    });
    await f.construct().clearSession();
    await a.connect();
    expect(f.provider.load).toHaveBeenCalledTimes(2);
  });

  it("reconciles a write-then-throw save using the advanced revision", async () => {
    const f = fixture(null);
    const save = f.sessionStore.save.getMockImplementation();
    f.sessionStore.save.mockImplementationOnce(async (state, expected) => {
      await save?.(state, expected);
      throw new Error("fictional ambiguous storage acknowledgement");
    });
    const a = f.construct();
    await expect(a.connect()).rejects.toMatchObject({
      code: "session_save_failed",
    });
    await a.connect();
    expect(f.provider.load).toHaveBeenCalledOnce();
    expect(f.sessionStore.save).toHaveBeenCalledOnce();
  });

  it("rejects stale CAS publication when a generation advances during transport", async () => {
    const f = fixture();
    const gate = deferred<TransportResponse>();
    const entered = deferred<void>();
    f.transport.mockImplementationOnce(async () => {
      entered.resolve();
      return gate.promise;
    });
    const call = f.construct().connect();
    await entered.promise;
    // Simulate an external fenced writer winning; CAS remains required even with coordination.
    await f.sessionStore.save(
      sessionFromToken(subdomain, "fictional-peer"),
      await f.sessionStore.revision(),
    );
    gate.resolve(response(accepted, "fictional-stale"));
    await expect(call).rejects.toMatchObject({ code: "stale_session_state" });
    expect(JSON.stringify(await f.sessionStore.load())).toContain(
      "fictional-peer",
    );
  });

  it.each(["revision", "load", "save", "coordination"] as const)(
    "fails closed and sanitizes %s failure",
    async (boundary) => {
      const f = fixture(null);
      const secret = "fictional-sensitive-password";
      const options: Partial<ClientOptions> =
        boundary === "coordination"
          ? {
              coordinator: {
                runExclusive: async () => {
                  throw new Error(secret);
                },
              },
            }
          : {};
      if (boundary !== "coordination")
        f.sessionStore[boundary].mockRejectedValueOnce(new Error(secret));
      const error: unknown = await f
        .construct(options)
        .connect()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlockbotError);
      expect(error).toMatchObject({
        code:
          boundary === "coordination"
            ? "coordination_failed"
            : boundary === "save"
              ? "session_save_failed"
              : "session_load_failed",
      });
      expect(inspect(error)).not.toContain(secret);
      if (boundary !== "save") expect(f.provider.load).not.toHaveBeenCalled();
    },
  );

  it("fails closed when coordinator is absent at runtime", async () => {
    const f = fixture();
    const client = f.construct({
      coordinator: undefined,
    } as unknown as Partial<ClientOptions>);
    await expect(client.connect()).rejects.toMatchObject({
      code: "coordination_failed",
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.sessionStore.load).not.toHaveBeenCalled();
  });

  it("keeps intervention in place when reset fails", async () => {
    const blocked: SessionState = {
      ...initial(),
      intervention: {
        configurationVersion: "initial",
        reason: "action_required",
      },
    };
    const f = fixture(blocked);
    const revision = await f.sessionStore.revision();
    f.sessionStore.clear.mockRejectedValueOnce(
      new Error("fictional-sensitive-reset-error"),
    );
    const error: unknown = await f
      .construct()
      .clearSession()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "session_clear_failed" });
    expect(inspect(error)).not.toContain("fictional-sensitive-reset-error");
    expect(await f.sessionStore.load()).toEqual(blocked);
    expect(await f.sessionStore.revision()).toBe(revision);
    await expect(f.construct().connect()).rejects.toMatchObject({
      code: "action_required",
    });
    expect(f.provider.load).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
});

describe("bounded operation policy and write outcomes", () => {
  it.each(["GET", "POST"] as const)(
    "sanitizes an unclassified %s callback failure without blaming coordination",
    async (method) => {
      const f = fixture();
      f.transport.mockResolvedValueOnce(response({ ok: true }));
      const originalClone = CookieJar.prototype.cloneSync;
      const secret = "fictional-sensitive-serialization-failure";
      const clone = vi
        .spyOn(CookieJar.prototype, "cloneSync")
        .mockImplementation(function (
          this: CookieJar,
          ...args: Parameters<typeof originalClone>
        ) {
          const candidate = originalClone.apply(this, args);
          if (candidate)
            vi.spyOn(candidate, "serializeSync").mockImplementationOnce(() => {
              throw new Error(secret);
            });
          return candidate;
        });
      try {
        const client = f.construct();
        const result =
          method === "POST"
            ? client.post("example/write", {})
            : client.get("dashboard");
        const error: unknown = await result.catch((e: unknown) => e);
        expect(error).toMatchObject({
          code:
            method === "POST" ? "write_outcome_unknown" : "operation_failed",
        });
        expect((error as FlockbotError).outcome).toBe(
          method === "POST" ? "unknown" : undefined,
        );
        expect(inspect(error)).not.toContain(secret);
        expect(f.transport).toHaveBeenCalledOnce();
        expect(f.sessionStore.save).not.toHaveBeenCalled();
        expect(await f.sessionStore.load()).toEqual(initial());
        expect(f.provider.load).not.toHaveBeenCalled();
      } finally {
        clone.mockRestore();
      }
    },
  );

  it("aborts callback work after coordinator rejection before public POST submission", async () => {
    const clock = new ManualClock();
    const f = fixture(null, { clock });
    const entered = deferred<void>();
    const gate = deferred<SessionState | null>();
    let callback: Promise<unknown> | undefined;
    let signal: AbortSignal | undefined;
    f.sessionStore.load.mockImplementationOnce(async () => {
      entered.resolve();
      return gate.promise;
    });
    const call = f
      .construct({
        coordinator: {
          async runExclusive(_identity, currentSignal, work) {
            signal = currentSignal;
            // Simulate lease loss reported before the running callback settles.
            callback = work().catch((error: unknown) => error);
            await entered.promise;
            throw new Error("fictional lease loss");
          },
        },
      })
      .post("example/write", {});
    await expect(call).rejects.toMatchObject({
      code: "coordination_failed",
      outcome: "not_submitted",
    });
    expect(signal?.aborted).toBe(true);
    gate.resolve(null);
    await callback;
    expect(f.provider.load).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.sessionStore.save).not.toHaveBeenCalled();
    expect(clock.timers.size).toBe(0);
  });

  it.each(["lock", "load", "bootstrap"] as const)(
    "reports a POST deadline before submission during %s and fences late completion",
    async (stage) => {
      const clock = new ManualClock();
      const f = fixture(stage === "bootstrap" ? null : initial(), {
        clock,
        policy: { timeoutMs: 100 },
      });
      const entered = deferred<void>();
      const responseGate = deferred<TransportResponse>();
      const loadGate = deferred<SessionState | null>();
      let blocker: Promise<void> | undefined;
      if (stage === "load") {
        f.sessionStore.load.mockImplementationOnce(async () => {
          entered.resolve();
          return loadGate.promise;
        });
      } else {
        f.transport.mockImplementationOnce(async () => {
          entered.resolve();
          return responseGate.promise;
        });
        if (stage === "lock") {
          blocker = f.construct({ policy: { timeoutMs: 1000 } }).connect();
          await entered.promise;
        }
      }
      const call = f.construct().post("example/write", {});
      const failure = expect(call).rejects.toMatchObject({
        code: "operation_timeout",
        outcome: "not_submitted",
      });
      if (stage !== "lock") await entered.promise;
      await clock.advance(100);
      await failure;
      loadGate.resolve(initial());
      responseGate.resolve(
        stage === "bootstrap"
          ? response(first, "fictional-late-bootstrap")
          : response(),
      );
      await blocker;
      await tick();
      expect(
        f.transport.mock.calls.some(
          ([request]) => new URL(request.url).pathname === "/example/write",
        ),
      ).toBe(false);
      expect(f.transport).toHaveBeenCalledTimes(stage === "load" ? 0 : 1);
      expect(f.provider.load).toHaveBeenCalledTimes(
        stage === "bootstrap" ? 1 : 0,
      );
      expect(f.sessionStore.save).not.toHaveBeenCalled();
      expect(clock.timers.size).toBe(0);
    },
  );

  it("uses deterministic backoff and an operation-wide bounded read retry count", async () => {
    const clock = new ManualClock();
    const f = fixture(initial(), {
      clock,
      policy: { timeoutMs: 1000, maxReadRetries: 2, readBackoffMs: 100 },
    });
    f.transport.mockResolvedValue(response({}, undefined, 503));
    const call = f.construct().get("dashboard");
    await tick();
    expect(f.transport).toHaveBeenCalledOnce();
    await clock.advance(99);
    expect(f.transport).toHaveBeenCalledOnce();
    await clock.advance(1);
    expect(f.transport).toHaveBeenCalledTimes(2);
    await clock.advance(200);
    await expect(call).rejects.toMatchObject({ code: "upstream_rejected" });
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(f.provider.load).not.toHaveBeenCalled();
    expect(clock.timers.size).toBe(0);
  });

  it("shares the read retry allowance across saved verification and password verification", async () => {
    const clock = new ManualClock();
    const f = fixture(initial(), {
      clock,
      policy: { timeoutMs: 1000, maxReadRetries: 1, readBackoffMs: 10 },
    });
    f.transport
      .mockResolvedValueOnce(response({}, undefined, 503))
      .mockResolvedValueOnce(response(invalid))
      .mockResolvedValueOnce(response(first, "fictional-candidate"))
      .mockResolvedValueOnce(response({ success: true, loginSuccess: true }))
      .mockResolvedValueOnce(response({}, undefined, 503));
    const call = f.construct().connect();
    const failure = expect(call).rejects.toMatchObject({
      code: "authentication_unavailable",
    });
    await tick();
    await clock.advance(10);
    await failure;
    expect(f.transport).toHaveBeenCalledTimes(5);
    expect(f.provider.load).toHaveBeenCalledOnce();
    expect(f.sessionStore.save).not.toHaveBeenCalled();
  });

  it("normal same-client overlap saves rotation before reset and never restores cached cookies", async () => {
    const f = fixture();
    const gate = deferred<TransportResponse>();
    const entered = deferred<void>();
    f.transport.mockImplementationOnce(async () => {
      entered.resolve();
      return gate.promise;
    });
    const client = f.construct();
    const request = client.get("dashboard");
    await entered.promise;
    const reset = client.clearSession();
    await tick();
    expect(f.sessionStore.clear).not.toHaveBeenCalled();
    gate.resolve(response(accepted, "fictional-before-reset"));
    await request;
    await reset;
    expect(await f.sessionStore.load()).toBeNull();
    await client.connect();
    expect(f.provider.load).toHaveBeenCalledOnce();
    expect(f.transport.mock.calls[1]?.[0].headers.Cookie).toBeUndefined();
    expect(JSON.stringify(await f.sessionStore.load())).not.toContain(
      "fictional-before-reset",
    );
  });

  it("deadline terminates a hung transport and fences its late cookie before queued reset", async () => {
    const clock = new ManualClock();
    const f = fixture(initial(), { clock, policy: { timeoutMs: 100 } });
    const gate = deferred<TransportResponse>();
    f.transport.mockImplementationOnce(() => gate.promise);
    const a = f.construct();
    const call = a.connect();
    const failure = expect(call).rejects.toMatchObject({
      code: "operation_timeout",
    });
    await tick();
    await clock.advance(100);
    await failure;
    expect(f.transport.mock.calls[0]?.[0].signal.aborted).toBe(true);
    const reset = a.clearSession();
    await tick();
    expect(f.sessionStore.clear).not.toHaveBeenCalled();
    gate.resolve(response(accepted, "fictional-late"));
    await reset;
    expect(f.sessionStore.save).not.toHaveBeenCalled();
    expect(await f.sessionStore.load()).toBeNull();
    expect(f.provider.load).not.toHaveBeenCalled();
  });

  it("a timed-out in-flight store save remains coordinated until it settles before reset", async () => {
    const clock = new ManualClock();
    const f = fixture(initial(), { clock, policy: { timeoutMs: 100 } });
    f.transport.mockResolvedValueOnce(
      response(accepted, "fictional-late-store"),
    );
    const entered = deferred<void>();
    const gate = deferred<void>();
    const save = f.sessionStore.save.getMockImplementation();
    f.sessionStore.save.mockImplementationOnce(async (state, expected) => {
      entered.resolve();
      await gate.promise;
      await save?.(state, expected);
    });
    const a = f.construct();
    const call = a.connect();
    const failure = expect(call).rejects.toMatchObject({
      code: "operation_timeout",
    });
    await entered.promise;
    await clock.advance(100);
    await failure;
    const reset = f.construct().clearSession();
    await tick();
    expect(f.sessionStore.clear).not.toHaveBeenCalled();
    gate.resolve();
    await reset;
    expect(await f.sessionStore.load()).toBeNull();
    await expect(a.get("dashboard")).resolves.toEqual(accepted);
    expect(f.provider.load).toHaveBeenCalledOnce();
  });

  it("deadline during a hung load prevents any late login", async () => {
    const clock = new ManualClock();
    const f = fixture(null, { clock, policy: { timeoutMs: 100 } });
    const gate = deferred<SessionState | null>();
    f.sessionStore.load.mockImplementationOnce(() => gate.promise);
    const call = f.construct().connect();
    const failure = expect(call).rejects.toMatchObject({
      code: "operation_timeout",
    });
    await tick();
    await clock.advance(100);
    await failure;
    gate.resolve(null);
    await tick();
    expect(f.provider.load).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("cancels during backoff and does not retry or renew", async () => {
    const clock = new ManualClock();
    const abort = new AbortController();
    const f = fixture(initial(), {
      clock,
      policy: { timeoutMs: 1000, maxReadRetries: 2, readBackoffMs: 100 },
    });
    f.transport.mockRejectedValue(new Error("fictional network error"));
    const call = f.construct().get("dashboard", { signal: abort.signal });
    const failure = expect(call).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    await tick();
    abort.abort();
    await failure;
    await clock.advance(1000);
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.provider.load).not.toHaveBeenCalled();
  });

  it("rejects a backoff that would consume the remaining deadline", async () => {
    const clock = new ManualClock();
    const f = fixture(initial(), {
      clock,
      policy: { timeoutMs: 100, maxReadRetries: 1, readBackoffMs: 100 },
    });
    f.transport.mockResolvedValueOnce(response({}, undefined, 503));
    await expect(f.construct().get("dashboard")).rejects.toMatchObject({
      code: "operation_timeout",
    });
    expect(f.transport).toHaveBeenCalledOnce();
  });

  it("cancelled queued operations never execute after another client releases coordination", async () => {
    const f = fixture();
    const gate = deferred<TransportResponse>();
    f.transport.mockImplementationOnce(() => gate.promise);
    const firstCall = f.construct().connect();
    await tick();
    const abort = new AbortController();
    const second = f.construct().connect({ signal: abort.signal });
    const failure = expect(second).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    abort.abort();
    await failure;
    gate.resolve(response());
    await firstCall;
    await tick();
    expect(f.transport).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "cancel"])(
    "reports an uncertain submitted POST on %s and never replays it",
    async (mode) => {
      const clock = new ManualClock();
      const abort = new AbortController();
      const f = fixture(initial(), { clock, policy: { timeoutMs: 100 } });
      const gate = deferred<TransportResponse>();
      f.transport.mockImplementationOnce(() => gate.promise);
      const call = f
        .construct()
        .post("example/write", {}, { signal: abort.signal });
      const failure = expect(call).rejects.toMatchObject({
        code: mode === "timeout" ? "operation_timeout" : "operation_cancelled",
        outcome: "unknown",
      });
      await tick();
      if (mode === "cancel") abort.abort();
      else await clock.advance(100);
      await failure;
      gate.resolve(response(accepted, "fictional-late-write"));
      await tick();
      expect(f.transport).toHaveBeenCalledOnce();
      expect(f.sessionStore.save).not.toHaveBeenCalled();
      expect(f.provider.load).not.toHaveBeenCalled();
    },
  );

  it.each([
    { failure: "transport", code: "transport_failed", status: undefined },
    {
      failure: "invalid_session",
      code: "authentication_required",
      status: undefined,
    },
    { failure: "rate_limit", code: "upstream_rejected", status: 429 },
    { failure: "permission", code: "permission_denied", status: 403 },
    { failure: "invalid_input", code: "upstream_rejected", status: 200 },
    { failure: "malformed", code: "invalid_response", status: undefined },
  ])(
    "never renews/replays an uncertain POST after $failure and preserves its error class",
    async ({ failure, code, status }) => {
      const f = fixture();
      if (failure === "transport")
        f.transport.mockRejectedValueOnce(
          new Error("fictional-sensitive-error"),
        );
      else if (failure === "malformed")
        f.transport.mockResolvedValueOnce({
          ...response(),
          body: "fictional-sensitive-error",
        });
      else
        f.transport.mockResolvedValueOnce(
          response(
            failure === "invalid_input"
              ? { success: false, message: "fictional-sensitive-error" }
              : invalid,
            "fictional-rejected",
            status ?? 200,
          ),
        );
      const error = await f
        .construct()
        .post(
          failure === "invalid_input" ? "example/write" : "user/userData",
          {},
        )
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code, outcome: "unknown" });
      expect((error as FlockbotError).status).toBe(status);
      expect(inspect(error)).not.toContain("fictional-sensitive-error");
      expect(f.transport).toHaveBeenCalledOnce();
      expect(f.provider.load).not.toHaveBeenCalled();
      expect(f.sessionStore.save).not.toHaveBeenCalled();
    },
  );

  it("distinguishes an adapter's known-not-submitted request without replay", async () => {
    const f = fixture();
    f.transport.mockRejectedValueOnce(new RequestNotSentError());
    await expect(f.construct().post("example/write", {})).rejects.toMatchObject(
      { code: "request_not_sent", outcome: "not_submitted" },
    );
    expect(f.transport).toHaveBeenCalledOnce();
  });

  it("a pre-aborted POST is known not submitted and makes no state or transport call", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(
      f.construct().post("example/write", {}, { signal: abort.signal }),
    ).rejects.toMatchObject({
      code: "operation_cancelled",
      outcome: "not_submitted",
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.sessionStore.load).not.toHaveBeenCalled();
  });
});
