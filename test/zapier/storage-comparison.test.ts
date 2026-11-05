import { expect, it, vi } from "vitest";
import {
  compareStorage,
  comparisonHints,
  COMPARISON_CONSENT,
  CONTENTION_CONSENT,
} from "../../scripts/zapier/storage-comparison.js";
import type { StorageFetch } from "../../adapters/zapier/src/storage.js";
const secret = "12345678-1234-4234-8234-123456789abc";
const config = { consent: COMPARISON_CONSENT, dedicatedStore: true };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
it("projects only fixed fields and booleans", () => {
  const r = comparisonHints(
    JSON.stringify({
      success: false,
      value: "private",
      secret: "private",
      other: "private",
    }),
    "attempt",
    "previous",
  );
  expect(r).toMatchObject({
    json: true,
    fields: [
      { field: "success", boolean: false },
      { field: "value", boolean: null },
    ],
    containsAttempted: false,
    containsPrevious: false,
  });
  expect(JSON.stringify(r)).not.toContain("private");
});
it.each([
  "safe",
  "stale400",
  "broken",
  "lostPost",
  "foreign",
  "oversized",
  "stalled",
  "matching400",
  "collision",
])("diagnoses %s without replay or foreign deletion", async (fault) => {
  const values = new Map<string, string>();
  let patches = 0;
  const methods: string[] = [];
  const sensitive: string[] = [secret, "upstream-sentinel"];
  const transport = vi.fn<StorageFetch>(async (url, options) => {
    const method = String(options.method);
    methods.push(method);
    if (method === "POST") {
      if (fault === "lostPost") throw new Error("private");
      for (const [k, v] of Object.entries(JSON.parse(String(options.body))))
        values.set(k, v as string);
      return json({}, 201);
    }
    if (method === "PATCH") {
      patches++;
      const { key, value, previous_value } = JSON.parse(
        String(options.body),
      ).data;
      sensitive.push(key, value, previous_value);
      const match = values.get(key) === previous_value;
      if (fault === "matching400") return json({}, 400);
      if (match || fault === "broken") values.set(key, value);
      if (fault === "oversized") return new Response("x".repeat(17000));
      if (fault === "stalled")
        return new Response(new ReadableStream({ start() {} }));
      return json(
        {
          success: match,
          key,
          value,
          previous_value,
          message: "upstream-sentinel",
        },
        fault === "stale400" && !match ? 400 : 200,
      );
    }
    const key = new URL(url).searchParams.get("key") as string;
    if (fault === "collision" && methods.length === 1)
      return json({ [key]: "foreign" });
    if (fault === "foreign" && patches === 2) values.set(key, "foreign");
    if (method === "DELETE") values.delete(key);
    return json(values.has(key) ? { [key]: values.get(key) } : {});
  });
  // Exercise the real timeout path without spending two wall-clock seconds.
  if (fault === "stalled") vi.useFakeTimers();
  let r: Awaited<ReturnType<typeof compareStorage>>;
  try {
    const pending = compareStorage(config, secret, transport);
    if (fault === "stalled") await vi.advanceTimersByTimeAsync(2000);
    r = await pending;
  } finally {
    if (fault === "stalled") vi.useRealTimers();
  }
  expect(r.requests).toBeLessThanOrEqual(10);
  expect(methods.filter((x) => x === "POST")).toHaveLength(
    fault === "collision" ? 0 : 1,
  );
  for (const value of sensitive) expect(JSON.stringify(r)).not.toContain(value);
  expect(JSON.stringify(r)).not.toContain(secret);
  if (fault === "safe" || fault === "stale400") {
    expect(r).toMatchObject({
      initialized: true,
      matchingApplied: true,
      stalePreserved: true,
      cleanup: "unconfirmed",
      unresolvedWrites: 1,
      atomicityProven: false,
      requests: 10,
    });
    expect(
      r.responses.map(
        (x) => x.hints.fields?.find((f) => f.field === "success")?.boolean,
      ),
    ).toEqual([true, false]);
  } else if (fault === "broken")
    expect(r).toMatchObject({ stalePreserved: false, cleanup: "confirmed" });
  else if (fault === "stalled")
    expect(r).toMatchObject({
      failure: "storage_timeout",
      cleanup: "confirmed",
      unresolvedWrites: 0,
    });
  else if (fault === "oversized") expect(r.responses[0]?.truncated).toBe(true);
  else if (fault === "matching400")
    expect(r).toMatchObject({
      matchingApplied: false,
      failure: "storage_protocol_error",
    });
  else expect(methods).not.toContain("DELETE");
  expect(patches).toBe(
    ["lostPost", "collision"].includes(fault)
      ? 0
      : ["stalled", "matching400"].includes(fault)
        ? 1
        : 2,
  );
});
it("refuses missing consent without a request", async () => {
  const transport = vi.fn<StorageFetch>();
  await expect(
    compareStorage({ ...config, consent: "" }, secret, transport),
  ).rejects.toMatchObject({ code: "invalid_configuration" });
  expect(transport).not.toHaveBeenCalled();
});

