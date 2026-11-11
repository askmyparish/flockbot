import { describe, expect, it } from "vitest";
import {
  EmailRecipients,
  FlockbotError,
  type EmailRecipientsInput,
} from "../src/index.js";
import { recipientPage, recipientRow } from "./fixtures/email-recipients.js";

function fixture(
  page: unknown = recipientPage(),
  note: unknown = { ID: 801, type: "email" },
) {
  const requests: string[] = [];
  return {
    requests,
    context: {
      check() {},
      async read(path: string) {
        requests.push(`GET ${path}`);
        return { success: true, note };
      },
      async query(path: string, body?: string) {
        requests.push(`POST ${path} ${body}`);
        return page;
      },
    },
  };
}

describe("specific-email recipient records", () => {
  it.each(["opened", "unopened"] as const)(
    "reads one %s page of an explicit older email with no contact enrichment",
    async (category) => {
      const f = fixture(
        recipientPage(category, [
          recipientRow(),
          { ...recipientRow(), fname: "Casey" },
        ]),
      );
      const input: EmailRecipientsInput = {
        emailId: "00801",
        category,
        fields: [],
      };
      const lookup = new EmailRecipients(input);
      (input.fields as string[]).push("address");
      const result = await lookup.read(f.context);
      expect(result).toMatchObject({
        requested: { emailId: "801", category, fields: [] },
        selection: "selected",
        page: 1,
        returnedCount: 2,
        totalRecords: 2,
        omittedCount: 0,
        hasMore: null,
        completeness: "unknown",
        truncated: false,
      });
      expect(result.recipients).toEqual([
        {
          userId: "301",
          firstName: "Alex",
          lastName: "Example",
          nameTruncated: false,
        },
        {
          userId: "301",
          firstName: "Casey",
          lastName: "Example",
          nameTruncated: false,
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("alex@example.test");
      expect(JSON.stringify(lookup)).not.toContain("801");
      expect(f.requests).toEqual([
        "GET note/801/analyticsSummary?ajax",
        `POST note/801/detailedAnalytics?ajax type=${category}&page=1`,
      ]);
    },
  );

  it("returns addresses only on explicit selection and flags text clipping", async () => {
    const row = {
      ...recipientRow(),
      fname: "A".repeat(257),
      address: "x".repeat(321),
    };
    const f = fixture(recipientPage("opened", [row]));
    const r = await new EmailRecipients({
      emailId: "801",
      category: "opened",
      fields: ["address"],
    }).read(f.context);
    expect(r.recipients).toEqual([
      {
        userId: "301",
        firstName: "A".repeat(256),
        lastName: "Example",
        nameTruncated: true,
        address: "x".repeat(320),
        addressTruncated: true,
      },
    ]);
    expect(r.truncated).toBe(true);
    row.fname = "A".repeat(256);
    row.address = "x".repeat(320);
    const boundary = await new EmailRecipients({
      emailId: "801",
      category: "opened",
      fields: ["address"],
    }).read(f.context);
    expect(boundary.truncated).toBe(false);
  });

  it("caps upstream rows, preserves supported identities and reports unsupported omissions", async () => {
    const records: unknown[] = Array.from({ length: 51 }, (_, i) =>
      recipientRow(301 + i),
    );
    records[0] = { ...recipientRow(), targetContacts: [{ userID: 999 }] };
    records[1] = { ...recipientRow(), service: "sms" };
    records[2] = { ...recipientRow(), userID: 0 };
    records[3] = { ...recipientRow(), userID: "9".repeat(129) };
    const f = fixture({
      ...recipientPage("opened", records),
      totalRecords: 200,
    });
    const r = await new EmailRecipients({
      emailId: "801",
      category: "opened",
    }).read(f.context);
    expect(r).toMatchObject({
      returnedCount: 46,
      omittedCount: 4,
      upstreamReturnedCount: 51,
      totalRecords: 200,
      truncated: true,
      hasMore: null,
      completeness: "unknown",
    });
    expect(r.recipients[0]?.userId).toBe("305");
    expect(r.recipients.at(-1)?.userId).toBe("350");
    expect(f.requests).toHaveLength(2);
  });

  it("does not mark exactly 50 supported rows as locally clipped", async () => {
    const f = fixture(
      recipientPage(
        "opened",
        Array.from({ length: 50 }, (_, i) => recipientRow(301 + i)),
      ),
    );
    const r = await new EmailRecipients({
      emailId: "801",
      category: "opened",
    }).read(f.context);
    expect(r).toMatchObject({
      returnedCount: 50,
      upstreamReturnedCount: 50,
      omittedCount: 0,
      truncated: false,
      hasMore: null,
      completeness: "unknown",
    });
  });

  it.each([
    [null, "expected_object"],
    [{ ...recipientRow(), fname: 123 }, "invalid_name"],
    [{ ...recipientRow(), address: 123 }, "invalid_contact"],
    [
      { ...recipientRow(), address: "private\n@example.test" },
      "invalid_contact",
    ],
  ])(
    "rejects malformed supported rows regardless of address projection (%j)",
    async (row, reason) => {
      for (const fields of [[], ["address"]] as const) {
        const f = fixture(recipientPage("opened", [row]));
        await expect(
          new EmailRecipients({
            emailId: "801",
            category: "opened",
            fields,
          }).read(f.context),
        ).rejects.toMatchObject({ code: "invalid_response", reason });
        expect(f.requests).toHaveLength(2);
      }
    },
  );

  it("does not claim an empty page is an exhaustive list", async () => {
    const f = fixture(recipientPage("unopened", []));
    const r = await new EmailRecipients({
      emailId: "801",
      category: "unopened",
    }).read(f.context);
    expect(r).toMatchObject({
      recipients: [],
      returnedCount: 0,
      totalRecords: 0,
      hasMore: null,
      completeness: "unknown",
      truncated: false,
    });
  });

  it("rejects a mismatched email before the category query, and withholds non-email recipients", async () => {
    const mismatch = fixture(undefined, { ID: 802, type: "email" });
    const lookup = new EmailRecipients({ emailId: "801", category: "opened" });
    await expect(lookup.read(mismatch.context)).rejects.toMatchObject({
      code: "invalid_response",
      reason: "email_identity_shape",
    });
    expect(mismatch.requests).toHaveLength(1);
    const sms = fixture(undefined, { ID: 801, type: "sms" });
    expect(await lookup.read(sms.context)).toMatchObject({
      selection: "unknown",
      reason: "unsupported_email_type",
      recipients: [],
      totalRecords: null,
    });
    expect(sms.requests).toEqual(["GET note/801/analyticsSummary?ajax"]);
  });

  it.each([
    [{ type: "unopened" }, "recipient_page_mismatch"],
    [{ page: "2" }, "recipient_page_mismatch"],
    [{ page: 1 }, "recipient_page_mismatch"],
    [{ records: {} }, "expected_results_array"],
    [{ totalRecords: -1 }, "invalid_result_count"],
    [{ totalRecords: "1" }, "invalid_result_count"],
  ])("rejects invalid category envelopes %j", async (override, reason) => {
    const f = fixture({ ...recipientPage(), ...(override as object) });
    await expect(
      new EmailRecipients({ emailId: "801", category: "opened" }).read(
        f.context,
      ),
    ).rejects.toMatchObject({ code: "invalid_response", reason });
    expect(f.requests).toHaveLength(2);
  });

  it("preserves rejected reads and cancellation without replay", async () => {
    const f = fixture({ success: false, message: "PRIVATE" });
    const lookup = new EmailRecipients({ emailId: "801", category: "opened" });
    await expect(lookup.read(f.context)).rejects.toMatchObject({
      code: "upstream_rejected",
    });
    expect(f.requests).toHaveLength(2);
    const cancelled = fixture();
    cancelled.context.check = () => {
      if (cancelled.requests.length)
        throw new FlockbotError("operation_cancelled");
    };
    await expect(lookup.read(cancelled.context)).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    expect(cancelled.requests).toHaveLength(1);
  });

  it.each([
    null,
    {},
    { emailId: "../801", category: "opened" },
    { emailId: "801", category: "clicked" },
    { emailId: "801", category: "opened", page: 2 },
    { emailId: "801", category: "opened", fields: ["email"] },
    { emailId: "801", category: "opened", fields: ["address", "address"] },
  ])("rejects invalid input %j before resource access", (input) => {
    expect(() => new EmailRecipients(input as EmailRecipientsInput)).toThrow(
      FlockbotError,
    );
  });
});
