import { draftTarget } from "./email-draft.js";

/** Sanitized native-copy shape: identities change, authored data does not. */
export function duplicationFixture() {
  const source = {
    ID: 801,
    type: "email",
    status: "published",
    newNote: false,
    duplicate: false,
    networkID: 501,
    userID: 201,
    title: "Annual choir plans",
    fromName: "The Choir",
    themeID: 0,
    noteTargets: [
      { ...draftTarget(), ID: 841 },
      { ...draftTarget(), ID: 842, entityID: "102", groupID: "102" },
    ],
    options: {
      comments: true,
      includeLink: false,
      includeGroupHeader: true,
      schedule: false,
      route2: false,
      voiceCalls: false,
      replyToGive: { enabled: false },
    },
    sections: [
      {
        ID: 811,
        layout: "1",
        size: "large",
        spacing: 0,
        col1: {
          size: "full",
          items: [
            {
              type: "text",
              col: "1",
              data: {
                ID: 821,
                noteID: "801",
                networkID: 501,
                html: '<h1 style="text-align:center">Annual plans</h1><div>Keep &amp; enjoy</div>',
              },
            },
          ],
        },
        col2: { size: "none", items: [] },
      },
      {
        ID: 812,
        layout: "1",
        size: "normal",
        spacing: 2,
        col1: {
          size: "full",
          items: [
            {
              type: "photo",
              col: "1",
              data: {
                ID: 822,
                noteID: "801",
                networkID: 501,
                photoID: 901,
                photourl: "https://images.example.test/choir.png",
                photodimensions: { width: 1560, height: 400 },
              },
            },
            {
              type: "button",
              col: "1",
              data: {
                ID: 823,
                noteID: "801",
                networkID: 501,
                type: "url",
                text: "Details",
                url: "www.example.test",
                fontSize: "28px",
                maxWidth: "390",
                backgroundGradientStart: "016099",
                base64Gradient: "data:image/png;base64,AA==",
              },
            },
          ],
        },
        col2: { size: "none", items: [] },
      },
    ],
  };
  const duplicate = {
    ...structuredClone(source),
    ID: 0,
    autosaveID: "802",
    duplicate: true,
    status: "autosaved",
    noteTargets: [] as typeof source.noteTargets,
  };
  for (const section of duplicate.sections) {
    section.ID += 100;
    for (const item of section.col1.items) {
      item.data.ID += 100;
      item.data.noteID = "802";
      if ("photoID" in item.data) item.data.photoID = 902;
    }
  }
  const persisted = {
    ...structuredClone(source),
    ID: 803,
    status: "draft",
    fromName: "",
    sections: structuredClone(duplicate.sections),
  };
  for (const section of persisted.sections)
    for (const item of section.col1.items) item.data.noteID = "803";
  const response = (path: string, body?: string): unknown => {
    const form = new URLSearchParams(body);
    switch (path) {
      case "user/userData":
        return { success: true, userID: 201 };
      case "network/getMetadata":
        return { success: true, networkID: 501 };
      case "dashboard":
        return '<div class="group_item" data-groupid="101" data-shortname="choir"><span class="group_name">Choir</span></div><div class="group_item" data-groupid="102" data-shortname="volunteers"><span class="group_name">Volunteers</span></div>';
      case "composer/editNote":
        return {
          success: true,
          noteInfo: structuredClone(
            form.get("noteID") === "801" ? source : persisted,
          ),
        };
      case "composer/duplicateNote":
        return { success: true, noteInfo: structuredClone(duplicate) };
      case "composer/save2":
        if (form.get("ID") === "803" && form.get("status") === "draft")
          persisted.fromName = form.get("fromName") ?? "";
        return {
          success: true,
          note: {
            ID: 803,
            autosaveID: "802",
            ...(form.get("ID") === "0" ? { status: "draft" } : {}),
          },
        };
      default:
        throw new Error("Unexpected fictional request");
    }
  };
  return { source, duplicate, persisted, response };
}
