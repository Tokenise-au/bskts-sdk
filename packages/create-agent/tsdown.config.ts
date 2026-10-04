import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  dts: false,
  sourcemap: true,
  clean: true,
  // .js, as package.json "bin" names it (the package is "type": "module")
  fixedExtension: false,
});