it("refuses an unconfirmed dedicated store before network", async () => {
  const transport = vi.fn<StorageFetch>();
  await expect(
    compareStorage({ ...config, dedicatedStore: false }, secret, transport),
  ).rejects.toMatchObject({ code: "invalid_configuration" });
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  "atomic",
  "race",
  "softBoth200",
  "reversedResponses",
  "lostA",
  "foreignCleanup",
  "collision",
  "initialFailure",
  "staleAccepted",
])(
  "captures labeled contender evidence for %s without replay",
  async (fault) => {
    const values = new Map<string, string>();
    const methods: string[] = [];
    const privateValues = [secret, "private-upstream-sentinel"];
    let patches = 0;
    let gets = 0;
    let release = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = vi.fn<StorageFetch>(async (url, options) => {
      const method = String(options.method);
      methods.push(method);
      if (method === "POST") {
        for (const [key, value] of Object.entries(
          JSON.parse(String(options.body)),
        )) {
          privateValues.push(key, String(value));
          values.set(key, String(value));
        }
        return json({}, 201);
      }
      if (method === "PATCH") {
        const index = ++patches;
        const { key, value, previous_value } = JSON.parse(
          String(options.body),
        ).data;
        privateValues.push(key, value, previous_value);
        const match = values.get(key) === previous_value;
        if (fault === "race" && index <= 2) {
          if (index === 2) release();
          await bothStarted;
        }
        if (match || (fault === "staleAccepted" && index === 3))
          values.set(key, value);
        if (fault === "lostA" && index === 1)
          throw new Error("private-upstream-sentinel");
        if (fault === "reversedResponses" && index === 1)
          await new Promise((resolve) => setTimeout(resolve, 5));
        return json(
          { [key]: values.get(key), private: "private-upstream-sentinel" },
          match ||
            fault === "softBoth200" ||
            (fault === "staleAccepted" && index === 3)
            ? 200
            : 400,
        );
      }
      const key = new URL(url).searchParams.get("key") as string;
      if (method === "GET") {
        gets++;
        if (gets === 1 && fault === "initialFailure") return json({}, 503);
        if (gets === 1 && fault === "collision")
          return json({ [key]: "foreign" });
        if (gets === 5 && fault === "foreignCleanup")
          values.set(key, "foreign");
      }
      if (method === "DELETE") values.delete(key);
      return json(values.has(key) ? { [key]: values.get(key) } : {});
    });
    const result = await compareStorage(
      { consent: CONTENTION_CONSENT, dedicatedStore: true },
      secret,
      transport,
    );
    expect(result.requests).toBeLessThanOrEqual(11);
    expect(result.atomicityProven).toBe(false);
    expect(result).not.toHaveProperty("passed");
    for (const value of privateValues)
      expect(JSON.stringify(result)).not.toContain(value);
    if (fault === "collision" || fault === "initialFailure") {
      expect(methods).toEqual(["GET"]);
      expect(result.cleanup).toBe("not_needed");
      return;
    }
    expect(methods.filter((method) => method === "POST")).toHaveLength(1);
    expect(methods.filter((method) => method === "PATCH")).toHaveLength(
      fault === "lostA" ? 2 : 3,
    );
    if (fault === "lostA") {
      expect(result).toMatchObject({
        failure: "storage_transport_failed",
        cleanup: "unconfirmed",
      });
      return;
    }
    const stages = Object.fromEntries(
      result.responses.map((response) => [response.stage, response.status]),
    );
    expect(stages.contenderA).toBe(200);
    expect(stages.contenderB).toBe(
      fault === "race" || fault === "softBoth200" ? 200 : 400,
    );
    expect(stages.stale).toBe(
      fault === "softBoth200" || fault === "staleAccepted" ? 200 : 400,
    );
    if (fault === "atomic") {
      expect(result.unresolvedWrites).toBe(2);
      expect(
        result.responses.find((response) => response.stage === "contenderA")
          ?.hints,
      ).toMatchObject({ containsAttempted: true, containsPrevious: false });
      expect(
        result.responses.find((response) => response.stage === "contenderB")
          ?.hints,
      ).toMatchObject({ containsAttempted: false, containsPrevious: false });
    }
    expect(result).toMatchObject({
      initialized: true,
      matchingApplied: true,
      stalePreserved: fault !== "staleAccepted",
      cleanup: "unconfirmed",
      contention: {
        singleWinnerObserved: !["race", "softBoth200"].includes(fault),
        winnerIsA: fault !== "race",
        winnerIsB: fault === "race",
        clientOverlapObserved: true,
      },
    });
    if (fault === "reversedResponses")
      expect(result.responses.map((r) => r.stage)).toEqual([
        "contenderB",
        "contenderA",
        "stale",
      ]);
    if (fault === "foreignCleanup") expect(methods).not.toContain("DELETE");
    else expect(result.requests).toBe(11);
  },
);

