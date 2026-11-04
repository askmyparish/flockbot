import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StorageFetch } from "../../adapters/zapier/src/storage.js";
import {
  diagnoseZapierStorage,
  validationHints,
} from "../../scripts/zapier/storage-diagnostic.js";

const secret = "12345678-1234-4234-8234-123456789abc";
const config = {
  consent: "authorize-isolated-storage-diagnostic",
  dedicatedStore: true,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

describe("isolated Storage validation diagnostic", () => {
  it("projects schema fields/types but no server-provided values", () => {
    const hints = validationHints(
      JSON.stringify({
        message: `PRIVATE-${secret}-person@example.test`,
        schema: {
          properties: {
            data: {
              required: ["key", "value", "previous_value", "PRIVATE"],
              properties: {
                previous_value: { type: "string" },
                value: { type: "object" },
                PRIVATE: { type: secret },
              },
            },
          },
        },
      }),
    );
    expect(hints).toMatchObject({
      json: true,
      requiredFields: ["key", "value", "previous_value"],
      fieldTypes: [
        { field: "previous_value", type: "string" },
        { field: "value", type: "object" },
      ],
      missingRequired: true,
    });
    expect(JSON.stringify(hints)).not.toContain(secret);
    expect(JSON.stringify(hints)).not.toContain("PRIVATE");
    expect(JSON.stringify(hints)).not.toContain("person@example.test");
  });

  it("returns only fixed boolean/vocabulary hints for non-JSON messages", () => {
    const hints = validationHints(
      `PRIVATE-${secret}: previous_value has unexpected type null; string required`,
    );
    expect(hints).toMatchObject({
      json: false,
      fields: ["previous_value"],
      types: ["string", "null"],
      missingRequired: true,
      unexpectedField: true,
    });
    expect(JSON.stringify(hints)).not.toContain(secret);
    expect(JSON.stringify(hints)).not.toContain("PRIVATE");
  });

  it("keeps missing consent/dedicated-store input offline", async () => {
    const transport = vi.fn<StorageFetch>();
    await expect(
      diagnoseZapierStorage({ ...config, consent: "" }, secret, transport),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      diagnoseZapierStorage(
        { ...config, dedicatedStore: false },
        secret,
        transport,
      ),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps the wrapper inert with only the diagnostic flag", () => {
    try {
      execFileSync(
        process.execPath,
        [
          "scripts/zapier/probe-storage.mjs",
          "--authorize-isolated-storage-diagnostic",
        ],
        { cwd: new URL("../..", import.meta.url), stdio: "pipe" },
      );
      throw new Error("Expected inert exit.");
    } catch (error) {
      expect(error).toMatchObject({ status: 2 });
      expect(String((error as { stderr: unknown }).stderr)).toContain(
        "No requests made.",
      );
    }
  });

  it("executes the real diagnostic wrapper with an offline child transport", () => {
    const directory = mkdtempSync(join(tmpdir(), "flockbot-diagnostic-test-"));
    try {
      const file = join(directory, "fictional-secret");
      const preload = join(directory, "offline-fetch.mjs");
      writeFileSync(file, secret, { mode: 0o600 });
      writeFileSync(
        preload,
        'globalThis.fetch = async (url, options) => { if (new URL(url).origin !== "https://store.zapier.com" || !["GET", "PATCH"].includes(options.method)) throw new Error("Unexpected offline request"); return new Response(JSON.stringify(options.method === "PATCH" ? {schema: {required: ["previous"]}} : {}), {status: options.method === "PATCH" ? 400 : 200}); };',
      );
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          preload,
          "scripts/zapier/probe-storage.mjs",
          "--authorize-isolated-storage-diagnostic",
          "--dedicated-store",
          "--secret-file",
          file,
        ],
        {
          cwd: new URL("../..", import.meta.url),
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      expect(JSON.parse(output)).toMatchObject({
        responseReceived: true,
        httpStatus: 400,
        validation: { requiredFields: ["previous"] },
        requests: 2,
      });
      expect(output).not.toContain(secret);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("inspects one rejected PATCH and makes only a keyed cleanup read", async () => {
    const transport = vi.fn<StorageFetch>(async (_url, options) =>
      options.method === "PATCH"
        ? json(
            {
              schema: {
                required: ["previous"],
                properties: { previous: { type: "string" } },
              },
              raw: secret,
            },
            400,
          )
        : json({}),
    );
    const result = await diagnoseZapierStorage(config, secret, transport);
    expect(result).toMatchObject({
      responseReceived: true,
      httpStatus: 400,
      validation: {
        requiredFields: ["previous"],
        fieldTypes: [{ field: "previous", type: "string" }],
      },
      requests: 2,
      cleanup: "unconfirmed",
    });
    const [patch, read] = transport.mock.calls;
    const body = JSON.parse(String(patch?.[1].body));
    expect(body).toMatchObject({
      action: "set_value_if",
      data: { previous_value: null },
    });
    expect(body.data.key).toMatch(/^fbdiag_[a-f0-9]{22}$/);
    expect(new URL(String(read?.[0])).searchParams.get("key")).toBe(
      body.data.key,
    );
    for (const [url, options] of transport.mock.calls) {
      expect(new URL(url).origin).toBe("https://store.zapier.com");
      expect(url).not.toContain(secret);
      expect(options).toMatchObject({
        credentials: "omit",
        redirect: "manual",
        headers: { "X-Secret": secret },
      });
    }
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(body.data.value);
    expect(JSON.stringify(result)).not.toContain(body.data.key);
  });

  it("cleans only its observed marker with at most four requests", async () => {
    let key = "";
    let marker: string | null = null;
    const transport = vi.fn<StorageFetch>(async (_url, options) => {
      if (options.method === "PATCH") {
        const { data } = JSON.parse(String(options.body));
        key = data.key;
        marker = data.value;
        return json({});
      }
      if (options.method === "DELETE") {
        marker = null;
        return json({});
      }
      return json(marker === null ? {} : { [key]: marker });
    });
    const result = await diagnoseZapierStorage(config, secret, transport);
    expect(result).toMatchObject({
      responseReceived: true,
      httpStatus: 200,
      validation: null,
      cleanup: "confirmed",
      requests: 4,
    });
    expect(transport.mock.calls.map(([, options]) => options.method)).toEqual([
      "PATCH",
      "GET",
      "DELETE",
      "GET",
    ]);
    expect(marker).toBeNull();
  });

  it("does not delete a foreign marker or a malformed cleanup response", async () => {
    const foreign = vi.fn<StorageFetch>(async (url, options) =>
      options.method === "PATCH"
        ? json({}, 400)
        : json({ [new URL(url).searchParams.get("key") as string]: "foreign" }),
    );
    const unknown = vi.fn<StorageFetch>(async (_url, options) =>
      options.method === "PATCH" ? json({}, 400) : json({ message: "private" }),
    );
    for (const transport of [foreign, unknown]) {
      const result = await diagnoseZapierStorage(config, secret, transport);
      expect(result.cleanup).toBe("unconfirmed");
      expect(transport.mock.calls.map(([, options]) => options.method)).toEqual(
        ["PATCH", "GET"],
      );
    }
  });

  it("stops after a transport failure without replay or cleanup calls", async () => {
    const transport = vi.fn<StorageFetch>(async () => {
      throw new Error(`PRIVATE-${secret}`);
    });
    const result = await diagnoseZapierStorage(config, secret, transport);
    expect(result).toMatchObject({
      responseReceived: false,
      cleanup: "unconfirmed",
      failure: "storage_transport_failed",
      requests: 1,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("bounds a stalled validation body and stops without a second request", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn<StorageFetch>(
        async () =>
          new Response(
            new ReadableStream({ pull: () => new Promise(() => {}) }),
            { status: 400 },
          ),
      );
      const pending = diagnoseZapierStorage(config, secret, transport);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await pending;
      expect(result).toMatchObject({
        responseReceived: false,
        httpStatus: 400,
        failure: "storage_timeout",
        cleanup: "unconfirmed",
        requests: 1,
      });
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds validation data to 16KiB without returning the oversized text", async () => {
    const transport: StorageFetch = async (_url, options) =>
      options.method === "PATCH"
        ? new Response("PRIVATE".repeat(3000), { status: 400 })
        : json({});
    const result = await diagnoseZapierStorage(config, secret, transport);
    expect(result).toMatchObject({
      httpStatus: 400,
      validationTruncated: true,
      requests: 2,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});
