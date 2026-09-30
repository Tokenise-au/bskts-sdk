import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  // .js, as package.json "bin" and "exports" name them (the package is "type": "module")
  fixedExtension: false,
});