it("requires the dedicated-store attestation for contention before transport", async () => {
  const transport = vi.fn<StorageFetch>();
  await expect(
    compareStorage(
      { consent: CONTENTION_CONSENT, dedicatedStore: false },
      secret,
      transport,
    ),
  ).rejects.toMatchObject({ code: "invalid_configuration" });
  expect(transport).not.toHaveBeenCalled();
});

it.each(["bWins", "contradictoryRead", "neither400", "neither200"])(
  "requires a matching readback in the %s contention scenario",
  async (scenario) => {
    let current: string | undefined;
    let patches = 0;
    const statuses: number[] = [];
    const transport: StorageFetch = async (url, options) => {
      if (options.method === "POST") {
        current = String(Object.values(JSON.parse(String(options.body)))[0]);
        return json({}, 201);
      }
      if (options.method === "PATCH") {
        const index = ++patches;
        const { key, value } = JSON.parse(String(options.body)).data;
        const status =
          scenario === "bWins"
            ? index === 2
              ? 200
              : 400
            : scenario === "contradictoryRead"
              ? index === 1
                ? 200
                : 400
              : scenario === "neither200"
                ? 200
                : 400;
        if (
          index === 2 &&
          (scenario === "bWins" || scenario === "contradictoryRead")
        )
          current = value;
        statuses.push(status);
        return json({ [key]: current }, status);
      }
      const key = new URL(url).searchParams.get("key") as string;
      if (options.method === "DELETE") current = undefined;
      return json(current === undefined ? {} : { [key]: current });
    };
    const result = await compareStorage(
      { consent: CONTENTION_CONSENT, dedicatedStore: true },
      secret,
      transport,
    );
    expect(result.atomicityProven).toBe(false);
    if (scenario.startsWith("neither")) {
      expect(patches).toBe(2);
      expect(result).toMatchObject({
        failure: "storage_protocol_error",
        matchingApplied: false,
        contention: {
          singleWinnerObserved: false,
          winnerIsA: false,
          winnerIsB: false,
        },
      });
      expect(result.responses.map((response) => response.status)).toEqual(
        statuses,
      );
      for (const response of result.responses)
        expect(response.hints).toMatchObject({
          containsAttempted: false,
          containsPrevious: true,
        });
    } else {
      expect(patches).toBe(3);
      expect(result).toMatchObject({
        matchingApplied: true,
        stalePreserved: true,
        unresolvedWrites: 2,
        contention: {
          singleWinnerObserved: scenario === "bWins",
          winnerIsA: false,
          winnerIsB: true,
        },
      });
      expect(
        result.responses.find((response) => response.stage === "contenderB")
          ?.hints,
      ).toMatchObject({ containsAttempted: true, containsPrevious: false });
    }
    expect(result.cleanup).toBe("unconfirmed");
  },
);

it.each(["release", "timeout"])(
  "settles the second contender before cleanup after first failure: %s",
  async (mode) => {
    vi.useFakeTimers();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current: string | undefined;
    let patches = 0;
    let gets = 0;
    let secondSettled = false;
    let cleanupStartedTooEarly = false;
    let secondSignal: AbortSignal | null | undefined;
    const transport: StorageFetch = async (url, options) => {
      if (options.method === "POST") {
        current = String(Object.values(JSON.parse(String(options.body)))[0]);
        return json({}, 201);
      }
      if (options.method === "PATCH") {
        if (++patches === 1) throw new Error("private transport detail");
        secondSignal = options.signal;
        if (mode === "timeout") await new Promise(() => {});
        else await held;
        secondSettled = true;
        return json({}, 400);
      }
      if (
        options.method === "GET" &&
        ++gets > 2 &&
        !secondSettled &&
        !secondSignal?.aborted
      )
        cleanupStartedTooEarly = true;
      const key = new URL(url).searchParams.get("key") as string;
      if (options.method === "DELETE") current = undefined;
      return json(current === undefined ? {} : { [key]: current });
    };
    const pending = compareStorage(
      { consent: CONTENTION_CONSENT, dedicatedStore: true },
      secret,
      transport,
    );
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(patches).toBe(2);
      expect(gets).toBe(2);
      if (mode === "release") release();
      else await vi.advanceTimersByTimeAsync(2000);
      const result = await pending;
      expect(cleanupStartedTooEarly).toBe(false);
      expect(result).toMatchObject({
        failure: "storage_transport_failed",
        unresolvedWrites: 2,
        cleanup: "unconfirmed",
      });
      expect(patches).toBe(2);
      if (mode === "timeout") {
        expect(secondSignal?.aborted).toBe(true);
        expect(result.observations[4]).toMatchObject({
          failure: "storage_timeout",
          status: null,
        });
      } else expect(secondSettled).toBe(true);
    } finally {
      release();
      await pending;
      vi.useRealTimers();
    }
  },
);
