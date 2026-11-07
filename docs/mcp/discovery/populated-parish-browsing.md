# Populated parish: follow-up API discovery

This record extends [member-browsing discovery](member-browsing.md) using a second
user-supplied HAR from a parish with more data. It documents observed contracts
and possible MCP tools. It does not implement tools, create a Bruno collection,
or authorize live verification. All analysis was offline; no request was replayed.

Credentials, parish identity, member identities, contact values, signup titles,
and group names are excluded. Paths use placeholders. HAR references in this
document are one-based positions in the **second** capture's `log.entries` array;
they must not be confused with the first capture's entry numbers.

A [third capture](notes-and-engagement.md) extends communications discovery with
note search and per-note analytics. The network-wide reports below and those
per-note requests are separate contracts.

## Coverage and changes to earlier conclusions

The second capture contains 317 requests over approximately 64 seconds. Applying
the same exclusion of assets, templates, and unrelated origins leaves 43
application requests across 26 method/path combinations. All 43 have HTTP 200
responses. Nine combinations were absent from the first capture, including
navigation/metadata requests that the existing connector already uses in other
contexts. These are newly captured observations, not nine newly discovered
product features.

The useful additions are:

- A second page of group members establishes an observed offset request.
- Two subscriber-row formats require deliberate handling of boolean/numeric flags.
- Analytics is populated with demonstration mode disabled, resolving the earlier
  demo-only limitation for the observed report branch.
- Signup-list metadata includes populated records and nullable slot limits.
- Group navigation exposes parent/descendant relationships and group capabilities.
- Network permissions and feature metadata can guide operation availability.
- Prayer-request statistics provide an aggregate retrieval endpoint.

No individual-member profile tabs, contact updates, or household lookups occur in
this capture. It does not resolve the earlier household-ID change, phone-write
read-back, or empty profile-record questions.

## Group-member pagination and row variants

### Observed additional-page request

Entry 230 returns the first 100 subscribers from
`POST /group/{groupId}/people?ajax`, with `includeUnsubscribed=0` and
`moreSubscribersExist: true`.

Entry 250 requests another page from the same group:

```text
POST /group/{groupId}/people/100?ajax&more
Content-Type: application/x-www-form-urlencoded

includeUnsubscribed=0
```

`ajax` and `more` are query flags with empty values. The trailing `100` is the
observed paging segment; it is not a member identifier. The response contains
100 subscribers whose IDs do not overlap the first page, and again reports
`moreSubscribersExist: true`. Both responses have empty `pendingMembers` arrays.
The additional-page response omits the initial page's asset/callback/HTML payload.

An offset interpretation is supported by the initial 100 rows followed by the
`/100` request. Only this additional offset is captured. The next offset,
custom page sizes, ordering stability, concurrent membership changes, final-page
termination, and pending-member pagination remain unverified. Do not report an
initial page as the complete group or assume an unobserved `/200` request is a
validated contract.

The captured `/js/people.js` (second-capture entry 87) supplies additional
client-code evidence: `loadPeople` builds `/group/{groupId}/people/{offset}`
with `?ajax&more`, using the number of loaded nondeleted member cards as the
offset. It submits `includeUnsubscribed` and removes the load-more control
when `moreSubscribersExist` is false. This establishes the UI's continuation
algorithm beyond the single observed offset, without establishing a live
response at every later offset or a stable snapshot. The small initial pages
in the first capture (49, 250) already show `moreSubscribersExist: false`.
Later offsets, empty final pages and additional-page termination in connector
tests remain simulated cases.

Entries 298 and 313 load another group's initial page, again returning 100
subscribers and `moreSubscribersExist: true`.

### Subscriber-row formats

The Everyone-group responses (230, 250) contain boolean `userActive`, `mailVer`,
and `phnVer` values. Rows include fields such as `isSmartGroupMember`,
`isSmartGroupChildMember`, `isNotRemovable`, `hasGivingView`, `hasGivingInput`,
`2fa`, and `photo`; `sID` is null in the observed rows.

The other group's responses (298, 313) use numeric flags for `userActive`,
`mailVer`, and `phnVer`. Observed mail/phone verification values are `0` and `1`.
These rows also contain `pendMailID`, `phnID`, `badEmail`, `pend`, `sID`, and
`phan`; some include string-valued `pgPermLev`. The same endpoint family can
therefore return different row shapes.

A future parser should validate each supported representation, normalize only
known flag encodings, and retain optional-field/null handling. Permission-code
and subscription-state meanings are not established by these field names.
Both observed groups have `isSmartGroup: false` and `includeContacts: false`, so
these shapes do not characterize smart-group or contacts-view rows.

## Analytics outside demonstration mode

### Network summary

`GET /network/{networkId}/unolyticsData` (265) returns
`info.showFakeUnolyticsData: false`. Its populated metric structure includes:

