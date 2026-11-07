/** Fictional values preserving the observed metadata and search row shapes. */
export const searchMetadata = () => ({
  peopleFilterInfo: {
    generalSearchFilter: {
      filterID: 17,
      filterName: "generalPeopleSearch",
      operator: "Search",
      inputs: {
        searchTerm: {
          inputName: "searchTerm",
          dataType: "text",
          allowMultiple: false,
        },
      },
    },
  },
});
export const searchRow = (userID = 301, fn = "Alex", ln = "Rivera") => ({
  userID,
  fn,
  ln,
  userActive: true,
  mail: "alex@example.test",
  mailVer: false,
  phn: "+1 (202) 555-0123",
  phnVer: true,
  date: "Mar 5, 2026",
});
