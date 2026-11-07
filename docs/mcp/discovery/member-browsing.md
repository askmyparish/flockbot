# Member browsing: observed internal API

This discovery record documents a user-supplied HAR captured while browsing a test
parish, opening member profiles and tabs, searching people, viewing analytics, and
editing a phone number. It proposes future MCP operations; it does not add tools
or establish a supported upstream API contract.

A [second capture from a parish with more data](populated-parish-browsing.md)
adds member-list pagination, non-demo analytics, signup-list details, navigation
hierarchy, capability discovery, and prayer-request statistics. Unless explicitly
labeled as follow-up evidence, counts and HAR entry references in this document
refer to the first capture only.

A [third capture](notes-and-engagement.md) adds populated note-search results,
per-note engagement summaries, sending information, and recipient-detail
categories. It does not add evidence about profile notes/remarks or member edits.

A [fourth capture](email-drafting.md) documents email drafting, content/layout
saves, previews, and draft settings. The user confirmed that the note was never
sent. Scheduling fields in draft saves do not establish queued delivery.

A [fifth capture](email-editing.md) adds richer email modules, replacement and
in-place module edits, multi-section layout saves, and recent-color preferences.
Its final captured preview is a draft; no sending operation is observed.

Analysis was entirely offline. No captured request was replayed. The raw HAR,
credentials, parish identity, member identities, and contact values are excluded
from this document. Paths use placeholders instead of captured identifiers.

## Capture coverage and evidence

The capture contains 289 requests over approximately 158 seconds. After excluding
assets, templates, and unrelated origins, 64 application requests remain across
38 method/path combinations. Of those requests, 61 have HTTP 200 responses and
three global-search requests have status 0 with an aborted-request indication.
Two HTTP 200 household responses explicitly contain `success: false`.

Evidence references below are one-based positions in the original HAR's
`log.entries` array. They identify observations without embedding raw responses.
Names such as Member A and Member B are analysis aliases, not upstream names.

The observed sequence was:

1. Global search, then opening a group's people page (entries 15–61).
2. Opening Member A and exploring profile tabs (66–166).
3. Filtering people, opening the spreadsheet view, and viewing analytics
   (188–220).
4. Opening another group's people page and Member B (246–262).
5. Submitting a phone edit, refreshing supporting profile information, opening
   contact history, and filtering people again (269–280).

This sequence is reconstructed from requests. Click intent and durable server
effects cannot always be established from the HAR alone.

## Candidate MCP tools

These names are proposals. The existing connector already supports group
discovery, subscriber counts, and adding members; this capture suggests additional
operations around locating and inspecting existing members.

| Candidate | Observed internal requests | Evidence and limits |
| --- | --- | --- |
| `flocknote_find_members` | `POST /group/{groupId}/filter` | Three successful searches return structured member results and `resultCount`. Strong first candidate. General text search is observed; other filter combinations and pagination are unverified. |
| `flocknote_group_members` | `POST /group/{groupId}/people?ajax`; follow-up: `POST /group/{groupId}/people/{offset}?ajax&more` | Structured subscriber lists include pending members, permissions, filter metadata, and `moreSubscribersExist`. The follow-up captures two distinct 100-member pages with offset `100`; final-page behavior remains unverified. |
| `flocknote_member` | `POST /user/{userId}/profile` | Two profiles returned names, contact fields, verification flags, and capability flags. Return selected domain fields, excluding UI assets and administrative/session capabilities. |
| `flocknote_member_groups` | `POST /user/{userId}/groups` | Returns subscribed and available groups, membership flags, and channel preferences. Preference meanings and changing membership/preferences are not established. |
| `flocknote_member_household` | `GET /user/{userId}/householdDetail` | Three structured household responses, each with one member. Multi-member relationships, addresses, and possible household materialization need further evidence. |
| `flocknote_member_contact_history` | `GET /history/contact/{userId}` | One populated edit-history response with actor metadata, timestamps, and email/phone record types. Paging, ordering guarantees, and full value semantics are unverified. |
| `flocknote_member_delivery_status` | Profile fields plus `GET /user/suppressions?userID={userId}` | Profile responses include bad-email, verification, and stop-reply fields. Both suppression responses have empty `groups`, so a populated suppression contract is missing. This is a possible combined tool, not an established delivery diagnostic. |
| `flocknote_member_permissions` | `POST /user/{userId}/permissions` | Two responses contain `data.privs` and capability flags. A tool should expose only relevant roles/capabilities; changing permissions was not observed. |
| `flocknote_update_member_phone` | `POST /user/{userId}/updateContactInfo?ajax` | One phone update returned `success: true`. No phone-bearing read-back established durable persistence. Email updates, clearing a phone, notification effects, validation errors, duplicate matching, and replay safety remain unknown. |

