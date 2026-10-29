import { Hono } from "hono";
import type { AppEnv } from "../types";
import {
  clearHostSessionCookie,
  hostSessionSecret,
  passwordMatches,
  setHostSessionCookie,
} from "../lib/hostSession";

export const hostLogin = new Hono<AppEnv>();

hostLogin.post("/login", async (c) => {
  const secret = hostSessionSecret(c.env);
  if (!c.env.HOST_PASSWORD || !secret) {
    return c.json({ error: "password_login_not_configured" }, 503);
  }
  const body = await c.req.json<{ password?: unknown } | null>().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!(await passwordMatches(c.env, password))) {
    return c.json({ error: "invalid_password" }, 401);
  }
  await setHostSessionCookie(c, secret);
  return c.json({ ok: true });
});

hostLogin.post("/logout", (c) => {
  clearHostSessionCookie(c);
  return c.json({ ok: true });
});
