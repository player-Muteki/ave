import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const outDir = path.join(webDir, "dist", "browser");

await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [path.join(webDir, "src/main.tsx")],
  outfile: path.join(outDir, "workbench.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  conditions: ["ave-source", "import", "default"],
  sourcemap: true,
  jsx: "automatic",
});
await copyFile(path.join(webDir, "index.html"), path.join(outDir, "index.html"));
console.log("Built @ave/web bundle to apps/web/dist/browser/");
