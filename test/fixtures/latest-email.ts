import { profileResponse } from "./member-profile.js";

/** Fictional ordinary-email shapes from offline capture analysis, never raw HAR data. */
export function latestEmailResponses() {
  const note = { ID: "801", type: "email", dateTime: 1800000000 };
  return {
    "group/101?ajax": `<div class="page_group" data-groupid="101"><div class="page_notes"><div class="notes"><div class="holder">
      <div class="note_list_item" data-noteid="801" data-date="1800000000"><div class="author">Sent by <span>Private Author</span></div><div class="title">PRIVATE SUBJECT</div></div>
      <div class="note_list_item" data-noteid="800" data-date="1700000000"><div class="author">Sent by Private Author</div></div>
      </div><div class="load_more_notes"></div></div></div></div>`,
    "note/801/analyticsSummary?ajax": {
      success: true,
      note: { ...note, noteTargets: [{ groupID: 101 }] },
    },
    "note/801/analytics2?ajax": {
      success: true,
      note: { ...note },
      sendingSummary: [{ fromDate: 1800000000 }],
    },
    "user/301/profile": profileResponse(),
    "note/801/searchAnalytics?ajax": {
      success: true,
      s: "Rivera",
      results: [
        {
          userid: 302,
          fname: "Other",
          lname: "Rivera",
          status: "unopened",
          email: "other@example.test",
          phone: 0,
          address: "other@example.test",
        },
        {
          userid: 301,
          fname: "Alex",
          lname: "Rivera",
          status: "opened",
          email: "alex@example.test",
          phone: 0,
          address: "alex@example.test",
        },
        {
          userid: 303,
          fname: "Another",
          lname: "Rivera",
          status: "unopened",
          email: "another@example.test",
          phone: 0,
          address: "another@example.test",
        },
      ],
    },
  };
}
