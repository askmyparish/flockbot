import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { zipSync } from "fflate";

async function walk(root, directory = root, files = []) {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await stat(path);
    if (info.isDirectory()) await walk(root, path, files);
    else
      files.push({
        path,
        name: relative(root, path).replaceAll("\\", "/"),
        mode: info.mode,
      });
  }
  return files;
}

/** ZIP stores local calendar fields; fix them and normalize modes across build hosts. */
export async function zipDirectory(root, file, prefix = "", level = 6) {
  const entries = {};
  for (const item of await walk(root)) {
    entries[`${prefix}${item.name}`] = [
      new Uint8Array(await readFile(item.path)),
      {
        level,
        os: 3,
        attrs: (item.mode & 0o111 ? 0o755 : 0o644) << 16,
        mtime: new Date(2026, 0, 1, 0, 0, 0),
      },
    ];
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, zipSync(entries));
}
