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
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: '{"ok":true}',
    };
  },
});
assert.deepEqual(await client.get("dashboard"), { ok: true });
console.log("Built package imports and reuses a supplied session.");
