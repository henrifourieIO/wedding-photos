import { describe, expect, it } from "vitest";
import { presignR2Put, presignUrl } from "../src/lib/r2";

describe("SigV4 presigner", () => {
  it("matches the AWS documented presigned GET vector", async () => {
    const url = await presignUrl({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresInSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("builds an R2 path-style PUT URL signing content-type", async () => {
    const url = new URL(
      await presignR2Put(
        { accountId: "acc", bucket: "bkt", accessKeyId: "AK", secretAccessKey: "SK" },
        "events/e1/orig/m1.jpg",
        "image/jpeg",
        900,
        new Date("2025-01-01T00:00:00Z"),
      ),
    );
    expect(url.host).toBe("acc.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/bkt/events/e1/orig/m1.jpg");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});
