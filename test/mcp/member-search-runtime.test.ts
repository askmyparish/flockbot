import type { BrowserContext } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { openBrowserSession } from "../../adapters/mcp/src/browser-runtime.js";

describe("member search runtime allowlist", () => {
  it("permits only the exact observed read POST paths", async () => {
    const page = {
      route: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      evaluate: vi.fn(async (_expression: unknown, _arguments: unknown) => ({
        data: {},
      })),
      isClosed: () => false,
    };
    const context = {
      newPage: async () => page,
      pages: () => [page],
      close: vi.fn(async () => undefined),
    };
    const session = await openBrowserSession(
      {
        origin: "https://example-parish.flocknote.com",
        profile: "/fictional-profile",
        interactive: false,
      },
      async () => context as unknown as BrowserContext,
    );
    try {
      for (const path of ["group/101/people?ajax", "group/101/filter"])
        await session.request(path, "POST", "fictional=value");
      expect(page.evaluate).toHaveBeenCalledTimes(2);
      for (const [path, method] of [
        ["group/101/people?ajax", "GET"],
        ["group/101/filter", "GET"],
        ["group/101/people", "POST"],
        ["group/101/people?ajax&more", "POST"],
        ["group/101/filter?arbitrary=1", "POST"],
        ["group/../people?ajax", "POST"],
        ["user/301/updateContactInfo?ajax", "POST"],
        ["https://outside.invalid/", "POST"],
      ] as const)
        await expect(session.request(path, method)).rejects.toMatchObject({
          code: "invalid_path",
        });
      expect(page.evaluate).toHaveBeenCalledTimes(2);
      expect(page.evaluate.mock.calls[0]?.[1]).toMatchObject({
        path: "group/101/people?ajax",
        method: "POST",
        body: "fictional=value",
      });
    } finally {
      await session.close();
    }
  });
});
