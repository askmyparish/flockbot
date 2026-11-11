/** Fictional responses for the observed create-only composer contract. */
export function draftTarget() {
  return {
    ID: null,
    entityID: "101",
    groupID: "101",
    targetType: "group",
    targetTypeDictID: 1,
    isParent: false,
    includeContacts: false,
    isSmartGroup: false,
    isFilteredGroup: false,
    isEveryoneGroup: false,
  };
}
export function draftInitialization() {
  return {
    success: true,
    noteInfo: {
      type: "email",
      status: "autosaved",
      newNote: true,
      networkID: 501,
      userID: 201,
      themeID: 0,
      fromName: "Example Parish",
      noteTargets: [draftTarget()],
      sections: [],
      options: { comments: true, includeLink: false, includeGroupHeader: true },
    },
  };
}
export const draftInput = {
  groupName: "Choir",
  subject: `Q&A <b> "quoted" O'Neil`,
  body: 'A <b> &lt; "hi"\n\n**literal** café 🕊\n',
};
export const draftHtml =
  "<div>A &#60;b&#62; &#38;lt; &#34;hi&#34;<br><br>**literal** café 🕊<br></div>";
export function draftReadback() {
  return {
    success: true,
    noteInfo: {
      ...draftInitialization().noteInfo,
      ID: 803,
      autosaveID: 801,
      newNote: false,
      status: "draft",
      title: `Q&A <b> "quoted" O'Neil`,
      options: { schedule: false, route2: false, voiceCalls: false },
      sections: [
        {
          col1: { items: [{ type: "text", data: { html: draftHtml } }] },
          col2: { items: [] as unknown[] },
        },
      ],
    },
  };
}
export function draftResponse(path: string, body?: string): unknown {
  const form = new URLSearchParams(body);
  switch (path) {
    case "user/userData":
      return { success: true, userID: 201 };
    case "dashboard":
      return '<div class="group_item" data-groupid="101" data-shortname="choir"><span class="group_name">Choir</span></div>';
    case "network/getMetadata":
      return { success: true, networkID: 501 };
    case "network/501/writeNewNote?ajax":
      return {
        success: false,
        networkIsUnderBillingLockout: false,
        billingInfoNeededButNetworkIsUnverified: false,
        billingInfoNeededFromAdmin: false,
        missingNetworkSettingsInfo: false,
        ccEnteredPendingSuccessfulCharge: false,
        openComposerAfter: true,
      };
    case "composer/createNote":
      return draftInitialization();
    case "composer/save2":
      return {
        success: true,
        note:
          form.get("newNote") === "true"
            ? { autosaveID: "801", newNote: false }
            : { autosaveID: "801", ID: "803" },
      };
    case "composer/saveModule":
      return { success: true, itemID: "811" };
    case "composer/saveSection":
      return { success: true, sectionID: "821" };
    case "composer/saveLayout":
      return { success: true, layoutID: "831" };
    case "composer/editNote":
      return draftReadback();
    default:
      throw Error(`Unexpected fictional endpoint ${path}`);
  }
}
