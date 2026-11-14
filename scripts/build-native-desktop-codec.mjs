import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { bundleNativeDesktopCodec } from "./bundle-native-desktop-codec.mjs";
const root = process.cwd(),
	base = path.resolve(process.env.PI_FFMPEG_BUILD_DIR || ".safe-exec/ffmpeg-compat-build");
const revision = "986bab2b47540c3d45d1299a40a3b103b344323c",
	ff = path.join(base, "FFmpeg-" + revision),
	prefix = path.join(base, "prefix");
const output = path.join(root, "bin/desktop-codec/win32-x64"),
	binary = path.join(output, "pi-desktop-codec.dll");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 build required");
for (const name of ["amfenc.c", "amfenc.h", "amfenc_h264.c", "nvenc.c"]) {
	const source = await readFile(path.join(ff, "libavcodec", name), "utf8");
	if (
		source.includes("ctx->query_timeout < 0") ||
		source.includes("int64_t             query_timeout;") ||
		source.includes("params.resetEncoder = 0;")
	)
		throw new Error("Use the standard FFmpeg timing-v2 sources, without the local RustDesk patches");
}
await mkdir(output, { recursive: true });
await new Promise((resolve, reject) => {
	const toolchain = path.join(base, "w64devkit/bin");
	const child = spawn(path.join(toolchain, "make.exe"), ["-j4", "libavcodec/libavcodec.a", "libavutil/libavutil.a"], {
		cwd: ff,
		stdio: "inherit",
		windowsHide: true,
		env: { ...process.env, PATH: toolchain + ";" + process.env.PATH },
	});
	child.on("error", reject);
	child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("FFmpeg library build failed: " + code))));
});
const args = [
	"-std=c++17",
	"-O2",
	"-shared",
	"-static",
	"-Wl,--exclude-all-symbols",
	"-DNOMINMAX",
	"-D_WIN32_WINNT=0x0A00",
	"-I" + ff,
	"-I" + prefix + "/include",
	path.join(root, "native/desktop-codec/ffmpeg-bridge.cpp"),
	"-Wl,--start-group",
	ff + "/libavcodec/libavcodec.a",
	ff + "/libavutil/libavutil.a",
	prefix + "/lib/libvpl.a",
	"-Wl,--end-group",
	...[
		"d3d11",
		"dxgi",
		"dxguid",
		"mfuuid",
		"mfplat",
		"ole32",
		"oleaut32",
		"strmiids",
		"user32",
		"gdi32",
		"uuid",
		"bcrypt",
		"atomic",
		"ws2_32",
	].map((x) => "-l" + x),
	"-o",
	binary,
];
await new Promise((resolve, reject) => {
	const p = spawn(path.join(base, "w64devkit/bin/g++.exe"), args, { stdio: "inherit", windowsHide: true });
	p.on("error", reject);
	p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Native codec build failed: " + code))));
});
await writeFile(
	path.join(output, "build.json"),
	JSON.stringify(
		{
			backend: "native-d3d11",
			ffmpegRevision: revision,
			binarySha256: createHash("sha256")
				.update(await readFile(binary))
				.digest("hex"),
			experimental: true,
		},
		null,
		2,
	) + "\n",
);
await copyFile(path.join(ff, "COPYING.LGPLv2.1"), path.join(output, "COPYING.LGPLv2.1"));
await copyFile(path.join(root, "native/desktop-codec/README.md"), path.join(output, "README.md"));
await bundleNativeDesktopCodec(base, output);
console.log("Built native FFmpeg/D3D11 hardware codec.");
