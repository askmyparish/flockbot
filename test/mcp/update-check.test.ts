import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import {
  compareReleaseVersions,
  newestSetupRelease,
  RELEASES_URL,
  UPDATE_GUIDE,
  UpdateChecker,
} from "../../adapters/mcp/src/update-check.js";

const DAY = 86_400_000;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function release(v = "0.3.0") {
  const base = `https://github.com/askmyparish/flockbot/releases/download/mcp-v${v}/`;
  return {
    tag_name: `mcp-v${v}`,
    draft: false,
    prerelease: v.includes("-"),
    published_at: "2026-11-05T12:00:00Z",
    body: "fictional-remote-instruction-never-returned",
    assets: ["md", "zip"].map((ext) => ({
      name: `flockbot-setup-${v}-darwin-arm64.${ext}`,
      state: "uploaded",
      browser_download_url: `${base}flockbot-setup-${v}-darwin-arm64.${ext}`,
    })),
  };
}
function fixture(
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    installedVersion?: string;
    supported?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flockbot-updates-")));
  const file = join(root, "updates-v1", "checks.sqlite");
  let now = 1_800_000_000_000;
  const request = vi.fn<typeof fetch>(
    options.fetch ?? (async () => Response.json([release()])),
  );
  const make = (extra: { file?: string; installedVersion?: string } = {}) => {
    const checker = new UpdateChecker({
      file,
      installedVersion: "0.2.0",
      now: () => now,
      supported: true,
      ...options,
      fetch: request,
      ...extra,
    });
    cleanup.push(() => checker.close());
    return checker;
  };
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    file,
    request,
    make,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("public update discovery", () => {
  it.each([
    ["1.2.9", "1.2.10", -1],
    ["1.0.0-alpha.2", "1.0.0-alpha.10", -1],
    ["1.0.0-alpha", "1.0.0-alpha.0", -1],
    ["1.0.0-9", "1.0.0-a", -1],
    ["1.0.0", "1.0.0-rc.9", 1],
    ["1.0.0-beta.1", "1.0.0-beta.1", 0],
    ["9007199254740993.0.0", "9007199254740992.0.0", 1],
  ])("compares %s and %s by semantic precedence", (a, b, order) => {
    expect(compareReleaseVersions(a as string, b as string)).toBe(order);
  });

  it.each([
    "01.0.0",
    "1.0.0-01",
    "1.0.0+build",
    "mcp-v1.0.0",
    "https://evil.invalid",
    "1.0",
    "1.0.0-",
    "1.0.0\n",
  ])("rejects invalid version %s", (v) => {
    expect(() => compareReleaseVersions(v, "1.0.0")).toThrow();
  });

  it("selects the highest matching version, including labeled prereleases, independent of creation order", () => {
    expect(
      newestSetupRelease([
        release("0.3.0"),
        release("0.4.0-beta.2"),
        release("0.2.0"),
        release("0.4.0-beta.10"),
      ]),
    ).toBe("0.4.0-beta.10");
    expect(
      newestSetupRelease([release("0.4.0-beta.10"), release("0.4.0")]),
    ).toBe("0.4.0");
  });

  it("ignores drafts, missing/unuploaded assets, invalid metadata and foreign or version-mismatched URLs", () => {
    const invalid = [
      { ...release(), draft: true },
      { ...release(), prerelease: true },
      { ...release(), published_at: null },
      { ...release(), published_at: "not-a-date" },
      { ...release(), tag_name: "v0.3.0" },
      { ...release(), assets: [] },
      { ...release(), assets: release().assets.slice(0, 1) },
      {
        ...release(),
        assets: release().assets.map((a) => ({ ...a, state: "new" })),
      },
      {
        ...release(),
        assets: release().assets.map((a) => ({
          ...a,
          browser_download_url: a.browser_download_url.replace(
            "askmyparish/",
            "another-owner/",
          ),
        })),
      },
      {
        ...release(),
        assets: release().assets.map((a) => ({
          ...a,
          browser_download_url: a.browser_download_url.replace(
            "mcp-v0.3.0/",
            "mcp-v0.2.0/",
          ),
        })),
      },
      null,
      "fictional-secret",
      {},
    ];
    expect(newestSetupRelease(invalid)).toBeUndefined();
    expect(newestSetupRelease([...invalid, release("0.2.1")])).toBe("0.2.1");
    expect(newestSetupRelease(Array(101).fill(release()))).toBeUndefined();
    expect(newestSetupRelease({ releases: [release()] })).toBeUndefined();
  });

  it("uses a fixed anonymous endpoint and returns only fixed notice text and validated public versions", async () => {
    const f = fixture();
    const checker = f.make();
    await checker.refresh();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledWith(
      RELEASES_URL,
      expect.objectContaining({
        redirect: "error",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      }),
    );
    const headers = f.request.mock.calls[0]?.[1]?.headers;
    expect(headers).toEqual({
      Accept: "application/vnd.github+json",
      "User-Agent": "AskMyParish-Flockbot",
    });
    expect(checker.notice()).toEqual({
      installedVersion: "0.2.0",
      availableVersion: "0.3.0",
      prerelease: false,
      guideUrl: UPDATE_GUIDE,
      message:
        "A Flockbot update is available. Say “Update Flockbot” to install it.",
    });
    expect(JSON.stringify(checker.notice())).not.toMatch(
      /fictional|remote-instruction|\/private\/|\/Users\//,
    );
  });

  it.each(["0.3.0", "0.4.0", "1.0.0"])(
    "does not offer same/older release to installed %s",
    async (v) => {
      const f = fixture();
      const checker = f.make({ installedVersion: v });
      await checker.refresh();
      expect(checker.notice()).toBeUndefined();
    },
  );

  it("retains the daily budget across checker instances and refreshes once after 24 hours", async () => {
    const f = fixture();
    const first = f.make();
    await Promise.all([first.refresh(), first.refresh()]);
    const second = f.make();
    await second.refresh();
    expect(second.notice()?.availableVersion).toBe("0.3.0");
    expect(f.request).toHaveBeenCalledTimes(1);
    f.tick(DAY - 1);
    await first.refresh();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.tick(1);
    await Promise.all([first.refresh(), second.refresh()]);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.tick(-DAY * 2);
    await first.refresh();
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    "offline",
    "rate_limit",
    "malformed",
    "oversize",
    "hanging",
    "hanging_body",
  ])(
    "fails quietly and throttles a %s attempt, even after restart",
    async (mode) => {
      const f = fixture({
        timeoutMs: 25,
        fetch: async (_url, init) => {
          if (mode === "offline")
            throw new Error("fictional-password-never-returned");
          if (mode === "rate_limit")
            return new Response("fictional-cookie", { status: 429 });
          if (mode === "malformed")
            return new Response("{invalid-json-fictional-secret");
          if (mode === "oversize")
            return new Response("x".repeat(1024 * 1024 + 1));
          if (mode === "hanging_body")
            return new Response(new ReadableStream({ start() {} }));
          void init;
          return new Promise(() => {}); // Deliberately ignores abort.
        },
      });
      const checker = f.make();
      const started = performance.now();
      await checker.refresh();
      expect(performance.now() - started).toBeLessThan(1500);
      expect(checker.notice()).toBeUndefined();
      await checker.refresh();
      await f.make().refresh();
      expect(f.request).toHaveBeenCalledTimes(1);
      f.tick(DAY);
      await checker.refresh();
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );

  it("ignores corrupt, blocked and symlinked caches without any network request or browser-file changes", async () => {
    const f = fixture();
    mkdirSync(join(f.root, "browser-v1"));
    const sentinel = join(f.root, "browser-v1", "connection.json");
    writeFileSync(sentinel, "fictional-private-session");
    mkdirSync(join(f.root, "updates-v1"), { mode: 0o700 });
    writeFileSync(f.file, "not-sqlite", { mode: 0o600 });
    await f.make().refresh();
    const blocked = join(f.root, "blocker");
    writeFileSync(blocked, "not-a-folder");
    await f.make({ file: join(blocked, "checks.sqlite") }).refresh();
    if (process.platform !== "win32") {
      const link = join(f.root, "cache-link");
      symlinkSync(join(f.root, "updates-v1"), link);
      await f.make({ file: join(link, "checks.sqlite") }).refresh();
    }
    expect(f.request).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, "utf8")).toBe("fictional-private-session");
    expect(readFileSync(f.file, "utf8")).toBe("not-sqlite");
  });

  it("does not trust invalid cached versions or check timestamps", async () => {
    const f = fixture();
    await f.make().refresh();
    const db = new DatabaseSync(f.file);
    db.exec("UPDATE update_check SET latest='fictional-secret'");
    db.close();
    const other = f.make();
    await other.refresh();
    expect(other.notice()).toBeUndefined();
    expect(f.request).toHaveBeenCalledTimes(1);
    const damaged = new DatabaseSync(f.file);
    damaged.exec("UPDATE update_check SET latest=NULL, checked=-1");
    damaged.close();
    await f.make().refresh();
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("routes Mac updates through the guide and stops unsupported Windows updates without running old scripts", () => {
    for (const platform of ["macos"]) {
      const text = readFileSync(
        `plugins/flockbot-${platform}/skills/setup/SKILL.md`,
        "utf8",
      );
      expect(text).toContain("Update Flockbot");
      expect(text.indexOf(UPDATE_GUIDE)).toBeLessThan(
        text.indexOf("1. Resolve this installed plugin"),
      );
      expect(text).toContain(
        "Do not run this installed plugin’s old pinned setup script as an update",
      );
      expect(text).toContain("Preserve the");
      expect(text).toContain(
        "Never install automatically or run Forget to update",
      );
    }
    const windows = readFileSync(
      "plugins/flockbot-windows/skills/setup/SKILL.md",
      "utf8",
    );
    expect(windows).toContain("Do not promise a notice on");
    expect(windows).toContain(
      "automated Windows update route is not available",
    );
    expect(windows.indexOf("stop before step 1")).toBeLessThan(
      windows.indexOf("1. Resolve this installed plugin"),
    );
    expect(windows).toContain("preserve the existing connection");
    expect(windows).toContain("not an update to a newer release");
    const guide = readFileSync("guide.md", "utf8");
    expect(RELEASES_URL).toMatch(/per_page=20$/);
    expect(guide).toContain(
      "https://api.github.com/repos/askmyparish/flockbot/releases?per_page=100",
    );
    expect(guide).toContain("highest semantic version");
    expect(guide).toContain("prerelease");
    expect(guide).toContain("--route desktop");
    expect(guide).toContain("--route tui");
    expect(guide).toContain(
      "never select a version below the notice or the installed version",
    );
  });

  it("bounds the request to20 entries so a growing release history fits a realistic metadata payload", async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      ...release(`0.3.${i}`),
      body: "fictional release notes ".repeat(500),
      assets: [
        ...release(`0.3.${i}`).assets,
        ...Array.from({ length: 4 }, (_, a) => ({
          name: `unrelated-${a}.zip`,
          uploader: { description: "fictional public profile ".repeat(30) },
        })),
      ],
    }));
    const payload = JSON.stringify(entries);
    expect(Buffer.byteLength(payload)).toBeGreaterThan(200_000);
    expect(Buffer.byteLength(payload)).toBeLessThan(1024 * 1024);
    const f = fixture({ fetch: async () => new Response(payload) });
    const checker = f.make();
    await checker.refresh();
    expect(checker.notice()?.availableVersion).toBe("0.3.19");
    expect(f.request.mock.calls[0]?.[0]).toBe(RELEASES_URL);
    expect(newestSetupRelease([...entries, release("0.4.0")])).toBeUndefined();
  });

  it("skips unsupported platforms and stops outstanding checks when its server closes", async () => {
    const f = fixture({ fetch: async () => new Promise(() => {}) });
    const unsupported = f.make();
    unsupported.close();
    await unsupported.refresh();
    expect(f.request).not.toHaveBeenCalled();
    const checker = f.make();
    const pending = checker.refresh();
    checker.close();
    await pending;
    expect(checker.notice()).toBeUndefined();
    const other = fixture({ supported: false });
    await other.make().refresh();
    expect(other.request).not.toHaveBeenCalled();
  });

  it("disables discovery in the packaged offline runners before any cache or network access", async () => {
    vi.stubEnv("FLOCKBOT_UPDATE_CHECKS", "0");
    try {
      const f = fixture();
      const checker = f.make();
      checker.touch();
      await checker.refresh();
      expect(checker.notice()).toBeUndefined();
      expect(f.request).not.toHaveBeenCalled();
      expect(() => readFileSync(f.file)).toThrow();
      for (const name of ["check-browser-package", "verify-codex-browser"])
        expect(readFileSync(`scripts/mcp/${name}.mjs`, "utf8")).toContain(
          'FLOCKBOT_UPDATE_CHECKS: "0"',
        );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("claims the daily attempt atomically across separate MCP-like processes", async () => {
    const f = fixture();
    const entry = join(f.root, "checker.mjs"),
      events = join(f.root, "events.txt");
    writeFileSync(events, "");
    await build({
      stdin: {
        contents: `import {UpdateChecker} from ${JSON.stringify(resolve("adapters/mcp/src/update-check.ts"))}; import {appendFileSync} from 'node:fs';
const checker=new UpdateChecker({file:process.argv[2],supported:true,installedVersion:'0.2.0',fetch:async()=>{appendFileSync(process.argv[3],'request\\n'); await new Promise(r=>setTimeout(r,75)); return Response.json(${JSON.stringify([release()])});}});
await checker.refresh(); checker.close();`,
        resolveDir: process.cwd(),
      },
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const run = () =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [entry, f.file, events], {
          stdio: "ignore",
        });
        child.on("error", reject);
        child.on("close", resolve);
      });
    const results = await Promise.all(Array.from({ length: 4 }, run));
    expect(results).toEqual([0, 0, 0, 0]);
    // Cold-cache schema contention may quietly skip every attempt. It must
    // never duplicate a request, and a later uncontended call must check once.
    expect(["", "request\n"]).toContain(readFileSync(events, "utf8"));
    expect(await run()).toBe(0);
    expect(readFileSync(events, "utf8")).toBe("request\n");
    expect(await Promise.all(Array.from({ length: 4 }, run))).toEqual([
      0, 0, 0, 0,
    ]);
    expect(readFileSync(events, "utf8")).toBe("request\n");
  });
});
