import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    test: {
        env: { VOZEB_PRO_ENCRYPTION_KEY: "71".repeat(32) },
        include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    },
});
