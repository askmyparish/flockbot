import { inspect } from "node:util";
import { expect, it } from "vitest";
import { upstreamResponse } from "../src/rejections.js";

it("retains the actual rejection and selected response facts without guessing a reason", () => {
  expect(
    upstreamResponse({
      success: false,
      error: "Could not add user",
      userID: 201,
      existingSubscription: false,
      isApp: false,
      private: "unrelated-value",
    }),
  ).toEqual({
    success: false,
    error: "Could not add user",
    userId: "201",
    existingSubscription: false,
  });
});
it.each([
  "alex+probe@example.test",
  "alex.probe@example.test",
  "long-local-part-that-is-a-valid-contact@example.test",
])(
  "preserves an echoed address without changing its identity (%s)",
  (email) => {
    expect(upstreamResponse({ error: `Could not add ${email}` })).toEqual({
      error: `Could not add ${email}`,
    });
  },
);
it("uses message as a fallback and bounds error wording", () => {
  expect(
    upstreamResponse({ error: " ", message: "Could not add user" })?.error,
  ).toBe("Could not add user");
  expect(
    upstreamResponse({ message: "<b>Could not</b>\n add\u202e user" }),
  ).toEqual({ error: "Could not add user" });
  const result = upstreamResponse({ error: "x".repeat(1025) });
  expect(result?.error).toHaveLength(1024);
  expect(result?.errorTruncated).toBe(true);
  expect(upstreamResponse(result)).toEqual(result);
});
it("redacts cookie values longest first before truncation", () => {
  const result = upstreamResponse({ error: "Cannot add abcdef abc" }, [
    "abc",
    "abcdef",
  ]);
  expect(result?.error).toBe("Cannot add [redacted] [redacted]");
});
it.each([
  "Password was short-value",
  "Cookie Flocknote=short-value",
  "Authorization: Bearer short-value",
  "SessionData: short-value",
  "Your one-time code is 123456",
])("withholds credential-related text (%s)", (error) => {
  expect(upstreamResponse({ error })?.error).toBe(
    "[credential-related response withheld]",
  );
});
it.each([
  null,
  [],
  {
    error: { nested: "private-value" },
    userID: [],
    success: "false",
    authorized: 0,
    existingSubscription: "false",
  },
])("ignores malformed values and arbitrary keys (%j)", (input) => {
  expect(upstreamResponse(input)).toBeUndefined();
});
it.each([
  0,
  -1,
  NaN,
  Infinity,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  "0",
  "user-private-id",
  [],
])("omits invalid upstream user identifiers (%j)", (userID) => {
  expect(upstreamResponse({ success: false, userID })).toEqual({
    success: false,
  });
});
it("retains large decimal identifiers as strings without numeric conversion", () => {
  expect(upstreamResponse({ userID: "900719925474099312345" })?.userId).toBe(
    "900719925474099312345",
  );
});
it("copies and freezes the selected response, never retaining a body or credentials", () => {
  const input = {
    success: false,
    error: "Could not add user",
    password: "fictional-password",
    headers: { Cookie: "fictional-session" },
  };
  const result = upstreamResponse(input);
  input.error = "changed";
  expect(result).toEqual({ success: false, error: "Could not add user" });
  expect(Object.isFrozen(result)).toBe(true);
  expect(inspect(result)).not.toMatch(/fictional-|headers|password/);
});
