import { rm } from "node:fs/promises";

// A renamed model must not leave its old compiled module in the package.
await rm(new URL("../dist/", import.meta.url), {
  recursive: true,
  force: true,
});
