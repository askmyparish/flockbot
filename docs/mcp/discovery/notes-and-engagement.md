# Notes and engagement: third-capture discovery

This record extends [member browsing](member-browsing.md) and the
[populated-parish follow-up](populated-parish-browsing.md) using a third
user-supplied HAR. It documents note search, opening a note, and inspecting its
engagement information. These are outbound Flocknote communications, distinct
from the member-profile notes/remarks endpoint in the first capture.

A [fourth capture](email-drafting.md) fills part of the composition gap with
draft initialization, content/layout saves, preview, and draft-option changes.
The user confirmed that it was only drafted, never sent. References and absence
claims below continue to describe the third capture alone.

Analysis was offline and documentation-only. No captured request was replayed.
Credentials, parish/member identities, recipient addresses, note titles/content,
and captured search terms are excluded. Paths use placeholders. All HAR entry
references here are one-based positions in the **third** capture's `log.entries`
array, not references to either earlier capture.

## Coverage and useful additions

The capture contains 100 requests over approximately 65 seconds. The same
exclusion of assets, templates, and unrelated origins leaves 15 application
requests across 11 method/path combinations. Twelve have HTTP 200 responses;
three global-search requests have status 0 with an aborted-request indication.
Six combinations were absent from the two earlier inventories, all related to
opening a note, comments, or note-level analytics.

The captured sequence is:

1. Session/bootstrap calls (1–4).
2. Global search, with three aborted calls followed by one populated response
   (28, 30, 31, 32).
3. Opening a search-result note, loading its analytics summary and comments
   (61, 72, 73).
4. Opening fuller analytics, searching those analytics, and requesting opened and
   unopened recipient categories (83, 97, 98, 100).

All note-related paths, including the comment path, use the same numeric path
identifier, which matches a note ID in the search results. Only one note's
analytics is characterized; coverage across other note types is unverified.
No compose, draft-save, schedule, send, delete, comment-create, or membership-write
request is observed.

## Global search now includes note results

`POST /supersearch/query?ajax` sends URL-encoded `searchTerm`, `networkID`, and
repeated `filters[]` fields. The observed filter values are `note`, `event`,
`file`, `user`, `group`, and `comment`, matching the broad search from the first
capture. The `ajax` flag has an empty value.

Entry 32 returns `success: true`, `searchTerm`, `searchFilters`, `totalHits`, and
`searchResults`. All 30 returned results have `entityType: note`. Each includes
`noteID`, `entityID`, `noteTitle`, `noteTargets`, `type`, `commentCount`, `date`,
`author`, and `canViewUser`. Some also include `plainText` and `previewURL`.

Offline reinspection of entry 32 establishes that `searchFilters` is an object
with boolean values, not an array echo of `filters[]`. It includes the six
requested keys plus `userDocument: true`. `searchTerm` exactly matches the
submitted term. `totalHits` is a nonnegative integer and `searchResults` is an
array. Each captured note has matching numeric `noteID` and `entityID`, a string
`noteTitle`, a positive integer `date`, and an array of `noteTargets`. The numeric
date alone does not establish its unit, timezone, or original-send semantics.
Target records contain string `type` and `name`, numeric or string `entityID`,
and sometimes numeric `groupID`; do not expose non-group target identities as
group metadata.

Observed `type` strings include `email`, `sms`, and `scheduled`. Do not treat
this field as a pure delivery-channel enum: one observed value describes
scheduling state. The capture does not establish whether a scheduled result has
already been sent or a complete set of possible type values.

`noteTargets` vary by result. Some have `groupID`; target `entityID` values can
be numbers or strings. `author` contains a user identifier and name. Normalize
identifiers without requiring all targets to share a group-only shape. Text
previews and author/target names are optional output data, not necessary for
every search task. The internal `$queryString` field should not become a tool
result.

**`totalHits` exceeds the returned result count.** There is no captured search
pagination input or subsequent search page. Because the request includes multiple
entity types, the capture also does not prove that `totalHits` is a note-only
count. A future tool must not report these 30 items as an exhaustive result set.
A note-only filter request remains unverified; all returned results happening to
be notes is not evidence that only notes were requested.

The first capture established group results from this same broad search. Together
the captures support a search tool that validates heterogeneous result shapes
and reports incompleteness, rather than a parser expecting only groups or only
members.

## Opening a note is an HTML-bearing response

`POST /note/{noteId}?ajax` (61) has no observed body fields. Its JSON envelope
contains `mainHTML`, `assets`, `hasAssets`, `isReplyToGiveNote`, and session/user
metadata; it has no top-level `success` field.

This establishes a note-view request, not a clean structured note-body contract.
A future note-content operation would need separately validated extraction or a
structured content endpoint. Do not return or execute the full `mainHTML` or
load its asset scripts as an MCP result. Search `plainText` is an optional preview,
not proof of complete note content.

### Follow-up: structured editor content

A separate, authorized test-parish investigation on 2026-11-10 examined the
public `js/startComposer.js` Edit handler and exercised its request without
running the editor:

