# Release notes

Run `npm run changeset` when a change affects the Mac or Windows apps or the
connector they bundle. Select `@askmyparish/flockbot-mcp`, choose the semantic
version impact, and describe the user-visible change. Commit the generated
Markdown file with the implementation. Shared client and dependency changes that
affect MCP need a changeset too.

The MCP package is private on npm; the apps are GitHub downloads, published as
described in [Develop and verify](../docs/mcp/README.md#develop-and-verify).
The root client and Zapier candidate keep independent versions.

Do not put credentials, parish identities, contact details, or private
verification output in release notes.