The first useful implementation batch would be member search, group members,
member profile, and member groups. Household and contact history have useful
structured responses but narrower coverage. The phone-write contract should be
documented now and verified separately before implementation.

## Observed request contracts

### Search within a group

`POST /group/{groupId}/filter` accepts URL-encoded bracketed form fields. All three
observed requests use the same filter structure:

```text
request[and][0][or][0][and][0][filterID] = 3
request[and][0][or][0][and][0][isNegated] = false
request[and][0][or][0][and][0][inputs][searchTerm] = Alex
includeInactive = false
```

`Alex` is a fictional example, not a captured search value. The enclosing people
response identifies this filter as `generalPeopleSearch`, with filter ID `3`,
operator `Search`, and input `searchTerm` (entry 49). Future implementations should
validate that metadata rather than assume all parishes share a permanent ID.

The captured `peopleFilterInfo.generalSearchFilter` has a numeric `filterID`,
`filterName: "generalPeopleSearch"`, `operator: "Search"`, and
`inputs.searchTerm` with `inputName: "searchTerm"`, `dataType: "text"`, and
boolean `allowMultiple: false` (49, 250). These are observed metadata values,
not a guarantee that unsupported metadata variants can be interpreted safely.

Entries 188, 252, and 280 return `success: true`, `resultCount`, and `results`.
Result fields include `userID`, `fn`, `ln`, `mail`, `phn`, verification flags,
membership/role flags, and photo information. No pagination input, sorting input,
or search with `includeInactive=true` was exercised.

In these filter responses, `userID` is numeric and `fn`, `ln`, `mail`, and
`phn` are strings; the contact-verification keys are specifically boolean
`mailVer` and `phnVer`. Numeric verification flags are documented for the
follow-up's group-people rows, rather than observed in these filter rows.
Null, blank and missing search-contact fields used in offline edge-case tests
are simulated, not additional capture observations.

### List a group's members

`POST /group/{groupId}/people?ajax` sends `includeUnsubscribed`. Entries 49 and
250 return structured data including:

- `subscribedMembers` and `pendingMembers`;
- `moreSubscribersExist`;
- `canAdmin`, `canViewInactiveMembers`, and `userCanAddMembers`;
- `peopleFilterInfo.generalSearchFilter` and available filter definitions.

The same path with GET returns HTML. The POST response also contains `mainHTML`,
assets, and callback information alongside member data. An MCP operation should
extract structured fields without returning or executing the UI content.

