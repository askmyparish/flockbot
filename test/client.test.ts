import { coordinator } from "./support.js";
import http from "node:http";
import { get as namedHttpGet } from "node:http";
import http2 from "node:http2";
import { request as namedHttpsRequest } from "node:https";
import net from "node:net";
import { connect as namedNetConnect } from "node:net";
import tls from "node:tls";
import { inspect } from "node:util";
import { getGlobalDispatcher, type MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FlockbotClient,
  FlockbotError,
  sessionFromToken,
  type SessionState,
  type SessionStore,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "../src/index.js";

const origin = "https://example-parish.flocknote.com";
const initial = "fictional-initial-session";
const rotated = "fictional-replacement-session";

function store(
  state: SessionState | null = sessionFromToken("example-parish", initial),
) {
  let revision = 0;
  let saved = structuredClone(state);
  return {
    revision: vi.fn(async () => String(revision)),
    load: vi.fn(async () => structuredClone(saved)),
    save: vi.fn(async (next: SessionState, expected?: string) => {
      if (expected !== undefined && expected !== String(revision))
        throw new FlockbotError("stale_session_state");
      saved = structuredClone(next);
      revision++;
    }),
    clear: vi.fn(async (expected?: string) => {
      if (expected !== undefined && expected !== String(revision))
        throw new FlockbotError("stale_session_state");
      saved = null;
      revision++;
    }),
  } satisfies SessionStore;
}

function reply(body = '{"ok":true}', cookie?: string): TransportResponse {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
  });
  if (cookie) headers.append("Set-Cookie", cookie);
  return { status: 200, headers, body };
}

