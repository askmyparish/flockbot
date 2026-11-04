import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createAppTester, errors } from "zapier-platform-core";
import { afterEach, expect, it, vi } from "vitest";
import { createCandidateApp } from "../../adapters/zapier/src/app.js";
import { createNativeCandidate } from "../../adapters/zapier/src/native-candidate.js";
import {
  sessionFromToken,
  type Transport,
  type TransportResponse,
} from "../../src/index.js";

const z = { errors };
const accepted = { success: true, userID: 201 };
const rejected = { success: true, userID: null, authorized: false };
const credentials = {
  subdomain: "example-parish",
  email: "operator@example.test",
  password: "fictional-password",
};
const input = {
  group_id: "102",
  user_first_name: " Alex ",
  user_last_name: " Example ",
  user_email: " member@example.test ",
  user_mobile_phone: " ",
};
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
        state: sessionFromToken(credentials.subdomain, "fictional-saved"),
      }),
    },
    inputData: { ...input },
  };
}
function fixture() {
  const log = vi.fn<(message: string) => void>();
  let writeResponse = response({ success: true });
  const transport = vi.fn<Transport>(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/user/userData") return response(accepted);
    if (path === "/dashboard") return html(legacy);
    if (path === "/navigation/groups") return response(navigation);
    if (path === "/network/getMetadata") return response(metadata);
    if (path === "/login/twoFactorAuth") {
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
    }
    if (path === "/group/102/addToGroupByAdmin") return writeResponse;
    throw new Error("Unexpected fictional request");
  });
  const app = createNativeCandidate({ transport });
  return {
    app,
    transport,
    perform: (b = bundle()) =>
      app.creates.add_member.operation.perform({ ...z, console: { log } }, b),
    log,
    rejectWrite: (data: unknown, status = 200, token?: string) => {
      writeResponse = response(data, status, token);
    },
    paths: () => transport.mock.calls.map(([r]) => new URL(r.url).pathname),
    writes: () =>
      transport.mock.calls
        .map(([r]) => r)
        .filter((r) => r.url.includes("/addToGroupByAdmin")),
  };
}
function forbidCredentials(b: ReturnType<typeof bundle>) {
  for (const key of ["email", "password"])
    Object.defineProperty(b.authData, key, {
      get() {
        throw new Error("Operation must not read credentials");
      },
    });
}
afterEach(() => vi.useRealTimers());

it("emits no failure record for a confirmed successful write", async () => {
  const f = fixture();
  await expect(f.perform()).resolves.toEqual({ success: true });
  expect(f.writes()).toHaveLength(1);
  expect(f.log).not.toHaveBeenCalled();
});

it("keeps compatible mappings and a native auth-scoped membership lock", () => {
  const app = createNativeCandidate();
  expect(app.creates.add_member.operation.lock).toEqual({
    key: "flockbot-membership",
    scope: ["auth"],
    timeout: 60,
  });
  expect(
    app.creates.add_member.operation.inputFields.map((f) => f.key),
  ).toEqual(Object.keys(input));
  expect(app.triggers.group_choices.display.hidden).toBe(true);
  expect(app.flags.skipHttpPatch).toBe(true);
  expect(app.authentication.type).toBe("session");
});

it.each([false, true])(
  "uses one rotated jar for group lookup and one confirmed member POST (modern=%s)",
  async (modern) => {
    const f = fixture();
    const b = bundle();
    forbidCredentials(b);
    const original = b.authData.sessionData;
    f.transport.mockResolvedValueOnce(
      response(accepted, 200, "fictional-rotated"),
    );
    if (modern) f.transport.mockResolvedValueOnce(html(shell));
    const result = await createAppTester(f.app)(
      f.app.creates.add_member.operation.perform,
      b,
    );
    expect(result).toEqual({ success: true });
    expect(f.paths()).toEqual(
      modern
        ? [
            "/user/userData",
            "/dashboard",
            "/navigation/groups",
            "/network/getMetadata",
            "/user/userData",
            "/group/102/addToGroupByAdmin",
          ]
        : [
            "/user/userData",
            "/dashboard",
            "/user/userData",
            "/group/102/addToGroupByAdmin",
          ],
    );
    expect(
      f.transport.mock.calls
        .slice(1)
        .every(([r]) => r.headers.Cookie === "Flocknote=fictional-rotated"),
    ).toBe(true);
    expect(
      Object.fromEntries(new URLSearchParams(f.writes()[0]?.body)),
    ).toEqual({
      fname: "Alex",
      lname: "Example",
      email: "member@example.test",
      mobile_phone: "",
    });
    expect(b.authData.sessionData).toBe(original);
    expect(JSON.stringify(result)).not.toMatch(/private|fictional|member@/);
  },
);

