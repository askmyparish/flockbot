import { inspect } from "node:util";
import { errors, createAppTester } from "zapier-platform-core";
import { describe, expect, it, vi } from "vitest";
import {
  createAuthentication,
  createReadExecution,
  runOperationalWrite,
  feasibility,
} from "../../adapters/zapier/src/authentication.js";
import {
  sessionFromToken,
  type SessionState,
  type Transport,
  type TransportResponse,
} from "../../src/index.js";
import { FakeCoordinator } from "../support.js";

const z = { errors };
const credentials = {
  subdomain: "example-parish",
  email: "operator@example.test",
  password: "fictional-password",
};
const accepted = { success: true, userID: 201 };
const expired = { success: true, userID: null, authorized: false };
const firstFactor = {
  success: true,
  allowPasswordForFirstFactor: true,
  firstFactorSuccess: false,
};
function response(
  data: unknown,
  status = 200,
  token?: string,
): TransportResponse {
  const headers = new Headers({ "content-type": "application/json" });
  if (token)
    headers.set(
      "set-cookie",
      `Flocknote=${token}; Domain=flocknote.com; Path=/; Secure; HttpOnly`,
    );
  return { status, headers, body: JSON.stringify(data) };
}
function encoded(token = "fictional-saved") {
  return JSON.stringify({
    version: 1,
    state: sessionFromToken("example-parish", token),
  });
}
function bundle(sessionData = encoded()) {
  return { authData: { ...credentials, sessionData }, inputData: {} };
}
function fixture() {
  const transport = vi.fn<Transport>(async (request) => {
    if (request.url.endsWith("/login/twoFactorAuth"))
      return new URLSearchParams(request.body).has("password")
        ? response({ success: true, loginSuccess: true })
        : response(firstFactor, 200, "fictional-renewed");
    return response(accepted);
  });
  return {
    transport,
    authentication: createAuthentication({ transport }),
    paths: () => transport.mock.calls.map(([r]) => new URL(r.url).pathname),
  };
}

/** Deliberate model of a host committing only a successful auth-hook return.
 * It proves no real Zapier normal-action persistence or distributed lock. */
class ModeledHost {
  authData = { ...credentials, sessionData: encoded() };
  async commit(value: { sessionData: string }) {
    this.authData = {
      ...this.authData,
      ...(JSON.parse(JSON.stringify(value)) as { sessionData: string }),
    };
  }
  bundle() {
    return { authData: { ...this.authData }, inputData: {} };
  }
}

