import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  type CredentialProvider,
  type Credentials,
  FlockbotClient,
  sessionFromToken,
  type SessionState,
  type SessionStore,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "../src/index.js";

const subdomain = "example-parish";
const origin = `https://${subdomain}.flocknote.com`;
const firstFactor = {
  success: true,
  allowPasswordForFirstFactor: true,
  firstFactorSuccess: false,
};
const passwordAccepted = { success: true, loginSuccess: true };
const authenticated = { success: true, userID: 101 };
const credentials = {
  email: "fictional-login@example.test",
  password: "fictional-password",
};

function response(data: unknown, cookie?: string): TransportResponse {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.append("set-cookie", cookie);
  return { status: 200, headers, body: JSON.stringify(data) };
}

function store(initial: SessionState | null = null) {
  let state = structuredClone(initial);
  return {
    load: vi.fn(async () => structuredClone(state)),
    save: vi.fn(async (next: SessionState) => {
      state = structuredClone(next);
    }),
    clear: vi.fn(async () => {
      state = null;
    }),
  } satisfies SessionStore;
}

function exchange() {
  return [
    response(
      firstFactor,
      "Flocknote=fictional-session; Domain=flocknote.com; Path=/; Secure; HttpOnly; SameSite=Lax",
    ),
    response(passwordAccepted),
    response(
      authenticated,
      "Flocknote-Login-101=fictional-factor; Domain=.flocknote.com; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Max-Age=3600; Secure; HttpOnly; SameSite=Lax",
    ),
  ];
}

function setup(
  responses = exchange(),
  initial: SessionState | null = null,
  provider: CredentialProvider = { load: vi.fn(async () => credentials) },
) {
  const sessionStore = store(initial);
  const requests: TransportRequest[] = [];
  const transport = vi.fn<Transport>(async (request) => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("Unexpected synthetic request.");
    return next;
  });
  const client = new FlockbotClient({
    subdomain,
    sessionStore,
    transport,
    credentialProvider: provider,
  });
  return { client, sessionStore, requests, provider, transport };
}

