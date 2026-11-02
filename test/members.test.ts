import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FlockbotClient,
  FlockbotError,
  RequestNotSentError,
  sessionFromToken,
  type ClientOptions,
  type MemberInput,
  type SessionState,
  type Transport,
  type TransportResponse,
} from "../src/index.js";
import { FakeCoordinator } from "./support.js";

const member = {
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
};
const accepted = { success: true, userID: 201 };
const expired = { success: true, authorized: false, userID: null };
const firstFactor = {
  success: true,
  allowPasswordForFirstFactor: true,
  firstFactorSuccess: false,
};
function response(
  data: unknown = { success: true },
  status = 200,
  cookie?: string,
): TransportResponse {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie)
    headers.set(
      "set-cookie",
      `Flocknote=${cookie}; Domain=flocknote.com; Path=/; Secure; HttpOnly`,
    );
  return { status, headers, body: JSON.stringify(data) };
}
function fixture(options: Partial<ClientOptions> = {}) {
  let saved: SessionState | null = sessionFromToken(
    "example-parish",
    "fictional-session",
  );
  let revision = 0;
  const sessionStore = {
    revision: vi.fn(async () => String(revision)),
    load: vi.fn(async () => structuredClone(saved)),
    save: vi.fn(async (state: SessionState, expected: string) => {
      if (expected !== String(revision))
        throw new FlockbotError("stale_session_state");
      saved = structuredClone(state);
      revision++;
    }),
    clear: vi.fn(async (expected: string) => {
      if (expected !== String(revision))
        throw new FlockbotError("stale_session_state");
      saved = null;
      revision++;
    }),
  };
  const transport = vi.fn<Transport>(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/user/userData") return response(accepted);
    if (path === "/login/twoFactorAuth") {
      return new URLSearchParams(request.body).has("password")
        ? response({ success: true, loginSuccess: true })
        : response(firstFactor, 200, "fictional-renewed");
    }
    return response();
  });
  const provider = {
    load: vi.fn(async () => ({
      email: "operator@example.test",
      password: "fictional-password",
    })),
  };
  const client = new FlockbotClient({
    subdomain: "example-parish",
    sessionStore,
    coordinator: new FakeCoordinator(),
    transport,
    credentialProvider: provider,
    policy: { maxReadRetries: 0 },
    ...options,
  });
  return {
    client,
    sessionStore,
    transport,
    provider,
    paths: () =>
      transport.mock.calls.map(([request]) => new URL(request.url).pathname),
    writes: () =>
      transport.mock.calls.filter(([request]) =>
        request.url.endsWith("/addToGroupByAdmin"),
      ),
  };
}
afterEach(() => vi.useRealTimers());

