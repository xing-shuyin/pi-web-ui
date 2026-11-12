import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { windowsDesktopScript } from "../server/device-center/native-desktop/windows.ts";

if (process.platform !== "win32") {
	console.log("Windows service compilation test skipped on this platform");
} else {
	const directory = await mkdtemp(join(tmpdir(), "pi-desktop-service-test-"));
	const exe = join(directory, "PiDesktopService.exe");
	const generated = await readFile("bin/desktop-service/NativeDesktop.cs", "utf8");
	assert(
		generated.endsWith(
			windowsDesktopScript
				.slice(windowsDesktopScript.indexOf("using System;"), windowsDesktopScript.indexOf("\n'@"))
				.replaceAll("\r\n", "\n")
				.trimEnd() + "\n",
		),
	);
	function run(command, args) {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error("Service test timed out"));
			}, 30000);
			child.stdout.on("data", (data) => (out += data));
			child.stderr.on("data", (data) => (out += data));
			child.once("error", reject);
			child.once("exit", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve(out);
				else reject(new Error(out));
			});
		});
	}
	await run(join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), [
		"/nologo",
		"/target:exe",
		"/out:" + exe,
		"/r:System.Drawing.dll",
		"/r:System.Windows.Forms.dll",
		"/r:System.Web.Extensions.dll",
		"/r:System.ServiceProcess.dll",
		...["NativeDesktop.cs", "Native.cs", "Service.cs"].map((file) => resolve("bin/desktop-service", file)),
	]);
	const cases = [
		['{"type":"ack"}', false, true],
		['{"type":"configure","maxEdge":1280,"quality":60,"fps":30}', false, true],
		['{"type":"configure","maxEdge":30000,"quality":60,"fps":30}', true, false],
		['{"type":"configure","maxEdge":1280,"quality":60,"fps":30,"command":"calc"}', true, false],
		['{"type":"close"}', false, true],
		['{"type":"release"}', false, false],
		['{"type":"text","text":"test"}', false, false],
		['{"type":"text","text":"test"}', true, true],
		['{"type":"pointer","x":0.5,"y":0.4,"button":0,"action":"move"}', true, true],
		['{"type":"pointer","x":2,"y":0.4,"button":0,"action":"move"}', true, false],
		['{"type":"wheel","deltaY":1201}', true, false],
		['{"type":"key","code":"Numpad1","action":"down"}', true, true],
		['{"type":"text","text":"test","command":"calc"}', true, false],
		['{"type":"run","path":"calc.exe"}', true, false],
	];
	const path = join(directory, "check.ps1");
	await writeFile(
		path,
		`$ErrorActionPreference='Stop'
$assembly=[Reflection.Assembly]::LoadFile('${exe.replaceAll("'", "''")}')
$method=$assembly.GetType('PiDesktopService').GetMethod('Allowed',[Reflection.BindingFlags]'Static,NonPublic')
$cases=ConvertFrom-Json @'
${JSON.stringify(cases)}
'@
foreach($case in $cases) { $actual=$method.Invoke($null,@([string]$case[0],[bool]$case[1])); if($actual -ne [bool]$case[2]) {throw 'Input validation mismatch'} }
$errors=$null;$tokens=$null
[System.Management.Automation.Language.Parser]::ParseFile('${resolve("bin/desktop-service/install.ps1").replaceAll("'", "''")}',[ref]$tokens,[ref]$errors) | Out-Null
if($errors.Count) {throw $errors[0]}
Write-Output 'compiled; ${cases.length} IPC validation cases; installer syntax valid; no service installed or input injected'
`,
	);
	console.log(
		(
			await run(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				path,
			])
		).trim(),
	);
}
