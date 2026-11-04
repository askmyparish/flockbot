import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { errors } from "zapier-platform-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  createHostProbeApp,
  HOST_PROBE_CONSENT,
  type HostProbePlan,
} from "../../adapters/zapier/src/host-probe.js";
import {
  sessionFromToken,
  type Transport,
  type TransportResponse,
} from "../../src/index.js";

function plan(): HostProbePlan {
  return {
    subdomain: "example-parish",
    networkId: "201",
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60_000,
  };
}
function bundle() {
  return {
    authData: {
      subdomain: "example-parish",
      sessionData: JSON.stringify({
        version: 1,
        state: sessionFromToken("example-parish", "fictional-cookie"),
      }),
    } as Record<string, string>,
    inputData: { consent: HOST_PROBE_CONSENT } as Record<string, unknown>,
  };
}
const json = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: new Headers({ "content-type": "application/json" }),
  body: JSON.stringify(value),
});
function fixture(
  overrides: Partial<HostProbePlan> = {},
  auth: unknown = { success: true, userID: 301 },
  metadata: unknown = { networkID: 201 },
) {
  const transport = vi.fn<Transport>(async (request) =>
    new URL(request.url).pathname === "/user/userData"
      ? json(auth)
      : json(metadata),
  );
  return {
    transport,
    app: createHostProbeApp({ ...plan(), ...overrides }, transport),
  };
}
afterEach(() => vi.useRealTimers());

it("pins a native auth-scoped lock while making no upstream call", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const b = bundle();
  b.inputData.slot = "A";
  expect(f.app.creates.lock_hold.operation.lock).toEqual({
    key: "flockbot-host-probe",
    scope: ["auth"],
    timeout: 5,
  });
  let settled = false;
  const pending = f.app.creates.lock_hold.operation
    .perform({ errors }, b)
    .then((value) => {
      settled = true;
      return value;
    });
  await vi.advanceTimersByTimeAsync(2999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const observation = await pending;
  expect(observation).toMatchObject({
    slot: "A",
    lockGuaranteeProven: false,
  });
  expect(observation.finishedAt - observation.startedAt).toBe(3000);
  expect(observation.heldMs).toBe(3000);
  expect(f.transport).not.toHaveBeenCalled();
});

it("verifies a host-supplied saved session with two GETs and no credential reads", async () => {
  const f = fixture();
  const b = bundle();
  for (const field of ["password", "email"])
    Object.defineProperty(b.authData, field, {
      get: () => {
        throw new Error("Credentials must not be read");
      },
    });
  expect(
    await f.app.creates.verify_saved_session.operation.perform({ errors }, b),
  ).toEqual({
    connected: true,
    requests: 2,
    rotationObserved: false,
    passwordReads: 0,
    normalActionPersistenceProven: false,
  });
  expect(
    f.transport.mock.calls.map(([r]) => [r.method, new URL(r.url).pathname]),
  ).toEqual([
    ["GET", "/user/userData"],
    ["GET", "/network/getMetadata"],
  ]);
});

it("reports local rotation without claiming host persistence", async () => {
  const f = fixture();
  f.transport.mockImplementationOnce(async () => {
    const response = json({ success: true, userID: 301 });
    response.headers.set(
      "set-cookie",
      "Flocknote=fictional-rotated; Domain=flocknote.com; Path=/; Secure; HttpOnly",
    );
    return response;
  });
  expect(
    await f.app.creates.verify_saved_session.operation.perform(
      { errors },
      bundle(),
    ),
  ).toMatchObject({
    rotationObserved: true,
    normalActionPersistenceProven: false,
  });
  expect(f.transport.mock.calls[1]?.[0].headers.Cookie).toContain(
    "fictional-rotated",
  );
});

it.each([
  "expired",
  "wrong origin",
  "wrong consent",
  "extra input",
  "missing state",
])("refuses %s before transport", async (fault) => {
  const f = fixture(fault === "expired" ? { expiresAt: Date.now() - 1 } : {});
  const b = bundle();
  if (fault === "wrong origin") b.authData.subdomain = "other-parish";
  if (fault === "wrong consent") b.inputData.consent = "no";
  if (fault === "extra input") b.inputData.group_id = "102";
  if (fault === "missing state") b.authData.sessionData = "";
  await expect(
    f.app.creates.verify_saved_session.operation.perform({ errors }, b),
  ).rejects.toBeInstanceOf(errors.Error);
  expect(f.transport).not.toHaveBeenCalled();
});

it.each(["consent", "slot", "extra"])(
  "refuses invalid hold %s without a timer",
  async (fault) => {
    vi.useFakeTimers();
    const f = fixture();
    const b = bundle();
    b.inputData.slot = "A";
    if (fault === "consent") b.inputData.consent = "no";
    if (fault === "slot") b.inputData.slot = "C";
    if (fault === "extra") b.inputData.group_id = "102";
    await expect(
      f.app.creates.lock_hold.operation.perform({ errors }, b),
    ).rejects.toBeInstanceOf(errors.Error);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.transport).not.toHaveBeenCalled();
  },
);

it("refuses authentication and refresh without upstream requests", async () => {
  const f = fixture();
  await expect(f.app.authentication.test({ errors })).rejects.toThrow(
    "cannot authenticate or refresh",
  );
  await expect(
    f.app.authentication.sessionConfig.perform({ errors }),
  ).rejects.toThrow("cannot authenticate or refresh");
  expect(f.transport).not.toHaveBeenCalled();
});

