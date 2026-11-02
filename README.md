# Flockbot

Flockbot connects parish workflows to [Flocknote](https://www.flocknote.com/)
through its internal API.

The TypeScript port supports password login, saved sessions, and HTTP requests.
Automatic recovery, group operations, hosted adapters, and MCP support are still
coming. The Ruby gem remains available during the move.

## TypeScript development

You'll need Node.js 22.12+ and npm. Ruby isn't needed for the TypeScript package.

```sh
bin/setup       # Install locked npm dependencies
bin/test        # Run offline tests
npm run check   # Run all checks and build the package
```

The bin scripts work from any directory. They call `npm ci --ignore-scripts`
and `npm test`; CI uses those same npm commands on Node 22.

`npm run check` covers formatting, lint, types, tests, build, and package import.
Use `npm run format` to format files, or run individual checks with
`npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`,
and `npm run test:package` (after building). To run a focused test:

```sh
bin/test -t "reuses cookies"
```

### Use a saved session

The package is private and unpublished for now. After building, import it from
`dist/index.js`. This example keeps state in memory; your adapter should provide
protected storage that survives restarts.

```typescript
import {
  FlockbotClient,
  sessionFromToken,
  type SessionState,
} from "./dist/index.js";

let state: SessionState | null = sessionFromToken("example-parish", savedToken);
const client = new FlockbotClient({
  subdomain: "example-parish",
  sessionStore: {
    load: async () => state,
    save: async (next) => { state = next; },
    clear: async () => { state = null; },
  },
});
const result = await client.get("user/userData");
```

### Log in with a password

Your adapter supplies a protected `SessionStore` and a `CredentialProvider`
that returns `{ email, password }`. Keep those credentials out of chats and logs.
The client doesn't pick a credential store or load environment files.

```typescript
const client = new FlockbotClient({
  subdomain: "example-parish",
  sessionStore,
  credentialProvider: {
    load: async () => secureCredentials.load(),
  },
});
await client.connect();
```

Here, `sessionStore` and `secureCredentials` come from your adapter.
`connect()` checks a saved session without reading credentials, or logs in when
no usable cookie is available. Use `connect({ forcePasswordLogin: true })` to
start a fresh password login deliberately. A rejected saved session isn't
renewed automatically yet, and `get`/`post` don't log in or retry authentication.

Setup and saved-session checks keep cookie changes private until verification
succeeds. `connect()` returns no token or user details. Failed checks leave the
previous session alone. If saving fails, plain `connect()` retries the save;
forcing password login starts the exchange again.

Authentication errors use fixed codes:

| Code | Meaning |
| --- | --- |
| `credentials_unavailable` | Credentials are missing or couldn't be loaded |
| `credentials_rejected` | A known password-mismatch response |
| `authentication_required` | The session wasn't authorized |
| `action_required` | Password login is unavailable |
| `authentication_unavailable` | A network failure, rate limit, or server error |
| `authentication_protocol_error` | An unexpected authentication response |

Flocknote may still send a login email during password setup. The client doesn't
request, fetch, or enter codes. Password-disabled handling uses simulated test
responses; real code challenges haven't been verified. Unknown responses fail
clearly rather than being guessed to mean a bad password.

### Requests and storage

`get(path)` returns JSON or text. `post(path, fields)` sends URL-encoded string
fields. Use paths like `user/userData`, not full URLs or query strings. Requests
stay on the configured parish's HTTPS origin, and redirects are rejected.
Failures throw `FlockbotError` with a safe `code`, without copying sensitive
upstream bodies or exception details.

`SessionStore` provides `load`, `save`, and `clear`. The client reuses cookies
between calls and keeps their expiry across reloads. Only cookie changes trigger
a save. Valid replacements are saved even when rejecting a redirect. A failed
save is retried before another request; the original request isn't replayed.
`clearSession()` resets the store and this client's cached and pending state,
but doesn't reset other client instances. There's no cross-client coordination yet.

Stored sessions are credentials. Library-created state hides secrets during Node
inspection, but JSON and structured clones retain them for storage. Don't log
serialized state.

The default transport uses standard `fetch`, `Headers`, and `URL` APIs. A custom
`transport` must keep requests on the supplied origin and honor manual redirects.

Tests use fictional data and block unexpected network access. They don't need
credentials, environment files, or live Flocknote access, and never record missing
fixtures. CI runs checks without live credentials, deployment, or publishing.

## Ruby gem

Requires Ruby 3.3. Add this to your `Gemfile`:

```ruby
gem "flockbot", git: "https://github.com/askmyparish/flockbot"
```

### Connect

Create a session, choose a login method, then create the client. The subdomain
is the first part of your Flocknote URL.

```ruby
session = Flockbot::Session.new(subdomain: "example-parish", email: "user@example.com")

# Choose one:
session.login!(password: "example-password")

# Or request a code:
session.send_one_time_code
session.login!(code: "1234")

# Or reuse a saved session:
session.login!(token: saved_token)

client = Flockbot::Client.new(session: session)
```

### Groups and members

```ruby
client.groups
client.everyone_group
client.groups.first.subscriber_count
```

Adding a member requires first and last names, plus an email, mobile number,
or both. New members also join Everyone. Existing members are matched by email
or phone; the supplied name doesn't rename them.

```ruby
group = client.groups.last

group.add_user(first_name: "Alex", last_name: "Rivera", email: "alex@example.com")
group.add_user(first_name: "Sam", last_name: "Lee", mobile_phone: "555-555-5555")
```

### Ruby development

Use `bundle install` and `bundle exec rspec`. `bin/console` still opens a Ruby/Pry
prompt; `bin/setup` and `bin/test` now serve TypeScript.

## Contributing

Issues and pull requests are welcome at
[askmyparish/flockbot](https://github.com/askmyparish/flockbot).

## License

Available under the [MIT License](https://opensource.org/licenses/MIT).
