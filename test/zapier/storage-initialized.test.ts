import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  ProbeStorageClient,
  type StorageFetch,
} from "../../adapters/zapier/src/storage.js";
import {
  INITIALIZED_STORAGE_PROBE_CONSENT,
  probeZapierStorage,
} from "../../scripts/zapier/storage-probe.js";
const secret = "12345678-1234-4234-8234-123456789abc";
const config = {
  consent: INITIALIZED_STORAGE_PROBE_CONSENT,
  dedicatedStore: true,
};
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status });
function model(fault = "") {
  const values = new Map<string, string>();
  const methods: string[] = [];
  const transport = vi.fn<StorageFetch>(async (url, options) => {
    const method = String(options.method);
    methods.push(method);
    expect(options).toMatchObject({
      redirect: "manual",
      credentials: "omit",
      headers: { "X-Secret": secret },
    });
    expect(new URL(url).origin).toBe("https://store.zapier.com");
    if (method === "POST") {
      expect(new URL(url).search).toBe("");
      const body = JSON.parse(String(options.body));
      expect(Object.keys(body)).toHaveLength(1);
      const [key, value] = Object.entries(body)[0] as [string, string];
      if (fault === "post400") return json({}, 400);
      if (fault === "lostPost") throw new Error("private upstream sentinel");
      if (fault !== "unobservedPost") values.set(key, value);
      return json({});
    }
    if (method === "PATCH") {
      const { key, value, previous_value } = JSON.parse(
        String(options.body),
      ).data;
      expect(typeof previous_value).toBe("string");
      if (fault === "lostPatch") throw new Error("private upstream sentinel");
      if (values.get(key) !== previous_value) return json({}, 400);
      values.set(key, value);
      return json({});
    }
    const key = new URL(url).searchParams.get("key") as string;
    if (fault === "collision" && methods.length === 1)
      return json({ [key]: "foreign" });
    if (method === "DELETE") values.delete(key);
    return json(values.has(key) ? { [key]: values.get(key) } : {});
  });
  return { transport, methods, values };
}
it("tests initialized string CAS and owned cleanup in an offline model", async () => {
  const f = model();
  const result = await probeZapierStorage(
    config,
    new ProbeStorageClient(secret, f.transport),
  );
  expect(result).toMatchObject({
    passed: true,
    atomicityProven: false,
    unresolvedWrites: 0,
    cleanup: "confirmed",
    requests: 11,
  });
  expect(result.observations).toMatchObject({
    initialize: { status: 200 },
    contenderA: { status: 200 },
    contenderB: { status: 400 },
    staleUpdate: { status: 400 },
  });
  expect(f.methods).toEqual([
    "GET",
    "POST",
    "GET",
    "PATCH",
    "PATCH",
    "GET",
    "PATCH",
    "GET",
    "GET",
    "DELETE",
    "GET",
  ]);
  expect(f.values.size).toBe(0);
  expect(JSON.stringify(result)).not.toContain(secret);
});
it.each(["lostPost", "unobservedPost", "lostPatch", "post400"])(
  "keeps uncertain %s unresolved without replay",
  async (fault) => {
    const f = model(fault);
    const result = await probeZapierStorage(
      config,
      new ProbeStorageClient(secret, f.transport),
    );
    expect(result).toMatchObject({ passed: false, cleanup: "unconfirmed" });
    expect(result.unresolvedWrites).toBeGreaterThan(0);
    expect(f.methods.filter((x) => x === "POST")).toHaveLength(1);
    if (fault === "lostPatch")
      expect(f.methods.filter((x) => x === "PATCH")).toHaveLength(2);
    else expect(f.methods).not.toContain("DELETE");
    expect(JSON.stringify(result)).not.toContain("private upstream sentinel");
  },
);
it("does not initialize or delete a collision", async () => {
  const f = model("collision");
  expect(
    await probeZapierStorage(
      config,
      new ProbeStorageClient(secret, f.transport),
    ),
  ).toMatchObject({ passed: false, cleanup: "not_needed" });
  expect(f.methods).toEqual(["GET"]);
});

it("requires the dedicated store assertion before requests", async () => {
  const transport = vi.fn<StorageFetch>();
  await expect(
    probeZapierStorage(
      { ...config, dedicatedStore: false },
      new ProbeStorageClient(secret, transport),
    ),
  ).rejects.toMatchObject({ code: "invalid_configuration" });
  expect(transport).not.toHaveBeenCalled();
});
it.each([
  "--authorize-initialized-storage-probe",
  "--authorize-storage-comparison-diagnostic",
  "--authorize-storage-contention-diagnostic",
])("dispatches %s to POST with an offline child tripwire", (flag) => {
  const dir = mkdtempSync(join(tmpdir(), "initialized-wrapper-"));
  try {
    const file = join(dir, "secret"),
      preload = join(dir, "offline.mjs");
    writeFileSync(file, secret, { mode: 0o600 });
    writeFileSync(
      preload,
      'globalThis.fetch = async (_url, options) => { if(options.method === "POST") process.exit(91); if(options.method !== "GET") process.exit(90); return new Response("{}"); };',
    );
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--import",
          preload,
          "scripts/zapier/probe-storage.mjs",
          flag,
          "--dedicated-store",
          "--secret-file",
          file,
        ],
        { stdio: "pipe" },
      ),
    ).toThrowError(expect.objectContaining({ status: 91 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("dispatches the contention wrapper through its distinct concurrent branch offline", () => {
  const dir = mkdtempSync(join(tmpdir(), "contention-wrapper-"));
  try {
    const file = join(dir, "secret");
    const preload = join(dir, "offline.mjs");
    writeFileSync(file, secret, { mode: 0o600 });
    writeFileSync(
      preload,
      `
      const values = new Map();
      globalThis.fetch = async (url, options) => {
        const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
        if (options.method === "POST") {
          for (const [key,value] of Object.entries(JSON.parse(options.body))) values.set(key,value);
          return response({},201);
        }
        if (options.method === "PATCH") {
          const {key,value,previous_value} = JSON.parse(options.body).data;
          if (values.get(key) !== previous_value) return response({},400);
          values.set(key,value);
          return response({[key]:value});
        }
        const key = new URL(url).searchParams.get("key");
        if (options.method === "DELETE") values.delete(key);
        return response(values.has(key) ? {[key]:values.get(key)} : {});
      };
    `,
    );
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        preload,
        "scripts/zapier/probe-storage.mjs",
        "--authorize-storage-contention-diagnostic",
        "--dedicated-store",
        "--secret-file",
        file,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output);
    expect(result).toMatchObject({
      requests: 11,
      atomicityProven: false,
      unresolvedWrites: 2,
      contention: { singleWinnerObserved: true },
    });
    expect(
      result.responses
        .map((response: { stage: string }) => response.stage)
        .sort(),
    ).toEqual(["contenderA", "contenderB", "stale"]);
    expect(output).not.toContain(secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
