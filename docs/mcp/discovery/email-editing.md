# Email editing: fifth-capture discovery

This record extends [email drafting](email-drafting.md) with a fifth user-supplied
HAR of editing email content and layout. It characterizes richer modules,
replacement and in-place edits, section composition, preview read-back, and a
recent-color preference endpoint. These remain candidate contracts, not
implemented MCP tools or a supported upstream API.

Analysis was offline and documentation-only; no request was replayed. Credentials,
parish/member identities, group shortnames, subjects, sender names, content text,
and captured link/video values are excluded. IDs below are placeholders or
analysis aliases. HAR references are one-based positions in the **fifth**
capture's `log.entries` array.

## Coverage and lifecycle

The capture has 350 requests over approximately 183 seconds. Applying the same
exclusion of assets, templates, and unrelated origins leaves 58 application
requests across 23 method/path combinations. All indexed requests have HTTP 200
responses. The new composer path is `/composer/saveColorCollection`; most new
behavior uses previously observed save endpoints with richer payloads. The
initial group-shortname people URL is another newly captured path shape, not a
new structured member-list API.

Despite the editing activity, this flow initializes a **new** composer
(`createNote`, 187, with `noteInfo.newNote: true` and empty sections). It does not
show reopening an existing saved draft. The metadata save at 265 has
`status=autosaved`, `newNote=true`, `autosaved=1`, `explicitSaveClick=false`, and
`options[schedule]=false`, without an existing `ID` or `autosaveID`.

Its successful response yields autosave identifier **A**. All captured module,
section, and layout requests use A as `noteID`. Preview at 347 submits
`autosaveID=A` and returns `note.status: draft`, `autosaveID=A`, and a distinct
`note.ID`, **B**. This repeats the fourth capture's separate identifier pattern.
There are no later metadata saves in this capture.

No send, test-send, queued scheduling, scheduled cancellation, or note deletion
request is observed. The final preview is a draft. The user's explicit
never-sent confirmation concerned capture four; the fifth capture's conclusion
comes from its observed requests and draft response.

The entry check at 186 again returns `success: false`, followed by successful
composer initialization. Its success semantics remain unresolved as documented
in the fourth capture; repetition alone does not explain them.

## Module save contracts

All ten `POST /composer/saveModule` calls are URL-encoded. Common fields are
`noteID=A`, `noteType=email`, `type`, and `column=1`. Each response has
`success: true` and string-valued `itemID`. The outer `type` selects an email
module; it does not select a delivery channel.

| Module type | Observed data fields | HAR entries and limits |
| --- | --- | --- |
| `text` | `data[html]` | 266, 268, 270, 276. Saves without `data[ID]` return distinct IDs. HTML normalization rules and editing an existing text ID are not established. |
| `button` | Text, URL, subtype, dimensions, font, padding, gradient, and color fields listed below | 294, 300. The second save returns a new item ID and replaces the earlier button's layout reference. |
| `quote` | `data[quote]`, `data[author]` | 306. Only creation and preview read-back are observed. |
| `video` | `data[videocode]`, `data[videotype]` | 341. The observed provider is `youtube`; other providers and uploading video are not characterized. |
| `event` | `data[title]`, `data[details]`, `data[date]`; later `data[ID]` | 344, 346. A subsequent edit explicitly supplies the existing item ID and receives the same ID back. This is an email content block, not evidence of creating a separate calendar event. |

### Button fields and styling

Both button saves include:

```text
data[text], data[type], data[url], data[fontFamily],
data[fontSize], data[fontSizee], data[maxWidth], data[maxWidthInches],
data[outlookHeightInches], data[outlookLineHeight], data[padding],
data[backgroundGradientStart], data[backgroundGradientEnd], data[base64Gradient]
```

The observed inner `data[type]` is `url`, distinct from outer `type=button`.
The later button save (300) also includes `data[backgroundColor]` and
`data[textColor]`. Preserve the captured `fontSizee` spelling in the discovery
contract; whether it is required, ignored, or a UI artifact is unverified.
Dimensions and style values are form strings; units, allowable values, and
required-field combinations need validation. Presence of `base64Gradient` does
not establish that nonempty generated gradients were exercised.

