# Repository guidance

Flockbot is a reusable Flocknote integration. Read `README.md` for setup and
supported behavior, and `CONTEXT.md` for domain terminology.

## Architecture

Keep the shared Flocknote client independent of hosting platforms and AI clients.
Deployment adapters own their interfaces and session storage. Parish identities,
credentials, and session state belong in deployment configuration, not source code.

## Tests

Use the setup and test commands documented in `README.md`. The TypeScript
setup uses `bin/setup`, and the suite runs with `bin/test` (or `npm test`).
`npm run check` runs all TypeScript checks and the built-package import.
The existing Ruby suite runs with `bundle exec rspec`.

Routine tests must use sanitized fixtures and run without live Flocknote access.
Do not automatically record missing fixtures against the live service. Live
verification must be explicitly requested and use a designated test parish.

## Credentials and data

Keep passwords, authentication codes, and session cookies out of source,
fixtures, logs, error messages, and AI tool results. Treat member contact details
as sensitive and return only the data a task requires. Use fictional identities
and identifiers in examples and test fixtures.

## Public documentation

Keep documentation and agent instructions useful to contributors on other
machines and at other parishes. Document actual repository prerequisites and
commands. Keep personal agent workflows, private trackers, local preview
services, absolute workstation paths, and operator-specific deployment details outside
versioned repository guidance.

## Cloudflare

Use the `cf` CLI exclusively for Cloudflare work. Do not invoke the Wrangler CLI.
Preserve the project's selected hosting platform: for Cloudflare Pages, use
`cf pages` resource commands rather than migrating the project to Workers.
