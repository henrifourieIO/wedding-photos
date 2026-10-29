import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const request = new Request("http://example.com/api/health");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body: { ok: boolean; service: string } = await response.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("wedding-photos");
  });
});