The final preview returns these button data fields plus `ID`, `noteID`, and
`networkID`. This supports a styled-link block contract, not a generic attachment,
payment, signup, or event-registration action.

### Video and event read-back

The video preview data adds `url` and `iframeurl` to the saved `videocode` and
`videotype`, as well as identity/context fields. This characterizes server-returned
video metadata for the observed provider. It does not establish that arbitrary
embed HTML, arbitrary provider URLs, or media uploads are accepted.

The event save at 346 supplies `data[ID]` equal to the item returned at 344.
The response repeats that ID. The final preview matches the later title/details
and other submitted event fields, rather than the earlier title/details. The
date remains a content string; timezone, date validation, and structured calendar
semantics are unverified.

## Replacement saves and in-place edits

Module aliases **M1–M9** and section aliases **S1–S3** below identify returned
IDs without reproducing them. Ten module-save calls yield nine distinct item
IDs because the event edit reuses M9.

- M1 is a text module created at 266 and retained in the final layout.
- Text saves at 268, 270, and 276 return M2, M3, and M4. Successive layout saves
  reference M1 plus M2, then M1 plus M3, then M1 plus M4.
- Layout save 284 references only M1. This removes the other text module from the
  submitted layout, without a captured delete endpoint.
- Button saves 294 and 300 return M5 and M6. Later layout saves replace the M5
  reference with M6.
- Quote M7, video M8, and event M9 are subsequently included. The event edit at
  346 supplies `data[ID]=M9` and receives M9 back.

This establishes both a replacement-style sequence, where a new ID becomes the
active layout reference, and one explicit in-place update. Do not infer that
omitting `data[ID]` updates an existing module, or that all module types accept
the event module's update contract.

Omitting a module from layout is not proof that its server record is physically
deleted. No orphan cleanup, undo, physical module deletion, note deletion, or
rollback contract is observed. Replaying a create-style save could create another
module; replay safety and idempotency remain unknown.

## Sections and ordered layout

`POST /composer/saveSection` is called at 267, 342, and 343. All submit
`noteID=A`, `layout=1`, `size=normal`, and `spacing=0`. The latter two also submit
`animateIn=slide_down`. Each returns `success: true` and a distinct string
`sectionID`. `animateIn` is observed as a request field, not proof that animation
is meaningful in rendered email content.

Eight `POST /composer/saveLayout` calls submit `noteID=A`, indexed
`sections[n][sectionID]`, and repeated `sections[n][modules][]` form fields.
Their successful responses return `layoutID`.

The layout progression is:

| HAR entry | Submitted section/module references |
| --- | --- |
| 269 | S1: M1, M2 |
| 271 | S1: M1, M3 |
| 277 | S1: M1, M4 |
| 284 | S1: M1 |
| 295 | S1: M1, M5 |
| 301 | S1: M1, M6 |
| 307 | S1: M1, M6, M7 |
| 345 | S1: M1, M6, M7; S2: empty; S3: M8, M9 |

S2's `modules[]` is serialized as an empty form value in the final request.
Represent that as an empty section, not an invented empty-string module ID.
Preserve repeated module values and their order; flattening fields into a
single-value dictionary loses the layout.

Preview confirms the final three sections and ordered module references,
including the empty section. All saves use column 1, and all preview `col2.items`
arrays are empty. **Multiple sections are established; multiple-column editing
is not.** Pure reordering of a fixed set, editing an existing section, alternate
section layouts, section deletion, and spacing variants remain unverified.

## Preview and note-level style

`POST /composer/preview` (347) includes the broad composer payload from the
previous draft capture, plus `backgroundColor` and `textColor`. These top-level
style values are echoed in the response. They are distinct from a button's own
background/text colors. The capture does not separately reopen the note to prove
durable retention of these top-level style choices.

