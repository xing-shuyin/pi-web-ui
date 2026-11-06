import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");
const directory = await mkdtemp(join(tmpdir(), "pi-desktop-update-probe-"));
const reportPath = join(directory, "report.json");
const entry = join(directory, "probe.cjs");
const checkOnly = process.argv.includes("--check-only");
const updaterPath = require.resolve("electron-updater");
await writeFile(
	entry,
	`const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, simulatedVersion: '0.0.1', mode: ${JSON.stringify(checkOnly ? "check-only" : "download")}, events: [], installationTested: false };
const reportPath = ${JSON.stringify(reportPath)};
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
app.setPath('userData', ${JSON.stringify(join(directory, "user-data"))});
app.getVersion = () => report.simulatedVersion;
app.whenReady().then(async () => {
  const { NsisUpdater } = require(${JSON.stringify(updaterPath)});
  const updater = new NsisUpdater();
  updater.forceDevUpdateConfig = true;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  const config = path.join(${JSON.stringify(directory)}, 'app-update.yml');
  fs.writeFileSync(config, 'provider: github\\nowner: xing-shuyin\\nrepo: pi-web-ui\\nupdaterCacheDirName: pi-desktop-update-probe\\n');
  updater.updateConfigPath = config;
  updater.app = new Proxy(updater.app, { get(target, key) {
    if (key === 'baseCachePath') return ${JSON.stringify(directory)};
    return Reflect.get(target, key);
  }});
  for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error']) {
    updater.on(event, value => {
      const data = value instanceof Error ? { message: value.message } : value;
      report.events.push({ event, data, at: new Date().toISOString() });
      save();
      console.log(event, event === 'download-progress' ? Math.round(value.percent) + '%' : event === 'error' ? value.message : '');
    });
  }
  try {
    if (process.platform !== 'win32') throw new Error('This probe currently verifies the Windows NSIS updater only.');
    const result = await updater.checkForUpdates();
    if (!result?.updateInfo) throw new Error('No update metadata returned');
    report.targetVersion = result.updateInfo.version;
    if (!${JSON.stringify(checkOnly)}) {
      report.downloadedFiles = await updater.downloadUpdate();
      const crypto = require('node:crypto');
      const expected = result.updateInfo.files.find(file => file.url.endsWith('.exe'));
      if (!expected) throw new Error('No Windows executable in update metadata');
      const hash = crypto.createHash('sha512');
      for await (const chunk of fs.createReadStream(report.downloadedFiles[0])) hash.update(chunk);
      report.sha512Verified = hash.digest('base64') === expected.sha512;
      report.sizeVerified = fs.statSync(report.downloadedFiles[0]).size === expected.size;
      if (!report.sha512Verified || !report.sizeVerified) throw new Error('Downloaded installer failed independent integrity verification');
    }
    report.ok = true;
    save();
    app.exit(0);
  } catch (error) {
    report.ok = false;
    report.error = error.stack || String(error);
    save();
    app.exit(1);
  }
});
`,
);
console.log(`Report: ${reportPath}`);
console.log(`Isolated cache: ${directory}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [entry], { env, stdio: "inherit" });
const timer = setTimeout(() => {
	console.error("Updater probe timed out after 5 minutes");
	child.kill();
}, 300_000);
child.on("error", (error) => {
	clearTimeout(timer);
	console.error(error);
	process.exitCode = 1;
});
child.on("exit", (code) => {
	clearTimeout(timer);
	process.exitCode = code ?? 1;
});
