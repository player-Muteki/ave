const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { smokePackagedDesktopApp } = require("./packaged-app-smoke.js");

async function main() {
  assert.equal(process.platform, "linux");
  assert.notEqual(process.getuid(), 0, "Launch the AppImage as an ordinary user");
  const image = path.resolve(process.argv[2]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ave-appimage-"));
  try {
    fs.chmodSync(image, 0o755);
    execFileSync(image, ["--appimage-extract"], { cwd: tmp, stdio: "ignore" });
    const appPath = path.join(tmp, "squashfs-root");
    const desktop = fs.readdirSync(appPath).filter(f => f.endsWith(".desktop"));
    assert.equal(desktop.length, 1);
    const entry = fs.readFileSync(path.join(appPath, desktop[0]), "utf8");
    assert.match(entry, /^Name=AVE$/m);
    assert.doesNotMatch(entry, /^Exec=.*--no-sandbox/m);
    await smokePackagedDesktopApp({ appPath, executablePath: image,
      launchArgs: ["--appimage-extract-and-run"], expectedSandbox: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
