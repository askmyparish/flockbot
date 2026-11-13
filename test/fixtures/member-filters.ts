import { searchMetadata, searchRow } from "./member-search.js";

/** Fictional catalog values. Native IDs deliberately repeat across custom fields. */
export function filterInput(
  inputName: string,
  dataType = "keyword",
  allowedValues: unknown = null,
) {
  return { inputName, dataType, allowedValues, allowMultiple: false };
}
export function filterDefinition(
  filterName: string,
  operator: string,
  inputs: Record<string, ReturnType<typeof filterInput>> = {},
  negated?: string,
) {
  return {
    filterID: 71,
    filterName,
    operator,
    inputs,
    ...(negated ? { operatorNegated: negated } : {}),
    permissions: {
      isOnlyPeople: false,
      isNotContactsView: true,
      isNotHouseholdsView: true,
      requiredNetworkFeatureDictID: null,
    } as Record<string, unknown>,
  };
}
export function selectCategory(
  networkFieldID = 201,
  fieldTypeInstanceID = 501,
  count = 2,
) {
  const fixed = {
    networkFieldID: filterInput("networkFieldID", "keyword", networkFieldID),
    extendedFieldFieldType: filterInput("extendedFieldFieldType", "keyword", 5),
    fieldTypeInstanceID: filterInput(
      "fieldTypeInstanceID",
      "keyword",
      fieldTypeInstanceID,
    ),
  };
  return {
    displayName: "Volunteer preference",
    filters: [
      {
        ...filterDefinition(
          "Select List Field Exists",
          "Has",
          structuredClone(fixed),
          "Does not have",
        ),
        filterID: 81,
        extendedFieldFieldType: 5,
      },
      {
        ...filterDefinition(
          "Select List Field Equals",
          "Is",
          {
            ...structuredClone(fixed),
            listOfIDs: filterInput(
              "listOfIDs",
              "keyword",
              Array.from({ length: count }, (_, i) => ({
                value: i + 1,
                label: i < 2 ? "Same label" : `Option ${i + 1}`,
              })),
            ),
          },
          "Is not",
        ),
        filterID: 82,
        extendedFieldFieldType: 5,
      },
    ],
  };
}
export function filterCatalog() {
  const query = () => ({ searchTerm: filterInput("searchTerm", "text") });
  const dates = () => ({
    date: filterInput("date", "date"),
    dateQueryType: filterInput("dateQueryType", "text", [
      { label: "Before", value: "lessThanEqualToEndOfDay" },
      { label: "On", value: "onDay" },
      { label: "After", value: "greaterThanEqualToBeginOfDay" },
    ]),
  });
  return {
    groupID: "101",
    isEveryoneGroup: 1,
    canViewInactiveMembers: false,
    includeContacts: false,
    subscribedMembers: [searchRow()],
    pendingMembers: [searchRow(302)],
    mainHTML: "<script>private-member-html</script>",
    css: ["https://example.test/private.css"],
    peopleFilterInfo: {
      ...searchMetadata().peopleFilterInfo,
      generalSearchFilter: {
        ...searchMetadata().peopleFilterInfo.generalSearchFilter,
        permissions: {
          isNotContactsView: true,
          requiredNetworkFeatureDictID: null,
        },
        inputs: { searchTerm: filterInput("searchTerm", "text") },
      },
      filters: {
        "Personal Info": {
          categories: {
            "First Name": {
              filters: [
                filterDefinition("a first name", "Has", {}, "Does not have"),
                filterDefinition(
                  "first name",
                  "Search",
                  query(),
                  "Does not contain",
                ),
              ],
            },
            "Last Name": {
              filters: [
                filterDefinition("a last name", "Has", {}, "Does not have"),
                filterDefinition(
                  "last name",
                  "Search",
                  query(),
                  "Does not contain",
                ),
              ],
            },
            ChoiceA: selectCategory(),
            ChoiceB: selectCategory(202, 502),
            Unsupported: {
              filters: [
                {
                  filterID: 99,
                  filterName: "Unknown numeric field",
                  secret: "private-unsupported",
                },
              ],
            },
          },
        },
        "Contact Info": {
          categories: {
            "Email Address": {
              filters: [
                filterDefinition(
                  "an email address",
                  "Has",
                  {},
                  "Does not have",
                ),
                filterDefinition("email address for", "Search", query()),
                filterDefinition(
                  "Email Verification Status",
                  "Is",
                  {},
                  "Is not",
                ),
                filterDefinition("Email Bad", "Is"),
                filterDefinition("Email Not Bad", "Is"),
                filterDefinition("Email Last Updated", "Before", dates()),
              ],
            },
            "Phone Number": {
              filters: [
                filterDefinition("a phone number", "Has", {}, "Does not have"),
                filterDefinition("phone number for", "Search", query()),
                filterDefinition(
                  "Phone Verification Status",
                  "Equals",
                  {},
                  "Does not equal",
                ),
                filterDefinition("a mobile phone", "Is"),
                filterDefinition("a landline", "Is"),
                filterDefinition("Phone Last Updated", "Before", dates()),
              ],
            },
          },
        },
        Groups: {
          categories: {
            "Date Joined": {
              filters: [
                filterDefinition("Subscribed", "Before", {
                  groupID: filterInput("groupID"),
                  ...dates(),
                }),
              ],
            },
            "In Other Groups": {
              filters: [
                filterDefinition(
                  "also in",
                  "Is",
                  {
                    otherGroupID: filterInput("otherGroupID", "keyword", [
                      {
                        value: 101,
                        name: "Everyone",
                        disabled: true,
                        isSmartGroup: false,
                      },
                      {
                        value: 102,
                        name: "Choir",
                        disabled: false,
                        isSmartGroup: false,
                      },
                      {
                        value: 103,
                        name: "Filtered group",
                        disabled: false,
                        isSmartGroup: true,
                      },
                    ]),
                  },
                  "Is not",
                ),
              ],
            },
          },
        },
        Sacraments: { categories: { Unrelated: selectCategory(203, 503) } },
      },
    },
  };
}