```text
POST /composer/editNote
Content-Type: application/x-www-form-urlencoded
noteID=<existing-note-id>&fromComposer=1
```

For one existing published email containing a single text module, the response
had `success: true` and `noteInfo` with the matching `ID`, `type: email`,
`status: published`, `newNote: false`, and `duplicate: false`. `autosaveID` was
absent. `noteInfo.sections[]` contained ordered `col1.items[]` and `col2.items[]`;
the text item had `type: text` and `data.html`, plus module/note/network IDs.
The response also contained unrelated composer configuration, available groups,
targets and user context that a content reader must not expose.

This is structured content layout, not HTML-free content: the observed text
module still requires HTML-to-Markdown conversion. Its normalized readable text
matched the ordinary note view's `.email_sections` content. The ordinary view
had one `.page_note[data-noteid]` matching the requested identity and a
`.note_type_email` class; comments, author information and controls were outside
the email body container.

Across two editor-entry requests, the published listing's ID, edit date,
autosave reference and status remained unchanged. On the second request the
ordinary note-view HTML was also identical before and after. No editor scripts,
save, preview, send, duplicate or delete operations were executed.

**These checks do not establish a generally read-only endpoint.** They cover
one published text-only email, not drafts, SMS, rich modules, alternate
permissions, hidden server state or concurrent editing. The editor-entry route
is a candidate JSON source, not yet a validated replacement for the ordinary
note view in a read-only MCP tool. A successful response or an unchanged listing
must not be treated as proof that no other state changed.

### Follow-up: disposable email and SMS drafts

A second authorized test-parish experiment created two unsent, unscheduled drafts:
an email with two sections containing text, quote, button and text modules, and
an SMS with one text module. Initialization, autosave, module/section/layout saves
and preview materialization used the composer flow documented in
[email drafting](email-drafting.md). Preview supplied a distinct draft ID for
each autosave ID. The public SMS composer source also uses text modules with
`data.html`; that field is not exclusive to email HTML.

After closing and reopening the browser connection, two `editNote` calls per
draft returned matching IDs and channel types, `status: draft`, `newNote: false`,
`duplicate: false`, and scheduling disabled. Section and module order matched
the saved content. Text, quote author/text, button text/URL and submitted button
style fields matched; text comparison used decoded, whitespace-normalized text.
The server changed email paragraph tags from `p` to `div` and encoded text
entities. Returned headings, emphasis, list items and the text-module link
remained present. SMS retained its text in a text module, without HTML tags.

The two editor responses agreed on identity, title, status, options and the
projected section/module data. Preview and editor response objects were not
byte-identical: preview text-module data included `noteType`, which was absent
from editor data. Do not use whole-envelope equality as the content contract.
The ordinary `POST /note/{noteId}?ajax` draft responses were HTML strings without
the published note's JSON `mainHTML` envelope or a `.page_note` root. They were
not used as content sources, and no returned scripts were executed.

Cleanup deleted both draft IDs and both autosave IDs. Read-back through
`editNote` reported `status: deleted` for all four, while still returning
`success: true` and content. **A successful editor response does not establish
that a note is available.** A content reader must validate identity and status
before exposing a body; deleted content needs an explicit policy rather than
being silently returned as an ordinary note.

No send, scheduled-publication or forwarding endpoint was called. These tests
establish the observed draft content contracts and repeatability, not universal
absence of server-side effects. Alternate permissions, scheduled notes, other
module types, populated second columns, concurrent edits and hidden state remain
unverified.

## Per-note analytics

### Compact analytics summary

`GET /note/{noteId}/analyticsSummary?ajax` (72) returns `success: true`, `note`,
`counts`, capability/context flags, and assets. The `note` object includes string
`ID`, `title`, `date`, `author`, `type`, numeric `dateTime`, and `noteTargets`.
This is another place where a note ID arrives as a string even though path and
search-result identifiers are numeric in the capture.

The numeric `counts` fields are:

```text
opened, unopened, bounced, complaint, sms, total,
voicecalls, clicks, unsubscribes
```

Summary targets have variant shapes: group targets include group metadata and
flags such as `includeContacts`, `isSmartGroup`, and `isFilteredGroup`; another
target uses an `entityIDs` array. A target list must not be assumed to consist
only of named groups.

### Fuller analytics and sending summary

`GET /note/{noteId}/analytics2?ajax` (83) returns `success: true`, note metadata,
the same `counts` keys, `sendingSummary`, `highlights`, `hourGraphData`,
`noteSpamPoints`, flags, and assets. The numeric counts match the compact summary
for the one captured note. This does not establish that independent calls always
represent an atomic snapshot.

Each observed sending-summary item includes `fromName`, `fromUserID`, numeric
`fromDate`, `targets`, `totalRecipientCount`, and `superTextingCreditsUsed`.
`totalRecipientCount` is a decimal-count string, unlike the numeric aggregate
counts. Targets include a group-shaped item and a user-shaped item. Do not
assume the sender or target metadata is needed for an aggregate statistics task.

