import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECK_INTERVAL_MS,
  compareVersions,
  newestInFeed,
  UpdateCheck,
} from "../../adapters/mcp/src/updates.js";

describe("version order", () => {
  it.each([
    ["0.3.0-dev.10", "0.3.0-dev.2", 1],
    ["0.3.0", "0.3.0-dev.10", 1],
    ["0.10.0", "0.9.9", 1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["1.0.0-beta", "1.0.0-alpha.9", 1],
    ["0.2.1+build.7", "0.2.1", 0],
  ])("%s against %s is %i", (a, b, order) => {
    expect(compareVersions(a, b)).toBe(order);
    expect(compareVersions(b, a)).toBe(-order || 0);
  });

  it("refuses what isn't a version", () => {
    expect(compareVersions("0.3", "0.2.1")).toBeUndefined();
    expect(compareVersions("latest", "0.2.1")).toBeUndefined();
  });
});

describe("reading feeds", () => {
  it("finds the newest appcast item, whichever comes first", () => {
    const appcast = `<?xml version="1.0"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <item><sparkle:version>212</sparkle:version><sparkle:shortVersionString>0.3.0-dev.2</sparkle:shortVersionString></item>
    <item><sparkle:version>230</sparkle:version><sparkle:shortVersionString>0.3.0-dev.10</sparkle:shortVersionString></item>
    <item><enclosure url="https://example.com/Flockbot.zip" sparkle:shortVersionString="0.2.9" /></item>
  </channel>
</rss>`;
    expect(newestInFeed(appcast, "appcast")).toBe("0.3.0-dev.10");
  });

  it("finds the newest Velopack release among full and delta packages", () => {
    const releases = JSON.stringify({
      Assets: [
        { PackageId: "Flockbot", Version: "0.2.1-dev.9", Type: "Full" },
        { PackageId: "Flockbot", Version: "0.2.1-dev.19", Type: "Delta" },
        { PackageId: "Flockbot", Version: "0.2.1-dev.19", Type: "Full" },
        { PackageId: "Flockbot", Version: "not-a-version", Type: "Full" },
      ],
    });
    expect(newestInFeed(releases, "velopack")).toBe("0.2.1-dev.19");
  });

  it("finds nothing in an empty or broken feed", () => {
    expect(newestInFeed("<rss></rss>", "appcast")).toBeUndefined();
    expect(newestInFeed("not json", "velopack")).toBeUndefined();
    expect(newestInFeed('{"Assets":null}', "velopack")).toBeUndefined();
  });
});

describe("checking for updates", () => {
  let directory: string;
  let file: string;
  let now: number;
  let feed: string | Error;
  let fetches: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "flockbot-updates-"));
    file = join(directory, "profile", "update-check.json");
    now = Date.UTC(2026, 10, 20);
    feed = feedListing("0.3.0");
    fetches = 0;
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const feedListing = (version: string) =>
    JSON.stringify({ Assets: [{ Version: version, Type: "Full" }] });
  const check = (current = "0.2.1") =>
    new UpdateCheck({
      feed: "https://example.com/releases.win-x64.json",
      format: "velopack",
      current,
      file,
      now: () => now,
      fetch: (async () => {
        fetches++;
        if (feed instanceof Error) throw feed;
        return new Response(feed, { status: feed === "" ? 404 : 200 });
      }) as typeof fetch,
    });

  it("reports a newer release and remembers it for the next session", async () => {
    const first = check();
    expect(first.available()).toBeUndefined();
    await first.refresh();
    expect(first.available()).toBe("0.3.0");

    // The next session knows before it checks, and doesn't check again today.
    const next = check();
    expect(next.available()).toBe("0.3.0");
    await next.refresh();
    expect(fetches).toBe(1);

    // A day later it reads the feed again, and sees the newer release.
    now += CHECK_INTERVAL_MS;
    feed = feedListing("0.3.1");
    await next.refresh();
    expect(fetches).toBe(2);
    expect(next.available()).toBe("0.3.1");
  });

  it("reports nothing once this copy is current", async () => {
    const current = check("0.3.0");
    await current.refresh();
    expect(current.available()).toBeUndefined();
    expect(check("0.3.0-dev.4").available()).toBe("0.3.0");
  });

  it("keeps trying while the feed can't be read, and never throws", async () => {
    feed = new Error("offline");
    await check().refresh();
    feed = "";
    await check().refresh();
    expect(existsSync(file)).toBe(false);

    feed = feedListing("0.3.0");
    const online = check();
    await online.refresh();
    expect(fetches).toBe(3);
    expect(online.available()).toBe("0.3.0");
  });
});
