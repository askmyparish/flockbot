import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  FlockbotClient,
  FlockbotError,
  sessionFromToken,
  type ClientOptions,
  type Group,
  type SessionState,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "../src/index.js";
import { FakeCoordinator } from "./support.js";

const fixtureText = (name: string) =>
  readFileSync(new URL(`./fixtures/groups/${name}`, import.meta.url), "utf8");
const legacy = fixtureText("legacy.html");
const shell = fixtureText("shell.html");
const navigation: unknown = JSON.parse(fixtureText("navigation.json"));
const metadata: unknown = JSON.parse(fixtureText("metadata.json"));
const accepted = { success: true, userID: 201 };
function json(value: unknown, status = 200): TransportResponse {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(value),
  };
}
function html(value: string): TransportResponse {
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    body: value,
  };
}
function fixture(
  replies: Record<string, TransportResponse | Error> = {},
  options: Partial<ClientOptions> = {},
) {
  let state: SessionState | null = sessionFromToken(
    "example-parish",
    "fictional-session",
  );
  let revision = 0;
  const sessionStore = {
    revision: vi.fn(async () => String(revision)),
    load: vi.fn(async () => state),
    save: vi.fn(async (next: SessionState, expected: string) => {
      if (expected !== String(revision))
        throw new FlockbotError("stale_session_state");
      state = next;
      revision++;
    }),
    clear: vi.fn(async (expected: string) => {
      if (expected !== String(revision))
        throw new FlockbotError("stale_session_state");
      state = null;
      revision++;
    }),
  };
  const requests: TransportRequest[] = [];
  const responses: Record<string, TransportResponse | Error> = {
    "user/userData": json(accepted),
    dashboard: html(legacy),
    "navigation/groups": json(navigation),
    "network/getMetadata": json(metadata),
    "group/101/getSubscriberCount": json({ subscriberCount: "2" }),
    ...replies,
  };
  const transport = vi.fn<Transport>(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname.slice(1);
    const result = responses[path];
    if (result instanceof Error) throw result;
    if (!result) throw new Error("Unexpected fixture request");
    return result;
  });
  const provider = {
    load: vi.fn(async () => ({
      email: "fictional@example.test",
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
    requests,
    responses,
    transport,
    sessionStore,
    provider,
    paths: () =>
      transport.mock.calls.map(([request]) =>
        new URL(request.url).pathname.slice(1),
      ),
  };
}
const attributes = (groups: readonly Group[]) =>
  groups.map(({ id, name, shortName, isEveryone }) => ({
    id,
    name,
    shortName,
    isEveryone,
  }));
const everyone = {
  id: "101",
  name: "Everyone",
  shortName: "everyone",
  isEveryone: true,
};

describe("group discovery", () => {
  it("returns usable legacy groups, decodes text inertly, and preserves large identifiers exactly", async () => {
    const f = fixture();
    const groups = await f.client.groups();
    expect(attributes(groups)).toEqual([
      everyone,
      {
        id: "102",
        name: "Garden & Grounds",
        shortName: "garden",
        isEveryone: false,
      },
      {
        id: "9007199254740993",
        name: "Music Ministry",
        shortName: "music",
        isEveryone: false,
      },
    ]);
    expect(f.paths()).toEqual(["user/userData", "dashboard"]);
    expect(
      f.requests.every(
        (request) =>
          request.headers.Cookie === "Flocknote=fictional-session" &&
          request.method === "GET",
      ),
    ).toBe(true);
    expect(f.provider.load).not.toHaveBeenCalled();
    expect(Object.isFrozen(groups[0])).toBe(true);
  });

  it("loads the modern shell fallback and prepends Everyone from metadata", async () => {
    const f = fixture({ dashboard: html(shell) });
    expect(attributes(await f.client.groups())).toEqual([
      everyone,
      {
        id: "102",
        name: "Garden & Grounds",
        shortName: "garden",
        isEveryone: false,
      },
      {
        id: "103",
        name: "Music Ministry",
        shortName: "music",
        isEveryone: false,
      },
    ]);
    expect(f.paths()).toEqual([
      "user/userData",
      "dashboard",
      "navigation/groups",
      "network/getMetadata",
    ]);
  });

  it("merges Everyone by metadata ID or case-insensitive short name, with metadata precedence", async () => {
    const f = fixture({
      dashboard: html(shell),
      "navigation/groups": json({
        groups: [
          { ID: "00101", name: "All parish members", shortname: "all" },
          { ID: "old-group", name: "Old Everyone", shortname: "EVERYONE" },
          { ID: "00102", name: "Garden", shortname: "garden" },
          { ID: 102, name: "Duplicate", shortname: "duplicate" },
          { ID: "garden-extra", name: "Another garden", shortname: "garden" },
        ],
      }),
    });
    expect(attributes(await f.client.groups())).toEqual([
      everyone,
      { id: "102", name: "Garden", shortName: "garden", isEveryone: false },
      {
        id: "garden-extra",
        name: "Another garden",
        shortName: "garden",
        isEveryone: false,
      },
    ]);
  });

  it("deduplicates legacy IDs and Everyone without fixed parish IDs; first legacy data wins", async () => {
    const f = fixture({
      dashboard:
        html(`<div class="group_item" data-groupid="x-1" data-shortname="EVERYONE"><span class="group_name">All members</span></div>
      <div class="group_item" data-groupid="x-2" data-shortname="everyone"><span class="group_name">Duplicate Everyone</span></div>
      <div class="group_item" data-groupid="x-1" data-shortname="other"><span class="group_name">Duplicate ID</span></div>`),
    });
    expect(attributes(await f.client.groups())).toEqual([
      {
        id: "x-1",
        name: "All members",
        shortName: "EVERYONE",
        isEveryone: true,
      },
    ]);
  });

  it("accepts only explicit empty fallback collections, and still returns metadata Everyone for groups: []", async () => {
    const f = fixture({
      dashboard: html(shell),
      "navigation/groups": json({ groups: [] }),
      "network/getMetadata": json({ everyoneGroupID: null }),
    });
    expect(await f.client.groups()).toEqual([]);
    expect(await f.client.everyoneGroup()).toBeUndefined();
    f.responses["network/getMetadata"] = json(metadata);
    expect(attributes(await f.client.groups())).toEqual([everyone]);
    expect((await f.client.everyoneGroup())?.id).toBe("101");
  });

  it.each([
    [
      "unknown login page",
      html("<html><form action='/login'>Sign in</form></html>"),
    ],
    ["blank page", html("")],
    ["non-HTML dashboard", json({})],
    [
      "missing ID",
      html(
        '<div class="group_item" data-shortname="garden"><span class="group_name">Garden</span></div>',
      ),
    ],
    [
      "missing short name",
      html(
        '<div class="group_item" data-groupid="102"><span class="group_name">Garden</span></div>',
      ),
    ],
    [
      "blank name",
      html(
        '<div class="group_item" data-groupid="102" data-shortname="garden"><span class="group_name"> </span></div>',
      ),
    ],
    [
      "missing name node",
      html(
        '<div class="group_item" data-groupid="102" data-shortname="garden"></div>',
      ),
    ],
  ])(
    "rejects %s instead of pretending groups are empty",
    async (_label, dashboard) => {
      const f = fixture({ dashboard });
      await expect(f.client.groups()).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(f.paths()).toEqual(["user/userData", "dashboard"]);
    },
  );

  it.each([
    null,
    [],
    {},
    { groups: null },
    { groups: {} },
    { groups: [null] },
    { groups: [{ ID: 102, shortname: "garden" }] },
    { groups: [{ ID: 102, name: "Garden" }] },
    { groups: [{ name: "Garden", shortname: "garden" }] },
    { groups: [{ ID: 9007199254740992, name: "Garden", shortname: "garden" }] },
    { groups: [{ ID: "../members", name: "Garden", shortname: "garden" }] },
    { groups: [{ ID: {}, name: "Garden", shortname: "garden" }] },
    { groups: [{ ID: "0", name: "Garden", shortname: "garden" }] },
  ])("rejects malformed navigation %#", async (value) => {
    await expect(
      fixture({
        dashboard: html(shell),
        "navigation/groups": json(value),
      }).client.groups(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    null,
    [],
    {},
    { everyoneGroupID: "" },
    { everyoneGroupID: false },
    { everyoneGroupID: 1.2 },
    { everyoneGroupID: 9007199254740992 },
  ])("rejects missing or malformed Everyone metadata %#", async (value) => {
    await expect(
      fixture({
        dashboard: html(shell),
        "network/getMetadata": json(value),
      }).client.groups(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [json({}, 403), "permission_denied"],
    [json({}, 401), "upstream_rejected"],
    [json({}, 503), "upstream_rejected"],
    [json({}, 429), "upstream_rejected"],
    [json({ success: false }), "upstream_rejected"],
    [new Error("fictional private upstream detail"), "transport_failed"],
    [{ ...json({}), body: "{bad-json" }, "invalid_response"],
  ])(
    "preserves typed navigation failure %# instead of returning an empty list",
    async (response, code) => {
      const f = fixture({
        dashboard: html(shell),
        "navigation/groups": response,
      });
      await expect(f.client.groups()).rejects.toMatchObject({
        name: "FlockbotError",
        code,
      });
      expect(f.provider.load).not.toHaveBeenCalled();
      expect(f.paths()).not.toContain("network/getMetadata");
    },
  );

  it("does not discard metadata failures after otherwise valid navigation", async () => {
    const f = fixture({
      dashboard: html(shell),
      "network/getMetadata": json({}, 403),
    });
    await expect(f.client.groups()).rejects.toMatchObject({
      code: "permission_denied",
      status: 403,
    });
  });

  it("does not persist rotations from malformed discovery responses", async () => {
    const response = html('<div class="group_item"></div>');
    response.headers.set(
      "set-cookie",
      "Flocknote=fictional-rotation; Path=/; Secure",
    );
    const f = fixture({ dashboard: response });
    await expect(f.client.groups()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(f.sessionStore.save).not.toHaveBeenCalled();
  });

  it("rejects a legacy page containing only structural rows instead of returning empty", async () => {
    const f = fixture({
      dashboard: html(
        '<div class="group_item" data-groupid="layout-structure"></div>',
      ),
    });
    await expect(f.client.groups()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(f.paths()).toEqual(["user/userData", "dashboard"]);
  });

  it("allows the recognized shell to fall back when it has only structural rows", async () => {
    const f = fixture({
      dashboard: html(
        shell.replace(
          "</body>",
          '<div class="group_item" data-groupid="layout-structure"></div></body>',
        ),
      ),
    });
    expect(attributes(await f.client.groups())).toContainEqual(everyone);
    expect(f.paths()).toContain("navigation/groups");
  });
});

describe("subscriber counts", () => {
  it.each([0, "0", 7, "007", " 23 "])(
    "parses a valid count %j",
    async (count) => {
      const f = fixture({
        "group/101/getSubscriberCount": json({ subscriberCount: count }),
      });
      const [group] = await f.client.groups();
      expect(await group?.subscriberCount()).toBe(Number(count));
      expect(f.paths()).toEqual([
        "user/userData",
        "dashboard",
        "user/userData",
        "group/101/getSubscriberCount",
      ]);
    },
  );

  it.each([
    undefined,
    null,
    "",
    " ",
    -1,
    "-1",
    "1.5",
    1.5,
    "2 people",
    true,
    {},
    [],
    "1e2",
    "+2",
    "9007199254740992",
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid or missing count %#", async (count) => {
    const f = fixture({
      "group/101/getSubscriberCount": json({ subscriberCount: count }),
    });
    const [group] = await f.client.groups();
    await expect(group?.subscriberCount()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("caches zero per object, refreshes explicitly, and retains the last valid value after refresh failure", async () => {
    const f = fixture({
      "group/101/getSubscriberCount": json({ subscriberCount: 0 }),
    });
    const [group] = await f.client.groups();
    expect(await group?.subscriberCount()).toBe(0);
    f.responses["group/101/getSubscriberCount"] = json({ subscriberCount: 8 });
    expect(await group?.subscriberCount()).toBe(0);
    expect(
      f.paths().filter((path) => path.endsWith("getSubscriberCount")),
    ).toHaveLength(1);
    expect(await group?.subscriberCount({ force: true })).toBe(8);
    f.responses["group/101/getSubscriberCount"] = json({});
    await expect(group?.subscriberCount({ force: true })).rejects.toMatchObject(
      { code: "invalid_response" },
    );
    expect(await group?.subscriberCount()).toBe(8);
    const [newGroup] = await f.client.groups();
    await expect(newGroup?.subscriberCount()).rejects.toMatchObject({
      code: "invalid_response",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      group?.subscriberCount({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
  });

  it.each([
    [json({}, 403), "permission_denied"],
    [json({}, 500), "upstream_rejected"],
    [new Error("fictional private detail"), "transport_failed"],
    [html("<html>Sign in</html>"), "invalid_response"],
  ])(
    "propagates count failures without caching them %#",
    async (response, code) => {
      const f = fixture({ "group/101/getSubscriberCount": response });
      const [group] = await f.client.groups();
      const verified = json(accepted);
      verified.headers.set(
        "set-cookie",
        "Flocknote=fictional-verified; Domain=flocknote.com; Path=/; Secure",
      );
      f.responses["user/userData"] = verified;
      await expect(group?.subscriberCount()).rejects.toMatchObject({ code });
      expect(JSON.stringify(await f.sessionStore.load())).toContain(
        "Flocknote=fictional-verified",
      );
      expect(f.sessionStore.save).toHaveBeenCalledOnce();
      f.responses["group/101/getSubscriberCount"] = json({
        subscriberCount: "3",
      });
      expect(await group?.subscriberCount()).toBe(3);
    },
  );
});

describe("group persistence and safety", () => {
  it("retries a failed verification save before reading or caching a count", async () => {
    const f = fixture();
    const [group] = await f.client.groups();
    const verified = json(accepted);
    verified.headers.set(
      "set-cookie",
      "Flocknote=fictional-verified; Domain=flocknote.com; Path=/; Secure",
    );
    f.responses["user/userData"] = verified;
    f.sessionStore.save.mockRejectedValueOnce(
      new Error("fictional-private-save-error"),
    );
    await expect(group?.subscriberCount()).rejects.toMatchObject({
      code: "session_save_failed",
    });
    expect(f.paths().some((path) => path.endsWith("getSubscriberCount"))).toBe(
      false,
    );
    f.responses["user/userData"] = json(accepted);
    f.responses["group/101/getSubscriberCount"] = json({
      subscriberCount: "9",
    });
    expect(await group?.subscriberCount()).toBe(9);
    expect(f.sessionStore.save).toHaveBeenCalledTimes(2);
    expect(f.requests.at(-1)?.headers.Cookie).toBe(
      "Flocknote=fictional-verified",
    );
    expect(f.provider.load).not.toHaveBeenCalled();
  });

  it.each([
    {
      endpoint: "dashboard",
      failure: json({}, 403),
      code: "permission_denied",
    },
    {
      endpoint: "navigation/groups",
      failure: json({}, 503),
      code: "upstream_rejected",
    },
    {
      endpoint: "network/getMetadata",
      failure: new Error("fictional-private-error"),
      code: "transport_failed",
    },
    {
      endpoint: "network/getMetadata",
      failure: { ...json({}), body: "invalid JSON" },
      code: "invalid_response",
    },
    {
      endpoint: "dashboard",
      failure: html('<div class="group_item"></div>'),
      code: "invalid_response",
    },
  ])(
    "retains verified rotation when later $endpoint fails with $code",
    async ({ endpoint, failure, code }) => {
      const verified = json(accepted);
      verified.headers.set(
        "set-cookie",
        "Flocknote=fictional-verified; Domain=flocknote.com; Path=/; Secure",
      );
      if (!(failure instanceof Error))
        failure.headers.set(
          "set-cookie",
          "Flocknote=fictional-unverified; Domain=flocknote.com; Path=/; Secure",
        );
      const f = fixture({
        "user/userData": verified,
        dashboard: html(shell),
        [endpoint]: failure,
      });
      await expect(f.client.groups()).rejects.toMatchObject({ code });
      expect(f.sessionStore.save).toHaveBeenCalledOnce();
      expect(JSON.stringify(await f.sessionStore.load())).toContain(
        "Flocknote=fictional-verified",
      );
      expect(JSON.stringify(await f.sessionStore.load())).not.toContain(
        "Flocknote=fictional-unverified",
      );
      f.responses["user/userData"] = json(accepted);
      f.responses.dashboard = html(legacy);
      await f.client.groups();
      expect(f.requests.at(-1)?.headers.Cookie).toBe(
        "Flocknote=fictional-verified",
      );
      expect(f.provider.load).not.toHaveBeenCalled();
    },
  );

  it("keeps failed-save counts out of cache and publishes only validated rotations", async () => {
    const f = fixture();
    const [group] = await f.client.groups();
    const countResponse = json({ subscriberCount: "4" });
    countResponse.headers.set(
      "set-cookie",
      "Flocknote=fictional-count-rotation; Domain=flocknote.com; Path=/; Secure",
    );
    f.responses["group/101/getSubscriberCount"] = countResponse;
    f.sessionStore.save.mockRejectedValueOnce(
      new Error("fictional-private-storage-detail"),
    );
    await expect(group?.subscriberCount()).rejects.toMatchObject({
      code: "session_save_failed",
    });
    f.responses["group/101/getSubscriberCount"] = json({
      subscriberCount: "5",
    });
    expect(await group?.subscriberCount()).toBe(5);
    expect(
      f.paths().filter((path) => path.endsWith("getSubscriberCount")),
    ).toHaveLength(2);
    expect(f.requests.at(-1)?.headers.Cookie).toBe(
      "Flocknote=fictional-count-rotation",
    );
  });

  it("returns sanitized typed errors and group JSON without session/callback details", async () => {
    const f = fixture();
    const [group] = await f.client.groups();
    expect(JSON.parse(JSON.stringify(group))).toEqual(everyone);
    f.responses["group/101/getSubscriberCount"] = new Error(
      "fictional-private-upstream-detail",
    );
    try {
      await group?.subscriberCount();
      expect.unreachable("Expected a count failure");
    } catch (error) {
      expect(error).toBeInstanceOf(FlockbotError);
      expect(String(error)).toBe(
        "FlockbotError: Flockbot request failed (transport_failed).",
      );
      expect(JSON.stringify(error)).not.toMatch(
        /private|session|Cookie|password/,
      );
    }
  });
});

describe("shared group lifecycle", () => {
  it("uses the common authentication error class for verification outages", async () => {
    const f = fixture({ "user/userData": json({}, 503) });
    await expect(f.client.groups()).rejects.toMatchObject({
      code: "authentication_unavailable",
    });
    expect(f.paths()).toEqual(["user/userData"]);
    expect(f.sessionStore.save).not.toHaveBeenCalled();
    expect(f.provider.load).not.toHaveBeenCalled();
  });

  it("requires a usable cookie after successful group verification", async () => {
    const verified = json(accepted);
    verified.headers.set(
      "set-cookie",
      "Flocknote=deleted; Domain=flocknote.com; Path=/; Max-Age=0; Secure",
    );
    const f = fixture({ "user/userData": verified });
    const previous = await f.sessionStore.load();
    await expect(f.client.groups()).rejects.toMatchObject({
      code: "authentication_protocol_error",
    });
    expect(await f.sessionStore.load()).toEqual(previous);
    expect(f.sessionStore.save).not.toHaveBeenCalled();
    expect(f.paths()).toEqual(["user/userData"]);
  });

  it("recovers a confirmed invalid session through the common login path, then persists rotation and reads groups/counts", async () => {
    const f = fixture();
    f.transport
      .mockResolvedValueOnce(
        json({ success: true, userID: null, authorized: false }),
      )
      .mockResolvedValueOnce(
        json({
          success: true,
          allowPasswordForFirstFactor: true,
          firstFactorSuccess: false,
        }),
      )
      .mockResolvedValueOnce({
        ...json({ success: true, loginSuccess: true }),
        headers: new Headers({
          "content-type": "application/json",
          "set-cookie": "Flocknote=fictional-renewed; Path=/; Secure",
        }),
      });
    const [group] = await f.client.groups();
    expect(group?.id).toBe("101");
    expect(await group?.subscriberCount()).toBe(2);
    expect(f.paths()).toEqual([
      "user/userData",
      "login/twoFactorAuth",
      "login/twoFactorAuth",
      "user/userData",
      "user/userData",
      "dashboard",
      "user/userData",
      "group/101/getSubscriberCount",
    ]);
    expect(f.provider.load).toHaveBeenCalledTimes(1);
    expect(f.sessionStore.save).toHaveBeenCalledTimes(1);
    expect(f.requests.at(-1)?.headers.Cookie).toBe(
      "Flocknote=fictional-renewed",
    );
    expect(
      f.paths().every((path) => !/member|contact|user\/list/i.test(path)),
    ).toBe(true);
  });

  it("preserves typed authentication verification failures", async () => {
    const f = fixture({
      "user/userData": json({ success: true, userID: 201, authorized: false }),
    });
    await expect(f.client.groups()).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(f.paths()).toEqual(["user/userData"]);
    expect(f.provider.load).not.toHaveBeenCalled();
  });

  it("does not infer expiry or renew login from group endpoint bodies", async () => {
    const f = fixture({
      dashboard: html(shell),
      "navigation/groups": json({
        success: true,
        authorized: false,
        userID: null,
      }),
    });
    await expect(f.client.groups()).rejects.toMatchObject({
      code: "upstream_rejected",
    });
    expect(f.provider.load).not.toHaveBeenCalled();
  });

  it("retries transient reads within one budget across verification and discovery", async () => {
    const f = fixture(
      { dashboard: new Error("offline") },
      { policy: { maxReadRetries: 1, readBackoffMs: 0 } },
    );
    f.transport.mockResolvedValueOnce(json({}, 503));
    await expect(f.client.groups()).rejects.toMatchObject({
      code: "transport_failed",
    });
    expect(f.paths()).toEqual(["user/userData", "user/userData", "dashboard"]);
    // A fourth call would show an incorrectly reset retry budget for dashboard.
    expect(f.transport).toHaveBeenCalledTimes(3);
  });

  it("honors cancellation and a single deadline across discovery requests", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({}, { policy: { timeoutMs: 30 } });
      f.transport.mockImplementation(
        async (request) =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new URL(request.url).pathname === "/user/userData"
                    ? json(accepted)
                    : html(legacy),
                ),
              20,
            );
          }),
      );
      const pending = f.client.groups();
      const assertion = expect(pending).rejects.toMatchObject({
        code: "operation_timeout",
      });
      await vi.advanceTimersByTimeAsync(30);
      await assertion;
      expect(f.transport).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(f.sessionStore.save).not.toHaveBeenCalled();
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        f.client.groups({ signal: cancelled.signal }),
      ).rejects.toMatchObject({ code: "operation_cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });
});
