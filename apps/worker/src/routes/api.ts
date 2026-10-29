import { Hono } from "hono";
import { guest } from "./guest";
import { host } from "./host";
import { hostAccessAuth } from "../lib/auth";
import { assertNever, type AppEnv, type RevealMode } from "../types";

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

api.route("/", guest);
api.use("/host/*", hostAccessAuth());
api.route("/host", host);
