/** Fictional subscribed shape; isSubscribed:false is simulated from captured UI code. */
export const membershipRow = (
  groupID = 102,
  groupName = "Choir",
  isSubscribed = true,
) => ({
  groupID,
  groupName,
  isSubscribed,
  emailPref: 1,
  smsPref: 0,
  voicePref: 0,
  superAdmin: false,
});
export const membershipResponse = () => ({
  success: true,
  userID: 201,
  data: {
    canView: true,
    canEdit: true,
    subscribedGroups: [
      membershipRow(101, "Everyone"),
      membershipRow(),
      membershipRow(103, "Proxy relationship", false),
    ],
    availableGroups: [{ groupID: 104, groupName: "Readers" }],
    networkPreferences: { email: true },
  },
});
