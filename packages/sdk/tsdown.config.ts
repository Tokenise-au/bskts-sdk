import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "neutral",
  target: "es2023",
  dts: true,
  sourcemap: true,
  clean: true,
  // peer and runtime dependencies stay imports, never bundled
  external: ["viem", /^viem\//, "zod"],
});
