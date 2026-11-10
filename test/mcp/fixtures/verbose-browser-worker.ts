import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { runBrowserBroker } from "../../../adapters/mcp/src/browser-broker.js";
import { openBrowserSession } from "../../../adapters/mcp/src/browser-runtime.js";

const entry = process.argv[1];
const profile = process.argv[2];
if (!entry || !profile?.includes("flockbot-verbose-browser-"))
  throw new Error("Disposable test profile required");

await runBrowserBroker({
  entry,
  profile,
  idleMs: 30_000,
  factory: (options) =>
    openBrowserSession(options, async (directory, settings) => {
      const context = await chromium.launchPersistentContext(directory, {
        ...settings,
        headless: true,
        ignoreDefaultArgs: [],
        chromiumSandbox: false,
        args: [
          ...(settings?.args ?? []),
          "--host-resolver-rules=MAP * ~NOTFOUND",
        ],
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== "https://example-parish.flocknote.com") {
          appendFileSync(join(profile, "external"), "blocked\n");
          await route.abort();
          return;
        }
        const path = url.pathname.slice(1);
        appendFileSync(
          join(profile, "events"),
          `${JSON.stringify({ path, method: request.method() })}\n`,
        );
        if (path === "group/101/notes") {
          await route.fulfill({
            contentType: "text/html",
            body: `<div class="page_group" data-groupid="101"><div class="page_notes">
              <script>${"EXCLUDE_ME_73".repeat(6000)}</script>
              <input type="hidden" value="EXCLUDE_ME_73">
              <div class="note_list_item" data-noteid="801" data-date="1800000000"><span>Sent by Alex</span></div>
              <div class="note_list_item" data-noteid="800" data-date="0"><span>Draft</span></div>
            </div></div>`,
          });
          return;
        }
        let data: unknown;
        if (path === "group/101/getSubscriberCount")
          data = {
            subscriberCount: "1,23",
            email: "alex@example.test",
            PHPSESSID: "EXCLUDE_ME_73",
          };
        else if (path === "group/102/getSubscriberCount")
          data = { subscriberCount: 9, email: "normal@example.test" };
        else if (path === "group/103/getSubscriberCount") {
          while (existsSync(join(profile, "hold"))) await delay(10);
          data = { subscriberCount: 5 };
        } else if (path === "group/102/addToGroupByAdmin") {
          if (existsSync(join(profile, "reject-write"))) {
            await route.abort();
            return;
          }
          data = {
            success: true,
            email: "alex@example.test",
            nested: [["Cookie", "EXCLUDE_ME_73"]],
          };
        } else if (path === "user/userData")
          data = { success: true, userID: 201 };
        else {
          await route.abort();
          return;
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      });
      return context;
    }),
});
