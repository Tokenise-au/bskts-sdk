import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    // a test that touches the network is a bug in the test
    testTimeout: 5_000,
  },
});
