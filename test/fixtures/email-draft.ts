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
export const htmlDraftInput = {
  ...draftInput,
  bodyFormat: "html" as const,
  body: '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>\n<div><p>A <strong>bold</strong> <b>alias</b> <em>emphasis</em> <i>italic</i><br/>Literal &lt;b&gt; &amp;lt; &quot; &#39; café 🕊</p><ul><li>First</li><li><ol><li>Nested</li></ol></li></ul><blockquote><p>Quote</p></blockquote><a href="https://example.test/?a=1&amp;b=2#part">A &amp; B</a></div>',
};
export const htmlDraftStored =
  '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6> <div><div>A <strong>bold</strong> <b>alias</b> <em>emphasis</em> <i>italic</i><br>Literal &#60;b&#62; &#38;lt; &#34; &#39; café 🕊</div><ul><li>First</li><li><ol><li>Nested</li></ol></li></ul><blockquote><div>Quote</div></blockquote><a href="https://example.test/?a=1&#38;b=2#part">A &#38; B</a></div>';
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
          col1: {
            items: [{ type: "text", data: { ID: 811, html: draftHtml } }],
          },
          col2: { items: [] as unknown[] },
        },
      ],
    },
  };
}
export function draftResponse(
  path: string,
  body?: string,
  html = draftHtml,
): unknown {
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
    case "upload/photo/note":
      return {
        success: true,
        photoID: 901,
        url: "https://images.example.test/first.jpg",
      };
    case "composer/saveSection":
      return { success: true, sectionID: "821" };
    case "composer/saveLayout":
      return { success: true, layoutID: "831" };
    case "composer/editNote":
      return {
        ...draftReadback(),
        noteInfo: {
          ...draftReadback().noteInfo,
          sections: [
            {
              col1: { items: [{ type: "text", data: { ID: 811, html } }] },
              col2: { items: [] },
            },
          ],
        },
      };
    default:
      throw Error(`Unexpected fictional endpoint ${path}`);
  }
}

export const blockDraftInput = {
  groupName: "Choir",
  subject: draftInput.subject,
  content: [
    { type: "text" as const, body: "Invitation <b>\nDetails" },
    {
      type: "button" as const,
      text: `Join <b> & "quoted" O'Neil café 🕊 &lt;`,
      url: "https://example.test/register?a=1&b=2#part",
    },
    {
      type: "text" as const,
      bodyFormat: "html" as const,
      body: "<p>Thanks, <strong>Alex</strong></p>",
    },
    {
      type: "button" as const,
      text: "More information",
      url: "http://example.test/info",
    },
  ],
};
export const blockDraftStored = [
  {
    type: "text",
    data: { ID: 811, html: "<div>Invitation &#60;b&#62;<br>Details</div>" },
  },
  {
    type: "button",
    data: {
      ID: 812,
      type: "url",
      text: `Join <b> & "quoted" O'Neil café 🕊 &lt;`,
      url: "https://example.test/register?a=1&b=2#part",
      fontFamily: "Arial",
      fontSize: "16",
      maxWidth: "300",
      padding: "12",
      backgroundColor: "336699",
      textColor: "ffffff",
    },
  },
  {
    type: "text",
    data: { ID: 813, html: "<div>Thanks, <strong>Alex</strong></div>" },
  },
  {
    type: "button",
    data: {
      ID: 814,
      type: "url",
      text: "More information",
      url: "http://example.test/info",
      fontFamily: "Arial",
      fontSize: "16",
      maxWidth: "300",
      padding: "12",
      backgroundColor: "336699",
      textColor: "ffffff",
    },
  },
];
/** Independent saved records, not an echo of the writer's request payload. */
export function blockDraftResponse(
  items: {
    type: string;
    data: { ID: number; [key: string]: unknown };
  }[] = blockDraftStored,
) {
  let next = 0;
  return (path: string, body?: string): unknown => {
    if (path === "composer/createNote") next = 0;
    if (path === "composer/saveModule")
      return { success: true, itemID: String(items[next++]?.data.ID) };
    if (path === "composer/editNote")
      return {
        success: true,
        noteInfo: {
          ...draftReadback().noteInfo,
          sections: [
            { col1: { items: structuredClone(items) }, col2: { items: [] } },
          ],
        },
      };
    return draftResponse(path, body);
  };
}

export const imageDraftStored = [
  {
    type: "photo",
    data: {
      ID: 811,
      photoID: "901",
      photourl: "https://images.example.test/first.jpg",
      photodimensions: { width: 240, height: 120 },
    },
  },
  { type: "button", data: { ...blockDraftStored[1]!.data, ID: 812 } },
  {
    type: "photo",
    data: {
      ID: 813,
      photoID: "902",
      photourl: "https://images.example.test/second.png",
      photodimensions: { width: 120, height: 240 },
    },
  },
];
export function imageDraftInput(first: string, second: string) {
  return {
    groupName: "Choir",
    subject: draftInput.subject,
    content: [
      { type: "image" as const, path: first },
      blockDraftInput.content[1]!,
      { type: "image" as const, path: second },
    ],
  };
}
export function imageDraftResponse() {
  const response = blockDraftResponse(imageDraftStored);
  let uploads = 0;
  return (path: string, body?: string) =>
    path === "upload/photo/note"
      ? {
          success: true,
          photoID: 901 + uploads++,
          url: "https://images.example.test/upload.jpg",
        }
      : response(path, body);
}
