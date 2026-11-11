# Email drafting: fourth-capture discovery

This record extends [notes and engagement discovery](notes-and-engagement.md)
with a fourth user-supplied HAR of creating and editing an email draft.
**The user explicitly confirmed that the note was never sent, only drafted.**
The capture establishes draft-building operations and scheduling preferences
inside draft saves; it does not establish a send or queued-publication contract.

Analysis was offline and documentation-only. No captured request was replayed.
Credentials, parish/member identities, captured subject/body text, sender names,
and target names are excluded. Identifiers use placeholders. All HAR references
below are one-based positions in the **fourth** capture's `log.entries` array.

A [fifth capture](email-editing.md) extends the module-editing evidence with
buttons, quotes, video, event content, replacement/in-place updates, and multiple
sections. Absence claims below describe the fourth capture alone unless a
follow-up is explicitly noted.

## Coverage and observed sequence

The capture has 143 requests over approximately 60 seconds. The same exclusion
of assets, templates, and unrelated origins leaves 22 application requests across
18 method/path combinations. All have HTTP 200 responses. Nine combinations are
new relative to the earlier inventories, covering composer initialization,
delivery estimates, templates, saves, and preview.

The observed sequence is:

1. Load a group and its people-page context (25, 26, 54).
2. Request the new-note entry check and initialize an email composer (57, 58).
3. Fetch a delivery summary and composer templates (117, 122).
4. Autosave note metadata, save a text module and section, and link their layout
   (131–134).
5. Generate a preview that contains the saved text module (135).
6. Save draft metadata with scheduling preferences and change the comment option
   (138, 141, 142, 143).

Only one email-draft flow and one group-shaped target are characterized. No SMS
composition, test-email delivery, actual sending, queued scheduling, cancellation,
deletion, or reopening of an existing draft is captured.

## Composer entry and initialization

### Entry check

`POST /network/{networkId}/writeNewNote?ajax` (57) sends URL-encoded `groupID`
and `openComposerAfter=1`. The `ajax` query flag has an empty value.

The response has `success: false` alongside readiness, billing, and verification
fields: `networkIsUnderBillingLockout`, `billingInfoNeededButNetworkIsUnverified`,
`billingInfoNeededFromAdmin`, `missingEIN`, `promptForEIN`,
`missingNetworkSettingsInfo`, `hasWebsite`, `hasAddress`, `hasSuperAdminContact`,
name/contact-verification flags, and `openComposerAfter`.

The following composer initialization succeeds. Without additional evidence, do
not interpret the entry check's `success: false` as a generic rejection or derive
a billing/permission rule from it. This is an observed UI entry-check envelope,
not a validated standalone authorization test or justification to bypass checks.

### Initialize an email

`POST /composer/createNote` (58) sends URL-encoded `type=email` and `groupID`.
It returns `success: true`, `composerData`, `noteInfo`, assets, and `version`.

`noteInfo` initially has `type: email`, `status: autosaved`, `newNote: true`,
`duplicate: false`, and empty `sections`. It has neither `ID` nor `autosaveID`.
It also provides sender/network/user context, `themeID`, delivery options,
`availableGroups`, `noteTargets`, schedule defaults, and feature configuration.
The response does not establish that a durable note identifier already exists.

`composerData` includes themes, colors, available layouts/signups, capabilities,
and texting-credit configuration. Presence of texting or voice options in an
email composer is not evidence those delivery routes were selected or exercised.

## Targets, delivery estimates, and templates

The initialized target includes `groupID`, `entityID`, `targetType`,
`targetTypeDictID`, optional `ID`, names, group metadata, flags such as
`isParent`, `includeContacts`, `isSmartGroup`, `isFilteredGroup`, and
social-posting metadata. IDs and booleans vary between typed initialization
objects and string-valued form echoes. Only one group-shaped target is observed;
direct-member, filtered, smart-group, and multi-target composition remain open.

`POST /composer/deliverySummary` (117) sends URL-encoded `networkID`, `type=email`,
and bracketed `targets[0][...]` fields. The response has `success: true`,
`deliverability`, and `premiumTextingSummary`. Numeric delivery fields include
`emailabilityCount`, `textabilityCount`, `emailabilityButNoTextabilityCount`,
`textabilityButNoEmailabilityCount`, and voiceability combinations. It also
includes UI descriptions, route-option fields, lockout metadata, and texting
balance/auto-renew configuration.

This is pre-delivery information, not a send confirmation or recipient-detail
contract. Overlap semantics, freshness, opt-out handling, and other target
combinations remain unverified. Aggregate estimates can be useful without
returning target members or billing details.

