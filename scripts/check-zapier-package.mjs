import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  assert.deepEqual(validateApp(app), []);
  assert.equal(app.platformVersion, "19.3.0");
  assert.equal(app.flags.skipHttpPatch, true);
  assert.equal(app.creates, undefined);
  assert.equal(app.searches, undefined);
  assert.equal(app.triggers, undefined);
  const requests = [];
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
      assert.equal(path, "/user/userData");
      assert.equal(
        options.headers.Cookie,
        "Flocknote=fictional-package-session",
      );
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
  console.log(
    `Private Zapier tarball validates, imports, and reuses shared authentication offline on ${process.version}; writes remain unregistered.`,
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(scratch, { recursive: true, force: true });
}
