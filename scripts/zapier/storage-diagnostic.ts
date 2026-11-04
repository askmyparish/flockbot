import { randomUUID } from "node:crypto";
import {
  ProbeStorageClient,
  StorageError,
  type StorageFailure,
  type StorageFetch,
} from "../../adapters/zapier/src/storage.js";

const FIELDS = [
  "action",
  "data",
  "key",
  "value",
  "previous_value",
  "prev_value",
  "previous",
  "expected_value",
  "expected",
  "new_value",
  "old_value",
  "set_value",
  "compare_value",
  "test",
  "set",
  "secret",
] as const;
const TYPES = [
  "string",
  "number",
  "integer",
  "object",
  "array",
  "boolean",
  "null",
] as const;
type Field = (typeof FIELDS)[number];
type TypeName = (typeof TYPES)[number];

/** A fixed-vocabulary projection: no upstream string is returned verbatim. */
export function validationHints(text: string) {
  const fields = FIELDS.filter((field) =>
    new RegExp(`\\b${field}\\b`, "i").test(text),
  );
  const types = TYPES.filter((type) =>
    new RegExp(`\\b${type}\\b`, "i").test(text),
  );
  const required = new Set<Field>();
  const fieldTypes: { field: Field; type: TypeName }[] = [];
  let visited = 0;
  let json = false;
  function walk(value: unknown, field?: Field, depth = 0): void {
    if (
      ++visited > 500 ||
      depth > 8 ||
      typeof value !== "object" ||
      value === null
    )
      return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, field, depth + 1);
      return;
    }
    for (const [name, item] of Object.entries(value)) {
      if (name === "required" && Array.isArray(item)) {
        for (const candidate of FIELDS)
          if (item.includes(candidate)) required.add(candidate);
      }
      if (name === "type" && field && TYPES.some((type) => type === item))
        fieldTypes.push({ field, type: item as TypeName });
      const next = FIELDS.find((candidate) => candidate === name) ?? field;
      walk(item, next, depth + 1);
    }
  }
  try {
    walk(JSON.parse(text));
    json = true;
  } catch {
    /* Unknown text stays a fixed-vocabulary hint only. */
  }
  return {
    json,
    fields,
    types,
    requiredFields: [...required],
    fieldTypes,
    missingRequired: /required|missing/i.test(text),
    unexpectedField: /additional propert|unexpected|unknown field/i.test(text),
    comparisonMismatch: /does not match|mismatch/i.test(text),
  };
}

export async function boundedText(response: Response) {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done)
        return { text: text + decoder.decode(), truncated: false };
      const remaining = 16_384 - bytes;
      if (chunk.value.byteLength > remaining)
        return {
          text: text + decoder.decode(chunk.value.subarray(0, remaining)),
          truncated: true,
        };
      bytes += chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** One explicitly authorized diagnostic; this does not retry the earlier key. */
export async function diagnoseZapierStorage(
  config: { consent: string; dedicatedStore: boolean },
  secret: string,
  transport: StorageFetch = fetch,
) {
  if (
    config.consent !== "authorize-isolated-storage-diagnostic" ||
    config.dedicatedStore !== true
  )
    throw new StorageError("invalid_configuration");
  const key = `fbdiag_${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  const marker = `diagnostic-${randomUUID()}`;
  let hints: ReturnType<typeof validationHints> | null = null;
  let truncated = false;
  let httpStatus: number | null = null;
  let sent = 0;
  const client = new ProbeStorageClient(secret, async (url, options) => {
    if (sent >= 4) throw new StorageError("request_budget_exceeded");
    sent++;
    const response = await transport(url, options);
    if (options.method === "PATCH") {
      httpStatus = response.status;
      if (!response.ok) {
        const body = await boundedText(response);
        if (!options.signal?.aborted) {
          hints = validationHints(body.text);
          truncated = body.truncated;
        }
      }
    }
    return response;
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let cleanup: "confirmed" | "unconfirmed" = "unconfirmed";
  let failure: StorageFailure | undefined;
  let responseReceived = false;
  try {
    try {
      await client.setIf(key, null, marker, controller.signal);
      responseReceived = true;
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      if (error.code !== "storage_http_failed") throw error;
      responseReceived = true;
    }
    const current = await client.read(key, controller.signal);
    if (current === marker) {
      await client.remove(key, controller.signal);
      if ((await client.read(key, controller.signal)) === null)
        cleanup = "confirmed";
    }
  } catch (error) {
    failure =
      error instanceof StorageError ? error.code : "storage_transport_failed";
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return {
    responseReceived,
    httpStatus,
    validation: hints,
    validationTruncated: truncated,
    observations: client.observations,
    cleanup,
    ...(failure ? { failure } : {}),
    requests: sent,
  };
}