describe("private Zapier session authentication", () => {
  it("keeps all credentials and computed state in protected auth fields", () => {
    const { authentication } = fixture();
    expect(authentication.type).toBe("session");
    expect(authentication.fields.map((f) => f.key)).toEqual([
      "subdomain",
      "email",
      "password",
      "sessionData",
    ]);
    expect(authentication.fields.every((f) => f.isNoSecret === false)).toBe(
      true,
    );
    expect(
      authentication.fields.find((f) => f.key === "password"),
    ).toMatchObject({ type: "password", required: true });
    expect(
      authentication.fields.find((f) => f.key === "sessionData"),
    ).toMatchObject({ type: "password", computed: true });
  });

  it("bootstraps using the shared exchange and returns only protected serialized session state", async () => {
    const f = fixture();
    const input = { authData: {}, inputData: { ...credentials } };
    const output = await f.authentication.sessionConfig.perform(z, input);
    expect(f.paths()).toEqual([
      "/login/twoFactorAuth",
      "/login/twoFactorAuth",
      "/user/userData",
    ]);
    expect(Object.keys(output)).toEqual(["sessionData"]);
    expect(JSON.parse(output.sessionData)).toMatchObject({
      version: 1,
      state: { origin: "https://example-parish.flocknote.com" },
    });
    expect(output.sessionData).toContain("fictional-renewed");
    expect(output.sessionData).not.toMatch(
      /operator@example|fictional-password/,
    );
    expect(inspect(output)).not.toContain("fictional-renewed");
    expect(input.authData).toEqual({});
    const fields = new URLSearchParams(f.transport.mock.calls[0]?.[0].body);
    expect(fields.get("requestAuthCode")).toBe("false");
    expect(fields.has("firstCode")).toBe(false);
  });

  it("uses corrected reconnect credentials before stale saved authentication fields", async () => {
    const f = fixture();
    const corrected = {
      ...credentials,
      email: "corrected@example.test",
      password: "fictional-corrected-password",
    };
    await f.authentication.sessionConfig.perform(z, {
      authData: { ...credentials, sessionData: encoded() },
      inputData: corrected,
    });
    const initial = new URLSearchParams(f.transport.mock.calls[0]?.[0].body);
    const password = new URLSearchParams(f.transport.mock.calls[1]?.[0].body);
    expect(initial.get("firstFactor")).toBe(corrected.email);
    expect(password.get("firstFactor")).toBe(corrected.email);
    expect(password.get("password")).toBe(corrected.password);
    expect(f.paths()).toEqual([
      "/login/twoFactorAuth",
      "/login/twoFactorAuth",
      "/user/userData",
    ]);
  });

  it("does not let a legacy optional configuration field break setup", async () => {
    const f = fixture();
    const output = await f.authentication.sessionConfig.perform(z, {
      authData: { ...credentials, configurationVersion: "" },
      inputData: {},
    });
    expect(output.sessionData).toContain("fictional-renewed");
  });

  it("keeps rejected verification after a successful password exchange as a non-intervention error", async () => {
    const f = fixture();
    f.transport
      .mockResolvedValueOnce(response(firstFactor, 200, "fictional-new"))
      .mockResolvedValueOnce(response({ success: true, loginSuccess: true }))
      .mockResolvedValueOnce(response(expired));
    const error = await f.authentication.sessionConfig
      .perform(z, bundle())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AppError" });
    expect(String(error)).toContain("authentication_required");
    expect(f.paths()).toEqual([
      "/login/twoFactorAuth",
      "/login/twoFactorAuth",
      "/user/userData",
    ]);
  });

  it("persists only the returned hook result in the modeled host and reuses it across invocations", async () => {
    const host = new ModeledHost();
    const f = fixture();
    await host.commit(
      await f.authentication.sessionConfig.perform(z, host.bundle()),
    );
    const requestCount = f.transport.mock.calls.length;
    expect(await f.authentication.test(z, host.bundle())).toEqual({
      connected: true,
    });
    expect(
      f.transport.mock.calls.slice(requestCount).map(([r]) => r.method),
    ).toEqual(["GET"]);
    expect(f.transport.mock.calls.at(-1)?.[0].headers.Cookie).toBe(
      "Flocknote=fictional-renewed",
    );
  });

  it("reuses one jar across reads but does not pretend mutated authData is durable", async () => {
    const f = fixture();
    const input = bundle();
    const execution = createReadExecution(z, input, { transport: f.transport });
    f.transport.mockResolvedValueOnce(
      response({ ok: "first" }, 200, "fictional-rotated"),
    );
    expect(await execution.read("dashboard")).toEqual({ ok: "first" });
    f.transport.mockResolvedValueOnce(response({ ok: "second" }));
    expect(await execution.read("dashboard")).toEqual({ ok: "second" });
    expect(f.transport.mock.calls[1]?.[0].headers.Cookie).toBe(
      "Flocknote=fictional-rotated",
    );
    expect(input.authData.sessionData).toBe(encoded());
    await createReadExecution(z, input, { transport: f.transport }).read(
      "dashboard",
    );
    expect(f.transport.mock.calls[2]?.[0].headers.Cookie).toBe(
      "Flocknote=fictional-saved",
    );
    expect(inspect(execution)).not.toMatch(/fictional|operator@example/);
    expect(JSON.stringify(execution)).toBe('{"type":"FlockbotReadExecution"}');
    expect(f.paths()).toEqual(["/dashboard", "/dashboard", "/dashboard"]);
  });

  it.each([undefined, null, ""])(
    "requests safe read refresh when the host supplies no saved session %#",
    async (sessionData) => {
      const f = fixture();
      const input = {
        authData: { ...credentials, sessionData },
        inputData: {},
      } as unknown as Parameters<typeof createReadExecution>[1];
      await expect(async () =>
        createReadExecution(z, input, { transport: f.transport }).read(
          "dashboard",
        ),
      ).rejects.toMatchObject({ name: "RefreshAuthError" });
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  it("requests safe refresh when an actual read confirms invalid authentication", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(response(expired));
    const execution = createReadExecution(z, bundle(), {
      transport: f.transport,
    });
    await expect(execution.read("user/userData")).rejects.toMatchObject({
      name: "RefreshAuthError",
    });
    expect(f.paths()).toEqual(["/user/userData"]);
  });

  it("refreshes only after the shared lifecycle confirms invalid saved authentication", async () => {
    const host = new ModeledHost();
    const f = fixture();
    f.transport.mockResolvedValueOnce(
      response(expired, 200, "fictional-rejected"),
    );
    await expect(f.authentication.test(z, host.bundle())).rejects.toMatchObject(
      { name: "RefreshAuthError" },
    );
    expect(f.paths()).toEqual(["/user/userData"]);
    await host.commit(
      await f.authentication.sessionConfig.perform(z, host.bundle()),
    );
    await f.authentication.test(z, host.bundle());
    expect(f.paths()).toEqual([
      "/user/userData",
      "/login/twoFactorAuth",
      "/login/twoFactorAuth",
      "/user/userData",
      "/user/userData",
    ]);
    expect(f.transport.mock.calls.at(-1)?.[0].headers.Cookie).toBe(
      "Flocknote=fictional-renewed",
    );
  });

  it("uses safe host refresh when a saved cookie has actually expired", async () => {
    const state = sessionFromToken("example-parish", "fictional-expired");
    const input = bundle(
      JSON.stringify({
        version: 1,
        state: {
          ...state,
          cookies: state.cookies.map(
            (c) => `${c}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
          ),
        },
      }),
    );
    const f = fixture();
    await expect(f.authentication.test(z, input)).rejects.toMatchObject({
      name: "RefreshAuthError",
    });
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("requires a usable cookie after verification without guessing that deletion means expiry", async () => {
    const f = fixture();
    const reply = response(accepted);
    reply.headers.set(
      "set-cookie",
      "Flocknote=deleted; Domain=flocknote.com; Path=/; Max-Age=0; Secure",
    );
    f.transport.mockResolvedValueOnce(reply);
    const error = await f.authentication
      .test(z, bundle())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AppError" });
    expect(String(error)).toContain("authentication_protocol_error");
    expect(f.paths()).toEqual(["/user/userData"]);
  });

  it.each([
    [response({}, 401), "AppError"],
    [response({}, 403), "AppError"],
    [response({}, 429), "AppError"],
    [response({}, 503), "AppError"],
    [response({ success: true }), "AppError"],
    [response({ success: true, authorized: false, userID: 201 }), "AppError"],
  ])(
    "does not refresh permission, transient or unknown signals %#",
    async (reply, name) => {
      const f = fixture();
      f.transport.mockResolvedValueOnce(reply);
      const error = await f.authentication
        .test(z, bundle())
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ name });
      expect(String(error)).not.toContain("RefreshAuthError");
      expect(f.paths()).toEqual(["/user/userData"]);
    },
  );

  it.each([
    [
      {
        ...firstFactor,
        loginSuccess: false,
        message: "Sorry, that password doesn't match our records.",
      },
      "password",
    ],
    [{ success: true, allowPasswordForFirstFactor: false }, "challenge"],
  ])("requires manual reconnect for %s", async (reply, kind) => {
    const f = fixture();
    if (kind === "password")
      f.transport.mockResolvedValueOnce(
        response(firstFactor, 200, "fictional-unverified"),
      );
    f.transport.mockResolvedValueOnce(response(reply));
    const error = await f.authentication.sessionConfig
      .perform(z, bundle())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ExpiredAuthError" });
    if (kind === "password") {
      expect(String(error)).toContain("Flocknote rejected the password");
      expect(String(error)).toContain("Check your Flocknote password");
      expect(String(error)).toContain("credentials_rejected");
    } else {
      expect(String(error)).toContain("Sign in to Flocknote directly");
      expect(String(error)).toContain("action_required");
      expect(String(error)).not.toContain("rejected the password");
    }
    expect(String(error)).not.toContain(credentials.password);
    expect(String(error)).not.toContain(credentials.email);
    expect(String(error)).not.toContain("fictional-unverified");
    expect(f.transport.mock.calls.length).toBe(kind === "password" ? 2 : 1);
  });

  it("does not describe an unknown authentication response as a rejected password", async () => {
    const f = fixture();
    f.transport
      .mockResolvedValueOnce(response(firstFactor, 200, "fictional-unverified"))
      .mockResolvedValueOnce(
        response({
          ...firstFactor,
          loginSuccess: false,
          message: "Unrecognized private-auth-response-sentinel",
        }),
      );
    const error = await f.authentication.sessionConfig
      .perform(z, bundle())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(errors.Error);
    expect(error).not.toBeInstanceOf(errors.ExpiredAuthError);
    expect(String(error)).toContain("authentication_protocol_error");
    expect(String(error)).not.toMatch(
      /rejected the password|credentials_rejected|private-auth-response-sentinel|fictional-unverified/,
    );
    expect(f.transport).toHaveBeenCalledTimes(2);
  });

  it("keeps a modeled durable intervention blocked on a later invocation", async () => {
    let state: SessionState | null = null;
    let revision = 0;
    const store = {
      revision: async () => String(revision),
      load: async () => state,
      save: async (next: SessionState, expected: string) => {
        expect(expected).toBe(String(revision));
        state = next;
        revision++;
      },
      clear: async () => {
        state = null;
        revision++;
      },
    };
    const f = fixture();
    const auth = createAuthentication({
      transport: f.transport,
      sessionStore: store,
      coordinator: new FakeCoordinator(),
    });
    f.transport.mockResolvedValueOnce(
      response({ success: true, allowPasswordForFirstFactor: false }),
    );
    await expect(auth.sessionConfig.perform(z, bundle())).rejects.toMatchObject(
      { name: "ExpiredAuthError" },
    );
    expect(state).toMatchObject({
      intervention: { reason: "action_required" },
    });
    const count = f.transport.mock.calls.length;
    await expect(auth.test(z, bundle())).rejects.toMatchObject({
      name: "ExpiredAuthError",
    });
    expect(f.transport).toHaveBeenCalledTimes(count);
  });

  it("fails closed if the modeled session store cannot save", async () => {
    const f = fixture();
    const save = vi.fn(async () => {
      throw new Error("fictional-secret-store-error");
    });
    const auth = createAuthentication({
      transport: f.transport,
      sessionStore: {
        revision: async () => "0",
        load: async () => null,
        save,
        clear: async () => {},
      },
    });
    const error = await auth.sessionConfig
      .perform(z, bundle())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AppError" });
    expect(String(error)).toContain("session_save_failed");
    expect(String(error)).not.toContain("fictional-secret");
    expect(save).toHaveBeenCalledOnce();
  });

  it("sanitizes invalid protected input, upstream exceptions and ordinary auth results", async () => {
    const f = fixture();
    const marker = "fictional-private-contact@example.test";
    f.transport.mockRejectedValueOnce(new Error(marker));
    const error = await f.authentication
      .test(z, bundle())
      .catch((e: unknown) => e);
    expect(
      [String(error), inspect(error), JSON.stringify(error)].join(" "),
    ).not.toMatch(/fictional|operator@example/);
    expect(await f.authentication.test(z, bundle())).toEqual({
      connected: true,
    });
    for (const value of [
      "not-json",
      "{}",
      JSON.stringify({ version: 1, state: null }),
    ]) {
      await expect(
        f.authentication.test(z, bundle(value)),
      ).rejects.toMatchObject({ name: "AppError" });
    }
    const invalid = {
      authData: {
        get subdomain(): string {
          throw new Error(marker);
        },
      },
      inputData: {},
    };
    const inputError = await f.authentication
      .test(z, invalid)
      .catch((e: unknown) => e);
    expect(String(inputError)).not.toContain(marker);
  });

  it("prevents operational write callbacks and exposes no core write client", async () => {
    const work = vi.fn(async () => ({ success: true }));
    expect(feasibility.operationalWritesReady).toBe(false);
    await expect(runOperationalWrite(z, work)).rejects.toMatchObject({
      name: "AppError",
    });
    expect(work).not.toHaveBeenCalled();
    const execution = createReadExecution(z, bundle(), {
      transport: fixture().transport,
    });
    expect("post" in execution).toBe(false);
    expect("addMember" in execution).toBe(false);
  });

  it("executes the mocked authentication hook through the actual SDK app tester", async () => {
    const f = fixture();
    const app = {
      version: "0.0.0",
      platformVersion: "19.3.0",
      authentication: f.authentication,
      flags: { skipHttpPatch: true },
    };
    const tester = createAppTester(app);
    const result = await tester(app.authentication.test, bundle());
    expect(result).toEqual({ connected: true });
    expect(f.paths()).toEqual(["/user/userData"]);
  });
});