`POST /composer/getComposerTemplates` (122) differs in serialization: it sends
**JSON** with `noteTargets` as an array of target objects. The response has
`success: true`, an empty `collections` array, populated `defaultTemplates`, and
user/network context. Template summaries contain `ID`, `title`, `noteID`, and
`image`. Applying or copying a template was not captured; this supports listing
templates only. Do not encode this request as the bracketed form used by the
delivery-summary endpoint.

## Draft metadata saves and identifiers

`POST /composer/save2` is called five times (131, 138, 141, 142, 143), always with
URL-encoded form data. It saves metadata/settings separately from the HTML module
content and layout requests below.

The request includes these observed field families, not a proven minimal payload:

- Identity/lifecycle: `ID`, `autosaveID`, `networkID`, `userID`, `type`, `newNote`,
  `status`, `autosaved`, `duplicate`, and `explicitSaveClick`.
- Presentation: `title`, `fromName`, `themeID`, and `noteTargets[0][...]`.
- Options: `options[comments]`, `options[includeLink]`,
  `options[includeGroupHeader]`, `options[route2]`, `options[voiceCalls]`,
  `options[schedule]`, and reply-to-give configuration.
- Schedule preferences: `schedule[date_day]`, `schedule[date_time]`, and later
  `options[scheduleTime]`.
- Additional browser state: premium-texting, voice-delivery, `sst`/`iig`,
  `requireEmailFunctions`, `returnVoiceData`, and later
  `commentsExplicitlyClicked`.

The first save (131) has `status=autosaved`, `newNote=true`, `autosaved=1`,
`explicitSaveClick=false`, `options[schedule]=false`, and no `ID` or `autosaveID`.
Its successful response returns `note.autosaveID` as a string and
`note.newNote: false`, without `note.ID`.

Use analysis aliases **A** for this autosave identifier and **B** for the distinct
`note.ID` first visible in the preview response (135). The module, section, and
layout saves use A as their `noteID`. Preview sends `autosaveID=A`; its response
contains both `autosaveID=A` and `ID=B`. Subsequent metadata saves send both A
and B and receive both back. Preserve their separate meanings rather than
substituting one identifier everywhere. The exact server-side allocation timing
and lifecycle are not proven by their first appearance in responses.

All five save responses have `success: true`, a `note` object,
`networkCanPayoutRTG`, and `plaintextForVoice`. Later save responses do not echo a
status field. Their success flags confirm the save response, not a transition to
sent or queued state. All observed saves have `explicitSaveClick=false`; an
explicit save-button path is not characterized.

## Text content, sections, and layout

The observed single-text-module flow is:

1. `POST /composer/saveModule` (132) sends `noteID=A`, `noteType=email`,
   `type=text`, `column=1`, and `data[html]`. It returns `success: true` and string
   `itemID`. Here `type=text` means an email text module, not SMS delivery.
2. `POST /composer/saveSection` (133) sends `noteID=A`, `layout=1`, `size=normal`,
   and `spacing=0`. It returns `success: true` and string `sectionID`.
3. `POST /composer/saveLayout` (134) sends `noteID=A`,
   `sections[0][sectionID]`, and `sections[0][modules][]`, referencing the returned
   section and module IDs. It returns `success: true` and string `layoutID`.

All three requests are URL-encoded. Body HTML is not a `save2` field in this
capture; a metadata-only save is not evidence that content/layout was saved.
Updating existing modules, deleting/reordering content, multiple sections/columns,
images, attachments, buttons, and other module types remain uncharacterized.