describe("membership requests", () => {
  it.each([
    ["email only", { ...member, mobilePhone: null }, "alex@example.test", ""],
    [
      "mobile only",
      { firstName: "Sam", lastName: "Lee", mobilePhone: "+1 (202) 555-0123" },
      "",
      "+1 (202) 555-0123",
    ],
    [
      "both",
      { ...member, mobilePhone: "202-555-0123" },
      "alex@example.test",
      "202-555-0123",
    ],
  ])(
    "maps %s to the existing form fields",
    async (_label, input, email, mobile) => {
      const f = fixture();
      expect(await f.client.addMember("00101", input)).toEqual({
        success: true,
      });
      expect(f.paths()).toEqual([
        "/user/userData",
        "/group/101/addToGroupByAdmin",
      ]);
      const request = f.writes()[0]?.[0];
      expect(request?.method).toBe("POST");
      expect(request?.redirect).toBe("manual");
      expect(request?.headers).toMatchObject({
        Cookie: "Flocknote=fictional-session",
        "Content-Type": "application/x-www-form-urlencoded",
      });
      expect(Object.fromEntries(new URLSearchParams(request?.body))).toEqual({
        fname: input.firstName,
        lname: input.lastName,
        email,
        mobile_phone: mobile,
      });
      expect(f.provider.load).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, "", "   "])(
    "normalizes optional blank %#",
    async (blank) => {
      const f = fixture();
      await f.client.addMember(101, {
        firstName: " Alex ",
        lastName: " Rivera ",
        email: " alex@example.test ",
        mobilePhone: blank,
      });
      expect(
        Object.fromEntries(new URLSearchParams(f.writes()[0]?.[0].body)),
      ).toEqual({
        fname: "Alex",
        lname: "Rivera",
        email: "alex@example.test",
        mobile_phone: "",
      });
    },
  );

  it.each(["new", "existing"])(
    "uses the same minimal request/result for a %s member",
    async (_kind) => {
      const f = fixture();
      // These flags are response metadata, never instructions to update a person.
      f.transport
        .mockResolvedValueOnce(response(accepted))
        .mockResolvedValueOnce(
          response({
            success: true,
            existingSubscription: _kind === "existing",
            subscribed: true,
            subscribedUserID: 301,
            email: "private-response@example.test",
          }),
        );
      const result = await f.client.addMember("9007199254740993", member);
      expect(result).toEqual({ success: true });
      expect(Object.isFrozen(result)).toBe(true);
      expect(f.writes()[0]?.[0].url).toBe(
        "https://example-parish.flocknote.com/group/9007199254740993/addToGroupByAdmin",
      );
      expect([...new URLSearchParams(f.writes()[0]?.[0].body).keys()]).toEqual([
        "fname",
        "lname",
        "email",
        "mobile_phone",
      ]);
    },
  );

  it("snapshots normalized fields before awaiting dependencies", async () => {
    const f = fixture();
    const input = { ...member };
    const pending = f.client.addMember("101", input);
    input.email = "changed@example.test";
    await pending;
    expect(new URLSearchParams(f.writes()[0]?.[0].body).get("email")).toBe(
      member.email,
    );
  });

  it.each([
    null,
    undefined,
    [],
    {},
    { ...member, firstName: "" },
    { ...member, firstName: 1 },
    { ...member, lastName: "  " },
    { ...member, lastName: "Rivera\nOther" },
    { firstName: "Alex", lastName: "Rivera" },
    { ...member, email: null },
    { ...member, email: "  " },
    { ...member, email: "invalid" },
    { ...member, email: "a@b@c.test" },
    { ...member, email: "alex@ example.test" },
    { ...member, email: false },
    { ...member, mobilePhone: 2025550123 },
    { ...member, mobilePhone: "call me" },
    { ...member, mobilePhone: "123" },
    { ...member, mobilePhone: "1234567890123456" },
  ])(
    "rejects invalid member %# before coordination, storage or transport",
    async (input) => {
      const coordinator = { runExclusive: vi.fn() };
      const f = fixture({ coordinator });
      await expect(
        f.client.addMember("101", input as MemberInput),
      ).rejects.toMatchObject({
        code: "invalid_input",
        outcome: "not_submitted",
      });
      expect(coordinator.runExclusive).not.toHaveBeenCalled();
      expect(f.sessionStore.load).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "0",
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "../members",
    "101?x=y",
    null,
    {},
  ])("rejects invalid group %# before any request", async (id) => {
    const f = fixture();
    await expect(
      f.client.addMember(id as string, member),
    ).rejects.toMatchObject({
      code: "invalid_input",
      outcome: "not_submitted",
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.sessionStore.load).not.toHaveBeenCalled();
  });
});

describe("membership results", () => {
  it.each([
    [
      "false success",
      response({ success: false, message: "private-contact@example.test" }),
      "upstream_rejected",
      200,
    ],
    ["unavailable group", response({}, 404), "upstream_rejected", 404],
    ["permission denial", response({}, 403), "permission_denied", 403],
    ["service failure", response({}, 503), "upstream_rejected", 503],
    ["rate limit", response({}, 429), "upstream_rejected", 429],
    ["auth-like body", response(expired), "upstream_rejected", 200],
    [
      "missing success",
      response({ subscribed: true }),
      "invalid_response",
      undefined,
    ],
    [
      "string success",
      response({ success: "true" }),
      "invalid_response",
      undefined,
    ],
    ["null", response(null), "invalid_response", undefined],
    ["array", response([{ success: true }]), "invalid_response", undefined],
    [
      "broken JSON",
      { ...response(), body: "{private-contact" },
      "invalid_response",
      undefined,
    ],
  ])(
    "reports %s explicitly without replay",
    async (_label, reply, code, status) => {
      const f = fixture({ policy: { maxReadRetries: 5, readBackoffMs: 0 } });
      f.transport
        .mockResolvedValueOnce(response(accepted))
        .mockResolvedValueOnce(reply);
      await expect(f.client.addMember("101", member)).rejects.toMatchObject({
        code,
        status,
        outcome: "unknown",
      });
      expect(f.writes()).toHaveLength(1);
      expect(f.paths()).toHaveLength(2);
      expect(f.provider.load).not.toHaveBeenCalled();
      expect(f.sessionStore.save).not.toHaveBeenCalled();
    },
  );

  it("keeps an accepted preflight rotation when the write is rejected", async () => {
    const f = fixture();
    f.transport
      .mockImplementationOnce(async () =>
        response(accepted, 200, "fictional-verified"),
      )
      .mockImplementationOnce(async (request) => {
        expect(f.sessionStore.save).toHaveBeenCalledOnce();
        expect(request.headers.Cookie).toBe("Flocknote=fictional-verified");
        return response({ success: false }, 200, "fictional-unverified");
      });
    await expect(f.client.addMember("101", member)).rejects.toMatchObject({
      code: "upstream_rejected",
      outcome: "unknown",
    });
    const state = JSON.stringify(await f.sessionStore.load());
    expect(state).toContain("fictional-verified");
    expect(state).not.toContain("fictional-unverified");
  });

  it("does not persist cookies from an unconfirmed successful HTTP response", async () => {
    const f = fixture();
    f.transport
      .mockResolvedValueOnce(response(accepted))
      .mockResolvedValueOnce(
        response({ subscribed: true }, 200, "fictional-unverified"),
      );
    await expect(f.client.addMember("101", member)).rejects.toMatchObject({
      code: "invalid_response",
      outcome: "unknown",
    });
    expect(f.sessionStore.save).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.sessionStore.load())).not.toContain(
      "fictional-unverified",
    );
  });

  it("reports save failure without replay and can retry only persistence", async () => {
    const f = fixture();
    f.transport
      .mockResolvedValueOnce(response(accepted))
      .mockResolvedValueOnce(
        response({ success: true }, 200, "fictional-accepted"),
      );
    f.sessionStore.save.mockRejectedValueOnce(
      new Error("private-storage-details"),
    );
    await expect(f.client.addMember("101", member)).rejects.toMatchObject({
      code: "session_save_failed",
      outcome: "unknown",
    });
    await f.client.connect();
    expect(f.writes()).toHaveLength(1);
    expect(f.sessionStore.save).toHaveBeenCalledTimes(2);
    expect(f.transport.mock.calls.at(-1)?.[0].headers.Cookie).toBe(
      "Flocknote=fictional-accepted",
    );
  });

  it("discards upstream contacts in success/error/inspect outputs", async () => {
    const f = fixture();
    const marker = "private-upstream-contact@example.test";
    f.transport.mockResolvedValueOnce(response(accepted)).mockResolvedValueOnce(
      response({
        success: true,
        email: marker,
        password: "fictional-private-secret",
      }),
    );
    const result = await f.client.addMember("101", member);
    expect(
      [inspect(result), JSON.stringify(result), inspect(f.client)].join(" "),
    ).not.toMatch(
      /alex@example|private-upstream|fictional-private|fictional-session/,
    );
    f.transport
      .mockResolvedValueOnce(response(accepted))
      .mockResolvedValueOnce(response({ success: false, message: marker }));
    const error = await f.client
      .addMember("101", member)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(FlockbotError);
    expect(
      [String(error), inspect(error), JSON.stringify(error)].join(" "),
    ).not.toMatch(
      /alex@example|private-upstream|fictional-private|fictional-session/,
    );
  });
});