Follow-up evidence now establishes an additional-page request with an offset
segment and exposes two subscriber-row formats with different flag types. See
[pagination and member schemas](populated-parish-browsing.md#group-member-pagination-and-row-variants).

The fourth capture also has a people-page envelope that omits
`subscribedMembers`. See the [additional bootstrap observation](email-drafting.md#additional-bootstrap-observation);
missing member arrays should not silently become confirmed empty lists.

### Read a member profile

`POST /user/{userId}/profile` has no observed form fields. Entries 66 and 255 return
`success`, `userInfo`, profile-view capabilities, available tabs, and assets.
`userInfo` includes names, email, mobile and landline fields, pending-contact
fields, verification flags, archived status, language, household information,
bad-email status, and stop-reply information.

Member A's response has `success: true`, a nonempty error, and
`canEditContactInfo: false`; Member B's permits contact editing. A top-level
success flag does not imply that every profile capability is available.

The contact-bearing keys are `userInfo.userID`, `firstName`, `lastName`,
`email`, `emailVerified`, `pendingEmail`, `mobilePhone`,
`mobilePhoneVerified`, and `pendingMobilePhone`. Email is a string in both
profiles; mobile phone is a string in one and null in the other. Both pending
contact fields are null in these observations. `isBadEmail` is a boolean and
can be true while an email value is present. A stored address therefore does
not establish verification or deliverability. Non-null pending contacts and
missing email values still require separate fixture/contract evidence.

Both profiles have `canViewProfile: true` at the top level and in `userInfo`.
`canEditContactInfo` governs editing, so its false value alone must not be
interpreted as denial of a contact read. `userInfo.userID` matches the requested
person; the top-level `userID` does not in either response. Do not validate the
requested person's identity against that top-level field.

`POST /user/{userId}/profile2` is a separate supporting response: it contains
identifiers, household linkage, merge-related capability/state fields, and giving
configuration. It is not a replacement for the contact-bearing profile response.

`POST /user/{userId}/getAdditionalContactInfo` succeeds three times, but its
`additionalContactInfo` arrays are empty. Nonempty additional-contact records have
not been characterized.

### Read memberships

`POST /user/{userId}/groups` returns `data.subscribedGroups`,
`data.availableGroups`, `data.networkPreferences`, `canView`, and `canEdit`
(entry 86). Subscribed entries include group IDs/names, Everyone status,
`isSubscribed`, `emailPref`, `smsPref`, `voicePref`, `commentsPref`, and role flags.
Available groups also include parent IDs and disabled/smart-group fields.

In entry 86, `data.canView` is true and all seven `subscribedGroups` rows have
boolean `isSubscribed: true`. Its four `availableGroups` rows omit
`isSubscribed`. The captured groups-tab JavaScript (entry 87,
`/assets/userprofile/tabs/groups.js`) explicitly handles proxy-only entries in
`subscribedGroups` with `isSubscribed: false`, filtering on that flag when
determining actual subscriptions. This is evidence from the captured UI code;
the JSON capture itself has no proxy-only row. Array inclusion alone must not
be treated as a confirmed subscription. An available-group row has no explicit
subscription flag, and absence from the response is not independently proven
to be an exhaustive negative membership result.

The membership envelope's top-level `userID` also differs from the requested
person. The request path selects that person; the captured `data` object has no
separate subject-user identifier or explicit completeness/pagination field.

This response provides membership and preference information. It does not prove a
contract for subscribing, unsubscribing, or updating channel preferences.

### Read household details

`GET /user/{userId}/householdDetail` returns `householdProfile`, including a
household identifier, names, address, members, and household flags (75, 185, 258).
Member entries include identifiers, names, head-of-household/child/archive flags,
and spouse/birthday/age fields, with several fields null in this capture.

There is an unresolved state change: each member's earlier `profile2` response has
a null `householdID`; later `profile2` responses have a non-null `householdID`
(73 → 184 and 256 → 271). Household details were loaded between those observations.
This could reflect lazy creation, normalization, or another server/UI action.
The capture does not establish the cause. Even a GET endpoint should not be
declared side-effect-free on method alone.

`POST /family/getHouseholdDataForProfile`, with a `userID` form field, returns
HTTP 200 but `success: false` and error/message fields on both attempts (89, 262).
`POST /user/{userId}/householdInfo` returns assets and a success envelope without
household records. These endpoints are not interchangeable with `householdDetail`.

### Update a phone number

Entry 269 submits the following form to
`POST /user/{userId}/updateContactInfo?ajax`:

```text
changeOrigin = profile
type = phone
phone = +1 (202) 555-0123
```

The number is fictional. The response has `success: true`, `editingUserID`,
`type`, `verified`, `mobilePhone`, `mobilePhoneVerified`, `pendingMobilePhone`,
`carrier`, and `landPhone`. Supporting profile requests follow the update, but
they do not provide an independent phone-bearing read-back in this capture.

Only this phone branch is observed. Do not infer email/name/address updates from
the endpoint's broad name. Preserve the existing no-automatic-replay rule for
writes whose outcome becomes unknown.

### Read contact history

`GET /history/contact/{userId}` returns `success: true` and a populated
`editHistory` array (276). Entries include `createdBy`, `createdAt`,
`isSuperDuperAdmin`, `responses`, and `isSync`. Response items have `recordType`
and `value`; email and phone types are observed. The path's ID matches the edited
member's ID. History values are not reproduced here.

## Other useful discoveries and limits

- **Global search:** `POST /supersearch/query?ajax` sends `searchTerm`,
  `networkID`, and repeated `filters[]` values: `note`, `event`, `file`, `user`,
  `group`, and `comment`. Three calls are aborted, followed by one successful
  response containing group results (15, 17, 18, 19). Member results are not
  observed here; the group-filter search has stronger evidence for finding
  people. Preserve repeated form parameters when documenting or implementing it.
  The [third capture](notes-and-engagement.md#global-search-now-includes-note-results)
  adds note-result shapes and evidence of a truncated search response.
- **Duplicate count:** `POST /duplicate/getDuplicateCount` returns
  `numberOfDuplicates` (3). Duplicate details and merging are not observed.
- **Signup lists:** `POST /signuplist/list` returns populated `signupLists`,
  templates, and capability flags (2, 284, 288). Listing available signups is a
  plausible future tool; viewing slots, registering, and cancelling are absent.
- **Spreadsheet view:** `POST /group/{groupId}/sheet?ajax` sends
  `includeUnsubscribed` and returns a nonempty `sheetURL` plus UI metadata (193).
  This does not establish a spreadsheet download or export API.
- **Analytics:** `GET /network/{networkId}/unolyticsData` returns summary metrics;
  `POST /unolytics/{networkId}/getReport` accepts `startDate`, `endDate`,
  `reportType`, and `fakeData`. The observed report type is `notesSent`.
  **The screen has `showFakeUnolyticsData: true`, and the report request explicitly
  sends `fakeData=1`.** Shapes are useful discovery evidence; these figures do not
  establish real parish reporting behavior. The summary endpoint also accepts a
  date range, but its real-data behavior is not proven in this demo context.
  The [follow-up capture](populated-parish-browsing.md#analytics-outside-demonstration-mode)
  resolves the demo-mode limitation: it has the fake-data flag disabled, populated
  report rows, and date-range requests without `fakeData`.
- **Profile notes, documents, and activity:** the respective responses contain
  empty `data.notes`, `data.documents`, and `data.newsfeed` arrays. These show
  retrieval entry points, not populated item schemas or create/update contracts.
  Profile notes/remarks should not be conflated with outbound Flocknote messages.
- **Medical:** `/medical` loads assets; GET `/medicalInfo` returns medical and
  emergency-contact structure with empty/null content. Populated records and
  editing are not observed.
- **Sacraments:** `/sacraments` returns assets and a success envelope. It does not
  provide a characterized sacramental-record API in this capture.
- **Giving:** `/giving` returns permission, household, pledge, and payment-UI
  configuration. No populated giving transaction/history contract is observed.
- **Other networks:** `/user/getOtherNetworks` includes credential-bearing
  `USERTOKEN` fields in its response. Its raw payload is unsuitable for tool
  results or fixtures. It is not needed for the proposed member tools.

## Complete application-request inventory

Counts collapse distinct numeric IDs into placeholders. This inventory includes
UI-loading calls as well as structured-data calls; presence here does not imply
that a path should become an MCP tool or that it is safe to replay.

| Method | Path | Count | HAR entries |
| --- | --- | ---: | --- |
| GET | `/user/userData` | 1 | 1 |
| POST | `/signuplist/list` | 3 | 2, 284, 288 |
| POST | `/duplicate/getDuplicateCount` | 1 | 3 |
| POST | `/user/getOtherNetworks` | 1 | 4 |
| GET | `/dashboard/nextActions` | 3 | 5, 285, 289 |
| GET | `/dashboard/systemNotifications` | 3 | 6, 283, 287 |
| POST | `/supersearch/query` | 4 | 15, 17, 18, 19 |
| POST | `/group/{groupId}` | 2 | 29, 246 |
| GET | `/group/{groupId}/people` | 2 | 46, 247 |
| POST | `/group/{groupId}/people` | 2 | 49, 250 |
| GET | `/group/{groupId}/getSubscriberCount` | 2 | 61, 251 |
| POST | `/user/{userId}/profile` | 2 | 66, 255 |
| POST | `/user/{userId}/profile2` | 4 | 73, 184, 256, 271 |
| POST | `/user/{userId}/getAdditionalContactInfo` | 3 | 74, 257, 270 |
| GET | `/user/{userId}/householdDetail` | 3 | 75, 185, 258 |
| POST | `/user/{userId}/groups` | 1 | 86 |
| POST | `/family/getHouseholdDataForProfile` | 2 | 89, 262 |
| GET | `/user/suppressions` | 2 | 99, 118 |
| POST | `/user/{userId}/newsfeed` | 1 | 100 |
| POST | `/user/{userId}/info` | 1 | 108 |
| POST | `/user/{userId}/medical` | 1 | 119 |
| GET | `/user/{userId}/medicalInfo` | 1 | 126 |
| POST | `/user/{userId}/documents` | 1 | 127 |
| POST | `/user/{userId}/sacraments` | 1 | 135 |
| POST | `/user/{userId}/notes` | 1 | 143 |
| POST | `/user/{userId}/permissions` | 2 | 149, 261 |
| POST | `/user/{userId}/householdInfo` | 1 | 162 |
| POST | `/user/{userId}/giving` | 1 | 166 |
| POST | `/group/{groupId}/filter` | 3 | 188, 252, 280 |
| POST | `/group/{groupId}/sheet` | 1 | 193 |
| POST | `/board/hasFeature` | 1 | 194 |
| POST | `/group/{groupId}/notes` | 1 | 198 |
| POST | `/network/{networkId}/unolytics` | 1 | 201 |
| GET | `/network/{networkId}/unolyticsData` | 1 | 210 |
| POST | `/unolytics/{networkId}/getReport` | 1 | 219 |
| POST | `/unolytics/{networkId}/getSummaryDatapointsTotalMembers` | 1 | 220 |
| POST | `/user/{userId}/updateContactInfo` | 1 | 269 |
| GET | `/history/contact/{userId}` | 1 | 276 |

## Evidence needed before implementation

Retain these as follow-up questions, not inferred requirements or authorization
to make live requests:

- Search pagination, remaining member-list pages and termination, empty matches,
  inactive/unsubscribed members, and permission failures. A second member-list
  page is now documented in the follow-up.
- Identifier semantics and nullability across profile, membership, and household
  responses; cause of household-ID changes during browsing.
- Populated additional contacts, suppressions, multi-member households, profile
  notes, documents, and activity records where those features are useful.
- Phone write read-back, validation and permission failures, notification and
  duplicate effects, and safe handling of uncertain completion.
- Analytics date-range boundaries/timezone semantics, additional report ranges,
  and report types beyond `notesSent`. The follow-up establishes non-demo
  responses and `YYYY-MM-DD` request fields, but not those remaining semantics.

Future client/domain parsing should remain independent of the browser and MCP
interfaces. Browser endpoints should be explicitly allowlisted and MCP responses
should expose only the data needed for the requested operation. Routine tests
must use fictional offline fixtures derived from validated shapes; this document
does not authorize recording or replaying live requests.
