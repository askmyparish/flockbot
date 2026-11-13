# @askmyparish/flockbot-mcp

## 0.3.0-beta.14

### Minor Changes

- e119e0c: Add explicit find_members count mode with validated, scoped OR-of-ANDs criteria and fresh native catalog bindings. Preserve simple member lookup, suppress native member rows from count results, and retain existing request limits and authentication diagnostics. Advanced member pages and contact-update date criteria remain unavailable.
- e6de189: Add bounded advanced member pages with opt-in contacts and stateless query-bound continuation. Reject stale or stalled traversals without retrying, preserve legacy lookup and count behavior, and document caller consent, overlap and automatic-pass limits.
- 4db6543: Support explicit basic HTML formatting in create_email_draft, with shared fragment validation, safe HTTP(S) links and persisted structure/text verification. Plain text remains the default; drafts are never sent or scheduled.
- 70b2d16: Add read-only group_notes discovery from one JSON listing, with bounded titles, explicit continuation/clipping, and unknown channel metadata instead of per-note enrichment.
- f10d4ed: Add read-only parish-wide find_notes keyword discovery from one JSON search page, preserving mixed note types and explicit completeness limits without bodies, recipients or per-note enrichment.
- fe91c45: Enable characterized email and phone update-date filters in advanced member counts and pages. Expose strict before/on/after operators with missing-contact exclusion, validate current native definitions, and document unverified timezone and negation semantics.
- cfe93a7: Add aggregate email analytics by email ID or latest originally sent group email. Report Flocknote's nine tracking categories without recipient records, preserving unknown counts and conservative selection limits.
- b62b18e: Add shared structured failure diagnostics and bounded private local traces across MCP tools. Explicit per-call verbose capture retains credential-filtered JSON, form payloads and inert sanitized HTML structure locally, including permitted contact data, while ordinary calls keep metadata-only logging. A centralized sanitizer applies the same policy at capture and broker/storage boundaries. Capture does not add requests, replay writes, or automatically disclose payloads to the assistant.
- 37c957c: Read existing email/SMS notes as bounded Markdown from JSON, with status and identity checks and explicit partial results for unsupported content.
- e245ef4: Add local Codex tools for group discovery, subscriber counts, and explicitly requested membership additions. Staff sign in privately through a dedicated Flocknote browser profile, shared across local conversations. Credentials stay with the browser, and uncertain writes are never replayed automatically.
  
  Provide versioned macOS Apple silicon and Windows x64 bundles with verified downloads. Windows and clean staff installation remain unverified; this is a prerelease candidate.
- 4021a39: Add read-only member_filters discovery with scoped, paginated field definitions and choices. Discard bundled member data and preserve existing simple member lookup behavior. Contact-update date criteria remain unavailable until independently verified.
- 16cdb1d: Copy an identified published email into a verified unscheduled draft with native duplication. Preserve supported content and all original ordinary groups, return a note link subject to Flocknote permissions, and retain known draft progress without replaying uncertain writes.
- 55cac5f: Return parish-scoped note URLs in note reads, searches, group listings and successful draft creation without additional requests. Unavailable reads return no link.
- 3b6e694: Create drafts with ordered plain-text, basic HTML and native URL-button blocks. Existing body-based calls remain supported; verified saves check block order, content, links and button appearance without sending or scheduling.
- 5779c02: Add create_email_draft for new, unscheduled plain-text email drafts in an explicit group, with persisted read-back verification and partial-write progress instead of automatic retries.
- 37dbac6: Add an integrity-pinned, release-specific Codex TUI setup prompt and reusable per-user Mac installation core for guide-based desktop and terminal setup. Preserve the personal marketplace and saved browser connection through coordinated, recoverable setup and version-checked updates. Include independent Flockbot branding and clear host-reload/sign-in status; Windows and real desktop installation remain unverified.
  
  Recover owned source stages across process interruption using durable ownership intents, and report version refusals with the known installed state and the repair required before retrying. Keep Mac filesystem checks platform-gated and compatibility manifests limited to the supported onboarding metadata.
- e2d1187: Add email_recipients for one bounded opened/unopened page of a specific email, with identity checks, opt-in addresses, and explicit unknown completeness for unsupported routing and pagination.
- 89d9236: Create unsent email drafts with uploaded local JPEG, PNG and GIF image blocks alongside text and buttons. Validate files before writes, verify persisted photo identities, and report known uploaded assets on partial failures without retrying or deleting them.

### Patch Changes

- 76919d8: Select the latest group email for engagement and aggregate analytics from one JSON notes listing. Preserve unknown selection for unexpected row statuses, invalid dates, duplicate IDs, ambiguous ordering, and insufficient pagination evidence. Check the selected note's identity, email type, group target, and original send metadata without skipping rows or falling back to older email.
- 3baa6e2: Default new and duplicated email drafts to an empty sender display label, and verify that it remains empty after saving. Leave the original email unchanged when duplicating.
- 524b24c: Accept subscriber counts formatted with comma-separated thousands. Continue rejecting malformed grouping, fractional or negative counts, and values outside the safe integer range.
- 0bed866: Add a guide and copyable setup prompt for desktop and terminal Codex users. Keep checksum-verified local setup, shared connection preservation and a direct link to the native plugin page without requiring a separate CLI on desktop.
  
  Use the uniform Flockbot name, square-friendly sheep artwork and AskMyParish publisher identity with askmyparish.com. Downloaded ZIPs preserve executable permissions with macOS extraction.
- f3d5506: Restrict note searches to Flocknote's notes-only filter and validate the returned category flags. Report the upstream note-only search count while preserving bounded results and incompleteness warnings.
- a70bb62: Serialize macOS runtime setup across processes, recover owned interrupted installations on retry, and bound download and browser preparation failures without changing the saved connection.
- 362fb8b: Distribute MCP candidates through reviewed version and changelog PRs and GitHub release downloads, with reproducible archives, checksum verification, and signed build provenance.
- efd920e: Keep the sign-in tool active briefly while browser login finishes, then prompt the assistant to continue the original request without a separate “I’m signed in” message. Preserve a bounded pending/cancellation fallback and the existing browser connection; never automatically replay a write with an unknown outcome.
- 12dcf09: Offer available Flockbot updates after normal parish responses using a cached daily public release check. Keep network failures quiet and updates user initiated through the same verified guide, preserving sign-in and existing tool results.
