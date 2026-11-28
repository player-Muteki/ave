import path from "node:path";
import { pathToFileURL } from "node:url";

const media = path.join(process.resourcesPath, "native-media");
const executable = process.platform === "win32" ? ".exe" : "";
process.env.AVE_MEDIA_DIR = media;
process.env.AVE_FFMPEG = path.join(media, "bin", "ffmpeg" + executable);
process.env.AVE_FFPROBE = path.join(media, "bin", "ffprobe" + executable);
await import(
  pathToFileURL(
    path.join(process.resourcesPath, "native-ave/apps/desktop/dist/main.js"),
  ).href
);