it("starts each independent action from the host-saved state, without claiming writeback", async () => {
  const f = fixture();
  const b = bundle();
  f.transport.mockResolvedValueOnce(
    response(accepted, 200, "fictional-rotated"),
  );
  await f.perform(b);
  await f.perform(b);
  expect(f.transport.mock.calls[0]?.[0].headers.Cookie).toBe(
    "Flocknote=fictional-saved",
  );
  expect(f.transport.mock.calls[4]?.[0].headers.Cookie).toBe(
    "Flocknote=fictional-saved",
  );
  expect(f.writes()).toHaveLength(2);
});

it("lists compatible group choices without reading credentials", async () => {
  const f = fixture();
  const b = bundle();
  forbidCredentials(b);
  const groups = await f.app.triggers.group_choices.operation.perform(z, b);
  expect(groups[0]).toEqual({
    id: "101",
    name: "Everyone",
    short_name: "everyone",
    is_everyone: true,
  });
  expect(f.paths()).toEqual(["/user/userData", "/dashboard"]);
});

it.each(["missing", "invalid", "preflight"])(
  "requests native refresh for a %s session only before submission",
  async (kind) => {
    const f = fixture();
    const b = bundle();
    forbidCredentials(b);
    if (kind === "missing") b.authData.sessionData = "";
    if (kind === "invalid")
      f.transport.mockResolvedValueOnce(response(rejected));
    if (kind === "preflight")
      f.transport
        .mockResolvedValueOnce(response(accepted))
        .mockResolvedValueOnce(html(legacy))
        .mockResolvedValueOnce(response(rejected));
    const error = await f.perform(b).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(errors.RefreshAuthError);
    expect(f.log).not.toHaveBeenCalled();
    expect(f.transport).toHaveBeenCalledTimes(
      kind === "missing" ? 0 : kind === "invalid" ? 1 : 3,
    );
    expect(f.writes()).toHaveLength(0);
    expect(f.paths()).not.toContain("/login/twoFactorAuth");
  },
);

it.each(["missing", "invalid"])(
  "models one host refresh and safe action re-execution after %s state",
  async (kind) => {
    const f = fixture();
    const b = bundle();
    if (kind === "missing") b.authData.sessionData = "";
    else f.transport.mockResolvedValueOnce(response(rejected));
    await expect(f.perform(b)).rejects.toBeInstanceOf(errors.RefreshAuthError);
    expect(f.writes()).toHaveLength(0);
    // The test models the host hook/persistence/re-execution contract, not Zapier itself.
    const refreshed = await f.app.authentication.sessionConfig.perform(z, {
      authData: b.authData,
      inputData: {},
    });
    const replay = {
      authData: { ...b.authData, ...refreshed },
      inputData: b.inputData,
    };
    forbidCredentials(replay);
    await expect(f.perform(replay)).resolves.toEqual({ success: true });
    expect(f.writes()).toHaveLength(1);
    const passwordPosts = f.transport.mock.calls.filter(
      ([r]) =>
        new URL(r.url).pathname === "/login/twoFactorAuth" &&
        new URLSearchParams(r.body).has("password"),
    );
    expect(passwordPosts).toHaveLength(1);
    expect(f.writes()[0]?.headers.Cookie).toBe("Flocknote=fictional-renewed");
  },
);

it.each([401, 403, 429, 503])(
  "does not renew or retry a pre-submission HTTP%s",
  async (status) => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(
      response({ message: "private-upstream-sentinel" }, status),
    );
    const error = await f.perform().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(errors.Error);
    expect(error).not.toBeInstanceOf(errors.RefreshAuthError);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.writes()).toHaveLength(0);
    expect(String(error)).not.toContain("private-upstream-sentinel");
  },
);

