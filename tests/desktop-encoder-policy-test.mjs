// Execute the production C# selection policy; no GPU or driver changes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
if (process.platform !== "win32") {
	console.log("Windows compiler test skipped");
	process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), "pi-encoder-policy-"));
function run(command, args) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (b) => (output += b));
		child.stderr.on("data", (b) => (output += b));
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Policy test timed out"));
		}, 20000);
		child.once("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			code === 0 ? resolveRun(output) : reject(new Error(output));
		});
	});
}
try {
	const source = join(directory, "Test.cs"),
		target = join(directory, "Test.exe");
	await writeFile(
		source,
		`using System;
class Test {
 static void Check(uint? api, bool installed, params DesktopEncoderBuild[] expected) {
  var result=DesktopEncoder.NvidiaBuilds(api,installed);
  if(result.Length!=expected.Length) throw new Exception("Wrong candidate count");
  for(int i=0;i<result.Length;i++) if(result[i]!=expected[i]) throw new Exception("Wrong candidate priority");
 }
 static void Main() {
  Check(0xc2,true,DesktopEncoderBuild.NvidiaCompatible);
  Check(0xc1,true,DesktopEncoderBuild.NvidiaCompatible);
  Check(0xd1,true,DesktopEncoderBuild.NvidiaCompatible,DesktopEncoderBuild.Default);
  Check(null,true,DesktopEncoderBuild.NvidiaCompatible,DesktopEncoderBuild.Default);
  Check(0xc2,false,DesktopEncoderBuild.Default);
  Check(0xb1,true,DesktopEncoderBuild.Default);
  Check(0xd1,false,DesktopEncoderBuild.Default);
  foreach(string codec in new[]{"h264_amf","h264_qsv","h264_mf"}) {
   var result=DesktopEncoder.Builds(codec,null,true);
   if(result.Length!=2||result[0]!=DesktopEncoderBuild.NvidiaCompatible||result[1]!=DesktopEncoderBuild.Default) throw new Exception("Hardware timing runtime priority");
   if(DesktopEncoder.Builds(codec,null,false).Length!=1) throw new Exception("Missing runtime fallback");
  }
  if(DesktopEncoder.Builds("libx264",null,true)[0]!=DesktopEncoderBuild.Default) throw new Exception("CPU runtime fallback");
  Console.WriteLine("14 production encoder policy cases passed");
 }
}`,
	);
	await run(join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), [
		"/nologo",
		"/target:exe",
		"/out:" + target,
		resolve("bin/desktop-service/DesktopEncoder.cs"),
		source,
	]);
	const output = await run(target, []);
	assert.match(output, /14 production/);
	console.log(output.trim());
} finally {
	await rm(directory, { recursive: true, force: true });
}
