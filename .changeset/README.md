# Release notes

Run `npm run changeset` when a change affects the Codex MCP distribution. Select
`@askmyparish/flockbot-mcp`, choose the semantic version impact, and describe the
user-visible change. Commit the generated Markdown file with the implementation.
Shared client and dependency changes that affect MCP need a changeset too.

The MCP package is private on npm; its release artifacts are GitHub downloads.
The root client and Zapier candidate keep independent versions. Beta mode is
enabled until the staff-installation checks are complete.

See [the release runbook](../docs/mcp/releases.md). Do not put credentials,
parish identities, contact details, or private verification output in release notes.