- Note count, distinct sending-group count, and distinct recipient count.
- Group count, period-end subscriber count, and subscriber-count change.
- Opened, unopened, and bounced email totals; text and voice-call totals.
- `newMembersGraphData` and `attendanceAndGivingGraphData`.

`averageAttendance` and `totalGivingDollars` are null in the top-level `info`
object. A giving tile separately has numeric `data.averageAttendance`; these
locations should not be treated as interchangeable or null as zero. This is not
evidence of a donation ledger or populated giving totals.

The summary request has no date-range query fields in the capture. A future
summary tool must not imply it can select arbitrary ranges through this GET.

### Notes-sent report

Entry 274 submits URL-encoded fields to
`POST /unolytics/{networkId}/getReport`:

```text
startDate = 2026-01-01
endDate = 2026-01-31
reportType = notesSent
```

Dates above are fictional examples preserving the observed `YYYY-MM-DD` format.
Unlike the first capture, this request does not include `fakeData`. Together with
the disabled demo flag, this supports documenting the non-demo report branch.
It does not independently audit the accuracy of the metrics.

The response contains `reportInfo` and populated `info` rows. Row fields include
`groupID`, `groupShortname`, `groupName`, `groupHierarchyLevel`, `groupPhotoURL`,
`totalNotesSent`, `totalEmailsSent`, and `totalSMSSent`. The three count fields
are decimal digit strings in all observed rows; the summary's count fields are
numbers. `reportInfo.topResultKey` is `totalNotesSent`.

The network-summary tiles also advertise report names `topGrowers`, `topSenders`,
and `attendanceAndGiving`. Those report requests were not made. An advertised
name is discovery evidence, not a validated input/output contract.

### Member-count history

`POST /unolytics/{networkId}/getSummaryDatapointsTotalMembers` (282) sends
`startDate` and `endDate` in the same `YYYY-MM-DD` format. It returns `info` as a
map of month/day labels to numeric counts. The labels omit a year; preserve the
requested range when interpreting them. Year boundaries, leap days, missing
days, inclusivity, timezone, and range limits remain unverified.

Neither report response has a top-level `success` field. A future validator
should check the observed shape rather than require `success: true` everywhere.

## Navigation and capability discovery

`GET /navigation/groups` (150) returns a populated `groups` array. Beyond the
ID/name/shortname fields already used by discovery, entries include:

- `parentGroupID`, `hierarchyLevel`, `descendantIds`, and `hasChildren`;
- `type.value`, `type.hidden`, and `type.closed`;
- `subscribed`, `isGroupAdmin`, `canHaveSubgroups`, `isSmartGroup`, and
  `includeContacts`;
- `section`, ordering information, and optional description/photo information.

Populated descendant lists are observed. This supports documenting a hierarchy
view, but not assuming navigation is an exhaustive authorization-independent
directory or inferring every type/section code. Parent sentinel meanings and
cross-parish invariants are unverified.

`POST /network/getMetadata` (147) returns `success: true`, `networkID`,
`everyoneGroupID`, and feature flags such as `hasFNP`, `hasReports`,
`hasSmartGroups`, `hasGivingUI`, `hasSignupsProfileFields`, and
`canHouseholdDatabase`. The observed request has no form fields. **POST is the
method captured here**; this does not establish that the connector's existing GET
variant is invalid or should be replaced.

`GET /permissions` (149) returns current-login capabilities including
`canAddMember`, `canManageGroups`, `canSendNotes`, `canSuperSearch`,
`canSeeDuplicateFinder`, `canSeeReportsMenuNav`, `canSeeUnolytics`,
`canSeeHouseholdDatabaseNav`, and `canViewAllGivingData`. These are parish-level
login capabilities, distinct from `/user/{userId}/permissions` in the first
capture. Feature and capability flags can guide available workflows; they do not
replace upstream authorization on the operation itself. Do not derive a complete
role model from navigation visibility flags.

## Signup lists and other new response shapes

### Signup-list summaries

`POST /signuplist/list` (151, 186, 224) returns populated `signupLists`. Each
summary has `ID`, `title`, numeric `expires`, `totalAvailableSlots`,
`totalConfirmedSignups`, `signupListStatusID`, `signupListTypeID`,
`hasSignupCost`, `createdBy`, and `createdByName`.

`totalAvailableSlots` is either numeric or null. Null does not establish that a
list is unlimited, full, closed, or has zero slots. The timestamp unit of
`expires` and the status/type code meanings require separate verification.
The envelope also includes `signupListTemplates`, feature/permission flags,
current-user information, and an empty `funds` array in this capture. A list tool
should return selected summary fields rather than the whole envelope. Slot
details, registration, payment, cancellation, paging, and filtering were not
exercised.

### Prayer-request statistics

`GET /prayerRequests/stats` (154) returns `success`, `total`, `unseenTotal`,
and `impactTotals` containing `prayerReactionCount`, `authorCount`, and
`prayerRequestCount`; those fields are numeric. This could support an aggregate
statistics tool without returning prayer content or identities. Counter scope,
time windows, and whether unseen state is login-specific remain unverified.

