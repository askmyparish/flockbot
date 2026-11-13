import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { searchMetadata, searchRow } from "../../fixtures/member-search.js";
import { filterCatalog } from "../../fixtures/member-filters.js";
import { profileResponse } from "../../fixtures/member-profile.js";
import { membershipResponse } from "../../fixtures/member-groups.js";
import { rosterPage, rosterRow } from "../../fixtures/group-members.js";
import { latestEmailResponses } from "../../fixtures/latest-email.js";
import { noteSearchResponse } from "../../fixtures/note-search.js";
import { noteResponse } from "../../fixtures/note.js";
import { duplicationFixture } from "../../fixtures/email-duplication.js";
import { recipientPage } from "../../fixtures/email-recipients.js";
import {
  draftResponse,
  htmlDraftStored,
  blockDraftResponse,
  imageDraftResponse,
} from "../../fixtures/email-draft.js";
import { recordResponse } from "../../../adapters/mcp/src/diagnostics.js";
import {
  BrowserService,
  runBrowserBroker,
} from "../../../adapters/mcp/src/browser-broker.js";

const entry = process.argv[1] ?? "";
const profile = process.argv[2] ?? "";
const role = process.argv[3];
if (role === "broker") {
  writeFileSync(join(profile, "owner.pid"), String(process.pid));
  await runBrowserBroker({
    entry,
    profile,
    idleMs: 1500,
    factory: async () => {
      appendFileSync(join(profile, "events"), "launch\n");
      const blocks = blockDraftResponse();
      const images = imageDraftResponse();
      const duplication = duplicationFixture();
      return {
        signIn: async () => undefined,
        close: async () => {
          appendFileSync(join(profile, "events"), "close\n");
        },
        request: async (path, method = "GET", body, photo) => {
          appendFileSync(join(profile, "events"), `${method} ${path}\n`);
          const data = await (async () => {
            if (existsSync(join(profile, "duplicate"))) {
              if (
                existsSync(join(profile, "draft-failure")) &&
                path === "composer/save2"
              )
                return { success: false };
              return duplication.response(path, body);
            }
            if (existsSync(join(profile, "draft"))) {
              if (existsSync(join(profile, "draft-images"))) {
                if (path === "upload/photo/note" && !photo?.base64)
                  throw new Error("Missing fictional image bytes");
                if (
                  existsSync(join(profile, "draft-failure")) &&
                  path === "composer/saveSection"
                )
                  return { success: false };
                return images(path, body);
              }
              if (
                existsSync(join(profile, "draft-failure")) &&
                path === "composer/saveModule"
              )
                return { success: false };
              if (existsSync(join(profile, "draft-blocks")))
                return blocks(path, body);
              return draftResponse(
                path,
                body,
                existsSync(join(profile, "draft-html"))
                  ? htmlDraftStored
                  : undefined,
              );
            }
            switch (path) {
              case "user/userData":
                if (existsSync(join(profile, "signed-out")))
                  return { success: true, userID: null, authorized: false };
                return { success: true, userID: 201 };
              case "dashboard":
                return '<div id="fnReactHolder"></div>';
              case "navigation/groups":
                return {
                  groups: [
                    { ID: 102, name: "Volunteers", shortname: "volunteers" },
                  ],
                };
              case "network/getMetadata":
                return { success: true, networkID: 201, everyoneGroupID: 101 };
              case "composer/editNote":
                if (body !== "noteID=801&fromComposer=1")
                  throw new Error("Unexpected note input");
                return noteResponse();
              case "supersearch/query?ajax":
                return noteSearchResponse(
                  new URLSearchParams(body).get("searchTerm") ?? "",
                );
              case "note/801/detailedAnalytics?ajax":
                return recipientPage(
                  new URLSearchParams(body).get("type") ?? "",
                );
              case "group/101/getSubscriberCount":
                while (existsSync(join(profile, "hold-count"))) await delay(10);
                return {
                  subscriberCount: existsSync(join(profile, "invalid-count"))
                    ? "1,23"
                    : 7,
                  email: "alex@example.test",
                  token: "EXCLUDE_ME_73",
                };
              case "group/101/people?ajax":
                return searchMetadata();
              case "group/104/people?ajax":
                return {
                  ...filterCatalog(),
                  groupID: "104",
                  isEveryoneGroup: 0,
                };
              case "group/101/filter":
                return {
                  success: true,
                  results: [searchRow()],
                  resultCount: 1,
                };
              case "group/102/people?ajax":
                return rosterPage(
                  Array.from({ length: 100 }, (_, i) =>
                    rosterRow(301 + i, "Alex", `Example${i}`),
                  ),
                  true,
                );
              case "group/102/people/100?ajax&more":
                return rosterPage([rosterRow(401)], false, null);
              case "user/301/profile":
                return profileResponse();
              case "user/301/groups":
                return membershipResponse();
              case "group/102/addToGroupByAdmin":
                while (existsSync(join(profile, "hold"))) await delay(10);
                return { success: true };
              default: {
                const responses: Record<string, unknown> =
                  latestEmailResponses();
                if (Object.hasOwn(responses, path)) return responses[path];
                throw new Error("Missing fictional fixture");
              }
            }
          })();
          recordResponse(
            path,
            method,
            {
              status: 200,
              contentType: typeof data === "string" ? "html" : "json",
              data,
            },
            1,
            body,
          );
          return data;
        },
      };
    },
  });
} else {
  const connection = new BrowserService({
    entry,
    profile,
    launch: () => {
      const child = spawn(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", entry, profile, "broker"],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
    },
  });
  const result =
    role === "add"
      ? await connection.addMemberByName("Volunteers", {
          firstName: "Alex",
          lastName: "Rivera",
          email: "alex@example.test",
        })
      : await connection.count("101");
  process.stdout.write(JSON.stringify(result));
}
