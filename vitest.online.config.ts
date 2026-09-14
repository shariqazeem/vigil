import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * The tests that reach the network on purpose — the certificate checks, against hosts that exist to
 * be reached that way. They have their own config so the default suite can keep the property that
 * is claimed for it everywhere else: no network, no model, no API key, nothing spawned.
 *
 *   npm test            the suite a stranger can run on a train
 *   npm run test:online these
 */
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src"), "server-only": resolve(__dirname, "src/test/server-only.ts") } },
  test: { environment: "node", include: ["src/**/*.online.test.ts"], testTimeout: 25_000 },
});