it("validates mapped input before any connection access", async () => {
  const f = fixture();
  const b = bundle();
  b.inputData.user_email = "invalid";
  Object.defineProperty(b, "authData", {
    get() {
      throw new Error("Connection should not be read");
    },
  });
  const error = await f.perform(b).catch((e: unknown) => e);
  expect(String(error)).toContain("invalid_input");
  expect(f.transport).not.toHaveBeenCalled();
});

it("rejects a deleted group before submission with a clear error", async () => {
  const f = fixture();
  const b = bundle();
  b.inputData.group_id = "999";
  const error = await f.perform(b).catch((e: unknown) => e);
  expect(String(error)).toContain("selected group is unavailable");
  expect(f.writes()).toHaveLength(0);
});

it.each([
  "false",
  "auth-body",
  "both-flags",
  "401",
  "403",
  "422",
  "503",
  "transport",
])(
  "reports an uncertain submitted %s failure once and halts without renewal or replay",
  async (kind) => {
    const f = fixture();
    f.transport
      .mockResolvedValueOnce(response(accepted))
      .mockResolvedValueOnce(html(legacy))
      .mockResolvedValueOnce(response(accepted));
    if (kind === "transport")
      f.transport.mockRejectedValueOnce(new Error("private-upstream-sentinel"));
    else
      f.transport.mockResolvedValueOnce(
        response(
          kind === "auth-body"
            ? rejected
            : kind === "both-flags"
              ? { success: false, authorized: false }
              : {
                  success: false,
                  error: "Could not add user",
                  userID: 201,
                  existingSubscription: false,
                },
          /^\d{3}$/.test(kind) ? Number(kind) : 200,
        ),
      );
    const error = await f.perform().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(errors.HaltedError);
    expect(error).not.toBeInstanceOf(errors.RefreshAuthError);
    expect(String(error)).toContain("completion is unconfirmed");
    expect(String(error)).toContain("automatic retry is disabled");
    expect(String(error)).not.toMatch(/private-|undefined/);
    expect(f.log).toHaveBeenCalledTimes(1);
    const report = JSON.parse(f.log.mock.calls[0]?.[0] ?? "");
    expect(report).toMatchObject({
      event: "flockbot.membership_failed",
      parish: "example-parish",
      app_version: f.app.version,
      stage: "membership",
      outcome: "unknown",
      inputs: {
        group_id: "102",
        user_first_name: "Alex",
        user_last_name: "Example",
        user_email: "member@example.test",
        user_mobile_phone: "",
      },
    });
    expect(report.attempt_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(String(error)).toContain(report.attempt_id);
    if (kind === "transport") {
      expect(report.code).toBe("transport_failed");
      expect(report.http_status).toBeUndefined();
      expect(report.response).toBeUndefined();
    } else {
      expect(report.http_status).toBe(
        /^\d{3}$/.test(kind) ? Number(kind) : 200,
      );
      expect(report.response).toBeDefined();
    }
    expect(f.log.mock.calls[0]?.[0] ?? "").not.toMatch(
      /fictional-password|fictional-saved|operator@example|authData|sessionData|Cookie/,
    );
    expect(f.writes()).toHaveLength(1);
    expect(f.paths()).not.toContain("/login/twoFactorAuth");
  },
);

it.each([
  "alex+probe@example.test",
  "alex.probe@example.test",
  "alex%2Bprobe@example.test",
])(
  "reports the submitted input and actual response without inferring email validity (%s)",
  async (email) => {
    const f = fixture();
    const b = bundle();
    b.inputData.user_email = email;
    b.inputData.user_mobile_phone = "+12025550123";
    forbidCredentials(b);
    f.rejectWrite({
      success: false,
      error: "Could not add user",
      userID: 201,
      existingSubscription: false,
    });
    const error = await f.perform(b).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(errors.HaltedError);
    expect(String(error)).toContain(email);
    expect(String(error)).toContain("Could not add user");
    expect(String(error)).not.toMatch(
      /email_plus|response_hints|email_rejected/,
    );
    const report = JSON.parse(f.log.mock.calls[0]?.[0] ?? "");
    expect(report.response).toEqual({
      success: false,
      error: "Could not add user",
      userId: "201",
      existingSubscription: false,
    });
    expect(report.inputs).toEqual({
      group_id: "102",
      user_first_name: "Alex",
      user_last_name: "Example",
      user_email: email,
      user_mobile_phone: "+12025550123",
    });
    expect(new URLSearchParams(f.writes()[0]?.body).get("email")).toBe(email);
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(f.writes()).toHaveLength(1);
  },
);

it("does not make a submitted failure replayable when console reporting throws", async () => {
  const f = fixture();
  f.rejectWrite({ success: false, error: "Could not add user" });
  f.log.mockImplementation(() => {
    throw new Error("Logging unavailable");
  });
  const error = await f.perform().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(errors.HaltedError);
  expect(String(error)).toContain("Could not add user");
  expect(f.writes()).toHaveLength(1);
  expect(f.log).toHaveBeenCalledTimes(1);
});

it.each([
  "+12025550123",
  "2025550123",
  "12025550123",
  "(202) 555-0123",
  "202-555-0123",
  "+44 20 7946 0123",
])("reports and submits mobile %s without reformatting", async (mobile) => {
  const f = fixture();
  const b = bundle();
  b.inputData.user_email = "alex@example.test";
  b.inputData.user_mobile_phone = mobile;
  forbidCredentials(b);
  f.rejectWrite({ success: false, error: "Could not add user" });
  const error = await f.perform(b).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(errors.HaltedError);
  expect(String(error)).toContain('email "alex@example.test"');
  expect(String(error)).toContain(`mobile ${JSON.stringify(mobile)}`);
  expect(String(error)).toContain("Could not add user");
  expect(String(error)).toContain("automatic retry is disabled");
  expect(new URLSearchParams(f.writes()[0]?.body).get("mobile_phone")).toBe(
    mobile,
  );
  expect(
    JSON.parse(f.log.mock.calls[0]?.[0] ?? "").inputs.user_mobile_phone,
  ).toBe(mobile);
  expect(f.log).toHaveBeenCalledTimes(1);
  expect(f.writes()).toHaveLength(1);
});

it("rejects unsupported mobile inputs before any Zapier connection access", async () => {
  const f = fixture();
  const b = bundle();
  b.inputData.user_mobile_phone = "call me";
  Object.defineProperty(b, "authData", {
    get() {
      throw new Error("Validation must precede connection access");
    },
  });
  const error = await f.perform(b).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(errors.Error);
  expect(error).not.toBeInstanceOf(errors.HaltedError);
  expect(String(error)).toContain("invalid_input");
  expect(f.transport).not.toHaveBeenCalled();
  expect(JSON.parse(f.log.mock.calls[0]?.[0] ?? "")).toMatchObject({
    stage: "validation",
    outcome: "not_submitted",
    inputs: { user_mobile_phone: "call me" },
  });
});

it("labels a mobile-only failure and omits an absent email from its summary", async () => {
  const f = fixture();
  const b = bundle();
  b.inputData.user_email = "";
  b.inputData.user_mobile_phone = "+12025550123";
  f.rejectWrite({ success: false, error: "Could not add user" });
  const error = await f.perform(b).catch((e: unknown) => e);
  expect(String(error)).toContain('mobile "+12025550123"');
  expect(String(error)).not.toContain('email "');
  expect(f.writes()).toHaveLength(1);
});

it("reports the original input snapshot when the host bundle changes during execution", async () => {
  const f = fixture();
  const b = bundle();
  b.inputData.user_email = "alex+probe@example.test";
  f.transport.mockImplementation(async (request) => {
    b.inputData.user_email = "different@example.test";
    const path = new URL(request.url).pathname;
    if (path === "/user/userData") return response(accepted);
    if (path === "/dashboard") return html(legacy);
    return response({ success: false, error: "Could not add user" });
  });
  await f.perform(b).catch(() => undefined);
  expect(JSON.parse(f.log.mock.calls[0]?.[0] ?? "").inputs.user_email).toBe(
    "alex+probe@example.test",
  );
  expect(new URLSearchParams(f.writes()[0]?.body).get("email")).toBe(
    "alex+probe@example.test",
  );
});

it("reports invalid inputs without reading protected credentials or making a request", async () => {
  const f = fixture();
  const b = bundle();
  b.inputData.user_email = "not an email";
  forbidCredentials(b);
  Reflect.set(b.inputData, "extra", { password: "private-input-sentinel" });
  const error = await f.perform(b).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(errors.Error);
  expect(error).not.toBeInstanceOf(errors.HaltedError);
  const report = JSON.parse(f.log.mock.calls[0]?.[0] ?? "");
  expect(report).toMatchObject({
    stage: "validation",
    code: "invalid_input",
    outcome: "not_submitted",
  });
  expect(report.inputs.user_email).toBe("not an email");
  expect(f.log.mock.calls[0]?.[0] ?? "").not.toMatch(
    /private-input|password|authData|sessionData/,
  );
  expect(f.transport).not.toHaveBeenCalled();
});

it("bounds failed-input snapshots and reports truncation instead of dumping arbitrary objects", async () => {
  const f = fixture();
  const b = bundle();
  b.inputData.user_first_name = "x".repeat(2000);
  b.inputData.user_email = "invalid";
  Reflect.set(b.inputData, "user_mobile_phone", {
    password: "private-input-sentinel",
  });
  await f.perform(b).catch(() => undefined);
  const report = JSON.parse(f.log.mock.calls[0]?.[0] ?? "");
  expect(report.inputs.user_first_name).toHaveLength(1024);
  expect(report.inputs_truncated).toBe(true);
  expect(report.inputs.user_mobile_phone).toBe("[invalid input type]");
  expect(f.log.mock.calls[0]?.[0] ?? "").not.toContain(
    "private-input-sentinel",
  );
  expect(f.transport).not.toHaveBeenCalled();
});

it("shares the total 20-second budget across slow discovery and a submitted write", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.transport
    .mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 15_000));
      return response(accepted);
    })
    .mockResolvedValueOnce(html(legacy))
    .mockResolvedValueOnce(response(accepted))
    .mockImplementationOnce(() => new Promise(() => {}));
  const pending = f.perform().catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(20_001);
  expect(await pending).toBeInstanceOf(errors.HaltedError);
  expect(f.writes()).toHaveLength(1);
});