Preview returns `success: true`, `previewHTML`, note/sender/target metadata,
`sections`, style fields, and the draft state described above. The retained text,
later button, quote, video, and updated event module data match their decoded
save payloads. Replaced or omitted module IDs are absent from the final preview.
The initial event payload's title/details are superseded by its in-place edit.

This provides a useful content/layout read-back across the observed module
types. It does not prove a separate-session reload, full rendering in email
clients, video playback, link destinations, delivery, or atomic persistence of
all earlier writes. Preview's separate note ID still prevents treating it as a
proven side-effect-free renderer.

## Recent-color preferences

`POST /composer/saveColorCollection` is new in this capture (299, 308). It sends
URL-encoded `type=recents` and `colors[]`. Each observed request has one six-digit
hexadecimal color string **without a leading `#`**. Both responses contain
`success: true` and session/user metadata, with no returned collection ID.

The request has no `noteID`, `ID`, or `autosaveID`. Its name and `type` suggest a
recent-color picker preference, but user/network scope, merging/replacement,
ordering, retention, multiple colors, and other collection types are unverified.
It must not be assumed to persist a note's styling by itself. Module styles and
top-level preview styles have separate fields and evidence above.

This preference endpoint need not become an MCP tool just because the browser
uses it. Draft-editing tools can be defined around requested content and style
without exposing every editor preference operation.

## Implications for candidate MCP tools

The existing draft-tool proposals gain concrete evidence rather than requiring
one public tool per internal save request:

- `flocknote_create_email_draft` can now be scoped around the observed module
  types and multiple sections, rather than text-only content. Required fields,
  minimal sequences, and failure reconciliation still need verification.
- `flocknote_update_email_draft` has one same-session in-place event update and
  replacement/layout sequences for text and buttons. Arbitrary existing-draft
  loading and generic in-place updates are not established.
- `flocknote_preview_email_draft` has populated content read-back across these
  types and top-level styling, while retaining its unresolved state effects.

A structured content description should distinguish module types, sections,
ordered references, and note-level versus module-level styling. Preserve
partial-progress identifiers and the existing unknown-write-outcome rule. No
atomic transaction or safe automatic retry is established, and removing layout
references must not be advertised as verified permanent deletion.

## Other observations

The initial `GET /{groupShortname}/people` returns HTML and is distinct from the
structured `POST /group/{groupId}/people`. Its shortname matches a group in the
navigation response. It is presentation/navigation evidence, not a substitute
for structured group discovery.

The people-page response at 136 again omits `subscribedMembers`. This repeats the
fourth capture's missing-array variant without resolving its empty-list semantics.
Other bootstrap calls repeat earlier contracts; their presence does not add a
new feature merely because this capture includes them.

## Complete fifth-capture application-request inventory

Query flags are omitted in this index. Numeric identifiers and the initial group
shortname are replaced by role placeholders. Every listed request has HTTP 200;
the entry check at 186 has `success: false`, followed by successful composer
initialization and save responses.

| Method | Path | Count | Fifth-capture HAR entries |
| --- | --- | ---: | --- |
| GET | `/{groupShortname}/people` | 1 | 1 |
| POST | `/network/getMetadata` | 1 | 125 |
| GET | `/user/userData` | 5 | 126, 182, 272, 278, 315 |
| GET | `/permissions` | 1 | 127 |
| GET | `/navigation/groups` | 1 | 128 |
| POST | `/signuplist/list` | 5 | 129, 183, 273, 279, 316 |
| POST | `/duplicate/getDuplicateCount` | 5 | 130, 184, 274, 280, 317 |
| GET | `/prayerRequests/stats` | 1 | 131 |
| POST | `/user/getOtherNetworks` | 5 | 132, 185, 275, 281, 318 |
| POST | `/group/{groupId}` | 1 | 135 |
| POST | `/group/{groupId}/people` | 1 | 136 |
| GET | `/group/{groupId}/getSubscriberCount` | 1 | 175 |
| GET | `/backgroundjob/getJobs` | 1 | 181 |
| POST | `/network/{networkId}/writeNewNote` | 1 | 186 |
| POST | `/composer/createNote` | 1 | 187 |
| POST | `/composer/deliverySummary` | 1 | 251 |
| POST | `/composer/getComposerTemplates` | 1 | 256 |
| POST | `/composer/save2` | 1 | 265 |
| POST | `/composer/saveModule` | 10 | 266, 268, 270, 276, 294, 300, 306, 341, 344, 346 |
| POST | `/composer/saveSection` | 3 | 267, 342, 343 |
| POST | `/composer/saveLayout` | 8 | 269, 271, 277, 284, 295, 301, 307, 345 |
| POST | `/composer/saveColorCollection` | 2 | 299, 308 |
| POST | `/composer/preview` | 1 | 347 |

