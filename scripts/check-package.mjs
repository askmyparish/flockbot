import assert from "node:assert/strict";
import { FlockbotClient, sessionFromToken } from "@askmyparish/flockbot";

let state = sessionFromToken("example-parish", "fictional-session");
const client = new FlockbotClient({
  coordinator: { runExclusive: async (_identity, _signal, work) => work() },
  subdomain: "example-parish",
  sessionStore: {
    revision: async () => "fixture-revision",
    load: async () => state,
    save: async (next) => {
      state = next;
    },
    clear: async () => {
      state = null;
    },
  },
  transport: async (request) => {
    assert.equal(request.headers.Cookie, "Flocknote=fictional-session");
    const path = new URL(request.url).pathname;
    const data = {
      "/user/userData": { success: true, userID: 201 },
      "/dashboard":
        '<div class="group_item" data-groupid="101" data-shortname="everyone"><span class="group_name">Everyone</span></div>',
      "/group/101/getSubscriberCount": { subscriberCount: "0" },
    }[path];
    assert.notEqual(data, undefined);
    return {
      status: 200,
      headers: new Headers({
        "content-type":
          typeof data === "string" ? "text/html" : "application/json",
      }),
      body: typeof data === "string" ? data : JSON.stringify(data),
    };
  },
});
const groups = await client.groups();
assert.deepEqual(
  groups.map(({ id, name, shortName, isEveryone }) => ({
    id,
    name,
    shortName,
    isEveryone,
  })),
  [{ id: "101", name: "Everyone", shortName: "everyone", isEveryone: true }],
);
assert.equal(await groups[0].subscriberCount(), 0);
console.log(
  "Built package imports, reuses a supplied session, and reads groups/counts.",
);