describe("password authentication", () => {
  it("exchanges cookies, verifies authentication, then persists once", async () => {
    const responses = exchange();
    const { client, sessionStore, requests, provider, transport } =
      setup(responses);
    transport.mockImplementation(async (request) => {
      expect(sessionStore.save).not.toHaveBeenCalled();
      requests.push(request);
      const next = responses.shift();
      if (!next) throw new Error("Unexpected synthetic request.");
      return next;
    });
    await expect(client.connect()).resolves.toBeUndefined();
    expect(provider.load).toHaveBeenCalledOnce();
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", `${origin}/login/twoFactorAuth`],
      ["POST", `${origin}/login/twoFactorAuth`],
      ["GET", `${origin}/user/userData`],
    ]);
    expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toEqual({
      firstFactor: credentials.email,
      initialLoad: "false",
      requestAuthCode: "false",
    });
    expect(Object.fromEntries(new URLSearchParams(requests[1]?.body))).toEqual({
      firstFactor: credentials.email,
      initialLoad: "false",
      password: credentials.password,
    });
    expect(requests[0]?.headers.Cookie).toBeUndefined();
    expect(requests[1]?.headers.Cookie).toBe("Flocknote=fictional-session");
    expect(requests[2]?.headers.Cookie).toBe("Flocknote=fictional-session");
    expect(sessionStore.save).toHaveBeenCalledOnce();
    const saved = await sessionStore.load();
    expect(saved?.cookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Flocknote=fictional-session"),
        expect.stringContaining("Flocknote-Login-101=fictional-factor"),
      ]),
    );
    const factor = saved?.cookies.find((cookie) =>
      cookie.startsWith("Flocknote-Login-101="),
    );
    expect(factor).toContain("Domain=flocknote.com");
    expect(factor).toContain("Expires=");
    expect(factor).toContain("SameSite=Lax");
    expect(factor).not.toContain("Max-Age");
    expect(JSON.stringify(saved)).not.toContain(credentials.password);
    expect(JSON.stringify(saved)).not.toContain(credentials.email);
    const reloadedTransport = vi.fn<Transport>(async () =>
      response(authenticated),
    );
    await new FlockbotClient({
      subdomain,
      sessionStore,
      transport: reloadedTransport,
    }).connect();
    expect(reloadedTransport.mock.calls[0]?.[0].headers.Cookie).toContain(
      "Flocknote=fictional-session",
    );
    expect(reloadedTransport.mock.calls[0]?.[0].headers.Cookie).toContain(
      "Flocknote-Login-101=fictional-factor",
    );
  });

  it("persists a session cookie rotated during verification", async () => {
    const responses = exchange();
    responses[2]?.headers.append(
      "Set-Cookie",
      "Flocknote=fictional-rotated-session; Domain=flocknote.com; Path=/; Secure",
    );
    const { client, sessionStore, requests } = setup(responses);
    await client.connect();
    expect(sessionStore.save).toHaveBeenCalledOnce();
    const saved = await sessionStore.load();
    expect(JSON.stringify(saved)).toContain(
      "Flocknote=fictional-rotated-session",
    );
    expect(JSON.stringify(saved)).not.toContain("Flocknote=fictional-session");
    responses.push(response({ ok: true }));
    await client.get("dashboard");
    expect(requests[3]?.headers.Cookie).toContain(
      "Flocknote=fictional-rotated-session",
    );
  });

  it("verifies a supplied session without reading credentials or logging in", async () => {
    const { client, provider, requests, sessionStore } = setup(
      [response(authenticated)],
      sessionFromToken(subdomain, "fictional-saved"),
      {
        load: vi.fn(async () => {
          throw new Error("must not load");
        }),
      },
    );
    await expect(client.connect()).resolves.toBeUndefined();
    expect(provider.load).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it("starts a fresh password exchange only when explicitly requested", async () => {
    const { client, requests, provider } = setup(
      exchange(),
      sessionFromToken(subdomain, "fictional-old"),
    );
    await client.connect({ forcePasswordLogin: true });
    expect(provider.load).toHaveBeenCalledOnce();
    expect(requests[0]?.headers.Cookie).toBeUndefined();
  });

  it("does not automatically replace a rejected saved session", async () => {
    const previous = sessionFromToken(subdomain, "fictional-expired");
    const responses = [
      response(
        { success: true, userID: null, authorized: false },
        "Flocknote=fictional-rejected; Domain=flocknote.com; Path=/; Secure",
      ),
    ];
    const { client, provider, requests, sessionStore } = setup(
      responses,
      previous,
    );
    await expect(client.connect()).rejects.toMatchObject({
      code: "authentication_required",
    });
    expect(provider.load).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(sessionStore.save).not.toHaveBeenCalled();
    expect(await sessionStore.load()).toEqual(previous);
    responses.push(response({ ok: true }));
    await client.get("dashboard");
    expect(requests[1]?.headers.Cookie).toBe("Flocknote=fictional-expired");
  });

  it("persists successful saved-session rotation after verification", async () => {
    const responses = [
      response(
        authenticated,
        "Flocknote=fictional-verified-rotation; Domain=flocknote.com; Path=/; Secure",
      ),
    ];
    const { client, provider, sessionStore, requests } = setup(
      responses,
      sessionFromToken(subdomain, "fictional-saved"),
    );
    await client.connect();
    expect(provider.load).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(sessionStore.save).toHaveBeenCalledOnce();
    const reloadedTransport = vi.fn<Transport>(async () =>
      response(authenticated),
    );
    await new FlockbotClient({
      subdomain,
      sessionStore,
      transport: reloadedTransport,
    }).connect();
    expect(reloadedTransport.mock.calls[0]?.[0].headers.Cookie).toBe(
      "Flocknote=fictional-verified-rotation",
    );
    expect(sessionStore.save).toHaveBeenCalledOnce();
  });

  it("retains verified saved-session rotation when persistence fails", async () => {
    const previous = sessionFromToken(subdomain, "fictional-saved");
    const responses = [
      response(
        authenticated,
        "Flocknote=fictional-verified-rotation; Domain=flocknote.com; Path=/; Secure",
      ),
    ];
    const { client, provider, sessionStore, requests } = setup(
      responses,
      previous,
    );
    sessionStore.save.mockRejectedValueOnce(new Error("fictional outage"));
    await expect(client.connect()).rejects.toMatchObject({
      code: "session_save_failed",
    });
    expect(await sessionStore.load()).toEqual(previous);
    responses.push(response(authenticated));
    await client.connect();
    expect(provider.load).not.toHaveBeenCalled();
    expect(sessionStore.save).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.Cookie).toBe(
      "Flocknote=fictional-verified-rotation",
    );
    expect(JSON.stringify(await sessionStore.load())).toContain(
      "Flocknote=fictional-verified-rotation",
    );
  });

  it.each([
    {
      status: 503,
      body: JSON.stringify({ success: false }),
      code: "authentication_unavailable",
    },
    {
      status: 200,
      body: "invalid fictional JSON",
      code: "authentication_protocol_error",
    },
  ])(
    "discards cookies from failed saved-session checks: $code",
    async ({ status, body, code }) => {
      const previous = sessionFromToken(subdomain, "fictional-saved");
      const responses = [
        {
          ...response(
            {},
            "Flocknote=fictional-unverified; Domain=flocknote.com; Path=/; Secure",
          ),
          status,
          body,
        },
      ];
      const { client, sessionStore, provider, requests } = setup(
        responses,
        previous,
      );
      await expect(client.connect()).rejects.toMatchObject({ code });
      expect(sessionStore.save).not.toHaveBeenCalled();
      expect(await sessionStore.load()).toEqual(previous);
      expect(provider.load).not.toHaveBeenCalled();
      responses.push(response({ ok: true }));
      await client.get("dashboard");
      expect(requests[1]?.headers.Cookie).toBe("Flocknote=fictional-saved");
    },
  );

  it("does not overwrite newer stored state when a cached session is rejected", async () => {
    const responses = [response({ ok: true })];
    const { client, sessionStore, provider } = setup(
      responses,
      sessionFromToken(subdomain, "fictional-stale"),
    );
    await client.get("dashboard");
    const newer = sessionFromToken(subdomain, "fictional-newer");
    await sessionStore.save(newer);
    responses.push(
      response(
        { success: true, userID: null, authorized: false },
        "Flocknote=fictional-rejected; Domain=flocknote.com; Path=/; Secure",
      ),
    );
    await expect(client.connect()).rejects.toMatchObject({
      code: "authentication_required",
    });
    expect(await sessionStore.load()).toEqual(newer);
    expect(sessionStore.save).toHaveBeenCalledOnce();
    expect(provider.load).not.toHaveBeenCalled();
  });

  it("requires credentials before making any authentication request", async () => {
    const transport = vi.fn<Transport>();
    const client = new FlockbotClient({
      subdomain,
      sessionStore: store(),
      transport,
    });
    await expect(client.connect()).rejects.toMatchObject({
      code: "credentials_unavailable",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { email: "", password: "fictional" },
    { email: "  ", password: "fictional" },
    { email: "fictional@example.test", password: "" },
    null,
  ])("rejects missing provider values without a request", async (value) => {
    const { client, transport } = setup(exchange(), null, {
      load: vi.fn(async () => value as Credentials),
    });
    await expect(client.connect()).rejects.toMatchObject({
      code: "credentials_unavailable",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("recognizes the captured password-rejection response without storing its message", async () => {
    const responses = exchange();
    responses[1] = response({
      ...firstFactor,
      message:
        "Sorry, that password doesn't match our records. Try again OR enter the code we emailed to fictional-login@example.test.",
    });
    const { client, sessionStore, requests } = setup(responses);
    const error: unknown = await client
      .connect()
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "credentials_rejected" });
    expect(inspect(error)).not.toContain(credentials.email);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.Cookie).toBe("Flocknote=fictional-session");
    expect(await sessionStore.load()).toBeNull();
    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    "requires intervention when password login is unavailable at stage %s",
    async (stage) => {
      const responses = exchange();
      responses[stage] = response({
        ...firstFactor,
        allowPasswordForFirstFactor: false,
      });
      const { client, sessionStore, requests } = setup(responses);
      await expect(client.connect()).rejects.toMatchObject({
        code: "action_required",
      });
      expect(requests).toHaveLength(stage + 1);
      expect(sessionStore.save).not.toHaveBeenCalled();
      for (const request of requests) {
        const fields = new URLSearchParams(request.body);
        expect(fields.has("firstCode")).toBe(false);
        expect(fields.get("requestAuthCode")).not.toBe("true");
      }
    },
  );

  it("does not classify an unknown rejection as a wrong password", async () => {
    const responses = exchange();
    responses[1] = response({
      ...firstFactor,
      message: "A different fictional failure.",
    });
    const { client } = setup(responses);
    await expect(client.connect()).rejects.toMatchObject({
      code: "authentication_protocol_error",
    });
  });

  it.each([
    { stage: 0, data: { success: false } },
    { stage: 0, data: [] },
    { stage: 0, data: { success: true } },
    { stage: 1, data: { success: true } },
    { stage: 2, data: { success: true } },
    { stage: 2, data: { success: true, userID: "unexpected" } },
  ])(
    "rejects unexpected authentication data at stage $stage",
    async ({ stage, data }) => {
      const responses = exchange();
      responses[stage] = response(data);
      const { client, sessionStore } = setup(responses);
      await expect(client.connect()).rejects.toMatchObject({
        code: "authentication_protocol_error",
      });
      expect(sessionStore.save).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JSON during login without publishing partial cookies", async () => {
    const responses = exchange();
    responses[1] = {
      ...response(
        firstFactor,
        "Flocknote=fictional-unverified; Path=/; Secure",
      ),
      body: "not JSON fictional-sensitive-message",
    };
    const { client, sessionStore } = setup(responses);
    await expect(client.connect()).rejects.toMatchObject({
      code: "authentication_protocol_error",
    });
    expect(await sessionStore.load()).toBeNull();
    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it("preserves a prior session when explicit setup cannot verify the new login", async () => {
    const previous = sessionFromToken(subdomain, "fictional-previous");
    const responses = exchange();
    responses[2] = response({
      success: true,
      userID: false,
      authorized: false,
    });
    const { client, sessionStore, requests } = setup(responses, previous);
    await expect(
      client.connect({ forcePasswordLogin: true }),
    ).rejects.toMatchObject({ code: "authentication_required" });
    expect(sessionStore.save).not.toHaveBeenCalled();
    expect(await sessionStore.load()).toEqual(previous);
    responses.push(response({ ok: true }));
    await client.get("dashboard");
    expect(requests[3]?.headers.Cookie).toBe("Flocknote=fictional-previous");
  });

  it("requires an authentication cookie even when synthetic success flags are present", async () => {
    const { client, sessionStore } = setup([
      response(firstFactor),
      response(passwordAccepted),
      response(authenticated),
    ]);
    await expect(client.connect()).rejects.toMatchObject({
      code: "authentication_protocol_error",
    });
    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])(
    "reports temporary HTTP %s without blaming credentials",
    async (status) => {
      const responses = exchange();
      responses[0] = {
        ...response({ message: "fictional-sensitive-message" }),
        status,
      };
      const { client, sessionStore } = setup(responses);
      await expect(client.connect()).rejects.toMatchObject({
        code: "authentication_unavailable",
      });
      expect(sessionStore.save).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])(
    "does not label HTTP %s as a rejected password",
    async (status) => {
      const responses = exchange();
      responses[1] = { ...response({}), status };
      const { client } = setup(responses);
      await expect(client.connect()).rejects.toMatchObject({
        code: "authentication_protocol_error",
      });
    },
  );

  it("does not report a durable connection when saving the verified session fails", async () => {
    const responses = exchange();
    const { client, sessionStore, requests, provider } = setup(responses);
    sessionStore.save.mockRejectedValueOnce(
      new Error("fictional store failure"),
    );
    await expect(client.connect()).rejects.toMatchObject({
      code: "session_save_failed",
    });
    expect(await sessionStore.load()).toBeNull();
    expect(requests).toHaveLength(3);
    responses.push(response(authenticated));
    await client.connect();
    expect(sessionStore.save).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(4);
    expect(requests[3]?.headers.Cookie).toContain(
      "Flocknote=fictional-session",
    );
    expect(provider.load).toHaveBeenCalledOnce();
  });

  it.each(["provider", "transport"])(
    "redacts a sensitive %s exception",
    async (source) => {
      const secret =
        "fictional-password fictional-cookie fictional-login@example.test";
      const provider = { load: vi.fn(async () => credentials) };
      const { client, transport } = setup(exchange(), null, provider);
      if (source === "provider")
        provider.load.mockRejectedValue(new Error(secret));
      else transport.mockRejectedValue(new Error(secret));
      const error: unknown = await client
        .connect()
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code:
          source === "provider"
            ? "credentials_unavailable"
            : "authentication_unavailable",
      });
      for (const text of [
        inspect(client, { showHidden: true }),
        JSON.stringify(client),
        inspect(error),
      ]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(credentials.password);
        expect(text).not.toContain(credentials.email);
      }
    },
  );
});
