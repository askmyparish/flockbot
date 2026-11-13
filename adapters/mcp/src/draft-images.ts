import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { FlockbotError } from "../../../src/errors.js";
import type { EmailDraftInput } from "../../../src/models/email-draft.js";

export const MAX_IMAGE_BYTES = 12_000_000;
export interface DraftImage {
  readonly base64: string;
  readonly filename: string;
  readonly mime: string;
}

/** Private snapshots keep validation and upload on identical bytes, one file in memory. */
export class DraftImages {
  #directory: string | undefined;
  readonly #files = new Map<
    string,
    { file: string; filename: string; mime: string }
  >();

  async prepare(input: EmailDraftInput, check: () => void): Promise<void> {
    for (const block of input.content ?? []) {
      if (block.type !== "image" || this.#files.has(block.path)) continue;
      check();
      try {
        if (!isAbsolute(block.path)) throw new Error();
        const extension = extname(block.path).toLowerCase();
        const mime = [".jpg", ".jpeg", ".jfif"].includes(extension)
          ? "image/jpeg"
          : extension === ".png"
            ? "image/png"
            : extension === ".gif"
              ? "image/gif"
              : undefined;
        if (!mime) throw new Error();
        const source = await open(
          block.path,
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
          const stat = await source.stat();
          if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES)
            throw new Error();
          this.#directory ??= await mkdtemp(join(tmpdir(), "flockbot-images-"));
          const file = join(this.#directory, String(this.#files.size));
          const target = await open(file, "wx", 0o600);
          try {
            const buffer = Buffer.alloc(64 * 1024);
            let total = 0;
            for (;;) {
              check();
              const { bytesRead } = await source.read(buffer);
              if (!bytesRead) break;
              if (!total) {
                const signature = buffer.subarray(0, bytesRead);
                const valid =
                  mime === "image/jpeg"
                    ? signature
                        .subarray(0, 3)
                        .equals(Buffer.from([255, 216, 255]))
                    : mime === "image/png"
                      ? signature
                          .subarray(0, 8)
                          .equals(
                            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
                          )
                      : ["GIF87a", "GIF89a"].includes(
                          signature.subarray(0, 6).toString("ascii"),
                        );
                if (!valid) throw new Error();
              }
              total += bytesRead;
              if (total > MAX_IMAGE_BYTES) throw new Error();
              await target.writeFile(buffer.subarray(0, bytesRead));
            }
            if (!total) throw new Error();
          } finally {
            await target.close();
          }
          this.#files.set(block.path, {
            file,
            mime,
            filename: `${randomUUID()}${extension}`,
          });
        } finally {
          await source.close();
        }
      } catch (error) {
        if (error instanceof FlockbotError) throw error;
        throw new FlockbotError(
          "invalid_input",
          undefined,
          "not_submitted",
          undefined,
          "draft_image_file",
        );
      }
    }
  }

  async read(path: string): Promise<DraftImage> {
    const image = this.#files.get(path);
    if (!image) throw new FlockbotError("invalid_configuration");
    return {
      filename: image.filename,
      mime: image.mime,
      base64: (await readFile(image.file)).toString("base64"),
    };
  }

  async close(): Promise<void> {
    if (this.#directory)
      await rm(this.#directory, { recursive: true, force: true }).catch(() => {
        // Local cleanup must not replace the verified remote draft outcome.
      });
    this.#files.clear();
  }
}