it("times out before submission without a POST or native refresh", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.transport.mockImplementationOnce(() => new Promise(() => {}));
  const pending = f.perform().catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(20_001);
  const error = await pending;
  expect(error).toBeInstanceOf(errors.Error);
  expect(error).not.toBeInstanceOf(errors.RefreshAuthError);
  expect(f.writes()).toHaveLength(0);
});

it("keeps the default app blocked and excludes the native test factory from its entry", async () => {
  const error = await createCandidateApp()
    .creates.add_member.operation.perform(z, bundle())
    .catch((e: unknown) => e);
  expect(String(error)).toContain("feasibility_blocked");
  expect(readFileSync("adapters/zapier/src/index.ts", "utf8")).not.toContain(
    "native-candidate",
  );
});

it("builds a private root-loader artifact with schema, log suppression and no Storage", async () => {
  let directory: string | undefined;
  try {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/zapier/build-native-candidate.mjs"],
        { encoding: "utf8" },
      ),
    ) as { directory: string };
    directory = result.directory;
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"));
    const require = createRequire(import.meta.url);
    const app = require(join(directory, "index.js"));
    expect(
      require("zapier-platform-core/src/tools/schema").validateApp(app),
    ).toEqual([]);
    expect(app.version).toBe("2.1.4");
    expect(app.flags.skipHttpPatch).toBe(true);
    expect(app.creates.add_member.operation.lock).toEqual({
      key: "flockbot-membership",
      scope: ["auth"],
      timeout: 60,
    });
    expect(
      JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
    ).toMatchObject({
      version: app.version,
      private: true,
      main: "index.js",
      exports: "./index.js",
      dependencies: { "zapier-platform-core": "19.3.0" },
    });
    const definition = await require("zapier-platform-core").createAppHandler(
      join(directory, "index.js"),
    )({ command: "definition", calledFromCli: false });
    expect(JSON.stringify(definition)).toContain('"add_member"');
    expect(readFileSync(join(directory, "dist/index.cjs"), "utf8")).not.toMatch(
      /store\.zapier\.com|createHostProbeApp|createMembershipVerification|fictional-password|member@example/,
    );
    expect(app.createNativeCandidate).toBeUndefined();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});
