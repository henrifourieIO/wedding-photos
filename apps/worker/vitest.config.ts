import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              GUEST_COOKIE_SECRET: "test-cookie-secret",
              STREAM_ACCOUNT_ID: "acct",
              STREAM_API_TOKEN: "tok",
              STREAM_WEBHOOK_SECRET: "whsec",
            },
          },
        },
      },
    },
  };
});
