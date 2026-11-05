import { parseArgs } from "node:util";
import { syncVersions } from "./release-version.mjs";

const { values } = parseArgs({ options: { check: { type: "boolean" } } });
await syncVersions(process.cwd(), values.check);
