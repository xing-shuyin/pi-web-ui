import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") {
	console.log("Windows capture policy test skipped");
	process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), "pi-capture-policy-"));
function run(command, args) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (bytes) => (output += bytes));
		child.stderr.on("data", (bytes) => (output += bytes));
		const timer = setTimeout(() => child.kill(), 20_000);
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timer);
			code === 0 ? resolveRun(output) : reject(new Error(output || `Capture policy test exited ${code}`));
		});
	});
}
try {
	const source = join(directory, "CaptureTest.cs");
	const target = join(directory, "CaptureTest.exe");
	await writeFile(
		source,
		`using System;
using System.Drawing;
using System.Reflection;
class CaptureTest {
 static void Check(bool ok, string message) { if(!ok) throw new Exception(message); }
 static object New(string name) { return Activator.CreateInstance(typeof(DesktopVideo).GetNestedType(name,BindingFlags.NonPublic),true); }
 static void Set(object target,string name,object value) { target.GetType().GetField(name).SetValue(target,value); }
 static string Args(string codec,bool readback,bool direct,bool gdi,int edge,bool compatible=true) {
  object candidate=New("Candidate");
  if(!gdi) { object output=New("Output"); Set(output,"Adapter",2); Set(output,"Index",1); Set(candidate,"Output",output); }
  Set(candidate,"Codec",codec); Set(candidate,"Readback",readback); Set(candidate,"DirectTexture",direct);
  Set(candidate,"Build",compatible?DesktopEncoderBuild.NvidiaCompatible:DesktopEncoderBuild.Default);
  var settings=new NativeDesktop.VideoSettings{Bounds=new Rectangle(-1920,0,1920,1080),Edge=edge,Quality=70,Fps=240};
  return (string)typeof(DesktopVideo).GetMethod("Args",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{settings,candidate});
 }
 static void Main() {
  string direct=Args("h264_nvenc",false,true,false,1920);
  Check(direct.Contains("d3d11va=capture:2")&&direct.Contains("-filter_hw_device capture -filter_complex ddagrab=output_idx=1"),"Capture must bind the selected adapter and output");
  Check(!direct.Contains("-f lavfi")&&!direct.Contains("hwdownload")&&!direct.Contains("scale_d3d11"),"Native-size NVIDIA capture must keep the original GPU texture");
  foreach(string codec in new string[]{"h264_nvenc","h264_amf","h264_qsv","h264_mf"}) {
   string fallback=Args(codec,true,false,false,1280);
   Check(fallback.Contains("ddagrab=")&&fallback.Contains("scale=1280:720:flags=fast_bilinear,format=nv12,hwupload"),"Hardware fallback must retain DXGI and upload NV12 textures: "+codec);
   Check(!fallback.Contains("gdigrab"),"Video processor failure must not require GDI");
   if(codec=="h264_qsv") Check(fallback.Contains("hwmap=derive_device=qsv"),"Intel must derive a matching QSV device");
  }
  string scaled=Args("h264_amf",false,false,false,1280);
  Check(scaled.Contains("scale_d3d11=width=1280:height=720:format=nv12"),"Hardware scaling remains preferred");
  Check(scaled.Contains("matrix_coefficients=1:video_full_range_flag=0"),"GPU-converted NV12 must advertise the matching BT.709 limited range");
  Check(!direct.Contains("matrix_coefficients"),"Preserve the direct BGRA encoder's color conversion");
  Check(!Args("h264_amf",true,false,false,1280).Contains("matrix_coefficients"),"Do not relabel CPU-converted pixels");
  Check(!Args("h264_amf",false,false,false,1280,false).Contains("matrix_coefficients"),"Do not relabel the stock runtime's color conversion");
  string software=Args("libx264",false,false,false,1280);
  Check(software.Contains("format=yuv420p")&&!software.Contains("hwupload"),"Software encoding accepts CPU pixels");
  string gdi=Args("h264_nvenc",false,false,true,1280);
  Check(gdi.Contains("-offset_x -1920")&&gdi.Contains("-r 240 -f gdigrab")&&!gdi.Contains("-init_hw_device"),"GDI compatibility uses the selected bounds without a D3D encoder context");
  Check(direct.Contains("-fps_mode passthrough")&&direct.Contains("framerate=240"),"Do not synthesize output FPS");
  Console.WriteLine("13 production capture policy cases passed");
 }
}`,
	);
	await run(join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), [
		"/nologo",
		"/target:exe",
		"/main:CaptureTest",
		"/out:" + target,
		"/r:System.Drawing.dll",
		"/r:System.Windows.Forms.dll",
		"/r:System.Web.Extensions.dll",
		"/r:System.ServiceProcess.dll",
		...[
			"NativeDesktop.cs",
			"Native.cs",
			"DesktopVideo.cs",
			"DesktopEncoder.cs",
			"DesktopHardware.cs",
			"DesktopWgc.cs",
			"DesktopUserVideo.cs",
			"Service.cs",
		].map((name) => resolve("bin/desktop-service", name)),
		source,
	]);
	const output = await run(target, []);
	assert.match(output, /13 production capture policy cases passed/);
	console.log(output.trim());
} finally {
	await rm(directory, { recursive: true, force: true });
}
