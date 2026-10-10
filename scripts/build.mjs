import { copyFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist", { recursive: true });
const common = { bundle: true, sourcemap: true, logLevel: "info" };

await Promise.all([
  build({ ...common, entryPoints: ["src/app/main.ts"], outfile: "dist/main.cjs", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/app/preload.ts"], outfile: "dist/preload.cjs", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/app/renderer.ts"], outfile: "dist/renderer.js", platform: "browser", format: "iife" }),
]);
copyFileSync("src/app/index.html", "dist/index.html");
