import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          LEMON_WEBHOOK_SECRET: "test-webhook-secret",
          LEMON_API_KEY: "test-api-key",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
