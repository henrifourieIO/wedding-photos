import { Hono } from "hono";
import { api } from "./routes/api";
import { handlePhotoQueueBatch } from "./queue";
import { EventRoom } from "./durable/EventRoom";

export type AppEnv = {
  Bindings: Cloudflare.Env;
};

const app = new Hono<AppEnv>();

app.route("/api", api);

app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  queue: handlePhotoQueueBatch,
};

export { EventRoom };
