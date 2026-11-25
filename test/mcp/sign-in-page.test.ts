import { describe, expect, it, vi } from "vitest";
import {
  signInHandler,
  type PageRequest,
  type SignInResult,
} from "../../adapters/mcp/src/sign-in-page.js";

const authority = "127.0.0.1:49200";
const key = "fictional-key";
const credentials = {
  email: "fictional-login@example.test",
  password: "fictional-password",
};

function page(outcomes: SignInResult[] = ["signed_in"], maxAttempts?: number) {
  const signIn = vi.fn(async () => outcomes.shift() ?? "failed");
  const handle = signInHandler({
    parish: "example-parish",
    authority,
    key,
    signIn,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
  const get = (overrides: Partial<PageRequest> = {}) =>
    handle({
      method: "GET",
      path: `/${key}`,
      host: authority,
      origin: undefined,
      fetchSite: undefined,
      contentType: undefined,
      body: "",
      ...overrides,
    });
  const post = (
    fields: Record<string, string> = credentials,
    overrides: Partial<PageRequest> = {},
  ) =>
    handle({
      method: "POST",
      path: `/${key}`,
      host: authority,
      origin: `http://${authority}`,
      fetchSite: "same-origin",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams(fields).toString(),
      ...overrides,
    });
  return { signIn, get, post };
}

describe("local sign-in page", () => {
  it("serves the form only at this listener's own address and key", async () => {
    const f = page();
    const form = await f.get();
    expect(form.status).toBe(200);
    expect(form.body).toContain("example-parish.flocknote.com");
    expect(form.body).toContain('name="password"');
    for (const refused of [
      // A rebinding site and the localhost alias both name another host.
      { host: "attacker.example:49200" },
      { host: "localhost:49200" },
      { host: undefined },
      { path: "/" },
      { path: `/${key}x` },
      { path: `/${key}?next=1` },
      { path: "/favicon.ico" },
    ]) {
      const response = await f.get(refused);
      expect(response.status).toBe(403);
      expect(response.body).not.toContain("<form");
    }
  });

  it("accepts a submission only from its own page", async () => {
    const f = page();
    for (const refused of [
      { origin: "https://attacker.example" },
      { origin: "http://127.0.0.1:49201" },
      { origin: "null" },
      { fetchSite: "cross-site" },
      { fetchSite: "same-site" },
      { contentType: "text/plain" },
      { contentType: undefined },
      { host: "attacker.example:49200" },
      { path: "/" },
    ]) {
      expect((await f.post(credentials, refused)).status).toBe(403);
    }
    expect(f.signIn).not.toHaveBeenCalled();
    const accepted = await f.post();
    expect(accepted.status).toBe(200);
    expect(accepted.body).toContain("You're signed in");
    expect(f.signIn).toHaveBeenCalledTimes(1);
  });

  it("passes the typed credentials once without echoing the password", async () => {
    const f = page(["credentials_rejected"]);
    const response = await f.post({
      email: "  fictional-login@example.test ",
      password: " fictional password ",
    });
    expect(f.signIn.mock.calls).toEqual([
      [
        {
          email: "fictional-login@example.test",
          password: " fictional password ",
        },
      ],
    ]);
    expect(response.status).toBe(200);
    expect(response.body).toContain("did not accept that email and password");
    expect(response.body).toContain('value="fictional-login@example.test"');
    expect(response.body).not.toContain("fictional password");
  });

  it("escapes a typed email address", async () => {
    const f = page(["credentials_rejected"]);
    const response = await f.post({
      email: '"><script>alert(1)</script>@example.test',
      password: credentials.password,
    });
    expect(response.body).not.toContain("<script>");
    expect(response.body).toContain(
      "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;@example.test",
    );
  });

  it("returns an incomplete submission without sending or counting it", async () => {
    const f = page(["signed_in"], 1);
    for (const fields of [
      { email: "", password: credentials.password },
      { email: credentials.email, password: "" },
      { email: `${"a".repeat(255)}`, password: credentials.password },
    ]) {
      const response = await f.post(fields);
      expect(response.status).toBe(200);
      expect(response.body).toContain("Enter your email address");
    }
    expect(f.signIn).not.toHaveBeenCalled();
    expect((await f.post()).body).toContain("You're signed in");
  });

  it("stops forwarding after the attempt limit", async () => {
    const f = page(["credentials_rejected", "unavailable", "signed_in"], 2);
    expect((await f.post()).status).toBe(200);
    expect((await f.post()).status).toBe(429);
    expect((await f.post()).status).toBe(429);
    expect((await f.get()).status).toBe(429);
    expect(f.signIn).toHaveBeenCalledTimes(2);
  });

  it("holds a second submission while one is in flight and ends after success", async () => {
    let finish: (value: SignInResult) => void = () => undefined;
    const signIn = vi.fn(
      () =>
        new Promise<SignInResult>((resolve) => {
          finish = resolve;
        }),
    );
    const handle = signInHandler({
      parish: "example-parish",
      authority,
      key,
      signIn,
    });
    const submit = () =>
      handle({
        method: "POST",
        path: `/${key}`,
        host: authority,
        origin: `http://${authority}`,
        fetchSite: "same-origin",
        contentType: "application/x-www-form-urlencoded",
        body: new URLSearchParams(credentials).toString(),
      });
    const first = submit();
    expect((await submit()).body).toContain("already in progress");
    finish("signed_in");
    expect((await first).body).toContain("You're signed in");
    expect((await submit()).body).toContain("You're signed in");
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("forbids outside content, scripts, framing and caching", async () => {
    const response = await page().get();
    const policy = response.headers["Content-Security-Policy"] ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("script-src");
    const nonce = /style-src 'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(response.body).toContain(`<style nonce="${nonce}">`);
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(response.body).not.toMatch(/<script|https?:\/\//);
  });
});
