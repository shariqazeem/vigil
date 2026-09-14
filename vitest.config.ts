import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src"), "server-only": resolve(__dirname, "src/test/server-only.ts") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /*
     * `*.online.test.ts` reaches the network on purpose — the certificate checks, against hosts that
     * exist to be reached that way. They are excluded from the default run so that the claim made
     * about this suite everywhere else stays true: it needs no network, no model and no API key, and
     * spawns nothing. Run them with `npm run test:online`.
     */
    exclude: ["**/node_modules/**", "**/*.online.test.ts"],
  },
});