`highlights` contains presentation text/subtext and optional tab fields;
`hourGraphData` is a numeric-keyed map of numeric values. Neither establishes a
timestamp unit, timezone, or interpretation of distinct recipients versus events.
`noteSpamPoints` is boolean in this response, despite its name.

The capture does not establish count formulas, mutually exclusive categories,
tracking completeness, or whether every note type has the same metrics. Expose
upstream categories as observed rather than deriving undocumented totals or
claiming that a reported open proves a person read a message.

### Recipient detail categories

`POST /note/{noteId}/detailedAnalytics?ajax` accepts URL-encoded `type` and `page`.
The two observed requests are:

```text
type=opened&page=1
type=unopened&page=1
```

Entry 98 returns 25 opened records; entry 100 returns four unopened records.
For each category, `totalRecords` equals that response's record-array length.
Both responses have `success: true`, echo string-valued `type` and `page`, and
return numeric `totalRecords`. These are two category requests for page 1,
**not successive pages**. A page input is observed, but page 2, fixed page size,
empty categories, sorting, filters, and termination behavior remain unverified.

Records contain `address`, `userID`, `fname`, `lname`, `service`, and
`targetContacts`. The latter is empty in every captured record; nonempty target
contact structure is unknown. These records carry recipient contact data.
A future operation should return only fields needed for the requested task and
use aggregate `counts` when identities are unnecessary. Do not assume the same
record schema for unobserved categories such as clicks, bounces, or SMS.

### Search within analytics

`POST /note/{noteId}/searchAnalytics?ajax` (97) sends URL-encoded field `s`.
The response has `success: true`, echoes `s`, and returns `results: []`.
This establishes an empty search envelope only. Matching behavior, populated
result fields, category scope, and paging are unknown; it is not yet a validated
shortcut for finding a recipient's delivery status.

## Comments

`POST /comment/{noteId}/getComments` (73) has no observed body fields. Its numeric
path segment equals the selected note's ID; it should not be treated as the ID
of an individual comment on this evidence. The request includes an empty-valued
timestamp-like query key, consistent with cache busting; its necessity is unproven
and its literal value is not a stable parameter contract.

The response has `success: true`, `comments: []`,
`commentNoteNotificationPreference`, `commentNoteNotificationPreferenceRoute`,
`userHasEmail`, `userHasPhone`, `noteAllowPublicComments`, `commentPermission`,
and assets. Empty comments do not characterize comment items, threading,
pagination, or creating/deleting comments. The notification-preference route is
UI metadata, not evidence that a notification-setting operation was exercised.

## Candidate MCP additions

Names and scope below are proposals; no tools are added by this document.

| Candidate | Observed basis | Boundary |
| --- | --- | --- |
| `flocknote_search` | Broad search returning groups in capture one and notes here | Validate each result kind; preserve truncation and distinguish total hits from returned items. Note-only search and further pages remain unverified. |
| `flocknote_note_analytics` | Compact summary and fuller analytics with populated counts | Default to aggregate fields; sending/target details and graph data can be optional. Other note types and permissions remain unverified. |
| `flocknote_note_recipients` | Populated `opened` and `unopened` detail records | Support only validated category contracts; page 2 and other record types need evidence. Return contact details only when required. |

Note-content retrieval, note comments, and recipient-status search remain useful
discovery targets, but the HTML-only or empty responses above do not yet establish
their complete data contracts. The communication analytics requests do not imply
send/edit/delete operations or permission to replay requests.

## Complete third-capture application-request inventory

Query flags are omitted in this index and described above. Counts collapse
numeric IDs by role. Three search requests are aborted; the other indexed
requests have HTTP 200 responses.

| Method | Path | Count | Third-capture HAR entries |
| --- | --- | ---: | --- |
| GET | `/user/userData` | 1 | 1 |
| POST | `/signuplist/list` | 1 | 2 |
| POST | `/duplicate/getDuplicateCount` | 1 | 3 |
| POST | `/user/getOtherNetworks` | 1 | 4 |
| POST | `/supersearch/query` | 4 | 28, 30, 31, 32 |
| POST | `/note/{noteId}` | 1 | 61 |
| GET | `/note/{noteId}/analyticsSummary` | 1 | 72 |
| POST | `/comment/{noteId}/getComments` | 1 | 73 |
| GET | `/note/{noteId}/analytics2` | 1 | 83 |
| POST | `/note/{noteId}/searchAnalytics` | 1 | 97 |
| POST | `/note/{noteId}/detailedAnalytics` | 2 | 98, 100 |

## Remaining evidence gaps

- Search pagination and note-only filtering; additional result/entity types.
- Structured full note content; access to scheduled, SMS, archived, and other
  note variants beyond search previews.
- Analytics permissions, additional note types, metric definitions, timestamp
  units, and graph timezone/label interpretation.
- Further detail pages, empty detail categories, other detail types, and
  populated `targetContacts`.
- Populated analytics-search and comment results, with ordering and pagination.
- Any composition, scheduling, sending, editing, deletion, or comment writes.
  None is established by this capture.