The [fifth capture's module contracts](email-editing.md#module-save-contracts)
now characterize several of those types and both replacement and in-place
updates. Multiple sections are also observed there; multiple columns and
physical deletion remain unverified.

The preview's `sections` includes the saved text module. Its module `data` object
contains `html`, `ID`, `noteID`, `networkID`, and `noteType`. After form decoding,
the module HTML equals the submitted HTML and occurs in `previewHTML`. This is a
captured read-back of the content/layout flow, not proof of delivery or reopening
the persisted draft in a separate session.

## Preview can expose additional draft state

`POST /composer/preview` (135) sends a broad URL-encoded composer payload, including
`autosaveID=A`, `status=autosaved`, `newNote=false`, targets, title, sender, options,
and scheduling defaults. It has no request `ID` in this capture.

The response has `success: true`, `previewHTML`, `sections`, `title`, `fromName`,
`noteTargets`, `textingBillingData`, and `note`. The `note` object has
`status: draft`, `autosaveID=A`, and `ID=B`. Its target echoes are mostly strings,
while the top-level target list includes typed flags and nullable fields.

Preview is not established as a pure renderer: it first exposes a distinct note
ID and a draft status used by later saves. A future preview tool must account
for possible persistence/state changes rather than declaring the call read-only
from its name. Return controlled preview content/metadata rather than the whole
browser envelope; preview HTML remains content, not executable instructions.

## Draft options: scheduling preferences and comments

Saves 138, 141, 142, and 143 all send `status=draft`, `newNote=false`,
`autosaved=1`, `explicitSaveClick=false`, and `options[schedule]=true`.
They include `schedule[date_day]`, `schedule[date_time]`, and
`options[scheduleTime]`.

The decoded day uses `YYYY-MM-DD`; the time uses a 12-hour form such as `6:30pm`.
The combined `options[scheduleTime]` includes a date and time with an AM/PM marker
and no explicit timezone. The example time is fictional. Timezone, daylight
saving, validation, accepted variants, and the final scheduling action are
unverified. **These fields save scheduling preferences on a draft; they do not
establish that the note was queued.** The user's confirmation also establishes
that this session never sent the note.

`options[comments]` is true through save 142 and false in save 143.
`commentsExplicitlyClicked=true` appears in both 142 and 143. This provides a
draft-setting change with successful save responses, not evidence about deleting
existing comments or how permissions change on a published note.

## Form decoding and response validation

This HAR includes percent-encoded names and values in `postData.params` as well
as a raw `postData.text` body. For form analysis, parse the raw URL-encoded body
once with a form parser. Otherwise HTML and time values can appear still encoded,
and `+` characters can be misread. In this capture, correct decoding makes the
submitted module HTML match the preview content.

Do not double-decode actual content or apply form decoding to JSON requests.
Composer responses also vary in field types: initialized targets have typed
booleans/nulls; saved target echoes are string-valued; identifiers arrive as
strings or numbers in different objects. Validate the particular response rather
than treating form echoes as canonical typed domain data.

## Candidate MCP operations

These are task boundaries suggested by the evidence, not implemented interfaces
or validated minimal sequences.

| Candidate | Observed basis | Boundary |
| --- | --- | --- |
| `flocknote_create_email_draft` | Initialization, first metadata save, text-module/section/layout saves | A composite draft operation; preserve returned identifiers and partial progress. No send behavior is included. |
| `flocknote_update_email_draft` | Later metadata/settings saves on the same draft | Same-session updates are observed; loading/reopening arbitrary drafts and updating existing modules are not. |
| `flocknote_preview_email_draft` | HTML/section read-back and returned draft state | Preview may have state effects; do not assume it is read-only. |
| `flocknote_note_delivery_estimate` | Aggregate deliverability for the selected group | Estimates only; other target shapes, route semantics, and freshness need evidence. |
| `flocknote_email_templates` | Populated default-template summaries | Listing only; applying/copying templates is unobserved. |

Draft options could cover comments and retained scheduling preferences, but no
send-note or schedule-publication tool is established by this capture. Generic
raw composer payloads should not become public MCP arguments.

Draft creation spans several server operations. A later failure can leave
metadata, modules, sections, or layout saved independently. There is no observed
atomic transaction, idempotency key, cleanup contract, or safe automatic replay.
The existing unknown-write-outcome rule should remain applicable; preview also
needs an evaluated side-effect contract before retry/read-only claims are made.

## Additional bootstrap observation

The people-page response in entry 26 omits `subscribedMembers`, while containing
other people-page fields and `moreSubscribersExist: false`. Earlier captures
returned that array explicitly. This does not establish that a missing array
means an empty group; the response variant needs characterization before a future
member-list parser silently treats it as a successful empty result.

## Complete fourth-capture application-request inventory

Query flags are omitted in this index and described above. All listed requests
have HTTP 200 responses. The entry-check response at 57 has `success: false`;
the later composer operations have `success: true`.

| Method | Path | Count | Fourth-capture HAR entries |
| --- | --- | ---: | --- |
| GET | `/user/userData` | 1 | 1 |
| POST | `/signuplist/list` | 1 | 2 |
| POST | `/duplicate/getDuplicateCount` | 1 | 3 |
| POST | `/user/getOtherNetworks` | 1 | 4 |
| GET | `/dashboard/nextActions` | 1 | 5 |
| GET | `/dashboard/systemNotifications` | 1 | 6 |
| POST | `/group/{groupId}` | 1 | 25 |
| POST | `/group/{groupId}/people` | 1 | 26 |
| GET | `/group/{groupId}/getSubscriberCount` | 1 | 54 |
| POST | `/network/{networkId}/writeNewNote` | 1 | 57 |
| POST | `/composer/createNote` | 1 | 58 |
| POST | `/composer/deliverySummary` | 1 | 117 |
| POST | `/composer/getComposerTemplates` | 1 | 122 |
| POST | `/composer/save2` | 5 | 131, 138, 141, 142, 143 |
| POST | `/composer/saveModule` | 1 | 132 |
| POST | `/composer/saveSection` | 1 | 133 |
| POST | `/composer/saveLayout` | 1 | 134 |
| POST | `/composer/preview` | 1 | 135 |

## Remaining evidence gaps

- Entry-check success semantics and composer prerequisites/permission errors.
- Reloading an existing draft; loading/editing saved modules and themes.
- Required versus optional composer fields, additional targets, and template
  application.
- Partial-save reconciliation, duplicate behavior, cancellation, and idempotency.
- Other module types, multiple sections/columns, attachments, and layout edits.
- Scheduling timezone/validation and actual queued-publication behavior.
- Sending, test sends, delivery outcomes, deletion, and scheduled-send cancellation.
  None is established by this draft-only capture.

## Disposable-draft follow-up: explicit save and literal text

An authorized test-parish investigation on 2026-11-10 extended the HAR evidence
with JSON-response calls and Flocknote's public composer JavaScript. No send,
test-delivery, scheduling, SMS, or voice operation was requested. The following
findings describe this experiment, not an implemented draft-creation tool.

### Entry and explicit draft save

`handleWriteNewNoteResponse` in `https://static.flocknote.com/js/all.js` explains
why the entry response can contain `success:false` without blocking composition.
The UI branches on missing network settings, billing lockout, unverified billing,
admin billing requirements, pending card charges, a legacy `billingInfoNeeded`
value, and `clickSelectorToExecute`; it does not gate on `success`. A connector
must stop for unsupported branches, not execute selectors or bypass checks. The
test response had clear blocking flags and `openComposerAfter:true`.

`saveDraft` in
`https://static.flocknote.com/assets/composer2/js/email.js` drains the module queue
and calls `saveNote(true, true)`. This sets `autosaved=0`,
`explicitSaveClick=true`, and an empty `schedule`, then posts to `composer/save2`.
The experiment confirmed this path exposes a distinct draft ID without calling
`composer/preview`.

The tested sequence initialized one email and target, saved metadata to obtain
autosave ID A, saved a text module and section, linked their layout to A, then
explicitly saved the draft to obtain ID B. Reopening B through
`composer/editNote` confirmed draft status, email type, subject, target and
disabled scheduling, alternate routing and voice options. The inherited sender
name was initially returned as null. A subsequent explicit metadata save with
both A and B restored it; a fresh read confirmed the inherited sender and theme.
Do not assume the first successful save preserved every metadata field.

### HTML entities need a transport-specific encoding

Ordinary HTML escaping did not preserve literal text through the observed
save/read path. Submitted `&lt;b&gt;X&lt;/b&gt;` reopened as `<b>X</b>`.
An additional ampersand escape, `&amp;lt;b&amp;gt;`, also reopened as tags.
The effect occurred on the autosave reader too, before a final explicit save.
These observations do not locate the transformation within the upstream server.

A bounded encoding comparison found that escaped numeric references preserved
the intended text: submit `&amp;#60;` for a literal `<`, which reopened as
`&#60;`. The verified representation replaces each user-supplied `&`, `<`, `>`,
double quote and apostrophe with `&amp;#N;`, using that character's decimal code
point. Only the connector's wrapping `<div>` and newline `<br>` elements remain
markup. This is specific to the observed composer protocol, not a replacement
for ordinary HTML escaping elsewhere.

After saving a replacement module, relinking the layout and explicitly saving
the same owned draft, a fresh browser connection confirmed exact decoded text
and only `div`/`br` elements. Cases included literal `<b>` and `<script>` strings,
ampersands, quotes, apostrophes, accented text, an emoji, single and multiple
blank lines, Markdown punctuation, a URL, and literal entity-looking strings
such as `&lt;`, `&#60;`, `&amp;`, `&copy;`, and `&not;`. No supplied markup became
an element. This verifies persisted JSON content, not sent-email rendering.

### Cleanup and remaining limits

The experiment deleted only its owned draft B and autosave A with
`GET /note/{id}/deleteNote`, then reopened each and verified matching identity
and `status:deleted`. Despite its GET method, this endpoint is a write; it must
not enter a read-only allowlist. Deletion is experiment cleanup, not a proposed
automatic rollback for a user-facing draft tool.

The experiment proves a staged path to verified content and metadata, including
correction of its own disposable content. A clean single-pass client sequence,
input bounds, rejection/cancellation behavior, and partial-write reporting still
need implementation verification. Other group target shapes and arbitrary
composer options remain unsupported by this evidence. The reader's confirmed
status is required; HTTP 200 or `success:true` alone is insufficient.
