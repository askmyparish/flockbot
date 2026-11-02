# Flockbot

The Flockbot Ruby library provides convenient access to some limited features
of the [Flocknote](https://www.flocknote.com/) application. Flocknote does
not currently expose a public API, so this gem leverages parts of the
internal API in order to better integrate with external applications.

This repository is being ported to TypeScript. The TypeScript client currently
provides HTTP requests using an already-authenticated session, cookie reuse and
storage boundaries. Password login, automatic recovery, group operations, hosted
adapters, and MCP packaging are not implemented in the TypeScript client yet.
The existing Ruby library remains available below during the migration.

## TypeScript development

Requirements: Node.js 22.12 or later and npm. Node.js 22 is used by CI; Ruby is
not required to build or test the TypeScript package.

```sh
bin/setup
bin/test
```

`bin/setup` installs the locked npm dependencies with lifecycle scripts disabled;
`bin/test` runs the offline TypeScript tests. Both scripts work from any working
directory. They delegate to `npm ci --ignore-scripts` and `npm test`, respectively.

`npm run check` runs formatting, lint, strict type checks, the offline test suite,
the build, and an import check of the built package. Individual commands are
`npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build`, and `npm run test:package` (after building). Use `npm run format`
to apply formatting. Vitest supports focused runs, for example
`bin/test -t "reuses cookies"` (or `npm test -- -t "reuses cookies"`), through
the same offline setup. CI uses the same underlying npm commands directly.

The package is private and unpublished during development. After building, it
can be imported from `dist/index.js`. A deployment supplies protected storage;
the example below uses process memory only:

```typescript
import {
  FlockbotClient,
  sessionFromToken,
  type SessionState,
} from "./dist/index.js";

// Obtain the token through your deployment's secure configuration.
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

`get(path)` returns parsed JSON for JSON content types, or text for successful
non-JSON responses. `post(path, fields)` sends URL-encoded string fields. Paths
are endpoint paths such as `user/userData`, not arbitrary URLs or query strings.
Requests use HTTPS to the configured parish subdomain only. Redirects are
rejected, including same-origin redirects. HTTP failures, malformed JSON, and
storage failures return `FlockbotError` with a fixed, sanitized `code`; upstream
error bodies and transport exception details are not copied into errors.

The client retains its cookie jar for sequential calls. A store's `load`, `save`,
and `clear` methods allow a new client to reload state. Saved state is bound to
one parish origin and contains only Flocknote authentication cookies; it must be
treated as a credential. Cookie paths and expiry are honored, including across
reloads; relative expiry is fixed when a cookie is captured. Unchanged responses
do not rewrite storage. Valid replacement cookies are captured even when a
redirect is rejected, without following it. A failed save retains the replacement
and is retried before the next upstream request; the original request is not
replayed. `clearSession()` clears the store, this client's cached jar, and pending
saves. Other existing clients retain their own cached state, but unchanged reads
do not overwrite a cleared or newer stored session. This slice provides no locking
or coordination across clients or processes.

Library-produced session-state objects redact ordinary Node inspection, including
inspection with hidden fields. Intentional JSON serialization and structured
cloning retain the credential for storage; never log serialized state.

The default transport uses standard `fetch`, `Headers`, and `URL` APIs. An adapter
may inject a `transport` implementing the exported request/response types; that
trusted transport must honor manual redirects and must not forward requests or
authentication to other origins. `SessionStore` and `CredentialProvider` define
the storage/credential boundary; the supplied-session client does not read the
credential provider or perform a password login.

Routine TypeScript tests use fictional values and block unexpected fetch, HTTP,
HTTP/2, TCP, and TLS connection entry points, including named builtin exports.
No credentials, `.env` files, live Flocknote access, or automatic
fixture recording are needed. GitHub Actions runs the same checks on PRs and
pushes without deployment credentials or automatic publishing.

## Ruby requirements

* Ruby 3.3

## Ruby setup

Add the following to your `Gemfile`:

``` ruby
gem "flockbot", git: "https://github.com/askmyparish/flockbot"
```

## Ruby usage

### Create a `Flockbot::Client` with authenticated session

```ruby
#
# 1. Create a session
#
# Note: The `subdomain` is the first part of your Flocknote URL.  Example: https://myparish.flocknote.com
session = Flockbot::Session.new(subdomain: "myparish", email: "me@example.com")

#
# 2. Authenticate session using one of three ways:
#
# (A) using password
session.login!(password: "mypassword")

# (B) using one time code
session.send_one_time_code
session.login!(code: "1234") # from flocknote email

# (C) using a previous session token
token = some_prior_session.session_token
session.login!(token: token)

#
# 3. Create a client
#
client = Flockbot::Client.new(session: session)
```

### Client Usage

#### List all of your groups

```ruby
client.groups
=> [#<Flockbot::Models::Group {:id=>971110, :name=>"Everyone", :short_name=>"everyone", :everyone?=>true, :subscriber_count=>nil}>,
 #<Flockbot::Models::Group {:id=>977777, :name=>"Lectors", :short_name=>"LectorsGroup", :everyone?=>false, :subscriber_count=>nil}>,
 #<Flockbot::Models::Group {:id=>876666, :name=>"Alpha", :short_name=>"Alpha", :everyone?=>false, :subscriber_count=>nil}>]
```

#### Get a subscriber count for any group

```ruby
client.groups.first.subscriber_count
#=> 924
```

#### Find the `everyone` group

```ruby
client.everyone_group
=> #<Flockbot::Models::Group {:id=>971110, :name=>"Everyone", :short_name=>"everyone", :everyone?=>true, :subscriber_count=>nil}>
```

#### Add a new or existing user to any Flocknote group

A `first_name` and `last_name` are always required and then you must supply either an `email`, `mobile_phone`, or both.

If the user is not currently in Flocknote, they will be added to the group you specified as well as your "everyone" group.

If the user already exists in Flocknote, they will be automatically matched on either `email` or `mobile_phone` and added to the specified group.  This is true even if the name provided is not the exact one found in Flocknote.  As an example, if you already have a user named "James Smith" in Flocknote with email "jim@example.com" and you use Flockbot to add "Jimmy Smith" with email "jim@example.com" to your "Lectors" group, your existing user will added to the "RCIA group".  A duplicate user will not be created, nor will Flockbot change the existing user's name.

```ruby
group = client.groups.last
 #<Flockbot::Models::Group {:id=>977777, :name=>"Lectors", :short_name=>"LectorsGroup", :everyone?=>false, :subscriber_count=>nil}>

# adding a new user with just an email
group.add_user(first_name: "New", last_name: "User", email: "newuser@example.com")
#=> true

# adding a new user with just a mobile phone
group.add_user(first_name: "New", last_name: "User", mobile_phone: "555-555-5555")
#=> true

# adding an existing user
group.add_user(first_name: "Existing", last_name: "User", email: "existinguser@example.com")
#=> true
```

## Ruby development

For the existing Ruby gem, run `bundle install` and `bundle exec rspec`.
`bin/console` still opens a Ruby/Pry prompt during the migration; `bin/setup`
and `bin/test` now serve the TypeScript package.

## Contributing

Bug reports and pull requests are welcome on GitHub at https://github.com/askmyparish/flockbot.

Run TypeScript tests with `bin/test`, or all TypeScript checks with `npm run check`.
Ruby test commands are documented under Ruby development above.

## License

The gem is available as open source under the terms of the [MIT License](https://opensource.org/licenses/MIT).
