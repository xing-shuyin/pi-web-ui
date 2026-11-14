import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPatchRevision, patchDesktopFfmpeg } from "./patch-ffmpeg-desktop.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = resolve(
	process.argv.find((arg) => arg.startsWith("--work-dir="))?.slice(11) ?? join(root, ".safe-exec/ffmpeg-compat-build"),
);
if (process.platform !== "win32") throw new Error("This build recipe requires a Windows x64 build host");
if (/\s/.test(work)) throw new Error("Choose a --work-dir without spaces for the FFmpeg build");
const revision = "986bab2b47540c3d45d1299a40a3b103b344323c";
const sources = [
	{
		name: "toolchain.7z.exe",
		url: "https://github.com/skeeto/w64devkit/releases/download/v2.11.0/w64devkit-x64-2.11.0.7z.exe",
		sha256: "54c2bb9962e8a30c8270e34c5efc3d5fee579f53087fa7d435b95fbba2af7b2b",
	},
	{
		name: "ffmpeg.tar.gz",
		url: `https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/${revision}`,
		sha256: "4ea06a14d5b9d4e66919be3a93fe8d48e7ddb3516cafc3d6d5945e3e174ccbca",
	},
	{
		name: "nv-codec-headers.tar.gz",
		url: "https://codeload.github.com/FFmpeg/nv-codec-headers/tar.gz/refs/tags/n12.1.14.0",
		sha256: "2fefaa227d2a3b4170797796425a59d1dd2ed5fd231db9b4244468ba327acd0b",
	},
	{
		name: "cmake.zip",
		url: "https://github.com/Kitware/CMake/releases/download/v4.5.0/cmake-4.5.0-windows-x86_64.zip",
		sha256: "301b1728317ccd84e984b02e366a8293735bc5ac618757d3d8f58b578f062411",
	},
	{
		name: "amf-headers.tar.gz",
		url: "https://github.com/GPUOpen-LibrariesAndSDKs/AMF/releases/download/v1.5.3/AMF-headers-v1.5.3.tar.gz",
		sha256: "0f521ad98041f8001147cded4a660127f18b1c27a801a5cd691bda1fa48381be",
	},
	{
		name: "libvpl.tar.gz",
		url: "https://codeload.github.com/intel/libvpl/tar.gz/refs/tags/v2.17.0",
		sha256: "4de3e2faf1e8307fb282e4a43f443191810f6a6b0a484fffa7995ba1c814c6ec",
	},
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(work, { recursive: true });
await Promise.all(
	sources.map(async (source) => {
		const path = join(work, source.name);
		let bytes;
		try {
			bytes = await readFile(path);
		} catch {}
		if (!bytes) {
			const response = await fetch(source.url, { signal: AbortSignal.timeout(300_000) });
			if (!response.ok) throw new Error(`Download failed: ${source.name} HTTP ${response.status}`);
			bytes = Buffer.from(await response.arrayBuffer());
			await writeFile(path, bytes);
		}
		if (digest(bytes) !== source.sha256) throw new Error(`Source checksum mismatch: ${source.name}`);
	}),
);
const bin = join(work, "w64devkit/bin");
const env = {
	...process.env,
	PATH: `${bin};${process.env.PATH}`,
	PKG_CONFIG_PATH: join(work, "prefix/lib/pkgconfig").replaceAll("\\", "/"),
};
function run(command, args, cwd = work) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`))));
	});
}
try {
	await readFile(join(bin, "gcc.exe"));
} catch {
	await run(join(work, "toolchain.7z.exe"), ["-y", `-o${work}`]);
}
const source = join(work, `FFmpeg-${revision}`);
try {
	await readFile(join(source, "configure"));
} catch {
	await run("tar", ["-xf", join(work, "ffmpeg.tar.gz"), "-C", work]);
}
// Source archives have no .git: prevent FFmpeg from reporting the enclosing pi-web-ui revision.
await writeFile(join(source, "FF_VERSION"), `git-${revision.slice(0, 12)}-${desktopPatchRevision}\n`);
await patchDesktopFfmpeg(source);
const headers = join(work, "nv-codec-headers-n12.1.14.0");
try {
	await readFile(join(headers, "Makefile"));
} catch {
	await run("tar", ["-xf", join(work, "nv-codec-headers.tar.gz"), "-C", work]);
}
const prefix = join(work, "prefix").replaceAll("\\", "/");
await run(join(bin, "make.exe"), [`PREFIX=${prefix}`, "install"], headers);
for (const [archive, directory] of [
	["cmake.zip", "cmake-4.5.0-windows-x86_64"],
	["amf-headers.tar.gz", "amf-headers-v1.5.3"],
	["libvpl.tar.gz", "libvpl-2.17.0"],
]) {
	try {
		await readFile(
			join(
				work,
				directory,
				directory.startsWith("cmake")
					? "bin/cmake.exe"
					: directory.startsWith("amf")
						? "AMF/core/Factory.h"
						: "CMakeLists.txt",
			),
		);
	} catch {
		await run("tar", ["-xf", join(work, archive), "-C", work]);
	}
}
const cmake = join(work, "cmake-4.5.0-windows-x86_64/bin/cmake.exe");
const vpl = join(work, "libvpl-2.17.0"),
	vplBuild = join(work, "vpl-build");
await run(cmake, [
	"-S",
	vpl,
	"-B",
	vplBuild,
	"-G",
	"MinGW Makefiles",
	`-DCMAKE_C_COMPILER=${join(bin, "gcc.exe")}`,
	`-DCMAKE_CXX_COMPILER=${join(bin, "g++.exe")}`,
	`-DCMAKE_MAKE_PROGRAM=${join(bin, "make.exe")}`,
	`-DCMAKE_INSTALL_PREFIX=${prefix}`,
	"-DCMAKE_BUILD_TYPE=Release",
	"-DBUILD_SHARED_LIBS=OFF",
	"-DBUILD_TESTS=OFF",
	"-DBUILD_EXAMPLES=OFF",
	"-DINSTALL_EXAMPLES=OFF",
]);
await run(cmake, ["--build", vplBuild, "--parallel", "4"]);
await run(cmake, ["--install", vplBuild]);
const configure = [
	"configure",
	"--target-os=mingw32",
	"--arch=x86_64",
	"--cc=gcc",
	"--cxx=g++",
	"--pkg-config=pkg-config",
	"--disable-everything",
	"--disable-autodetect",
	"--disable-network",
	"--disable-debug",
	"--disable-doc",
	"--disable-ffplay",
	"--disable-ffprobe",
	"--disable-x86asm",
	"--enable-small",
	"--extra-ldflags=-static",
	"--extra-libs=-lstdc++",
	"--enable-ffmpeg",
	"--enable-ffnvcodec",
	"--enable-nvenc",
	"--enable-amf",
	"--enable-libvpl",
	"--enable-mediafoundation",
	`--extra-cflags=-I${join(work, "amf-headers-v1.5.3").replaceAll("\\", "/")}`,
	"--pkg-config-flags=--static",
	"--enable-d3d11va",
	"--enable-dxva2",
	"--enable-encoder=h264_nvenc,h264_amf,h264_qsv,h264_mf,wrapped_avframe",
	"--enable-decoder=rawvideo,wrapped_avframe",
	"--enable-muxer=h264,null",
	"--enable-demuxer=rawvideo",
	"--enable-indev=gdigrab,lavfi",
	"--enable-filter=ddagrab,scale_d3d11,hwdownload,hwupload,hwmap,format,scale,color,testsrc2,null",
	"--enable-protocol=file,pipe",
	"--enable-bsf=h264_metadata",
	"--enable-parser=h264",
];
await run(join(bin, "sh.exe"), configure, source);
await run(join(bin, "make.exe"), ["-j4", "ffmpeg.exe"], source);
const target = join(root, "bin/ffmpeg/win32-x64/nvenc-compat");
await mkdir(target, { recursive: true });
await copyFile(join(source, "ffmpeg.exe"), join(target, "ffmpeg.exe"));
await copyFile(join(source, "COPYING.LGPLv2.1"), join(target, "LICENSE.txt"));
const manifest = {
	sourceRevision: revision,
	nvencHeaders: "12.1.14.0",
	minimumNvencApi: "12.1",
	desktopPatchRevision,
	amfHeaders: "1.5.3",
	intelVpl: "2.17.0",
	binarySha256: digest(await readFile(join(target, "ffmpeg.exe"))),
	sources,
	configure,
};
await writeFile(join(target, "build.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(
	join(target, "THIRD_PARTY_NOTICES.txt"),
	`FFmpeg standalone desktop hardware encoder, LGPL 2.1 or later.\nSource: ${sources[1].url}\nModified by pi-web-ui: ${desktopPatchRevision}; high-resolution Windows pacing, nonblocking DXGI polling, D3D11 texture/scaler compatibility and RGB-to-NV12 color metadata.\nExact patches: scripts/patch-ffmpeg-desktop.mjs\nNVIDIA codec headers 12.1.14.0: ${sources[2].url}\nAMD AMF headers 1.5.3: ${sources[4].url}\nIntel libvpl 2.17.0 (static dispatcher): ${sources[5].url}\nThird-party license texts accompany this executable.\nReproducible recipe: scripts/build-ffmpeg-compat.mjs\nNo external network inputs or media demuxers are enabled; input is local desktop pixels.\n`,
);
await copyFile(join(headers, "include/ffnvcodec/nvEncodeAPI.h"), join(target, "NVIDIA-CODEC-HEADERS-LICENSE.h"));
await copyFile(join(vpl, "LICENSE"), join(target, "INTEL-VPL-LICENSE.txt"));
await copyFile(join(work, "amf-headers-v1.5.3/AMF/core/Factory.h"), join(target, "AMD-AMF-LICENSE.h"));
console.log(JSON.stringify({ target, binarySha256: manifest.binarySha256, nvencHeaders: manifest.nvencHeaders }));
