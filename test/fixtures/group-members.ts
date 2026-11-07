import { searchRow } from "./member-search.js";

/** Fictional normal-group subscriber rows use the observed numeric flag variant. */
export const rosterRow = (
  id = 301,
  firstName = "Alex",
  lastName = "Rivera",
) => ({
  ...searchRow(id, firstName, lastName),
  mailVer: 0,
  phnVer: 1,
  userActive: 1,
});

/** No success field is required by the captured people-page envelopes. */
export const rosterPage = (
  rows: unknown[] = [rosterRow(), rosterRow(302, "Bailey", "Morgan")],
  hasMore = false,
  groupID: number | null = 102,
) => ({
  ...(groupID === null ? {} : { groupID }),
  subscribedMembers: rows,
  pendingMembers: [] as unknown[],
  moreSubscribersExist: hasMore,
  canAdmin: false,
  includeContacts: false,
});
