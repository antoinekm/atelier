import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companySecretVersions } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

// Tokens shorter than this are ignored to avoid coincidental matches; real
// credentials (API keys, tokens, passwords) are comfortably longer.
const MIN_TOKEN_LEN = 8;
const TOKEN_SPLIT = /[\s"'`<>(){}\[\],;:|\\]+/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Candidate secret-like tokens from a body (whitespace/punctuation separated). */
function tokenize(text: string): string[] {
  return text
    .split(TOKEN_SPLIT)
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

/**
 * Block an outbound message whose body contains the value of one of the
 * company's secrets, so a prompt-injected agent cannot exfiltrate a credential
 * by emailing it out. Compares SHA-256 hashes of body tokens against the stored
 * `value_sha256` of current secret versions; no secret plaintext is ever loaded.
 */
export function mailOutboundGuard(db: Db) {
  return {
    assertNoSecretLeak: async (companyId: string, parts: Array<string | null | undefined>): Promise<void> => {
      const text = parts.filter(Boolean).join("\n");
      if (!text) return;
      const tokens = new Set(tokenize(text));
      if (tokens.size === 0) return;

      const rows = await db
        .select({ valueSha256: companySecretVersions.valueSha256 })
        .from(companySecretVersions)
        .innerJoin(companySecrets, eq(companySecretVersions.secretId, companySecrets.id))
        .where(
          and(
            eq(companySecrets.companyId, companyId),
            eq(companySecrets.status, "active"),
            inArray(companySecretVersions.status, ["current"]),
          ),
        );
      if (rows.length === 0) return;
      const secretHashes = new Set(rows.map((r) => r.valueSha256));

      for (const token of tokens) {
        if (secretHashes.has(sha256Hex(token))) {
          throw unprocessable(
            "Outbound message blocked: it appears to contain a secret value. Secrets must never be emailed out.",
          );
        }
      }
    },
  };
}