describe("membership authentication and submission safety", () => {
  it("bootstraps a missing session before its one membership submission", async () => {
    const f = fixture();
    await f.client.clearSession();
    expect(await f.client.addMember("101", member)).toEqual({ success: true });
    expect(f.paths()).toEqual([
      "/login/twoFactorAuth",
      "/login/twoFactorAuth",
      "/user/userData",
      "/group/101/addToGroupByAdmin",
    ]);
    expect(f.provider.load).toHaveBeenCalledOnce();
    expect(f.writes()).toHaveLength(1);
  });

  it("requires verified cookie persistence before submitting membership", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(
      response(accepted, 200, "fictional-verified"),
    );
    f.sessionStore.save.mockRejectedValueOnce(
      new Error("private-storage-details"),
    );
    await expect(f.client.addMember("101", member)).rejects.toMatchObject({
      code: "session_save_failed",
      outcome: "not_submitted",
    });
    expect(f.writes()).toHaveLength(0);
    expect(await f.client.addMember("101", member)).toEqual({ success: true });
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0]?.[0].headers.Cookie).toBe(
      "Flocknote=fictional-verified",
    );
    expect(f.sessionStore.save).toHaveBeenCalledTimes(2);
  });

  it("rejects a pre-aborted operation before any request", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.client.addMember("101", member, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "operation_cancelled",
      outcome: "not_submitted",
    });
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("recovers a known preflight rejection once, then submits exactly once", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(
      response(expired, 200, "fictional-rejected"),
    );
    expect(await f.client.addMember("101", member)).toEqual({ success: true });
    expect(f.paths()).toEqual([
      "/user/userData",
      "/login/twoFactorAuth",
      "/login/twoFactorAuth",
      "/user/userData",
      "/group/101/addToGroupByAdmin",
    ]);
    expect(f.provider.load).toHaveBeenCalledOnce();
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0]?.[0].headers.Cookie).toBe(
      "Flocknote=fictional-renewed",
    );
  });

  it("stops if verification after the one login is still rejected", async () => {
    const f = fixture();
    f.transport
      .mockResolvedValueOnce(response(expired))
      .mockResolvedValueOnce(response(firstFactor, 200, "fictional-new"))
      .mockResolvedValueOnce(response({ success: true, loginSuccess: true }))
      .mockResolvedValueOnce(response(expired));
    await expect(f.client.addMember("101", member)).rejects.toMatchObject({
      code: "authentication_required",
      outcome: "not_submitted",
    });
    expect(f.provider.load).toHaveBeenCalledOnce();
    expect(f.writes()).toHaveLength(0);
  });

  it("does not renew or submit after preflight permission denial", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(response({}, 403));
    await expect(f.client.addMember("101", member)).rejects.toMatchObject({
      code: "permission_denied",
      status: 403,
      outcome: "not_submitted",
    });
    expect(f.provider.load).not.toHaveBeenCalled();
    expect(f.writes()).toHaveLength(0);
  });

  it("never retries a possibly-submitted connection failure", async () => {
    const f = fixture({ policy: { maxReadRetries: 5, readBackoffMs: 0 } });
    f.transport
      .mockResolvedValueOnce(response(accepted))
      .mockRejectedValueOnce(
        new Error("private-upstream-contact@example.test"),
      );
    await expect(f.client.addMember("101", member)).rejects.toMatchObject({
      code: "transport_failed",
      outcome: "unknown",
    });
    expect(f.writes()).toHaveLength(1);
  });

  it("keeps a transport guarantee of no submission distinct without retrying", async () => {
    const f = fixture();
    f.transport
      .mockResolvedValueOnce(response(accepted))
      .mockRejectedValueOnce(new RequestNotSentError());
    await expect(f.client.addMember("101", member)).rejects.toMatchObject({
      code: "request_not_sent",
      outcome: "not_submitted",
    });
    expect(f.writes()).toHaveLength(1);
  });

  it("fences a late preflight response after a deadline before submission", async () => {
    vi.useFakeTimers();
    const f = fixture({ policy: { timeoutMs: 20, maxReadRetries: 0 } });
    f.transport.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve(response(accepted, 200, "fictional-late")),
            30,
          );
        }),
    );
    const assertion = expect(
      f.client.addMember("101", member),
    ).rejects.toMatchObject({
      code: "operation_timeout",
      outcome: "not_submitted",
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    await vi.advanceTimersByTimeAsync(10);
    expect(f.writes()).toHaveLength(0);
    expect(f.sessionStore.save).not.toHaveBeenCalled();
  });

  it.each(["timeout", "cancel"])(
    "reports %s after submission as unknown without late persistence",
    async (kind) => {
      vi.useFakeTimers();
      const f = fixture({ policy: { timeoutMs: 20, maxReadRetries: 5 } });
      f.transport
        .mockResolvedValueOnce(response(accepted))
        .mockImplementationOnce(
          async () =>
            new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve(response({ success: true }, 200, "fictional-late")),
                30,
              );
            }),
        );
      const controller = new AbortController();
      const assertion = expect(
        f.client.addMember("101", member, { signal: controller.signal }),
      ).rejects.toMatchObject({
        code: kind === "timeout" ? "operation_timeout" : "operation_cancelled",
        outcome: "unknown",
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.writes()).toHaveLength(1);
      if (kind === "cancel") controller.abort();
      await vi.advanceTimersByTimeAsync(19);
      await assertion;
      await vi.advanceTimersByTimeAsync(30);
      expect(f.writes()).toHaveLength(1);
      expect(f.sessionStore.save).not.toHaveBeenCalled();
    },
  );

  it("retains generic post behavior without adding a verification request", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(response({ arbitrary: "result" }));
    expect(await f.client.post("custom/action", { field: "value" })).toEqual({
      arbitrary: "result",
    });
    expect(f.paths()).toEqual(["/custom/action"]);
  });
});
