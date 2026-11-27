import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const outDir = path.join(webDir, "dist");

await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [path.join(webDir, "src/main.tsx")],
  outfile: path.join(outDir, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  jsx: "automatic",
});
await copyFile(path.join(webDir, "index.html"), path.join(outDir, "index.html"));
console.log("Built @ave/web bundle to apps/web/dist/");
