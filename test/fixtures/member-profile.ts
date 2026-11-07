/** Fictional profile preserving observed view/identity/contact field shapes. */
export const profileResponse = () => ({
  success: true,
  userID: 201,
  isInCurrentNet: true,
  canViewProfile: true,
  userInfo: {
    userID: 301,
    firstName: "Alex",
    lastName: "Rivera",
    canViewProfile: true,
    canEditContactInfo: false,
    email: "alex@example.test",
    emailVerified: false,
    isBadEmail: true,
    pendingEmail: null,
    mobilePhone: "+1 (202) 555-0123",
    mobilePhoneVerified: true,
    pendingMobilePhone: null,
  },
});
