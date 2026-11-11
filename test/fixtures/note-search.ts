/** Fictional values with observed search shapes; mixed/empty/error pages are simulations. */
export function noteSearchResponse(searchTerm = "choir + plans") {
  return {
    success: true,
    searchTerm,
    searchFilters: {
      note: true,
      event: true,
      file: true,
      user: true,
      group: true,
      comment: true,
      userDocument: true,
    },
    totalHits: 12,
    searchResults: [
      {
        entityType: "note",
        noteID: 803,
        entityID: "00803",
        noteTitle: "Choir plans",
        type: "scheduled",
        date: 1800000000,
        noteTargets: [
          {
            type: "group",
            groupID: 101,
            entityID: "group-101",
            name: "Everyone",
          },
          { type: "user", entityID: 301, name: "HIDDEN_PERSON" },
        ],
        author: { name: "HIDDEN_AUTHOR" },
        plainText: "HIDDEN_BODY",
        previewURL: "HIDDEN_URL",
      },
      { entityType: "user", entityID: 301, name: "HIDDEN_PERSON" },
      {
        entityType: "note",
        noteID: 801,
        entityID: 801,
        noteTitle: "Rehearsal",
        type: "email",
        date: 1700000000,
      },
      {
        entityType: "note",
        noteID: 802,
        entityID: 802,
        noteTitle: "Reminder",
        type: "sms",
        date: 1750000000,
      },
    ],
  };
}