function client(
  sessionStore = store(),
  transport: Transport = async () => reply(),
) {
  return new FlockbotClient({
    coordinator,
    policy: { maxReadRetries: 0 },
    subdomain: "example-parish",
    sessionStore,
    transport,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("supplied sessions", () => {
  it("reuses cookies, captures replacement, and reloads into a new client", async () => {
    const sessionStore = store();
    const requests: TransportRequest[] = [];
    const transport: Transport = async (request) => {
      requests.push(request);
      return reply(
        '{"ok":true}',
        `Flocknote=${rotated}; Domain=.flocknote.com; Path=/; Secure; HttpOnly`,
      );
    };
    const first = client(sessionStore, transport);
    expect(await first.get("dashboard")).toEqual({ ok: true });
    await first.get("navigation/groups");
    await client(sessionStore, transport).get("network/getMetadata");
    expect(requests.map((r) => r.headers.Cookie)).toEqual([
      `Flocknote=${initial}`,
      `Flocknote=${rotated}`,
      `Flocknote=${rotated}`,
    ]);
    expect(sessionStore.load).toHaveBeenCalledTimes(3);
    expect(sessionStore.save).toHaveBeenCalledTimes(1);
  });

  it("honors Max-Age after persistence instead of extending it on reload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const sessionStore = store();
    await client(sessionStore, async () =>
      reply(
        "{}",
        `Flocknote=${rotated}; Domain=flocknote.com; Path=/; Max-Age=2; Secure`,
      ),
    ).get("first");
    vi.setSystemTime(new Date("2026-01-01T00:00:03Z"));
    const transport = vi.fn<Transport>(async () => reply());
    await expect(
      client(sessionStore, transport).get("next"),
    ).rejects.toMatchObject({ code: "credentials_unavailable" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps Max-Age fixed across repeated calls on the same client", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const sessionStore = store();
    const transport = vi.fn<Transport>(async () => reply());
    transport.mockResolvedValueOnce(
      reply(
        "{}",
        `Flocknote=${rotated}; Domain=flocknote.com; Path=/; Max-Age=2; Secure`,
      ),
    );
    const connection = client(sessionStore, transport);
    await connection.get("first");
    vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
    await connection.get("second");
    // Past the granted expiry (t=2), before a slid expiry (t=3).
    vi.setSystemTime(new Date("2026-01-01T00:00:02.500Z"));
    await expect(connection.get("third")).rejects.toMatchObject({
      code: "credentials_unavailable",
    });
    await expect(
      client(sessionStore, transport).get("fourth"),
    ).rejects.toMatchObject({ code: "credentials_unavailable" });
    expect(
      transport.mock.calls.map(([request]) => request.headers.Cookie),
    ).toEqual([`Flocknote=${initial}`, `Flocknote=${rotated}`]);
    expect(sessionStore.save).toHaveBeenCalledTimes(1);
    expect((await sessionStore.load())?.cookies[0]).toContain(
      "Expires=Thu, 01 Jan 2026 00:00:02 GMT",
    );
  });

  it("does not restore cleared or newer stored state after an unchanged response", async () => {
    const sessionStore = store();
    const stale = client(sessionStore);
    await stale.get("first");
    await client(sessionStore).clearSession();
    await expect(stale.get("after-clear")).rejects.toMatchObject({
      code: "credentials_unavailable",
    });
    expect(await sessionStore.load()).toBeNull();
    const newer = sessionFromToken("example-parish", rotated);
    await sessionStore.save(newer);
    await stale.get("after-rotation");
    expect(await sessionStore.load()).toEqual(newer);
    expect(sessionStore.save).toHaveBeenCalledTimes(1);
  });

  it("does not need writable storage for an unchanged read", async () => {
    const sessionStore = store();
    sessionStore.save.mockRejectedValue(new Error("fictional storage outage"));
    await expect(client(sessionStore).get("dashboard")).resolves.toEqual({
      ok: true,
    });
    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it("retains unsaved rotations and retries persistence before another upstream request", async () => {
    const sessionStore = store();
    sessionStore.save.mockRejectedValueOnce(new Error("fictional outage"));
    sessionStore.save.mockRejectedValueOnce(
      new Error("fictional continuing outage"),
    );
    const transport = vi.fn<Transport>(async () => reply());
    transport.mockResolvedValueOnce(
      reply("{}", `Flocknote=${rotated}; Domain=flocknote.com; Path=/; Secure`),
    );
    const connection = client(sessionStore, transport);
    await expect(
      connection.post("example/write", { value: "fictional" }),
    ).rejects.toMatchObject({
      code: "session_save_failed",
      outcome: "unknown",
    });
    await expect(connection.get("after-failure")).rejects.toMatchObject({
      code: "session_save_failed",
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(sessionStore.save).toHaveBeenCalledTimes(2);
    await connection.get("after-recovery");
    expect(sessionStore.save).toHaveBeenCalledTimes(3);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]?.[0]).toMatchObject({
      method: "GET",
      headers: { Cookie: `Flocknote=${rotated}` },
    });
    expect((await sessionStore.load())?.cookies[0]).toContain(rotated);
    await connection.get("unchanged");
    expect(sessionStore.save).toHaveBeenCalledTimes(3);
  });

  it("discards pending persistence on explicit session clear", async () => {
    const sessionStore = store();
    sessionStore.save.mockRejectedValueOnce(new Error("fictional outage"));
    const transport = vi.fn<Transport>(async () => reply());
    transport.mockResolvedValueOnce(
      reply("{}", `Flocknote=${rotated}; Domain=flocknote.com; Path=/; Secure`),
    );
    const connection = client(sessionStore, transport);
    await expect(connection.get("first")).rejects.toMatchObject({
      code: "session_save_failed",
    });
    await connection.clearSession();
    await expect(connection.get("after-clear")).rejects.toMatchObject({
      code: "credentials_unavailable",
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(sessionStore.save).toHaveBeenCalledTimes(1);
    expect(await sessionStore.load()).toBeNull();
  });

  it("redacts library session-state inspection while preserving storage serialization", async () => {
    const state = sessionFromToken("example-parish", initial);
    expect(inspect(state)).not.toContain(initial);
    expect(inspect(state, { showHidden: true })).not.toContain(initial);
    expect(JSON.parse(JSON.stringify(state))).toEqual(structuredClone(state));
    expect(JSON.stringify(state)).toContain(initial);
    const sessionStore = store(state);
    await client(sessionStore, async () =>
      reply("{}", `Flocknote=${rotated}; Domain=flocknote.com; Path=/; Secure`),
    ).get("rotate");
    const saved = sessionStore.save.mock.calls[0]?.[0];
    expect(saved).toBeDefined();
    expect(inspect(saved, { showHidden: true })).not.toContain(rotated);
    expect(JSON.stringify(saved)).toContain(rotated);
    expect(structuredClone(saved)).toEqual(JSON.parse(JSON.stringify(saved)));
  });

  it("ignores unusable irrelevant cookies without failing a completed operation", async () => {
    const sessionStore = store();
    const response = reply('{"completed":true}', "=broken; Path=/");
    response.headers.append(
      "Set-Cookie",
      `Flocknote=${rotated}; Domain=flocknote.com; Path=/; Secure`,
    );
    expect(
      await client(sessionStore, async () => response).post(
        "example/write",
        {},
      ),
    ).toEqual({ completed: true });
    expect(sessionStore.save).toHaveBeenCalledTimes(1);
    expect((await sessionStore.load())?.cookies[0]).toContain(rotated);
  });

  it("rejects an invalid auth-cookie batch without partially changing memory or storage", async () => {
    const sessionStore = store();
    const response = reply(
      "{}",
      `Flocknote=${rotated}; Domain=flocknote.com; Path=/; Secure`,
    );
    response.headers.append(
      "Set-Cookie",
      "Flocknote-Login-123=fictional; Domain=evil.test; Path=/; Secure",
    );
    const transport = vi.fn<Transport>(async () => reply());
    transport.mockResolvedValueOnce(response);
    const connection = client(sessionStore, transport);
    await expect(connection.get("bad-batch")).rejects.toMatchObject({
      code: "invalid_response",
    });
    await connection.get("next");
    expect(transport.mock.calls[1]?.[0].headers.Cookie).toBe(
      `Flocknote=${initial}`,
    );
    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it("applies path restrictions and does not persist unrelated cookies", async () => {
    const sessionStore = store({
      version: 1,
      origin,
      cookies: [`Flocknote=${initial}; Path=/user; Secure`],
    });
    const transport = vi.fn<Transport>(async () => {
      const response = reply("{}");
      response.headers.append(
        "Set-Cookie",
        `Flocknote=${rotated}; Path=/private; Secure`,
      );
      response.headers.append(
        "Set-Cookie",
        "analytics=fictional; Domain=.flocknote.com; Path=/",
      );
      return response;
    });
    const connection = client(sessionStore, transport);
    await connection.get("private/first");
    await connection.get("public");
    await connection.get("private/second");
    expect(transport.mock.calls[1]?.[0].headers.Cookie).toBeUndefined();
    expect(transport.mock.calls[2]?.[0].headers.Cookie).toBe(
      `Flocknote=${rotated}`,
    );
    expect((await sessionStore.load())?.cookies).not.toEqual(
      expect.arrayContaining([expect.stringContaining("analytics")]),
    );
  });

  it("clears adapter state and cached cookies", async () => {
    const sessionStore = store();
    const transport = vi.fn<Transport>(async () => reply());
    const connection = client(sessionStore, transport);
    await connection.get("first");
    await connection.clearSession();
    await expect(connection.get("second")).rejects.toMatchObject({
      code: "credentials_unavailable",
    });
    expect(sessionStore.clear).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("encodes form fields and supports successful HTML responses", async () => {
    const transport = vi.fn<Transport>(async () => ({
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      body: "<p>Example</p>",
    }));
    const connection = client(store(), transport);
    expect(
      await connection.post("/example/action", {
        name: "Fictional Person",
        extra: "a&b",
      }),
    ).toBe("<p>Example</p>");
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      url: `${origin}/example/action`,
      method: "POST",
      redirect: "manual",
      body: "name=Fictional+Person&extra=a%26b",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  });
});

describe("request and cookie boundaries", () => {
  it.each([
    "",
    "example.parish",
    "x@evil.test",
    "x/evil",
    "-parish",
    "parish-",
    "x:443",
    "x".repeat(64),
  ])("rejects invalid subdomain %s", (subdomain) => {
    expect(
      () =>
        new FlockbotClient({
          coordinator,
          policy: { maxReadRetries: 0 },
          subdomain,
          sessionStore: store(),
        }),
    ).toThrow(expect.objectContaining({ code: "invalid_configuration" }));
  });

  it.each([
    "https://evil.test/path",
    "//evil.test/path",
    "../other",
    "a/../b",
    "a\\b",
    "a?secret=x",
    "a#fragment",
    "a/%2f/b",
    "a\nvalue",
  ])(
    "rejects unsafe endpoint %s before transport or state access",
    async (path) => {
      const transport = vi.fn<Transport>();
      const sessionStore = store();
      await expect(
        client(sessionStore, transport).get(path),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(
        client(sessionStore, transport).post(path, {}),
      ).rejects.toMatchObject({
        code: "invalid_path",
        outcome: "not_submitted",
      });
      expect(transport).not.toHaveBeenCalled();
      expect(sessionStore.load).not.toHaveBeenCalled();
    },
  );

  it("rejects a foreign session origin before making a request", async () => {
    const sessionStore = store(sessionFromToken("other-parish", initial));
    const transport = vi.fn<Transport>();
    await expect(
      client(sessionStore, transport).get("dashboard"),
    ).rejects.toMatchObject({ code: "invalid_session_state" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["evil.test", "other-parish.flocknote.com", "com"])(
    "rejects foreign saved cookie domain %s",
    async (domain) => {
      const state = {
        version: 1 as const,
        origin,
        cookies: [`Flocknote=${initial}; Domain=${domain}; Path=/; Secure`],
      };
      const transport = vi.fn<Transport>();
      await expect(
        client(store(state), transport).get("dashboard"),
      ).rejects.toMatchObject({ code: "invalid_session_state" });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("rejects a foreign response cookie without persisting it", async () => {
    const sessionStore = store();
    await expect(
      client(sessionStore, async () =>
        reply("{}", `Flocknote=${rotated}; Domain=evil.test; Secure`),
      ).get("dashboard"),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it("rejects redirects without following or leaking credentials", async () => {
    const transport = vi.fn<Transport>(async () => ({
      status: 302,
      headers: new Headers({ Location: "https://evil.test/" }),
      body: "",
    }));
    await expect(
      client(store(), transport).get("dashboard"),
    ).rejects.toMatchObject({ code: "redirect_rejected" });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[0].redirect).toBe("manual");
  });

  it.each(["", "value; injected=yes", 'quoted"value', "line\nvalue"])(
    "rejects an invalid supplied token",
    (token) => {
      expect(() => sessionFromToken("example-parish", token)).toThrow(
        FlockbotError,
      );
    },
  );
});

describe("sanitized failures", () => {
  const sensitive = "fictional-password fictional-cookie user@example.test";
  it.each(["load", "save", "clear"] as const)(
    "reports %s failure without the adapter's sensitive error",
    async (operation) => {
      const sessionStore = store();
      sessionStore[operation].mockRejectedValue(new Error(sensitive));
      const connection = client(sessionStore, async () =>
        reply(
          "{}",
          `Flocknote=${rotated}; Domain=flocknote.com; Path=/; Secure`,
        ),
      );
      const result =
        operation === "clear"
          ? connection.clearSession()
          : connection.get("dashboard");
      await expect(result).rejects.toMatchObject({
        code: `session_${operation}_failed`,
      });
      await result.catch((error: unknown) => {
        expect(inspect(error)).not.toContain(sensitive);
      });
    },
  );

  it("does not expose injected transport errors or client state through inspection/JSON", async () => {
    const connection = client(store(), async () => {
      throw new Error(sensitive);
    });
    const error = await connection
      .get("dashboard")
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "transport_failed" });
    for (const representation of [
      inspect(connection, { showHidden: true }),
      JSON.stringify(connection),
      inspect(error),
    ]) {
      expect(representation).not.toContain(initial);
      expect(representation).not.toContain(sensitive);
    }
  });

  it.each([
    { status: 503, body: sensitive, code: "upstream_rejected" },
    {
      status: 200,
      body: `invalid JSON ${sensitive}`,
      code: "invalid_response",
    },
    { status: 0, body: sensitive, code: "invalid_response" },
  ])(
    "reports malformed/upstream responses without raw bodies",
    async ({ status, body, code }) => {
      const error = await client(store(), async () => ({
        ...reply(body),
        status,
      }))
        .get("dashboard")
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code });
      expect(inspect(error)).not.toContain(sensitive);
    },
  );
});

describe("offline default transport", () => {
  it("captures cookies but never follows a redirect through the default fetch bridge", async () => {
    const network = getGlobalDispatcher() as MockAgent;
    let followed = false;
    network
      .get(origin)
      .intercept({ path: "/redirect" })
      .reply(302, "", {
        headers: {
          location: "https://redirect-target.invalid/target",
          "set-cookie": `Flocknote=${rotated}; Domain=flocknote.com; Path=/; Secure`,
        },
      });
    network
      .get("https://redirect-target.invalid")
      .intercept({ path: "/target" })
      .reply(
        200,
        () => {
          followed = true;
          return "{}";
        },
        { headers: { "content-type": "application/json" } },
      );
    const sessionStore = store();
    const connection = new FlockbotClient({
      coordinator,
      policy: { maxReadRetries: 0 },
      subdomain: "example-parish",
      sessionStore,
    });
    await expect(connection.get("redirect")).rejects.toMatchObject({
      code: "redirect_rejected",
    });
    expect(followed).toBe(false);
    expect((await sessionStore.load())?.cookies[0]).toContain(rotated);
    const transport = vi.fn<Transport>(async () => reply());
    await client(sessionStore, transport).get("next");
    expect(transport.mock.calls[0]?.[0].headers.Cookie).toBe(
      `Flocknote=${rotated}`,
    );
  });

  it("uses the real fetch bridge with cookie headers and separate Set-Cookie values", async () => {
    const network = getGlobalDispatcher() as MockAgent;
    network
      .get(origin)
      .intercept({
        path: "/dashboard",
        headers: { cookie: `Flocknote=${initial}` },
      })
      .reply(
        200,
        { ok: true },
        {
          headers: {
            "content-type": "application/json",
            "set-cookie": [
              `Flocknote=${rotated}; Domain=flocknote.com; Path=/; Secure`,
              "Flocknote-Login-123=fictional-factor; Path=/; Secure",
            ],
          },
        },
      );
    const sessionStore = store();
    const connection = new FlockbotClient({
      coordinator,
      policy: { maxReadRetries: 0 },
      subdomain: "example-parish",
      sessionStore,
    });
    expect(await connection.get("dashboard")).toEqual({ ok: true });
    expect((await sessionStore.load())?.cookies).toHaveLength(2);
  });

  it("blocks unexpected fetch and HTTP requests without recording fixtures", async () => {
    await expect(fetch("https://unexpected.invalid/")).rejects.toMatchObject({
      cause: { code: "UND_MOCK_ERR_MOCK_NOT_MATCHED" },
    });
    expect(() => http.get("https://unexpected.invalid/")).toThrow(
      "Unexpected network request",
    );
    await expect(
      new FlockbotClient({
        coordinator,
        policy: { maxReadRetries: 0 },
        subdomain: "example-parish",
        sessionStore: store(),
      }).get("unrecorded"),
    ).rejects.toMatchObject({ code: "transport_failed" });
  });

  it.each([
    () => namedHttpGet("http://unexpected.invalid/"),
    () => namedHttpsRequest("https://unexpected.invalid/"),
    () => net.connect({ host: "unexpected.invalid", port: 443 }),
    () => namedNetConnect({ host: "unexpected.invalid", port: 443 }),
    () => net.createConnection({ host: "unexpected.invalid", port: 443 }),
    () => new net.Socket().connect({ host: "unexpected.invalid", port: 443 }),
    () => tls.connect({ host: "unexpected.invalid", port: 443 }),
    () => http2.connect("https://unexpected.invalid"),
  ])(
    "blocks Node connection entry points and named builtin exports",
    (connect) => {
      expect(connect).toThrow("Unexpected network request in an offline test.");
    },
  );
});
