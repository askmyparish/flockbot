/** Fictional content in the observed published/email/SMS draft editor shape. */
export function noteResponse() {
  return {
    success: true,
    sessionToken: "HIDDEN_SESSION",
    composer: { user: "HIDDEN_USER", targets: ["HIDDEN_TARGET"] },
    noteInfo: {
      ID: 801,
      type: "email",
      status: "published",
      newNote: false,
      duplicate: false,
      title: "Choir plans",
      userID: 301,
      noteTargets: ["HIDDEN_TARGET"],
      sections: [
        {
          layout: "1",
          col1: {
            items: [
              {
                type: "text",
                data: {
                  html: "<h2>Rehearsal</h2><div>Bring <strong>music</strong> and <em>water</em>.</div><ul><li>North</li><li>South</li></ul>",
                },
              },
              {
                type: "quote",
                data: { quote: "Sing together", author: "Alex" },
              },
              {
                type: "button",
                data: {
                  text: "Details",
                  type: "url",
                  url: "https://example.test/choir",
                },
              },
            ],
          },
          col2: { items: [] },
        },
        {
          layout: "1",
          col1: {
            items: [{ type: "text", data: { html: "<p>See you soon!</p>" } }],
          },
          col2: { items: [] },
        },
      ],
    },
  };
}
