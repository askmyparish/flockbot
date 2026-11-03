import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { validateApp } = require("zapier-platform-core/src/tools/schema");
const { createAppTester } = require("zapier-platform-core");
const scratch = await mkdtemp(join(tmpdir(), "flockbot-zapier-package-"));
const originalFetch = globalThis.fetch;
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--workspace",
        "@askmyparish/flockbot-zapier",
        "--ignore-scripts",
        "--offline",
        "--json",
        "--cache",
        join(scratch, "npm-cache"),
        "--pack-destination",
        scratch,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(packed.length, 1);
  assert.deepEqual(packed[0].files.map((file) => file.path).sort(), [
    "README.md",
    "dist/index.cjs",
    "package.json",
  ]);
  execFileSync("tar", [
    "-xzf",
    join(scratch, packed[0].filename),
    "-C",
    scratch,
  ]);
  const packageRoot = join(scratch, "package");
  const metadata = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(metadata.private, true);
  assert.deepEqual(metadata.dependencies, { "zapier-platform-core": "19.3.0" });
  // Offline artifact test supplies the declared SDK dependency from npm ci.
  await symlink(
    resolve("node_modules"),
    join(packageRoot, "node_modules"),
    "dir",
  );
  const app = require(join(packageRoot, metadata.main));
  assert.equal(app.version, metadata.version);
  // Zapier's ESM wrapper imports the package by its own name. Verify that
  // resolves inside this tarball, never back to the repository workspace.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       const resolved = import.meta.resolve(${JSON.stringify(metadata.name)});
       assert.equal(resolved, ${JSON.stringify(pathToFileURL(await realpath(join(packageRoot, metadata.main))).href)});
       const { default: app } = await import(resolved);
       assert.equal(app.platformVersion, "19.3.0");
       assert.equal(app.createCandidateApp, undefined);`,
    ],
    { cwd: packageRoot, stdio: "pipe" },
  );
  assert.deepEqual(validateApp(app), []);
  assert.equal(app.platformVersion, "19.3.0");
  assert.equal(app.flags.skipHttpPatch, true);
  assert.deepEqual(Object.keys(app.creates), ["add_member"]);
  assert.deepEqual(Object.keys(app.triggers), ["group_choices"]);
  assert.equal(app.searches, undefined);
  assert.equal(app.createCandidateApp, undefined);
  assert.equal(
    app.creates.add_member.operation.inputFields[0].dynamic,
    "group_choices.id.name",
  );
  const requests = [];
  let loseWriteResponse = false;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    assert.equal(new URL(url).origin, "https://example-parish.flocknote.com");
    requests.push({ path, method: options.method });
    let data = { success: true, userID: 201 };
    const headers = { "content-type": "application/json" };
    if (path === "/login/twoFactorAuth") {
      const fields = new URLSearchParams(options.body);
      if (!fields.has("password"))
        assert.equal(fields.get("requestAuthCode"), "false");
      assert.equal(fields.has("firstCode"), false);
      data = fields.has("password")
        ? { success: true, loginSuccess: true }
        : {
            success: true,
            allowPasswordForFirstFactor: true,
            firstFactorSuccess: false,
          };
      if (!fields.has("password"))
        headers["set-cookie"] =
          "Flocknote=fictional-package-session; Domain=flocknote.com; Path=/; Secure";
    } else {
      assert.ok(
        [
          "/user/userData",
          "/dashboard",
          "/group/102/addToGroupByAdmin",
        ].includes(path),
      );
      assert.equal(
        options.headers.Cookie,
        "Flocknote=fictional-package-session",
      );
    }
    if (path === "/dashboard")
      return new Response(
        '<div class="group_item" data-groupid="00101" data-shortname="everyone"><span class="group_name">Everyone</span></div><div class="group_item" data-groupid="102" data-shortname="garden"><span class="group_name">Garden Ministry</span></div>',
        { headers: { "content-type": "text/html" } },
      );
    if (path === "/group/102/addToGroupByAdmin") {
      if (loseWriteResponse) throw new Error("Fictional connection loss.");
      assert.equal(options.method, "POST");
      assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), {
        fname: "Taylor",
        lname: "Example",
        email: "member@example.test",
        mobile_phone: "",
      });
      data = { success: true };
    }
    return new Response(JSON.stringify(data), { status: 200, headers });
  };
  const tester = createAppTester(app);
  const credentials = {
    subdomain: "example-parish",
    email: "operator@example.test",
    password: "fictional-password",
  };
  const auth = await tester(app.authentication.sessionConfig.perform, {
    authData: credentials,
    inputData: credentials,
  });
  assert.deepEqual(Object.keys(auth), ["sessionData"]);
  const result = await tester(app.authentication.test, {
    authData: { ...credentials, ...auth },
  });
  assert.deepEqual(result, { connected: true });
  assert.deepEqual(
    requests.map((r) => r.method),
    ["POST", "POST", "GET", "GET"],
  );
  const connection = { ...credentials, ...auth };
  const groupChoices = await tester(
    app.triggers.group_choices.operation.perform,
    { authData: connection },
  );
  assert.deepEqual(groupChoices, [
    { id: "101", name: "Everyone", short_name: "everyone", is_everyone: true },
    {
      id: "102",
      name: "Garden Ministry",
      short_name: "garden",
      is_everyone: false,
    },
  ]);
  const inputData = {
    group_id: groupChoices[1].id,
    user_first_name: "Taylor",
    user_last_name: "Example",
    user_email: "member@example.test",
  };
  const beforeBlocked = requests.length;
  await assert.rejects(
    tester(app.creates.add_member.operation.perform, {
      authData: connection,
      inputData,
    }),
    /feasibility_blocked/,
  );
  assert.equal(requests.length, beforeBlocked);
  console.log(
    `Private Zapier tarball: SDK schema, shared auth/group reads, and default write blockade pass offline on ${process.version} (${process.execPath}).`,
  );

  // Disposable model artifact, never part of npm pack or the deployed main.
  // It bundles the same app factory and shared core, with explicit simulated
  // store/coordination/transport dependencies rather than a readiness flag.
  const modeledPath = join(packageRoot, "offline-model.cjs");
  await build({
    stdin: {
      contents:
        'export { createCandidateApp } from "./adapters/zapier/src/app.ts";',
      resolveDir: resolve("."),
    },
    outfile: modeledPath,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["zapier-platform-core"],
  });
  const { createCandidateApp } = require(modeledPath);
  let state = JSON.parse(auth.sessionData).state;
  let revision = 0;
  const model = {
    sessionStore: {
      load: async () => state,
      revision: async () => String(revision),
      save: async (next, expected) => {
        assert.equal(expected, String(revision));
        state = next;
        revision++;
      },
      clear: async (expected) => {
        assert.equal(expected, String(revision));
        state = null;
        revision++;
      },
    },
    // This single sequential simulation is not a real cross-run lock.
    coordinator: {
      runExclusive: async (_identity, signal, work) => {
        assert.equal(signal.aborted, false);
        return work();
      },
    },
    transport: async (request) => {
      const reply = await globalThis.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
      });
      return {
        status: reply.status,
        headers: reply.headers,
        body: await reply.text(),
      };
    },
  };
  const modeledApp = createCandidateApp({
    read: model,
    modeledMembership: model,
  });
  assert.deepEqual(validateApp(modeledApp), []);
  const modeledTester = createAppTester(modeledApp);
  const beforeModel = requests.length;
  const modeledChoices = await modeledTester(
    modeledApp.triggers.group_choices.operation.perform,
    { authData: connection },
  );
  assert.deepEqual(modeledChoices, groupChoices);
  // Only this explicit modeled store mutation simulates a missing session.
  // It makes the action prove its safe pre-submission renewal boundary.
  state = null;
  revision++;
  const added = await modeledTester(
    modeledApp.creates.add_member.operation.perform,
    { authData: connection, inputData },
  );
  assert.deepEqual(added, { success: true });
  assert.deepEqual(
    requests.slice(beforeModel).map((r) => r.path),
    [
      "/user/userData",
      "/dashboard",
      "/login/twoFactorAuth",
      "/login/twoFactorAuth",
      "/user/userData",
      "/user/userData",
      "/dashboard",
      "/user/userData",
      "/group/102/addToGroupByAdmin",
    ],
  );
  assert.equal(
    requests.filter((r) => r.path.includes("addToGroupByAdmin")).length,
    1,
  );
  loseWriteResponse = true;
  const beforeUncertain = requests.length;
  await assert.rejects(
    modeledTester(modeledApp.creates.add_member.operation.perform, {
      authData: connection,
      inputData,
    }),
    (error) =>
      error.name === "HaltedError" &&
      /completion is unknown \(transport_failed\)/.test(String(error)),
  );
  const uncertainCalls = requests.slice(beforeUncertain);
  assert.equal(
    uncertainCalls.filter((r) => r.path.includes("addToGroupByAdmin")).length,
    1,
  );
  assert.equal(
    uncertainCalls.filter((r) => r.path.includes("login/")).length,
    0,
  );
  console.log(
    "Disposable offline model bundle: SDK group choices, safe renewal, confirmed membership and uncertain-write soft stop pass with simulated host dependencies; real hosted writes remain blocked.",
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(scratch, { recursive: true, force: true });
}
