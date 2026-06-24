import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { StorageService } from "../../storage/types.js";

/** An in-memory StorageService for tests (no disk/S3). */
export function createMemoryStorage(): StorageService {
  const store = new Map<string, { body: Buffer; contentType: string }>();
  const keyOf = (companyId: string, objectKey: string) => `${companyId}/${objectKey}`;
  let counter = 0;

  return {
    provider: "local_disk",
    async putFile({ companyId, namespace, originalFilename, contentType, body }) {
      counter += 1;
      const objectKey = `${namespace}/${counter}-${originalFilename ?? "file"}`;
      store.set(keyOf(companyId, objectKey), { body, contentType });
      return {
        provider: "local_disk",
        objectKey,
        contentType,
        byteSize: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
        originalFilename: originalFilename ?? null,
      };
    },
    async getObject(companyId, objectKey, options) {
      const entry = store.get(keyOf(companyId, objectKey));
      if (!entry) throw new Error("object not found");
      const body = options?.range
        ? entry.body.subarray(options.range.start, options.range.end + 1)
        : entry.body;
      return {
        stream: Readable.from(body),
        contentType: entry.contentType,
        contentLength: body.byteLength,
      };
    },
    async headObject(companyId, objectKey) {
      const entry = store.get(keyOf(companyId, objectKey));
      return entry
        ? { exists: true, contentType: entry.contentType, contentLength: entry.body.byteLength }
        : { exists: false };
    },
    async deleteObject(companyId, objectKey) {
      store.delete(keyOf(companyId, objectKey));
    },
  };
}
