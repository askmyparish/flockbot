import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { FlockbotError } from "../../src/index.js";
import { ParishConnection } from "../../adapters/mcp/src/connection.js";
import {
  AuthenticationSuspectedError,
  ConnectionError,
} from "../../adapters/mcp/src/session.js";
import {
  httpSessionFactory,
  sessionFile,
  type SessionBlob,
} from "../../adapters/mcp/src/http-session.js";
import { MCP_VERSION } from "../../adapters/mcp/src/version.js";
import { SerialCoordinator } from "../../adapters/mcp/src/serial-coordinator.js";
import {
  signInHandler,
  type SignInPageOptions,
} from "../../adapters/mcp/src/sign-in-page.js";
import { waitFor } from "./support.js";

const origin = "https://example-parish.flocknote.com";
const authority = "127.0.0.1:49200";
const credentials = {
  email: "fictional-login@example.test",
  password: "fictional-password",
};
const firstFactor = {
  success: true,
  allowPasswordForFirstFactor: true,
  firstFactorSuccess: false,
};
const sessionCookie =
  "Flocknote=fictional-session; Domain=flocknote.com; Path=/; Secure; HttpOnly";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly cookie: string | null;
  readonly origin: string | null;
  readonly contentType: string | null;
  readonly userAgent: string | null;
  readonly body: unknown;
}

function json(data: unknown, cookies: readonly string[] = [], status = 200) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

const directories: string[] = [];
const connections: ParishConnection[] = [];
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A fictional Flocknote plus the sign-in page, joined without sockets. */
function fixture(storage?: (profile: string) => SessionBlob) {
  const profile = mkdtempSync(join(tmpdir(), "flockbot-http-unit-"));
  directories.push(profile);
  const calls: Call[] = [];
  const routes: Record<string, (call: Call) => Response> = {
    "POST login/twoFactorAuth": (call) => {
      const fields = new URLSearchParams(String(call.body));
      if (!fields.has("password")) return json(firstFactor);
      return fields.get("password") === credentials.password
        ? json({ success: true, loginSuccess: true }, [sessionCookie])
        : json({
            ...firstFactor,
            message:
              "Sorry, that password doesn't match our records. Try again OR enter the code we emailed to fictional-login@example.test.",
          });
    },
    "GET user/userData": (call) =>
      call.cookie?.startsWith("Flocknote=")
        ? json({ success: true, userID: 201 })
        : json({ success: true, authorized: false, userID: null }),
    "GET group/101/getSubscriberCount": () => json({ subscriberCount: "7" }),
  };
  const send = (async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== origin) throw new Error("Unexpected fictional origin");
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: `${url.pathname.slice(1)}${url.search}`,
      cookie: headers.get("cookie"),
      origin: headers.get("origin"),
      contentType: headers.get("content-type"),
      userAgent: headers.get("user-agent"),
      body: init?.body ?? undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) throw new Error("Missing fictional fixture");
    return route(call);
  }) as typeof fetch;
  const pages: { options: SignInPageOptions; open: boolean }[] = [];
  const opened: string[] = [];
  let openFails = false;
  const factory = httpSessionFactory({
    fetch: send,
    ...(storage ? { storage } : {}),
    open: async (url) => {
      if (openFails) throw new Error("No fictional desktop");
      opened.push(url);
    },
    serve: async (options) => {
      const page = { options, open: true };
      pages.push(page);
      return {
        url: `http://${authority}/fictional-key-${pages.length}`,
        close: async () => {
          page.open = false;
        },
      };
    },
  });
  /** Submit the latest sign-in page the way its own form would. */
  const submit = (fields: Record<string, string> = credentials) => {
    const page = pages.at(-1);
    if (!page?.open) throw new Error("No fictional sign-in page is open");
    return signInHandler({
      ...page.options,
      authority,
      key: `fictional-key-${pages.length}`,
    })({
      method: "POST",
      path: `/fictional-key-${pages.length}`,
      host: authority,
      origin: `http://${authority}`,
      fetchSite: "same-origin",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams(fields).toString(),
    });
  };
  const connect = () => {
    const connection = new ParishConnection({
      profile,
      factory,
      pollMs: 5,
      setupMs: 5000,
      coordinator: new SerialCoordinator(),
    });
    connections.push(connection);
    return connection;
  };
  /** A session that already signed in through the page. */
  const signedIn = async () => {
    const session = await factory({ profile, origin, interactive: true });
    await session.signIn();
    expect((await submit()).body).toContain("You're signed in");
    await session.finishSignIn?.();
    calls.length = 0;
    return session;
  };
  return {
    profile,
    calls,
    routes,
    pages,
    opened,
    factory,
    submit,
    connect,
    signedIn,
    failOpen: () => {
      openFails = true;
    },
  };
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

