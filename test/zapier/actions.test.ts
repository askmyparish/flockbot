import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { errors, createAppTester } from "zapier-platform-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCandidateApp } from "../../adapters/zapier/src/app.js";
import { createActions } from "../../adapters/zapier/src/actions.js";
import {
  sessionFromToken,
  type SessionState,
  type SessionStore,
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
const input = {
  group_id: "00102",
  user_first_name: " Taylor ",
  user_last_name: " Example ",
  user_email: " member@example.test ",
  user_mobile_phone: " ",
};
const accepted = { success: true, userID: 201 };
const expired = { success: true, userID: null, authorized: false };
const legacy = readFileSync(
  new URL("../fixtures/groups/legacy.html", import.meta.url),
  "utf8",
);
const shell = readFileSync(
  new URL("../fixtures/groups/shell.html", import.meta.url),
  "utf8",
);
const navigation = JSON.parse(
  readFileSync(
    new URL("../fixtures/groups/navigation.json", import.meta.url),
    "utf8",
  ),
) as unknown;
const metadata = JSON.parse(
  readFileSync(
    new URL("../fixtures/groups/metadata.json", import.meta.url),
    "utf8",
  ),
) as unknown;
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
function html(body: string): TransportResponse {
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    body,
  };
}
function bundle() {
  return {
    authData: {
      ...credentials,
      sessionData: JSON.stringify({
        version: 1,
        state: sessionFromToken("example-parish", "fictional-saved"),
      }),
    },
    inputData: { ...input },
  };
}
function fixture(
  initial: SessionState | null = sessionFromToken(
    "example-parish",
    "fictional-saved",
  ),
) {
  let state = initial;
  let revision = 0;
  const save = vi.fn(async (next: SessionState, expected: string) => {
    expect(expected).toBe(String(revision));
    state = next;
    revision++;
  });
  const store: SessionStore = {
    load: vi.fn(async () => state),
    revision: async () => String(revision),
    save,
    clear: async (expected) => {
      expect(expected).toBe(String(revision));
      state = null;
      revision++;
    },
  };
  const transport = vi.fn<Transport>(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/login/twoFactorAuth")
      return new URLSearchParams(request.body).has("password")
        ? response({ success: true, loginSuccess: true })
        : response(
            {
              success: true,
              allowPasswordForFirstFactor: true,
              firstFactorSuccess: false,
            },
            200,
            "fictional-renewed",
          );
    if (path === "/user/userData") return response(accepted);
    if (path === "/dashboard") return html(legacy);
    if (path === "/navigation/groups") return response(navigation);
    if (path === "/network/getMetadata") return response(metadata);
    if (path === "/group/102/addToGroupByAdmin")
      return response({ success: true });
    throw new Error("Unexpected fictional endpoint.");
  });
  const model = {
    sessionStore: store,
    coordinator: new FakeCoordinator(),
    transport,
  };
  const actions = createActions({ read: model, modeledMembership: model });
  return {
    ...model,
    actions,
    save,
    state: () => state,
    paths: () => transport.mock.calls.map(([r]) => new URL(r.url).pathname),
    writes: () =>
      transport.mock.calls
        .map(([r]) => r)
        .filter((r) => r.url.includes("/addToGroupByAdmin")),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
afterEach(() => {
  vi.useRealTimers();
});

describe("private Zapier candidate actions", () => {
  it("registers the five compatible input keys and dynamic group choice", () => {
    const { creates, triggers } = createActions();
    expect(creates.add_member.operation.inputFields.map((f) => f.key)).toEqual(
      Object.keys(input),
    );
    expect(creates.add_member.operation.inputFields[0]).toMatchObject({
      dynamic: "group_choices.id.name",
      required: true,
    });
    expect(triggers.group_choices.display.hidden).toBe(true);
    expect(creates.add_member.operation.sample).toEqual({ success: true });
  });

  it.each([false, true])(
    "lists sorted stable group choices through shared parsers (modern=%s)",
    async (modern) => {
      const f = fixture();
      if (modern)
        f.transport
          .mockResolvedValueOnce(response(accepted))
          .mockResolvedValueOnce(html(shell));
      const result = await f.actions.triggers.group_choices.operation.perform(
        z,
        bundle(),
      );
      expect(result.map((g) => g.name)).toEqual([
        "Everyone",
        "Garden & Grounds",
        "Music Ministry",
      ]);
      expect(result[0]).toEqual({
        id: "101",
        name: "Everyone",
        short_name: "everyone",
        is_everyone: true,
      });
      expect(result[2]?.id).toBe(modern ? "103" : "9007199254740993");
      expect(
        result.every(
          (g) => Object.keys(g).join() === "id,name,short_name,is_everyone",
        ),
      ).toBe(true);
      expect(f.paths()).toEqual(
        modern
          ? [
              "/user/userData",
              "/dashboard",
              "/navigation/groups",
              "/network/getMetadata",
            ]
          : ["/user/userData", "/dashboard"],
      );
      expect(f.writes()).toHaveLength(0);
    },
  );

  it("keeps packaged membership blocked before any request despite supplied readiness-looking inputs", async () => {
    const f = fixture();
    const actions = createActions({ read: f });
    const b = bundle();
    Object.assign(b.inputData, {
      operationalWritesReady: true,
      modeledMembership: f,
      password: "fictional-decoy",
    });
    const error = await actions.creates.add_member.operation
      .perform(z, b)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AppError" });
    expect(String(error)).toContain("feasibility_blocked");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.sessionStore.load).not.toHaveBeenCalled();
  });

  it("runs complete modeled SDK flow with one client and confirmed minimal output", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(
      response(accepted, 200, "fictional-rotated"),
    );
    const app = createCandidateApp({ read: f, modeledMembership: f });
    const tester = createAppTester(app);
    const output = await tester(
      app.creates.add_member.operation.perform,
      bundle(),
    );
    expect(output).toEqual({ success: true });
    expect(f.paths()).toEqual([
      "/user/userData",
      "/dashboard",
      "/user/userData",
      "/group/102/addToGroupByAdmin",
    ]);
    expect(
      f.transport.mock.calls
        .slice(1)
        .every(([r]) => r.headers.Cookie === "Flocknote=fictional-rotated"),
    ).toBe(true);
    expect(
      Object.fromEntries(new URLSearchParams(f.writes()[0]?.body)),
    ).toEqual({
      fname: "Taylor",
      lname: "Example",
      email: "member@example.test",
      mobile_phone: "",
    });
    expect(f.save).toHaveBeenCalledOnce();
    expect(inspect(output)).not.toMatch(/member@|fictional|Taylor|Example/);
  });

  it("reuses accepted sessions without reading protected credentials", async () => {
    const f = fixture();
    const b = bundle();
    for (const key of ["email", "password"])
      Object.defineProperty(b.authData, key, {
        get: () => {
          throw new Error("Should not read credentials.");
        },
      });
    await expect(
      f.actions.creates.add_member.operation.perform(z, b),
    ).resolves.toEqual({ success: true });
    expect(f.paths()).not.toContain("/login/twoFactorAuth");
  });

  it.each(["missing", "invalid"])(
    "renews a %s session once before lookup and write using only protected credentials",
    async (kind) => {
      const f = fixture(kind === "missing" ? null : undefined);
      if (kind === "invalid")
        f.transport.mockResolvedValueOnce(response(expired));
      const b = bundle();
      let passwordReads = 0;
      Object.defineProperty(b.authData, "password", {
        get: () => {
          passwordReads++;
          return credentials.password;
        },
      });
      Object.assign(b.inputData, {
        email: "decoy@example.test",
        password: "fictional-decoy",
      });
      await expect(
        f.actions.creates.add_member.operation.perform(z, b),
      ).resolves.toEqual({ success: true });
      expect(passwordReads).toBe(1);
      const logins = f.transport.mock.calls
        .map(([r]) => r)
        .filter((r) => r.url.endsWith("/login/twoFactorAuth"));
      expect(logins).toHaveLength(2);
      expect(new URLSearchParams(logins[1]?.body).get("password")).toBe(
        credentials.password,
      );
      expect(f.writes()).toHaveLength(1);
      expect(f.state()?.cookies.join()).toContain("fictional-renewed");
      const count = f.transport.mock.calls.length;
      await f.actions.creates.add_member.operation.perform(z, b);
      expect(passwordReads).toBe(1);
      expect(
        f.transport.mock.calls
          .slice(count)
          .every(([r]) => r.headers.Cookie === "Flocknote=fictional-renewed"),
      ).toBe(true);
    },
  );

  it("stops a second renewal after lookup without another password submission", async () => {
    const f = fixture(null);
    f.transport
      .mockResolvedValueOnce(
        response(
          {
            success: true,
            allowPasswordForFirstFactor: true,
            firstFactorSuccess: false,
          },
          200,
          "fictional-renewed",
        ),
      )
      .mockResolvedValueOnce(response({ success: true, loginSuccess: true }))
      .mockResolvedValueOnce(response(accepted))
      .mockResolvedValueOnce(response(accepted))
      .mockResolvedValueOnce(html(legacy))
      .mockResolvedValueOnce(response(expired));
    const b = bundle();
    const password = vi.fn(() => credentials.password);
    Object.defineProperty(b.authData, "password", { get: password });
    const error = await f.actions.creates.add_member.operation
      .perform(z, b)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AppError" });
    expect(JSON.parse((error as Error).message)).toMatchObject({
      code: "credentials_unavailable",
    });
    expect(password).toHaveBeenCalledOnce();
    expect(f.paths()).toEqual([
      "/login/twoFactorAuth",
      "/login/twoFactorAuth",
      "/user/userData",
      "/user/userData",
      "/dashboard",
      "/user/userData",
    ]);
    expect(f.writes()).toHaveLength(0);
  });

  it.each(["email", "password"])(
    "fails before login when protected %s is missing",
    async (field) => {
      const f = fixture(null);
      const b = bundle();
      Object.defineProperty(b.authData, field, { value: undefined });
      const error = await f.actions.creates.add_member.operation
        .perform(z, b)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "AppError" });
      expect(JSON.parse((error as Error).message)).toMatchObject({
        code: "credentials_unavailable",
      });
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.writes()).toHaveLength(0);
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it.each([
    { group_id: "" },
    { group_id: "bad/path" },
    { user_first_name: " " },
    { user_last_name: "\n" },
    { user_email: "broken" },
    { user_mobile_phone: "abc" },
    { user_email: "", user_mobile_phone: "" },
    { user_first_name: 12 },
  ])(
    "rejects invalid action input before store access %#",
    async (override) => {
      const f = fixture();
      const b = { ...bundle(), inputData: { ...input, ...override } };
      const error = await f.actions.creates.add_member.operation
        .perform(z, b)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "AppError" });
      expect(JSON.parse((error as Error).message)).toEqual({
        message:
          "Check the mapped group, name and contact fields (invalid_input).",
        code: "invalid_input",
        status: 400,
      });
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.sessionStore.load).not.toHaveBeenCalled();
    },
  );

  it("rejects a deleted selection before member submission", async () => {
    const f = fixture();
    const b = bundle();
    b.inputData.group_id = "999";
    await expect(
      f.actions.creates.add_member.operation.perform(z, b),
    ).rejects.toThrow(
      "The selected group is unavailable. Refresh the group choice (invalid_input).",
    );
    expect(f.paths()).toEqual(["/user/userData", "/dashboard"]);
    expect(f.writes()).toHaveLength(0);
  });

  it.each([
    [response({}, 403), "permission_denied"],
    [response({}, 503), "upstream_rejected"],
    [response({}, 429), "upstream_rejected"],
    [response({}), "invalid_response"],
  ])(
    "keeps lookup failures explicit and never writes %#",
    async (reply, code) => {
      const f = fixture();
      f.transport
        .mockResolvedValueOnce(response(accepted))
        .mockResolvedValueOnce(reply);
      const error = await f.actions.creates.add_member.operation
        .perform(z, bundle())
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "AppError" });
      expect(String(error)).toContain(code);
      expect(String(error)).not.toContain("connection failed");
      expect(f.writes()).toHaveLength(0);
    },
  );

  it.each([
    [
      response({
        success: false,
        message: "member@example.test fictional-password",
      }),
      "upstream_rejected",
    ],
    [response({}, 403), "permission_denied"],
    [response({}, 404), "upstream_rejected"],
    [response({}, 503), "upstream_rejected"],
    [response({}, 429), "upstream_rejected"],
    [response({ success: "true" }), "invalid_response"],
    [response(expired), "upstream_rejected"],
  ])(
    "soft-stops submitted failures without replay or refresh %#",
    async (reply, code) => {
      const f = fixture();
      f.transport.mockImplementation(async (request) =>
        request.url.includes("addToGroupByAdmin")
          ? reply
          : request.url.endsWith("dashboard")
            ? html(legacy)
            : response(accepted),
      );
      const error = await f.actions.creates.add_member.operation
        .perform(z, bundle())
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "HaltedError" });
      expect(String(error)).toContain(code);
      expect(String(error)).toContain("completion is unknown");
      expect(
        [String(error), inspect(error), JSON.stringify(error)].join(),
      ).not.toMatch(/member@example|fictional-password|Taylor/);
      expect(f.writes()).toHaveLength(1);
      expect(f.paths()).not.toContain("/login/twoFactorAuth");
    },
  );

  it("soft-stops connection loss after one submission", async () => {
    const f = fixture();
    f.transport.mockImplementation(async (request) => {
      if (request.url.includes("addToGroupByAdmin"))
        throw new Error("member@example.test fictional-password");
      return request.url.endsWith("dashboard")
        ? html(legacy)
        : response(accepted);
    });
    const error = await f.actions.creates.add_member.operation
      .perform(z, bundle())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "HaltedError" });
    expect(String(error)).toContain("transport_failed");
    expect(String(error)).not.toContain("member@");
    expect(f.writes()).toHaveLength(1);
  });

  it.each(["challenge", "password"])(
    "requires manual reconnect for %s and persists modeled intervention",
    async (kind) => {
      const f = fixture(null);
      if (kind === "password")
        f.transport.mockResolvedValueOnce(
          response(
            {
              success: true,
              allowPasswordForFirstFactor: true,
              firstFactorSuccess: false,
            },
            200,
            "fictional-candidate",
          ),
        );
      f.transport.mockResolvedValueOnce(
        response(
          kind === "challenge"
            ? { success: true, allowPasswordForFirstFactor: false }
            : {
                success: true,
                loginSuccess: false,
                allowPasswordForFirstFactor: true,
                firstFactorSuccess: false,
                message: "Sorry, that password doesn't match our records.",
              },
        ),
      );
      await expect(
        f.actions.creates.add_member.operation.perform(z, bundle()),
      ).rejects.toMatchObject({ name: "ExpiredAuthError" });
      expect(f.state()?.intervention?.reason).toBe(
        kind === "challenge" ? "action_required" : "credentials_rejected",
      );
      const count = f.transport.mock.calls.length;
      await expect(
        f.actions.creates.add_member.operation.perform(z, bundle()),
      ).rejects.toMatchObject({ name: "ExpiredAuthError" });
      expect(f.transport).toHaveBeenCalledTimes(count);
      expect(f.writes()).toHaveLength(0);
    },
  );

  it("uses safe host refresh for dropdowns with absent saved session", async () => {
    const f = fixture(null);
    await expect(
      f.actions.triggers.group_choices.operation.perform(z, bundle()),
    ).rejects.toMatchObject({ name: "RefreshAuthError" });
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("bounds late lookup by the overall action deadline and fences submission", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = deferred<TransportResponse>();
    f.transport
      .mockResolvedValueOnce(response(accepted))
      .mockImplementationOnce(() => pending.promise);
    const result = f.actions.creates.add_member.operation
      .perform(z, bundle())
      .catch((e: unknown) => e);
    await settle();
    await vi.advanceTimersByTimeAsync(20_001);
    const error = await result;
    expect(error).toMatchObject({ name: "AppError" });
    expect(String(error)).toContain("operation_timeout");
    pending.resolve(html(legacy));
    await settle();
    expect(f.writes()).toHaveLength(0);
    expect(f.save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the deadline across lookup and a late submitted write without late save or replay", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const lookup = deferred<TransportResponse>();
    const write = deferred<TransportResponse>();
    f.transport.mockImplementation(async (request) => {
      if (request.url.endsWith("dashboard")) return lookup.promise;
      if (request.url.includes("addToGroupByAdmin")) return write.promise;
      return response(accepted);
    });
    const result = f.actions.creates.add_member.operation
      .perform(z, bundle())
      .catch((e: unknown) => e);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    lookup.resolve(html(legacy));
    await settle();
    expect(f.writes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_001);
    const error = await result;
    expect(error).toMatchObject({ name: "HaltedError" });
    expect(String(error)).toContain("operation_timeout");
    write.resolve(response({ success: true }, 200, "fictional-late"));
    await settle();
    expect(f.writes()).toHaveLength(1);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.state()?.cookies.join()).not.toContain("fictional-late");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for confirmed-write persistence and never returns early success when it fails", async () => {
    const f = fixture();
    f.transport.mockImplementation(async (request) =>
      request.url.includes("addToGroupByAdmin")
        ? response({ success: true }, 200, "fictional-rotation")
        : request.url.endsWith("dashboard")
          ? html(legacy)
          : response(accepted),
    );
    f.save.mockRejectedValueOnce(new Error("member@example.test"));
    const error = await f.actions.creates.add_member.operation
      .perform(z, bundle())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "HaltedError" });
    expect(String(error)).toContain("session_save_failed");
    expect(String(error)).not.toContain("member@");
    expect(f.writes()).toHaveLength(1);
  });
});