## Remaining evidence gaps

- Reopening existing drafts and fetching their editable module/layout data.
- Required module fields, accepted style units, content validation, other video
  providers, image/file uploads, and other module types.
- In-place edits for modules beyond the event block, explicit deletion/cleanup,
  undo, partial-write reconciliation, and replay safety.
- Multiple columns, alternate layouts, fixed-set reordering, existing-section
  updates/deletion, and nondefault spacing.
- Durable style retention, email-client rendering, link/video behavior, and
  recent-color collection scope/lifecycle.
- Actual sending, test sends, queued scheduling, and cancellation; none is
  established by these editing requests.

## Uploaded photo modules

A later image capture establishes a multipart `POST /upload/photo/note` with
`qquuid`, `qqfilename`, `qqtotalfilesize` and binary `qqfile`. A rejected WebP
upload returned HTTP 200 with `success: false`; a JPEG upload returned
`success: true`, numeric `photoID`, hosted `url` and `s3: true`. HTTP success
alone does not establish an accepted upload. The captured browser uploader sets
`sizeLimit: 12000000`; the server's exact byte boundary remains unverified.

The composer saves the image with `POST /composer/saveModule`, using
`noteType=email`, `type=photo`, `column=1`, `noteID` and `data[photoID]`.
The returned module ID goes into the existing `saveLayout` module list. The UI
first saved an empty photo placeholder, then replaced its layout reference after
uploading. Controlled disposable test-parish probes confirmed that directly
saving the populated module works without that placeholder.

JPEG, PNG and GIF uploads were accepted in those probes. Reopening through
`composer/editNote` returned the saved photo IDs in the requested order, with
`data.ID`, `noteID`, `networkID`, `photodimensions` (numeric `width`/`height`) and
`photourl`. Preview also included `noteType`; reopened data did not require it.
Only default appearance was exercised. Cropping, linked images, custom dimensions,
HEIC conversion, animation fidelity and delivered-email rendering remain unverified.

Uploads and module saves are separate writes. An upload timeout can leave its
outcome unknown, and an uploaded asset can survive a later draft failure. Neither
this capture nor the probes establish an asset rollback/delete contract. Do not
replay an uncertain upload or infer its absence solely from recent-image listings.

## Native duplication

The duplicate action uses `POST composer/duplicateNote` with `groupID` empty,
`noteID` set to the source and `fromComposer=1`. A controlled test-parish probe
returned `ID: 0`, a new `autosaveID`, `duplicate: true`, `status: autosaved` and
empty targets. Raw section/module content and layout survived the copy, while
section/module IDs and a photo ID changed; image URL and dimensions did not.

An explicit `composer/save2` with the original groups, `ID: 0`, the new autosave
identity, `autosaved: 0` and `explicitSaveClick: true` materialized a distinct
draft. A second metadata save using the final ID and `status: draft` was needed
to restore the sender label; the first reopened draft had `fromName: null`.
The second save response omitted status, so the final `composer/editNote`
read-back establishes it. The source remained unchanged. No module/layout saves,
uploads, sending or scheduling were used. Only one ordinary group and observed
single-column text/photo/URL-button content were exercised live.
