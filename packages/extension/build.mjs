// Bundles the extension into dist/. With --watch, rebuilds scripts on change; static files copy once.

import { cp, mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

const options = {
  entryPoints: ["src/background.ts", "src/content.ts", "src/popup.ts"],
  bundle: true,
  outdir: "dist",
  format: "iife",
  target: "chrome120",
  logLevel: "info",
};

await mkdir("dist", { recursive: true });
await cp("static", "dist", { recursive: true });

if (process.argv.includes("--watch")) {
  await (await esbuild.context(options)).watch();
} else {
  await esbuild.build(options);
}
