import { describe, expect, it } from "vitest";
import { FlockbotError } from "../../src/errors.js";
import {
  sanitizePayload,
  safePayload,
} from "../../adapters/mcp/src/diagnostic-payload.js";
import {
  runDiagnostic,
  recordResponse,
  captureFailure,
  beginAuthDiagnosis,
  endAuthDiagnosis,
  failureDiagnostic,
  receiveDiagnostic,
  diagnosticOperationId,
  safeDiagnostic,
  responseError,
  verboseDiagnostic,
  safeVerboseDiagnostic,
  receiveVerboseDiagnostic,
} from "../../adapters/mcp/src/diagnostics.js";

describe("shared diagnostic transport contract", () => {
  it("retains ordered HTML dates and status evidence without raw or active content", () => {
    const html = `<div class="page_group" data-groupid="101">
      <script>${"SCRIPT_SECRET".repeat(6000)}</script>
      <style>.private { display:none } /* STYLE_SECRET */</style>
      <!-- COMMENT_SECRET -->
      <form><p>FORM_SECRET</p><input value="INPUT_SECRET"></form>
      <div hidden>HIDDEN_SECRET</div><div style="display:/**/none">CSS_SECRET</div>
      <div aria-hidden=" TRUE ">ARIA_SECRET</div><div class="d-none">CLASS_SECRET</div>
      <iframe src="https://example.test/FRAME_SECRET"></iframe>
      <template>TEMPLATE_SECRET</template><svg><text>SVG_SECRET</text></svg>
      <div class="note_list_item" data-noteid="801" data-date="1800000000"
        data-token="ATTR_SECRET" onclick="EVENT_SECRET">
        <span>Sent by Alex</span><a href="https://example.test/LINK_SECRET">Read</a>
      </div>
      <div class="note_list_item" data-noteid="800" data-date="0"><span>Draft</span></div>
      <div class="note_list_item" data-noteid="799" data-date="-1"><span>Scheduled</span></div>
    </div>`;
    expect(Buffer.byteLength(html)).toBeGreaterThan(65536);
    const payload = sanitizePayload(html, "html");
    if (payload.state !== "captured") throw new Error("Missing HTML capture");
    expect(payload.format).toBe("html");
    expect(Buffer.byteLength(payload.json)).toBeLessThanOrEqual(8192);
    const structure = JSON.parse(payload.json);
    expect(
      structure.elements
        .filter((element: { attributes: Record<string, string> }) =>
          Object.hasOwn(element.attributes, "data-date"),
        )
        .map(
          (element: { attributes: Record<string, string> }) =>
            element.attributes["data-date"],
        ),
    ).toEqual(["1800000000", "0", "-1"]);
    expect(payload.json).toContain("Sent by");
    expect(payload.json).toContain("Draft");
    expect(payload.json).toContain("Scheduled");
    expect(payload.json).not.toMatch(/SECRET|<script|onclick|https:\/\//);
    expect(safePayload(payload)).toEqual(payload);
    expect(sanitizePayload("<p>alex@example.test</p>", "html")).toMatchObject({
      state: "captured",
      json: expect.not.stringContaining("alex@example.test"),
    });
  });

  it.each([
    "<p>Token: <b>EXCLUDE_ME_73</b></p>",
    "<span>To</span><span>ken</span><span>EXCLUDE_ME_73</span>",
    '<div id="session">EXCLUDE_ME_73</div>',
    '<span>Cookie</span><span class="EXCLUDE_ME_73"></span>',
    "<p>Authorization: Bearer EXCLUDE_ME_73</p>",
    "<p>api&#107;ey=EXCLUDE_ME_73</p>",
    "<aside><label>Token</label><span>EXCLUDE_ME_73</span></aside>",
    '<div id="session"><div><div><div><span>EXCLUDE_ME_73</span></div></div></div></div>',
    "<dl><dt>Token</dt><dd><div><span>EXCLUDE_ME_73</span></div></dd></dl>",
  ])("filters credentials across HTML nodes and attributes: %s", (html) => {
    const payload = sanitizePayload(html, "html");
    expect(payload.state).toBe("captured");
    expect(JSON.stringify(payload)).not.toContain("EXCLUDE_ME_73");
    expect(safePayload(payload)).toEqual(payload);
  });

  it.each([
    "<dl><dt><b>Token</b></dt><dd><div><span>482913</span></div></dd></dl>",
    "<table><tr><th><span>Passcode</span></th><td><div><span>482913</span></div></td></tr></table>",
    "<dl><dt>Password</dt><dt>Passcode</dt><dd><div><span>482913</span></div></dd></dl>",
    "<dl><dt><b>Password</b></dt><dt><i><span>Passcode</span></i></dt><dd><div><span>482913</span></div></dd></dl>",
    "<section><div><b><i>Token</i></b></div><div>482913</div></section>",
    "<section><div><b>Token</b></div><div><div><div><span>482913</span></div></div></div></div></section>",
    "<section><div><b><i>Token</i></b></div><div><b>Passcode</b></div><div><span>482913</span></div></section>",
    "<dl><dt><b>Token</b>:</dt><dd><div><span>482913</span></div></dd></dl>",
    "<table><tr><th><span>Passcode</span> *</th><td><div><span>482913</span></div></td></tr></table>",
    '<table><tr><th><span>PIN</span><span class="required"></span></th><td><span>4829</span></td></tr></table>',
    "<dl><dt>Your <b>passcode</b></dt><dd><div><span>482913</span></div></dd></dl>",
    '<dl><dt>Your <b>Password</b></dt><dt><b>Passcode</b><span class="required">*</span></dt><dd><div><span>482913</span></div></dd></dl>',
    "<section><div><b>Token</b>:</div><div><div><span>482913</span></div></div></section>",
    "<table><tr><th>Passcode</th></tr><tr><td><div><span>482913</span></div></td></tr></table>",
    "<table><thead><tr><th>Access code</th></tr></thead><tbody><tr><td><span>482913</span></td></tr></tbody></table>",
    "<dl><dt>Passcodes</dt><dd>1111</dd><dd>2222</dd><dd>3333</dd></dl>",
    "<table><tr><th>Name</th><th>PIN</th></tr><tr><td>Ann</td><td>4829</td></tr></table>",
  ])(
    "filters wrapped and chained HTML labels before capture and at boundaries: %s",
    (html) => {
      const controls = `<section><div><div><p>Ordinary parish activity</p>
      <div class="page_group page_notes" data-groupid="101">
        <div class="note_list_item" data-noteid="801" data-date="1800000000"><span class="author">Sent by Alex</span></div>
        <div class="load_more_notes">More notes</div>
      </div></div></div></section>`;
      const initial = sanitizePayload(html + controls, "html");
      if (initial.state !== "captured") throw new Error("Missing capture");
      const forged = JSON.parse(initial.json);
      forged.elements.push({
        position: 8192,
        depth: 3,
        tag: "span",
        text: "482913",
        attributes: {
          id: "4829",
          class: "page_notes 3333",
          "data-date": "EXCLUDE_ME_73",
        },
      });
      const boundary = safePayload({
        ...initial,
        json: JSON.stringify(forged),
      });
      for (const payload of [initial, boundary]) {
        if (payload.state !== "captured") throw new Error("Missing capture");
        expect(payload.json).not.toMatch(
          /482913|4829|1111|2222|3333|EXCLUDE_ME_73|Ordinary parish activity|Alex|More notes/,
        );
        expect(payload.json).toContain("Sent by");
        expect(payload.json).toContain('"data-date":"1800000000"');
        for (const selector of [
          "page_group",
          "page_notes",
          "note_list_item",
          "author",
          "load_more_notes",
        ])
          expect(payload.json).toContain(selector);
        const positions = JSON.parse(payload.json).elements.map(
          (element: { position: number }) => element.position,
        );
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(safePayload(safePayload(payload))).toEqual(payload);
      }
    },
  );

  it.each([0, 300])(
    "keeps redaction markers inert through repeated revalidation with %s padding elements",
    (padding) => {
      const html = `<p>Token</p><div class="x" ${padding ? 'data-noteid="801"' : ""}><span>a</span></div><p>Visible</p>
        ${"<p>Ordinary parish activity</p>".repeat(padding)}
        <div class="note_list_item" data-date="1800000000">Scheduled</div>`;
      const initial = sanitizePayload(html, "html");
      if (initial.state !== "captured") throw new Error("Missing capture");
      expect(initial.truncated).toBe(padding > 0);
      expect(initial.json).toContain('"class":"[redacted]"');
      expect(initial.json).not.toContain("Visible");
      expect(initial.json).toContain("Scheduled");
      expect(initial.json).toContain('"data-date":"1800000000"');
      let payload = initial;
      for (let i = 0; i < 5; i++) {
        const revalidated = safePayload(payload);
        expect(revalidated).toEqual(initial);
        if (revalidated.state !== "captured")
          throw new Error("Missing capture");
        payload = revalidated;
      }
    },
  );

  it.each([
    "%ED%AA",
    "Q&A; bring questions",
    "St. Mary&#8217;s",
    "100%Catholic",
    "passage".repeat(40),
    JSON.stringify({ text: "keyboard".repeat(40) }),
  ])(
    "omits arbitrary HTML text without decoding or clipping it: %s",
    (text) => {
      const payload = sanitizePayload(
        `<p>${text.replaceAll("&", "&amp;")}</p><div data-date="0">Draft</div>`,
        "html",
      );
      if (payload.state !== "captured") throw new Error("Missing capture");
      expect(payload.json).not.toContain(text);
      expect(payload.json).toContain('"data-date":"0"');
      expect(payload.json).toContain("Draft");
      expect(safePayload(safePayload(payload))).toEqual(payload);
    },
  );

  it("retains useful evidence through harmless wrappers and long unrelated page text", () => {
    const html = `<aside><div class="page_group" data-groupid="101">
      <figure><div class="note_list_item" data-date="0"><span>Scheduled</span></div></figure>
      ${"<p>Ordinary parish activity information for this week.</p>".repeat(200)}
      <p>Author</p><span>To</span><span>ken</span><span>EXCLUDE_ME_73</span>
      </div></aside>`;
    const payload = sanitizePayload(html, "html");
    if (payload.state !== "captured") throw new Error("Missing capture");
    expect(payload.truncated).toBe(true);
    expect(payload.json).toContain('"class":"note_list_item"');
    expect(payload.json).toContain('"data-date":"0"');
    expect(payload.json).toContain("Scheduled");
    expect(payload.json).not.toContain("EXCLUDE_ME_73");
    expect(safePayload(payload)).toEqual(payload);
    for (const input of ["<div>".repeat(130), "<div></div>".repeat(8193)]) {
      expect(sanitizePayload(input, "html")).toEqual({
        state: "omitted",
        reason: "limit",
      });
    }
  });

  it("keeps selectors and dates in ordinary email markup with percent and entity-like prose", () => {
    const html =
      `<div class="page_group" data-groupid="101"><div class="page_notes">
        <div class="note_list_item" data-noteid="801" data-date="1800000000"><div class="author">Sent by Private Author</div></div>
        <div class="load_more_notes"></div></div></div>` +
      "<p>100% accurate. 100% Catholic. Coffee & donuts; all welcome.</p>" +
      `<script>${"padding".repeat(10000)}</script>`;
    const payload = sanitizePayload(html, "html");
    if (payload.state !== "captured") throw new Error("Missing capture");
    const elements = JSON.parse(payload.json).elements;
    for (const name of [
      "page_group",
      "page_notes",
      "note_list_item",
      "author",
      "load_more_notes",
    ]) {
      expect(
        elements.some((element: { attributes: { class?: string } }) =>
          element.attributes.class?.split(/\s+/).includes(name),
        ),
      ).toBe(true);
    }
    expect(payload.json).toContain('"data-date":"1800000000"');
    expect(safePayload(payload)).toEqual(payload);
  });

  it.each(["noembed", "noframes", "dialog", "datalist", "details"])(
    "excludes hidden or embedded %s subtrees",
    (tag) => {
      const payload = sanitizePayload(
        `<${tag}><div data-date="13">Draft</div></${tag}><div data-date="17">Scheduled</div>`,
        "html",
      );
      expect(payload.state).toBe("captured");
      if (payload.state !== "captured") throw new Error("Missing capture");
      expect(payload.json).not.toContain('"data-date":"13"');
      expect(payload.json).toContain('"data-date":"17"');
    },
  );

  it("retains late diagnostic attributes under HTML truncation and revalidates forged projections", () => {
    const html = `${'<div class="wrapper"><span>Ordinary content</span></div>'.repeat(300)}
      <div data-date="0" data-noteid="801">Draft</div>`;
    runDiagnostic(
      "member_latest_email_status",
      () => {
        recordResponse(
          "group/101/notes?ajax&more",
          "GET",
          { contentType: "html", data: html },
          1,
        );
        const trace = verboseDiagnostic("success");
        expect(trace?.truncated).toBe(true);
        const payload = trace?.exchanges[0]?.response;
        if (payload?.state !== "captured") throw new Error("Missing capture");
        expect(payload.truncated).toBe(true);
        expect(payload.json).toContain('"data-date":"0"');
        expect(Buffer.byteLength(payload.json)).toBeLessThanOrEqual(8192);
        expect(safeVerboseDiagnostic(trace)).toEqual(trace);
        const structure = JSON.parse(payload.json);
        structure.elements[0].attributes.href = "EXCLUDE_ME_73";
        expect(
          safePayload({ ...payload, json: JSON.stringify(structure) }),
        ).toEqual({
          state: "omitted",
          reason: "unsupported",
        });
        delete structure.elements[0].attributes.href;
        structure.elements[0].tag = "script";
        expect(
          safePayload({ ...payload, json: JSON.stringify(structure) }),
        ).toEqual({
          state: "omitted",
          reason: "unsupported",
        });
      },
      undefined,
      false,
      true,
    );
    expect(sanitizePayload("x".repeat(1024 * 1024 + 1), "html")).toEqual({
      state: "omitted",
      reason: "limit",
    });
    const invalidEncoding = sanitizePayload(
      '<p>%ED%AA</p><div data-date="0">Draft</div>',
      "html",
    );
    expect(invalidEncoding).toMatchObject({
      state: "captured",
      json: expect.stringContaining('"data-date":"0"'),
    });
    expect(JSON.stringify(invalidEncoding)).not.toContain("%ED%AA");
  });

  it.each([
    "apikey",
    "accesskey",
    "privatekey",
    "passcode",
    "passphrase",
    "pincode",
    "accesscode",
    "securitycode",
    "verificationcode",
    "resetcode",
    "logincode",
    "mfacode",
    "smscode",
    "onetimecode",
    "twofactorcode",
    "passkey",
    "licensekey",
    "signingkey",
    "clientkey",
    "recoverykey",
    "userpin",
    "pinnumber",
    "API Key",
    "api key",
    "Access Code",
    "Security code",
    "Verification Code",
    "Session ID",
    "Auth Token",
    "New password",
    "PIN number",
    "One-time code",
    "Login code (6 digits)",
    "Authorization header",
    "Your password:",
    "password:",
    "session",
    "ＡＰＩＫＥＹ",
    ...[
      "\u00ad",
      "\u034f",
      "\u115f",
      "\u1160",
      "\u3164",
      "\uffa0",
      "\u17b4",
      "\u200b",
      "\u200d",
      "\u200f",
      "\u2060",
      "\ufe0f",
      "\u{e0100}",
    ].flatMap((invisible) => {
      const label = `to${invisible}ken`;
      return [label, encodeURIComponent(label)];
    }),
    "%EF%BD%94%EF%BD%8F%EF%BD%8B%EF%BD%85%EF%BD%8E",
  ])("filters credential labels and wrappers: %s", (label) => {
    for (const suspect of [
      // Colon-bearing property names are unsupported, unlike label values.
      ...(label.includes(":") ? [] : [{ [label]: "EXCLUDE_ME_73" }]),
      { name: label, value: "EXCLUDE_ME_73" },
      { field: label, value: "EXCLUDE_ME_73" },
      { key: label, value: "EXCLUDE_ME_73" },
      { header: label, value: "EXCLUDE_ME_73" },
      { name: [label], value: ["EXCLUDE_ME_73"] },
      { name: { v: label }, value: "EXCLUDE_ME_73" },
      { name: { value: label }, value: "EXCLUDE_ME_73" },
      { name: { label }, value: "EXCLUDE_ME_73" },
      { name: [[label]], value: "EXCLUDE_ME_73" },
      { name: { v: [[label]] }, value: "EXCLUDE_ME_73" },
      [[label, "EXCLUDE_ME_73"]],
      `${label}=EXCLUDE_ME_73`,
      `${label}: EXCLUDE_ME_73`,
      `${label} EXCLUDE_ME_73`,
    ]) {
      runDiagnostic(
        "member",
        () => {
          const data = { email: "alex@example.test", suspect };
          recordResponse(
            "user/301/profile",
            "POST",
            { contentType: "json", data },
            1,
            new URLSearchParams({
              name: label,
              value: "EXCLUDE_ME_73",
            }).toString(),
          );
          const captured = verboseDiagnostic("success");
          const exchange = captured?.exchanges[0];
          if (!exchange) throw new Error("Missing exchange");
          expect(exchange.response.state).toBe("captured");
          expect(exchange.request).toEqual({
            state: "captured",
            json: '"[redacted]"',
          });
          expect(JSON.stringify(captured)).not.toContain("EXCLUDE_ME_73");
          exchange.response = { state: "captured", json: JSON.stringify(data) };
          exchange.request = {
            state: "captured",
            json: JSON.stringify({ name: [label], value: ["EXCLUDE_ME_73"] }),
          };
          const sanitized = safeVerboseDiagnostic(captured);
          expect(sanitized?.exchanges[0]?.response.state).toBe("captured");
          expect(sanitized?.exchanges[0]?.request).toEqual({
            state: "captured",
            json: '"[redacted]"',
          });
          expect(JSON.stringify(sanitized)).not.toContain("EXCLUDE_ME_73");
        },
        undefined,
        false,
        true,
      );
    }
  });

  it.each(["%25252574oken", "to\\u00adken", "to&#173;ken", "to%ADken"])(
    "omits unresolved label encodings without a raw fallback: %s",
    (label) => {
      runDiagnostic(
        "member",
        () => {
          const data = { name: label, value: "EXCLUDE_ME_73" };
          recordResponse(
            "user/301/profile",
            "POST",
            { contentType: "json", data },
            1,
            new URLSearchParams(data).toString(),
          );
          const captured = verboseDiagnostic("success");
          const exchange = captured?.exchanges[0];
          if (!exchange) throw new Error("Missing exchange");
          const omitted = { state: "omitted", reason: "unsupported" };
          expect(exchange.response).toEqual(omitted);
          expect(exchange.request).toEqual(omitted);
          expect(JSON.stringify(captured)).not.toContain("EXCLUDE_ME_73");
          exchange.response = { state: "captured", json: JSON.stringify(data) };
          exchange.request = {
            state: "captured",
            json: JSON.stringify({ name: [label], value: ["EXCLUDE_ME_73"] }),
          };
          const sanitized = safeVerboseDiagnostic(captured);
          expect(sanitized?.exchanges[0]?.response).toEqual(omitted);
          expect(sanitized?.exchanges[0]?.request).toEqual(omitted);
          expect(JSON.stringify(sanitized)).not.toContain("EXCLUDE_ME_73");
        },
        undefined,
        false,
        true,
      );
    },
  );

  it("preserves safe Unicode text and wrapped labels without normalizing the output", () => {
    runDiagnostic(
      "member",
      () => {
        const data = {
          email: "alex@example.test",
          subscriberCount: "1,234",
          names: [
            "Pinto",
            "Spinelli",
            "\u200fדָּוִד\u200f",
            "Mickey",
            "Hickey",
            "Crispin",
          ] as const,
          title: "Keynote on Shipping",
          family: "👨‍👩‍👧‍👦",
          symbol: "❤️",
          spelling: "co\u00adoperate",
          fullwidth: "Ａｌｅｘ",
          greeting: "Alex%E2%80%8FRivera",
          greetingWithMarks: "A\u034f\u115f\u1160\u3164\uffa0\u17b4lex",
          "dis\u200dplay": "Alex",
          wrapped: { name: { v: [["Pinto"]] }, value: "Rivera" },
        };
        const fields = {
          email: data.email,
          subscriberCount: data.subscriberCount,
          name: data.names[2],
          family: data.family,
          symbol: data.symbol,
          spelling: data.spelling,
          fullwidth: data.fullwidth,
          greeting: data.greeting,
          greetingWithMarks: data.greetingWithMarks,
          names: data.names.join(", "),
        };
        recordResponse(
          "user/301/profile",
          "POST",
          { contentType: "json", data },
          1,
          new URLSearchParams(fields).toString(),
        );
        const result = verboseDiagnostic("success");
        const response = result?.exchanges[0]?.response;
        const request = result?.exchanges[0]?.request;
        if (response?.state !== "captured" || request?.state !== "captured")
          throw new Error("Missing capture");
        expect(JSON.parse(response.json)).toEqual(data);
        expect(JSON.parse(request.json)).toEqual(
          Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [key, [value]]),
          ),
        );
        expect(safeVerboseDiagnostic(result)).toEqual(result);
      },
      undefined,
      false,
      true,
    );
  });

  it.each([
    {
      data: { ok: false, status: 409, error: { message: "Session expired" } },
      expected: { ok: false, status: 409, error: "[redacted]" },
      prose: "Session expired",
    },
    {
      data: {
        ok: true,
        data: { result: { group: { title: "Pallbearer Ministry" } } },
      },
      expected: {
        ok: true,
        data: { result: { group: "[redacted]" } },
      },
      prose: "Pallbearer Ministry",
    },
    {
      data: { groups: [{ title: "Key Club" }, { title: "Choir" }] },
      expected: { groups: ["[redacted]", { title: "Choir" }] },
      prose: "Key Club",
    },
  ])(
    "redacts prose locally without discarding envelopes: $prose",
    ({ data, expected, prose }) => {
      runDiagnostic(
        "member",
        () => {
          const fields = {
            message: prose,
            email: "alex@example.test",
            subscriberCount: "1,234",
          };
          const requestData = Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [key, [value]]),
          );
          const expectedRequest = "[redacted]";
          recordResponse(
            "user/301/profile",
            "POST",
            { contentType: "json", data },
            1,
            new URLSearchParams(fields).toString(),
          );
          const captured = verboseDiagnostic("success");
          const exchange = captured?.exchanges[0];
          if (!exchange) throw new Error("Missing exchange");
          expect(exchange.response).toEqual({
            state: "captured",
            json: JSON.stringify(expected),
          });
          expect(exchange.request).toEqual({
            state: "captured",
            json: JSON.stringify(expectedRequest),
          });
          exchange.response = { state: "captured", json: JSON.stringify(data) };
          exchange.request = {
            state: "captured",
            json: JSON.stringify(requestData),
          };
          const sanitized = safeVerboseDiagnostic(captured);
          expect(sanitized?.exchanges[0]?.response).toEqual({
            state: "captured",
            json: JSON.stringify(expected),
          });
          expect(sanitized?.exchanges[0]?.request).toEqual({
            state: "captured",
            json: JSON.stringify(expectedRequest),
          });
        },
        undefined,
        false,
        true,
      );
    },
  );

  it.each(
    [
      [["session", "EXCLUDE_ME_73"]],
      [["Cookie", "EXCLUDE_ME_73"]],
      { PHPSESSID: "EXCLUDE_ME_73" },
      { "connect.sid": "EXCLUDE_ME_73" },
      {
        pwd: "EXCLUDE_ME_73",
        pass: "EXCLUDE_ME_73",
        jwt: "EXCLUDE_ME_73",
        signature: "EXCLUDE_ME_73",
        nonce: "EXCLUDE_ME_73",
      },
      { field: "password", value: "EXCLUDE_ME_73" },
      { key: "session", value: "EXCLUDE_ME_73" },
      [{ key: "PHPSESSID", value: "EXCLUDE_ME_73" }],
      { header: "Cookie", value: "EXCLUDE_ME_73" },
      { headerName: "Authorization", value: "EXCLUDE_ME_73" },
      { code: "token", value: "EXCLUDE_ME_73" },
      { name: ["session"], value: ["EXCLUDE_ME_73"] },
      { "to\u200bken": "EXCLUDE_ME_73" },
      { details: 'The response included "token": "EXCLUDE_ME_73"' },
      { details: "'token' => 'EXCLUDE_ME_73'" },
      { details: "token&quot;:&quot;EXCLUDE_ME_73" },
      { details: "%2574oken%253DEXCLUDE_ME_73" },
      { details: '{"password":"EXCLUDE_ME_73"}' },
    ].map((suspect) => ({ suspect })),
  )(
    "excludes credential representations before capture and again at the IPC boundary: $suspect",
    ({ suspect }) => {
      runDiagnostic(
        "member",
        () => {
          const data = { email: "alex@example.test", suspect };
          recordResponse(
            "user/301/profile",
            "GET",
            { contentType: "json", data },
            1,
          );
          const captured = verboseDiagnostic("success");
          expect(JSON.stringify(captured)).not.toContain("EXCLUDE_ME_73");
          if (!captured?.exchanges[0]) throw new Error("Missing exchange");
          captured.exchanges[0].response = {
            state: "captured",
            json: JSON.stringify(data),
          };
          expect(JSON.stringify(safeVerboseDiagnostic(captured))).not.toContain(
            "EXCLUDE_ME_73",
          );
        },
        undefined,
        false,
        true,
      );
    },
  );

  it("retains useful sibling data and ordinary names while dropping label/value secrets", () => {
    runDiagnostic(
      "member",
      () => {
        recordResponse(
          "user/301/profile",
          "GET",
          {
            contentType: "json",
            data: {
              email: "alex@example.test",
              names: ["Pinto", "Spinelli"],
              title: "Keynote on Shipping",
              unsafe: { key: "session", value: "EXCLUDE_ME_73" },
            },
          },
          1,
          "name=session&value=EXCLUDE_ME_73",
        );
        const result = verboseDiagnostic("success");
        const response = result?.exchanges[0]?.response;
        if (response?.state !== "captured") throw new Error("Missing capture");
        expect(JSON.parse(response.json)).toEqual({
          email: "alex@example.test",
          names: ["Pinto", "Spinelli"],
          title: "Keynote on Shipping",
          unsafe: "[redacted]",
        });
        expect(JSON.stringify(result)).not.toContain("EXCLUDE_ME_73");
      },
      undefined,
      false,
      true,
    );
  });

  it("captures structured payloads with redaction, auth exclusion and bounded provenance", () => {
    runDiagnostic(
      "subscriber_count",
      () => {
        recordResponse(
          "group/101/getSubscriberCount",
          "POST",
          {
            status: 200,
            contentType: "json",
            headers: { cookie: "CREDENTIAL_SENTINEL" },
            data: {
              subscriberCount: "1,234",
              email: "alex@example.test",
              nested: [
                {
                  password: "CREDENTIAL_SENTINEL",
                  accessToken: "CREDENTIAL_SENTINEL",
                  "%63ookie": "CREDENTIAL_SENTINEL",
                  loginCode: "CREDENTIAL_SENTINEL",
                },
                { name: "Authorization", value: "CREDENTIAL_SENTINEL" },
                { text: "Bearer CREDENTIAL_SENTINEL" },
                { text: "%74oken%3DCREDENTIAL_SENTINEL" },
                { text: '{"session":"CREDENTIAL_SENTINEL"}' },
              ],
            },
          },
          1,
          "email=alex%40example.test&token=EXCLUDE_ME_73&tag=one&tag=two",
        );
        beginAuthDiagnosis();
        recordResponse(
          "user/userData",
          "GET",
          { contentType: "json", data: { value: "CREDENTIAL_SENTINEL" } },
          2,
        );
        endAuthDiagnosis("authenticated");
        const result = verboseDiagnostic(
          "failure",
          failureDiagnostic(new FlockbotError("invalid_response")),
        );
        expect(result?.exchanges).toHaveLength(2);
        expect(result?.exchanges[0]?.response).toMatchObject({
          state: "captured",
          json: expect.stringContaining('"subscriberCount":"1,234"'),
        });
        expect(result?.exchanges[0]?.request).toMatchObject({
          state: "captured",
          json: expect.stringContaining('"tag":["one","two"]'),
        });
        expect(JSON.stringify(result)).toContain("alex@example.test");
        expect(JSON.stringify(result)).not.toContain("CREDENTIAL_SENTINEL");
        expect(JSON.stringify(result)).not.toContain("EXCLUDE_ME_73");
        expect(result?.exchanges[1]?.response).toEqual({
          state: "omitted",
          reason: "authentication",
        });
        expect(safeVerboseDiagnostic(result)).toEqual(result);
        for (let i = 0; i < 40; i++)
          recordResponse(
            "group/101/getSubscriberCount",
            "GET",
            { contentType: "json", data: { value: "é ".repeat(1800) } },
            i,
          );
        const bounded = verboseDiagnostic(
          "failure",
          failureDiagnostic(new Error()),
        );
        expect(bounded?.truncated).toBe(true);
        expect(bounded?.exchanges.length).toBeLessThanOrEqual(30);
        expect(bounded?.diagnostic?.events).toEqual([]);
        expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
          16384,
        );
      },
      undefined,
      false,
      true,
    );
  });

  it("isolates concurrent opt-ins, rejects foreign records and retains multiple owner replies", async () => {
    const result = await Promise.all(
      [false, true, false].map((verbose) =>
        runDiagnostic(
          "member",
          async () => {
            await Promise.resolve();
            recordResponse(
              "user/301/profile",
              "GET",
              { contentType: "json", data: { email: "alex@example.test" } },
              1,
            );
            return verboseDiagnostic("success");
          },
          undefined,
          false,
          verbose,
        ),
      ),
    );
    expect(result[0]).toBeUndefined();
    expect(result[2]).toBeUndefined();
    expect(result[1]?.exchanges).toHaveLength(1);
    runDiagnostic(
      "member",
      () => {
        receiveVerboseDiagnostic(result[1]);
        expect(verboseDiagnostic("success")).toMatchObject({
          available: false,
          exchanges: [],
        });
      },
      undefined,
      false,
      true,
    );
    runDiagnostic(
      "member",
      () => {
        for (const email of ["alex@example.test", "lee@example.test"]) {
          receiveVerboseDiagnostic(
            runDiagnostic(
              "member",
              () => {
                recordResponse(
                  "user/301/profile",
                  "GET",
                  { contentType: "json", data: { email } },
                  1,
                );
                return verboseDiagnostic("success");
              },
              diagnosticOperationId(),
              true,
              true,
            ),
          );
        }
        expect(verboseDiagnostic("success")?.exchanges).toHaveLength(2);
      },
      undefined,
      false,
      true,
    );
  });

  it("omits unsupported payloads and filters incoming stored or IPC captures again", () => {
    runDiagnostic(
      "member",
      () => {
        for (const [contentType, data] of [
          ["html", "<form>CREDENTIAL_SENTINEL</form>"],
          ["text", "CREDENTIAL_SENTINEL"],
          ["json", undefined],
          [
            "json",
            {
              password: "CREDENTIAL_SENTINEL".repeat(1000),
              email: "alex@example.test",
            },
          ],
        ] as const) {
          recordResponse("user/301/profile", "GET", { contentType, data }, 1);
        }
        const value = verboseDiagnostic("success");
        expect(value?.exchanges[0]?.response).toMatchObject({
          state: "captured",
          format: "html",
        });
        expect(JSON.stringify(value?.exchanges[0])).not.toContain(
          "CREDENTIAL_SENTINEL",
        );
        expect(
          value?.exchanges
            .slice(1, 3)
            .every((e) => e.response.state === "omitted"),
        ).toBe(true);
        expect(value?.exchanges[3]?.response).toMatchObject({
          state: "captured",
        });
        if (!value?.exchanges[3]) throw new Error("Missing capture");
        value.exchanges[3].response = {
          state: "captured",
          json: '{"token":"EXCLUDE_ME_73","email":"alex@example.test"}',
        };
        const sanitized = safeVerboseDiagnostic(value);
        expect(JSON.stringify(sanitized)).not.toContain("EXCLUDE_ME_73");
        expect(JSON.stringify(sanitized)).toContain("alex@example.test");
      },
      undefined,
      false,
      true,
    );
  });

  it("bounds traces while preserving the original failure and final disposition", () => {
    runDiagnostic("subscriber_count", () => {
      const response = recordResponse(
        "group/private-group/getSubscriberCount",
        "GET",
        {
          status: 401,
          contentType: "json",
          reason: "http_rejection",
          headers: "PRIVATE",
          data: { password: "PRIVATE" },
        },
        4,
      );
      captureFailure(
        responseError(
          new FlockbotError(
            "upstream_rejected",
            401,
            undefined,
            undefined,
            "http_rejection",
          ),
          response,
        ),
      );
      beginAuthDiagnosis();
      for (let i = 0; i < 40; i++)
        recordResponse(
          "user/userData",
          "GET",
          { status: 200, bytes: 77, contentType: "json" },
          i,
        );
      endAuthDiagnosis("sign_in_required");
      const diagnostic = failureDiagnostic(
        new FlockbotError("authentication_required"),
      );
      expect(diagnostic.failure).toMatchObject({
        endpoint: "group/{id}/getSubscriberCount",
        status: 401,
        reason: "http_rejection",
        phase: "operation",
      });
      expect(diagnostic.final.code).toBe("authentication_required");
      expect(diagnostic.authentication).toBe("sign_in_required");
      expect(diagnostic.events).toHaveLength(30);
      expect(diagnostic.truncated).toBe(true);
      expect(diagnostic.events.every((e) => e.phase === "authentication")).toBe(
        true,
      );
      const bytes = JSON.stringify(diagnostic);
      expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(16 * 1024);
      expect(bytes).not.toMatch(/PRIVATE|private-group|headers|password/);
      expect(safeDiagnostic(diagnostic)).toEqual(diagnostic);
    });
  });

  it("keeps concurrent operations isolated and rejects cross-operation IPC metadata", async () => {
    const results = await Promise.all(
      ["member", "groups"].map((name) =>
        runDiagnostic(name as "member" | "groups", async () => {
          const id = diagnosticOperationId();
          await Promise.resolve();
          recordResponse(
            name === "member" ? "user/301/profile" : "navigation/groups",
            "GET",
            { status: 200, contentType: "json" },
            3,
          );
          const failure = failureDiagnostic(
            new FlockbotError("invalid_response"),
          );
          expect(failure.operationId).toBe(id);
          return failure;
        }),
      ),
    );
    expect(results[0]?.operationId).not.toBe(results[1]?.operationId);
    expect(results[0]?.events[0]?.endpoint).toBe("user/{id}/profile");
    expect(results[1]?.events[0]?.endpoint).toBe("navigation/groups");
    runDiagnostic("member", () => {
      receiveDiagnostic(results[1]);
      expect(failureDiagnostic(new Error()).events).toEqual([]);
    });
  });

  it("uses the actual older owner identity and strips unrecognized metadata", () => {
    runDiagnostic("member", () => {
      const error = new FlockbotError(
        "invalid_response",
        undefined,
        undefined,
        undefined,
        "expected_object",
      );
      const remote = runDiagnostic(
        "member",
        () => failureDiagnostic(error),
        diagnosticOperationId(),
        true,
      );
      remote.browserRuntime = { version: "0.1.0", fingerprint: "a".repeat(64) };
      receiveDiagnostic({
        ...remote,
        private: "PRIVATE",
        failure: { ...remote.failure, body: "PRIVATE" },
      });
      const result = failureDiagnostic(error);
      expect(result.browserRuntime).toEqual(remote.browserRuntime);
      expect(result.runtime.version).not.toBe("0.1.0");
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(
        safeDiagnostic({
          ...result,
          failure: { ...result.failure, reason: "PRIVATE" },
        }),
      ).toBeUndefined();
    });
    runDiagnostic("member", () => {
      receiveDiagnostic(undefined);
      expect(failureDiagnostic(new Error()).browserRuntime).toBeNull();
    });
  });
});
