import { profileResponse } from "./member-profile.js";

/** Fictional ordinary-email shapes from offline capture analysis, never raw HAR data. */
export function latestEmailResponses() {
  const note = { ID: "801", type: "email", dateTime: 1800000000 };
  return {
    "group/101/notes?ajax&more": {
      groupID: "101",
      more: true,
      notes: [
        {
          ID: 801,
          publishedDate: 1800000000,
          status: "published",
          title: "PRIVATE SUBJECT",
        },
        {
          ID: 800,
          publishedDate: 1700000000,
          status: "published",
          title: "PRIVATE SUBJECT",
        },
      ],
    },
    "note/801/analyticsSummary?ajax": {
      success: true,
      note: { ...note, noteTargets: [{ groupID: 101 }] },
      counts: {
        opened: 17,
        unopened: 9,
        bounced: 2,
        complaint: 0,
        sms: 3,
        total: 31,
        voicecalls: 1,
        clicks: 5,
        unsubscribes: 4,
      },
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
