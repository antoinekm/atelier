import { describe, expect, it } from "vitest";

import { HttpError } from "../errors.js";
import { cloudUpstreamRemoteFailureReport } from "../services/cloud-upstreams.js";

describe("cloud upstream remote failures", () => {
  it("preserves the cloud response body and message on run reports", () => {
    const body = {
      error: "bad_request",
      message: "entities[42].body must be an object",
      errors: [{ path: "entities[42].body" }],
    };

    expect(cloudUpstreamRemoteFailureReport(new HttpError(400, "bad_request", body))).toEqual({
      error: "bad_request",
      errorMessage: "entities[42].body must be an object",
      details: body,
    });
  });

  it("redacts credential-shaped fields from cloud response details", () => {
    const body = {
      error: "bad_request",
      message: "remote rejected request",
      accessToken: "upt_secret",
      nested: {
        authorization: "Bearer upt_secret",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----",
      },
    };

    expect(cloudUpstreamRemoteFailureReport(new HttpError(400, "bad_request", body))).toEqual({
      error: "bad_request",
      errorMessage: "remote rejected request",
      details: {
        error: "bad_request",
        message: "remote rejected request",
        accessToken: "[redacted]",
        nested: {
          authorization: "[redacted]",
          privateKeyPem: "[redacted]",
        },
      },
    });
  });

  it("falls back to the thrown error message for non-remote failures", () => {
    expect(cloudUpstreamRemoteFailureReport(new Error("network failed"))).toEqual({
      error: "network failed",
    });
  });
});
