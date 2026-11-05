import { rm } from "node:fs/promises";
import { bundleBrowser } from "./browser-build.mjs";

await rm("adapters/mcp/dist", { recursive: true, force: true });
await bundleBrowser();