describe("plain-HTTP local connection", () => {
  it("signs in on the local page and works from the saved cookie alone", async () => {
    const f = fixture();
    const connection = f.connect();
    expect(await connection.connect("example-parish")).toEqual({
      state: "pending",
      parish: "example-parish",
    });
    expect(f.opened).toEqual([`http://${authority}/fictional-key-1`]);
    expect(f.pages[0]?.options.parish).toBe("example-parish");
    // Waiting for the person sends nothing to Flocknote.
    await delay(40);
    expect(f.calls).toEqual([]);

    expect((await f.submit()).body).toContain("You're signed in");
    await waitFor(async () =>
      expect(await connection.status()).toEqual({
        state: "ready",
        parish: "example-parish",
      }),
    );
    expect(f.pages[0]?.open).toBe(false);
    expect(await connection.count("101")).toBe(7);

    expect(f.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST login/twoFactorAuth",
      "POST login/twoFactorAuth",
      "GET user/userData",
      "GET user/userData",
      "GET group/101/getSubscriberCount",
    ]);
    expect(f.calls.map((call) => call.cookie)).toEqual([
      null,
      null,
      "Flocknote=fictional-session",
      "Flocknote=fictional-session",
      "Flocknote=fictional-session",
    ]);
    expect(
      f.calls.filter((call) =>
        String(call.body).includes("fictional-password"),
      ),
    ).toHaveLength(1);
    // Sign-in, verification and tool requests all identify the connector.
    expect(f.calls.map((call) => call.userAgent)).toEqual(
      f.calls.map(
        () =>
          `AskMyParish-Flockbot/${MCP_VERSION} (+https://github.com/askmyparish/flockbot)`,
      ),
    );

    const saved = files(f.profile);
    const session = saved.find((file) => file.endsWith("session.json"));
    expect(session).toBeDefined();
    expect(statSync(session ?? "").mode & 0o777).toBe(0o600);
    expect(readFileSync(session ?? "", "utf8")).toContain("fictional-session");
    for (const file of saved) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain(credentials.password);
      expect(text).not.toContain(credentials.email);
    }

    // A later process for the same OS user needs no sign-in.
    const restarted = f.connect();
    expect(await restarted.count("101")).toBe(7);
    expect(f.pages).toHaveLength(1);
  });

  it("lets a person correct a rejected password on the same page", async () => {
    const f = fixture();
    const connection = f.connect();
    await connection.connect("example-parish");
    const rejected = await f.submit({
      ...credentials,
      password: "fictional-mistake",
    });
    expect(rejected.body).toContain("did not accept that email and password");
    expect(rejected.body).not.toContain("fictional-mistake");
    await delay(40);
    expect(await connection.status()).toMatchObject({ state: "pending" });

    expect((await f.submit()).body).toContain("You're signed in");
    await waitFor(async () =>
      expect(await connection.status()).toMatchObject({ state: "ready" }),
    );
  });

  it("withholds the password when Flocknote does not offer password sign-in", async () => {
    const f = fixture();
    f.routes["POST login/twoFactorAuth"] = () =>
      json({ ...firstFactor, allowPasswordForFirstFactor: false });
    const session = await f.factory({
      profile: f.profile,
      origin,
      interactive: true,
    });
    await session.signIn();
    expect((await f.submit()).body).toContain("did not offer password sign-in");
    expect(f.calls).toHaveLength(1);
    expect(String(f.calls[0]?.body)).not.toContain(credentials.password);
    await session.close();
  });

  it("reports an unreachable Flocknote on the page without a stack or address", async () => {
    const f = fixture();
    f.routes["POST login/twoFactorAuth"] = () => {
      throw new Error("getaddrinfo ENOTFOUND example-parish.flocknote.com");
    };
    const session = await f.factory({
      profile: f.profile,
      origin,
      interactive: true,
    });
    await session.signIn();
    const response = await f.submit();
    expect(response.body).toContain("Flocknote could not be reached");
    expect(response.body).not.toContain("ENOTFOUND");
    await session.close();
  });

  it("reports a desktop that cannot open the page and closes the listener", async () => {
    const f = fixture();
    f.failOpen();
    const session = await f.factory({
      profile: f.profile,
      origin,
      interactive: true,
    });
    const error: unknown = await session.signIn().catch((error) => error);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({
      code: "browser_unavailable",
      stage: "sign_in",
    });
    expect(f.pages[0]?.open).toBe(false);
  });

  it("sends nothing without a saved session or outside the internal endpoints", async () => {
    const f = fixture();
    const fresh = await f.factory({
      profile: f.profile,
      origin,
      interactive: false,
    });
    await expect(fresh.request("user/userData")).rejects.toMatchObject({
      code: "authentication_required",
    });
    const session = await f.signedIn();
    for (const [path, method, body] of [
      ["login/twoFactorAuth", "POST", "firstFactor=fictional"],
      ["user/userData", "POST", ""],
      ["group/101/../../login", "GET", undefined],
      ["upload/photo/note", "POST", "fictional"],
    ] as const)
      await expect(session.request(path, method, body)).rejects.toMatchObject({
        code: "invalid_path",
      });
    expect(f.calls).toEqual([]);
  });

  it("classifies possible expiry separately from other rejections", async () => {
    const f = fixture();
    const session = await f.signedIn();
    f.routes["GET dashboard"] = () =>
      new Response(null, { status: 302, headers: { location: "/login" } });
    const redirected: unknown = await session
      .request("dashboard")
      .catch((error) => error);
    expect(redirected).toBeInstanceOf(AuthenticationSuspectedError);
    expect(redirected).toMatchObject({ code: "redirect_rejected" });

    f.routes["GET dashboard"] = () => json({}, [], 403);
    const denied: unknown = await session
      .request("dashboard")
      .catch((error) => error);
    expect(denied).toBeInstanceOf(AuthenticationSuspectedError);
    expect(denied).toMatchObject({ code: "permission_denied", status: 403 });

    f.routes["GET dashboard"] = () => json({}, [], 500);
    const failed: unknown = await session
      .request("dashboard")
      .catch((error) => error);
    expect(failed).toBeInstanceOf(FlockbotError);
    expect(failed).not.toBeInstanceOf(AuthenticationSuspectedError);
    expect(failed).toMatchObject({ code: "upstream_rejected", status: 500 });
  });

  it("keeps a rotated session cookie and no other cookie", async () => {
    const f = fixture();
    const session = await f.signedIn();
    f.routes["GET navigation/groups"] = () =>
      json({ groups: [] }, [
        "Flocknote=fictional-rotated; Domain=flocknote.com; Path=/; Secure; HttpOnly",
        "fictional_tracker=1; Path=/",
        "Flocknote=fictional-foreign; Domain=attacker.example; Path=/",
      ]);
    await session.request("navigation/groups");
    await session.request("user/userData");
    // A new process reads the rotation from the saved file.
    const restarted = await f.factory({
      profile: f.profile,
      origin,
      interactive: false,
    });
    await restarted.request("user/userData");
    expect(f.calls.map((call) => call.cookie)).toEqual([
      "Flocknote=fictional-session",
      "Flocknote=fictional-rotated",
      "Flocknote=fictional-rotated",
    ]);
    const saved = files(f.profile)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(saved).toContain("fictional-rotated");
    expect(saved).not.toMatch(/fictional_tracker|fictional-foreign/);
  });

  it("keeps both cookies when requests made side by side each rotate one", async () => {
    const f = fixture();
    const session = await f.signedIn();
    f.routes["GET navigation/groups"] = () =>
      json({ groups: [] }, [
        "Flocknote=fictional-rotated; Domain=flocknote.com; Path=/; Secure; HttpOnly",
      ]);
    f.routes["GET network/getMetadata"] = () =>
      json({ everyoneGroupID: 101 }, [
        "Flocknote-Login-201=fictional-login; Domain=flocknote.com; Path=/; Secure; HttpOnly",
      ]);
    await Promise.all([
      session.request("navigation/groups"),
      session.request("network/getMetadata"),
    ]);
    const restarted = await f.factory({
      profile: f.profile,
      origin,
      interactive: false,
    });
    await restarted.request("user/userData");
    expect(f.calls.at(-1)?.cookie?.split("; ").sort()).toEqual([
      "Flocknote-Login-201=fictional-login",
      "Flocknote=fictional-rotated",
    ]);
  });

  it("reports a rotated cookie it couldn't save instead of keeping the old one", async () => {
    let failSaves = false;
    const f = fixture((profile) => {
      const file = sessionFile(profile);
      return {
        get: () => file.get(),
        async set(text) {
          if (failSaves) throw new Error("Fictional storage failure");
          await file.set(text);
        },
      };
    });
    const session = await f.signedIn();
    f.routes["GET navigation/groups"] = () =>
      json({ groups: [] }, [
        "Flocknote=fictional-rotated; Domain=flocknote.com; Path=/; Secure; HttpOnly",
      ]);
    failSaves = true;
    const failed = await session
      .request("navigation/groups")
      .catch((error) => error);
    expect(failed).toBeInstanceOf(ConnectionError);
    expect(failed).toMatchObject({ code: "profile_unavailable" });
  });

  it("posts form bodies and image uploads the way the browser session did", async () => {
    const f = fixture();
    const session = await f.signedIn();
    f.routes["POST supersearch/query?ajax"] = () => json({ results: [] });
    f.routes["POST upload/photo/note"] = () => json({ success: true });
    await session.request("supersearch/query?ajax", "POST", "q=fictional");
    await session.request("upload/photo/note", "POST", undefined, {
      base64: "AQIDBAU=",
      filename: "fictional.png",
      mime: "image/png",
    });
    expect(f.calls[0]).toMatchObject({
      origin,
      contentType: "application/x-www-form-urlencoded",
      body: "q=fictional",
    });
    const upload = f.calls[1]?.body;
    expect(upload).toBeInstanceOf(FormData);
    const form = upload as FormData;
    const file = form.get("qqfile") as File;
    expect(form.get("qqfilename")).toBe("fictional.png");
    expect(form.get("qqtotalfilesize")).toBe("5");
    expect(file.type).toBe("image/png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([
      1, 2, 3, 4, 5,
    ]);
    // The multipart boundary is fetch's to set.
    expect(f.calls[1]?.contentType).toBeNull();
    for (const call of f.calls)
      expect(call.userAgent).toMatch(/^AskMyParish-Flockbot\/\d+\.\d+\.\d+/);
  });

  it("refuses any origin that is not a Flocknote parish", async () => {
    const f = fixture();
    for (const other of [
      "https://example-parish.flocknote.com.attacker.example",
      "https://flocknote.com.attacker.example",
      "http://example-parish.flocknote.com",
      "https://flocknote.com",
    ])
      await expect(
        f.factory({ profile: f.profile, origin: other, interactive: false }),
      ).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});