### Empty or presentation-only responses

- `GET /giving/campaignsList` (153) returns `campaigns: []`. This establishes an
  empty retrieval envelope, not campaign-item fields or campaign management.
- `GET /backgroundjob/getJobs` (184) returns `jobs: []`. No populated job schema
  or export-job lifecycle is established.
- `GET /dashboard/promoContent` (179), `GET /action-center` (1), group shell
  requests, and the notes page add presentation/bootstrap evidence. They do not
  establish a new domain operation by themselves.
- `POST /group/{groupId}/sheet?ajax` (306) again returns `sheetURL` and UI
  metadata. This still does not establish an export/download contract.

## Additional candidate MCP operations

These extend the earlier candidate list; names and scope remain proposals.

| Candidate | Observed basis | Remaining boundary |
| --- | --- | --- |
| `group_members` | First and additional pages, with two row formats and captured UI continuation code | Avoid silent truncation; final additional-page and stable-order behavior remain unverified live. |
| `flocknote_network_summary` | Non-demo `/unolyticsData` metrics | No arbitrary date-range input observed for this request; giving/attendance fields may be null. |
| `flocknote_notes_sent_report` | `getReport`, `reportType=notesSent`, date range, populated rows | Other report types, permissions, date boundaries, and range limits remain unknown. |
| `flocknote_member_count_history` | Date-range summary datapoints | Returned labels lack year/timezone; historical semantics need verification. |
| `flocknote_signup_lists` | Populated signup summaries | Expose summaries only; slot/status interpretation and signup actions are unverified. |
| `flocknote_prayer_request_stats` | Aggregate counters | Establish scope and permission behavior before promising a particular interpretation. |
| Extend group discovery with hierarchy | Parent, descendant, type, and capability fields | Validate hierarchy semantics and keep presentation-only fields out of results. |

Metadata and `/permissions` are useful supporting reads. A separate public
capabilities tool is optional; they need not each become an MCP endpoint.

## Complete second-capture application-request inventory

Query flags are omitted in this index and described in the contracts above.
Counts group numeric IDs and the observed paging segment by their roles. All
listed requests have HTTP 200 responses; several valid data envelopes omit a
top-level `success` field.

| Method | Path | Count | Second-capture HAR entries |
| --- | --- | ---: | --- |
| GET | `/action-center` | 1 | 1 |
| POST | `/network/getMetadata` | 1 | 147 |
| GET | `/user/userData` | 3 | 148, 185, 223 |
| GET | `/permissions` | 1 | 149 |
| GET | `/navigation/groups` | 1 | 150 |
| POST | `/signuplist/list` | 3 | 151, 186, 224 |
| POST | `/duplicate/getDuplicateCount` | 3 | 152, 187, 225 |
| GET | `/giving/campaignsList` | 1 | 153 |
| GET | `/prayerRequests/stats` | 1 | 154 |
| POST | `/user/getOtherNetworks` | 3 | 155, 188, 226 |
| GET | `/dashboard/systemNotifications` | 2 | 157, 190 |
| GET | `/dashboard/nextActions` | 2 | 159, 189 |
| GET | `/dashboard/promoContent` | 1 | 179 |
| GET | `/backgroundjob/getJobs` | 1 | 184 |
| POST | `/group/{groupId}` | 2 | 193, 297 |
| GET | `/group/{groupId}/people` | 2 | 227, 303 |
| POST | `/group/{groupId}/people` | 3 | 230, 298, 313 |
| GET | `/group/{groupId}/getSubscriberCount` | 4 | 242, 251, 299, 314 |
| POST | `/group/{groupId}/people/{offset}` | 1 | 250 |
| POST | `/network/{networkId}/unolytics` | 1 | 256 |
| GET | `/network/{networkId}/unolyticsData` | 1 | 265 |
| POST | `/unolytics/{networkId}/getReport` | 1 | 274 |
| POST | `/unolytics/{networkId}/getSummaryDatapointsTotalMembers` | 1 | 282 |
| POST | `/group/{groupId}/sheet` | 1 | 306 |
| POST | `/board/hasFeature` | 1 | 309 |
| POST | `/group/{groupId}/notes` | 1 | 317 |

## Remaining verification questions

Retain these as evidence gaps, not instructions to perform live operations:

- Remaining pages, final-page behavior, stable ordering, filter pagination,
  pending members, and inactive/unsubscribed members.
- Role and state-code meanings across member-list variants; smart-group and
  contacts-view response shapes.
- Analytics range boundaries, timezone/year interpretation, limits, permission
  errors, and report types other than `notesSent`.
- Signup status/type meanings, expiry units, nullable slot-limit semantics, and
  detailed signup operations.
- Prayer-counter scope and visibility, populated campaigns, and populated jobs.
- The first capture's unresolved household effects and write semantics; this
  capture contains no evidence that closes those questions.
