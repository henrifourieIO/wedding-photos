import { Hono } from "hono";
import { api } from "./routes/api";
import { handlePhotoQueueBatch } from "./queue";
import { EventRoom } from "./durable/EventRoom";
import type { AppEnv } from "./types";

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
