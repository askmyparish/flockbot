/** Fictional identities in the JSON shapes observed for mailgun category records. */
export function recipientRow(userID = 301) {
  return {
    userID,
    fname: "Alex",
    lname: "Example",
    address: "alex@example.test",
    service: "mailgun",
    targetContacts: [] as unknown[],
  };
}
export function recipientPage(
  category = "opened",
  records: unknown[] = [recipientRow()],
) {
  return {
    success: true,
    type: category,
    page: "1",
    records,
    totalRecords: records.length,
    isApp: false,
    userID: 201,
  };
}