it("does not refresh or retry a rejected saved session", async () => {
  const f = fixture({}, { success: true, userID: null, authorized: false });
  const error = await f.app.creates.verify_saved_session.operation
    .perform({ errors }, bundle())
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(errors.Error);
  expect(error).not.toBeInstanceOf(errors.RefreshAuthError);
  expect(f.transport).toHaveBeenCalledTimes(1);
});

it.each([429, 503, "transport"])(
  "does not retry a transient failure: %s",
  async (fault) => {
    const f = fixture();
    f.transport.mockImplementation(async () => {
      if (typeof fault !== "number")
        throw new Error("private-upstream-sentinel");
      return json({ message: "private-upstream-sentinel" }, fault);
    });
    const result = await f.app.creates.verify_saved_session.operation
      .perform({ errors }, bundle())
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(errors.Error);
    expect(result).not.toBeInstanceOf(errors.RefreshAuthError);
    expect(String(result)).not.toContain("private-upstream-sentinel");
    expect(f.transport).toHaveBeenCalledTimes(1);
  },
);

it("stops on a wrong network ID with sanitized output", async () => {
  const f = fixture({}, undefined, {
    networkID: 202,
    message: "private-upstream-sentinel",
  });
  const error = await f.app.creates.verify_saved_session.operation
    .perform({ errors }, bundle())
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(errors.Error);
  expect(String(error)).not.toContain("private-upstream-sentinel");
  expect(String(error)).not.toContain("fictional-cookie");
  expect(f.transport).toHaveBeenCalledTimes(2);
});

it("cancels an unresponsive read at the overall deadline without login", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.transport.mockImplementationOnce(() => new Promise(() => {}));
  const pending = f.app.creates.verify_saved_session.operation
    .perform({ errors }, bundle())
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(20_001);
  expect(await pending).toBeInstanceOf(errors.Error);
  expect(f.transport).toHaveBeenCalledTimes(1);
});

it("builds a loadable read-only package with the native lock schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-probe-build-test-"));
  let artifact: string | undefined;
  try {
    const file = join(root, "private.json");
    writeFileSync(
      file,
      JSON.stringify({
        consent: "authorize-read-only-host-probe-build",
        subdomain: "example-parish",
        networkId: "201",
        testOnlyLoginConfirmed: true,
        extraPrivateField: "private-config-sentinel",
      }),
      { mode: 0o600 },
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/zapier/build-host-probe.mjs", "--private-plan-file", file],
        { encoding: "utf8" },
      ),
    );
    artifact = result.directory;
    if (!artifact) throw new Error("Missing artifact");
    symlinkSync(resolve("node_modules"), join(artifact, "node_modules"));
    const require = createRequire(import.meta.url);
    const app = require(join(artifact, "index.js"));
    expect(
      require("zapier-platform-core/src/tools/schema").validateApp(app),
    ).toEqual([]);
    expect(app.version).toBe("2.0.2");
    expect(
      JSON.parse(readFileSync(join(artifact, "package.json"), "utf8")),
    ).toMatchObject({
      private: true,
      version: app.version,
      dependencies: { "zapier-platform-core": "19.3.0" },
    });
    expect(app.flags.skipHttpPatch).toBe(true);
    expect(Object.keys(app.creates).sort()).toEqual([
      "lock_hold",
      "verify_saved_session",
    ]);
    expect(app.creates.lock_hold.operation.lock).toEqual({
      key: "flockbot-host-probe",
      scope: ["auth"],
      timeout: 5,
    });
    const resultDefinition =
      await require("zapier-platform-core").createAppHandler(
        join(artifact, "index.js"),
      )({ command: "definition", calledFromCli: false });
    expect(resultDefinition).toBeDefined();
    expect(
      readFileSync(join(artifact, "dist/index.cjs"), "utf8"),
    ).not.toContain("store.zapier.com");
    expect(
      readFileSync(join(artifact, "dist/index.cjs"), "utf8"),
    ).not.toContain("private-config-sentinel");
  } finally {
    if (artifact) rmSync(artifact, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["symlink", "readable", "consent", "attestation"])(
  "refuses unsafe builder input: %s",
  (fault) => {
    const root = mkdtempSync(join(tmpdir(), "host-probe-refusal-"));
    try {
      const file = join(root, "private.json");
      writeFileSync(
        file,
        JSON.stringify({
          consent:
            fault === "consent"
              ? "wrong-private-config-sentinel"
              : "authorize-read-only-host-probe-build",
          subdomain: "example-parish",
          networkId: "201",
          testOnlyLoginConfirmed: fault !== "attestation",
        }),
        { mode: 0o600 },
      );
      let supplied = file;
      if (fault === "readable") chmodSync(file, 0o640);
      if (fault === "symlink") {
        supplied = join(root, "link");
        symlinkSync(file, supplied);
      }
      try {
        execFileSync(
          process.execPath,
          [
            "scripts/zapier/build-host-probe.mjs",
            "--private-plan-file",
            supplied,
          ],
          { stdio: "pipe" },
        );
        throw new Error("Expected refusal");
      } catch (error) {
        expect(error).toMatchObject({ status: 1 });
        expect(String((error as { stderr: unknown }).stderr)).not.toContain(
          "private-config-sentinel",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
