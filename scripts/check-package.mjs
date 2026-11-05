import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as api from "@askmyparish/flockbot";
import {
  Network,
  User,
  GroupMembership,
  FlocknoteLogin,
  FlockbotClient,
  sessionFromToken,
} from "@askmyparish/flockbot";

execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "--strict",
    "--module",
    "NodeNext",
    "--target",
    "ES2022",
    "--skipLibCheck",
    "scripts/check-model-types.ts",
  ],
  { stdio: "pipe" },
);

assert.equal(
  "Group" in api,
  false,
  "Group instances come from the client, rather than an exposed constructor",
);
const network = new Network("example-parish");
assert.equal(network.origin, "https://example-parish.flocknote.com");
const user = new User({
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
});
const membership = new GroupMembership("101", user);
assert.equal(
  new URLSearchParams(membership.request().body).get("email"),
  "alex@example.test",
);
assert.deepEqual({ ...user }, {});
assert.equal(
  FlocknoteLogin.fromResponse({ success: true, userID: 201 }).id,
  "201",
);
let writes = 0;
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
    if (path === "/group/101/addToGroupByAdmin") {
      assert.equal(request.method, "POST");
      assert.equal(
        new URLSearchParams(request.body).get("email"),
        "alex@example.test",
      );
      writes++;
    }
    const data = {
      "/user/userData": { success: true, userID: 201 },
      "/dashboard":
        '<div class="group_item" data-groupid="101" data-shortname="everyone"><span class="group_name">Everyone</span></div>',
      "/group/101/getSubscriberCount": { subscriberCount: "0" },
      "/group/101/addToGroupByAdmin": { success: true },
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
assert.deepEqual(await groups[0].addMember(user), { success: true });
assert.equal(writes, 1);
console.log(
  "Built package imports, reuses a supplied session, and reads groups/counts.",
);
