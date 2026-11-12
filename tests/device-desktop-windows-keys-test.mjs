import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsDesktopScript } from "../server/device-center/native-desktop/windows.ts";

if (process.platform === "win32") {
	const cases = [
		["KeyA", 65, false],
		["Enter", 13, false],
		...Array.from({ length: 10 }, (_, i) => [`Numpad${i}`, 0x60 + i, false]),
		["NumpadEnter", 13, true],
		["NumpadAdd", 0x6b, false],
		["NumpadSubtract", 0x6d, false],
		["NumpadMultiply", 0x6a, false],
		["NumpadDivide", 0x6f, true],
		["NumpadDecimal", 0x6e, false],
		["NumpadComma", 0x6c, false],
		["NumpadEqual", 0xbb, false],
		["NumpadClear", 12, false],
		["NumLock", 0x90, true],
	];
	const directory = await mkdtemp(join(tmpdir(), "pi-windows-key-test-"));
	try {
		const path = join(directory, "keys.ps1");
		// Compile the real helper, but never start capture or inject keys into the user's desktop.
		const declaration = windowsDesktopScript.replace(/^\[NativeDesktop\]::Run\([^\r\n]*\)\r?$/m, "");
		assert(!declaration.includes("[NativeDesktop]::Run("));
		await writeFile(
			path,
			declaration +
				`
$flags = [Reflection.BindingFlags]'Static,NonPublic'
$map = [NativeDesktop].GetMethod('Code', $flags)
$build = [NativeDesktop].GetMethod('KeyInput', $flags)
$result = foreach ($name in @(${cases.map(([name]) => `'${name}'`).join(",")})) {
 $code = $map.Invoke($null, @($name))
 $down = $build.Invoke($null, @($code, $true))
 $up = $build.Invoke($null, @($code, $false))
 [pscustomobject]@{name=$name;identity=$code;vk=$down.u.k.vk;upVk=$up.u.k.vk;downFlags=$down.u.k.flags;upFlags=$up.u.k.flags;scan=$down.u.k.scan}
}
$result | ConvertTo-Json -Compress
`,
		);
		const rows = await new Promise((resolve, reject) => {
			const child = spawn(
				join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path],
				{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
			);
			let stdout = "",
				stderr = "";
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error("Native key compilation timed out"));
			}, 20000);
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				if (code !== 0) return reject(new Error(stderr));
				try {
					resolve(JSON.parse(stdout));
				} catch (error) {
					reject(error);
				}
			});
		});
		assert.equal(rows.length, cases.length);
		for (const [name, vk, extended] of cases) {
			const row = rows.find((row) => row.name === name);
			assert.equal(row.vk, vk, name);
			assert.equal(row.upVk, vk, name + " release");
			assert.equal(row.downFlags, extended ? 1 : 0, name + " flags");
			assert.equal(row.upFlags, extended ? 3 : 2, name + " release flags");
		}
		assert.notEqual(
			rows.find((row) => row.name === "NumpadEnter").identity,
			rows.find((row) => row.name === "Enter").identity,
		);
		assert.equal(rows.find((row) => row.name === "NumLock").scan, 0x45);
		console.log(
			JSON.stringify({
				nativeCompile: true,
				keyCases: cases.length,
				extendedKeys: true,
				balancedReleases: true,
				noInputInjected: true,
			}),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
} else console.log("SKIP Windows native key descriptors: requires Windows PowerShell");
