import { Hono } from "hono";
import { assertNever, type RevealMode } from "../types";

export type AppEnv = {
  Bindings: Cloudflare.Env;
};

function describeRevealMode(mode: RevealMode): string {
  switch (mode) {
    case "instant":
      return "instant";
    case "delayed":
      return "delayed";
    case "private":
      return "private";
    default:
      return assertNever(mode);
  }
}

export const api = new Hono<AppEnv>();

api.get("/health", (c) => {
  const revealModes = (["instant", "delayed", "private"] as const).map(describeRevealMode);
  return c.json({ ok: true, service: "wedding-photos", revealModes });
});
