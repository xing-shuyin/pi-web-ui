/**
 * 一键准备本机运行环境（Windows）。可重复执行，已完成的步骤会跳过。
 * 所有下载物都进 .scratch/emotional-voice/（gitignore），不污染仓库。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RUNTIME = path.join(REPO, ".scratch", "emotional-voice");
const VENV = path.join(RUNTIME, "venv");
const PY = path.join(VENV, "Scripts", "python.exe");
const SOURCE = path.join(RUNTIME, "CosyVoice");
const MODEL = path.join(RUNTIME, "models", "CosyVoice2-0.5B");
const PROMPT_WAV = path.join(RUNTIME, "prompt.wav");
// 官方 PyTorch 源在国内常只有 0.5MB/s；阿里云镜像快一个数量级，但它不是
// PEP 503 索引，只能直接下 wheel，再用 uv 从 PyPI 镜像补依赖。
const TORCH_MIRROR = "https://mirrors.aliyun.com/pytorch-wheels/cu121";
const PYPI_INDEX = "https://mirrors.aliyun.com/pypi/simple/";
const WHEELS = path.join(RUNTIME, "wheels");

fs.mkdirSync(RUNTIME, { recursive: true });

function run(file, args, options = {}) {
	console.log(`  > ${file} ${args.join(" ")}`);
	const result = spawnSync(file, args, {
		stdio: "inherit",
		windowsHide: true,
		...options,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${file} 退出码 ${result.status}`);
	}
}

function findExe(name) {
	try {
		const found = execFileSync("where.exe", [name], {
			encoding: "utf8",
			windowsHide: true,
		})
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean);
		if (found) return found;
	} catch {
		// 继续找常见安装位置
	}
	const guesses = [];
	if (process.env.LOCALAPPDATA) {
		guesses.push(
			path.join(process.env.LOCALAPPDATA, "Programs", name, `${name}.exe`),
			path.join(process.env.LOCALAPPDATA, "Programs", "uv", "uv.exe"),
			path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"),
		);
	}
	if (process.env.USERPROFILE) {
		guesses.push(path.join(process.env.USERPROFILE, ".local", "bin", `${name}.exe`));
	}
	return guesses.find((candidate) => fs.existsSync(candidate));
}

async function waitFor(url, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
			if (response.ok) return;
		} catch {
			// 还没起来
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	throw new Error(`等待 ${label} 超时：${url}`);
}

async function step(title, fn) {
	console.log(`\n=== ${title} ===`);
	await fn();
}

await step("1/7 安装 uv（Python 版本管理器）", async () => {
	if (!findExe("uv")) {
		run("winget", [
			"install",
			"--id",
			"astral-sh.uv",
			"--exact",
			"-e",
			"--accept-source-agreements",
			"--accept-package-agreements",
			"--disable-interactivity",
		]);
	}
	const uv = findExe("uv");
	if (!uv) throw new Error("uv 安装后仍找不到可执行文件，重开终端再试一次");
	console.log(`  uv: ${uv}`);
});

const uv = findExe("uv");

await step("2/7 创建 Python 3.11 虚拟环境", () => {
	run(uv, ["python", "install", "3.11"]);
	if (!fs.existsSync(PY)) {
		run(uv, ["venv", VENV, "--python", "3.11"]);
	}
	console.log(`  python: ${PY}`);
});

await step("3/7 拉取 CosyVoice 源码（含 Matcha 子模块）", () => {
	if (!fs.existsSync(path.join(SOURCE, "cosyvoice", "cli", "cosyvoice.py"))) {
		run("git", [
			"clone",
			"--depth",
			"1",
			"--recurse-submodules",
			"--shallow-submodules",
			"https://github.com/QwenAudio/CosyVoice.git",
			SOURCE,
		]);
	}
	if (!fs.existsSync(path.join(SOURCE, "third_party", "Matcha-TTS", "matcha"))) {
		run("git", ["submodule", "update", "--init", "--recursive"], { cwd: SOURCE });
	}
});

await step("4/7 安装 Python 依赖（含 CUDA 版 PyTorch）", () => {
	// uv 建的 venv 默认不带 pip，依赖安装统一走 `uv pip --python <venv>`
	fs.mkdirSync(WHEELS, { recursive: true });
	const torchWheels = [
		["torch-2.3.1%2Bcu121-cp311-cp311-win_amd64.whl", "torch-2.3.1+cu121-cp311-cp311-win_amd64.whl"],
		["torchaudio-2.3.1%2Bcu121-cp311-cp311-win_amd64.whl", "torchaudio-2.3.1+cu121-cp311-cp311-win_amd64.whl"],
	];
	const localWheels = [];
	for (const [remote, local] of torchWheels) {
		const destination = path.join(WHEELS, local);
		localWheels.push(destination);
		if (!fs.existsSync(destination) || fs.statSync(destination).size < 1_000_000) {
			run("curl", ["-L", "-C", "-", "--retry", "5", "-o", destination, `${TORCH_MIRROR}/${remote}`]);
		}
	}
	run(uv, ["pip", "install", "--python", PY, "--index-url", PYPI_INDEX, ...localWheels]);
	// 上游 requirements 里的 VS onnxruntime-cuda 私有索引只用于 Linux CUDA，
	// 在 Windows 上会抢在 PyPI 前面导致 onnxruntime==1.18.0 解析失败，这里去掉。
	const requirements = fs
		.readFileSync(path.join(SOURCE, "requirements.txt"), "utf8")
		.split(/\r?\n/)
		.filter((line) => !line.trimStart().startsWith("--extra-index-url"))
		// whisper 与 antlr 的 sdist 构建在 Windows 上会卡死，改为直接解包源码（下一步）。
		// Matcha 运行时需要 wget 模块（虽然只用下载函数），保留它。
		.filter((line) => !/^(openai-whisper|antlr4-python3-runtime)==/.test(line.trim()))
		.join("\n");
	const localRequirements = path.join(RUNTIME, "requirements-win.txt");
	fs.writeFileSync(localRequirements, requirements);
	run(uv, ["pip", "install", "--python", PY, "--index-url", PYPI_INDEX, "-r", localRequirements]);
});

// Git 自带 GNU tar 会把 Windows 路径里的 D: 当成远程主机，故加 --force-local。
const WHISPER_SRC = path.join(RUNTIME, "src", "openai-whisper-20231117", "whisper");
const ANTLR_SRC = path.join(RUNTIME, "src", "antlr4-python3-runtime-4.9.3", "src");

await step("4.5/7 解包 whisper / antlr 源码（避开 sdist 构建）", () => {
	if (!fs.existsSync(path.join(WHISPER_SRC, "audio.py"))) {
		const archive = path.join(RUNTIME, "src", "openai-whisper.tar.gz");
		fs.mkdirSync(path.dirname(archive), { recursive: true });
		if (!fs.existsSync(archive)) {
			run("curl", [
				"-L",
				"--retry",
				"3",
				"-o",
				archive,
				"https://files.pythonhosted.org/packages/d2/6e/50ace2bf704e5ffc786d20d96403ab0d57c5d6ab8729de7fed8c436687df/openai-whisper-20231117.tar.gz",
			]);
		}
		run("tar", ["--force-local", "-xzf", archive, "-C", path.dirname(archive)]);
	}
	if (!fs.existsSync(path.join(ANTLR_SRC, "antlr4"))) {
		const archive = path.join(RUNTIME, "src", "antlr4.tar.gz");
		if (!fs.existsSync(archive)) {
			run("curl", [
				"-L",
				"--retry",
				"3",
				"-o",
				archive,
				"https://files.pythonhosted.org/packages/3e/38/7859ff46355f76f8d19459005ca000b6e7012f2f1ca597746cbcd1fbfe5e/antlr4-python3-runtime-4.9.3.tar.gz",
			]);
		}
		run("tar", ["--force-local", "-xzf", archive, "-C", path.dirname(archive)]);
	}
	console.log(`  whisper: ${WHISPER_SRC}`);
	console.log(`  antlr4:  ${ANTLR_SRC}`);
});

await step("5/7 下载 CosyVoice2-0.5B 模型（约 2GB）", () => {
	if (!fs.existsSync(path.join(MODEL, "cosyvoice2.yaml"))) {
		fs.mkdirSync(path.dirname(MODEL), { recursive: true });
		const code = [
			"from modelscope import snapshot_download",
			`snapshot_download('iic/CosyVoice2-0.5B', local_dir=${JSON.stringify(MODEL)})`,
		].join("; ");
		// ModelScope 默认要在用户家目录建 ~/.modelscope，工作区沙箱里没权限，
		// 把 HOME 指到运行时目录即可。
		const home = path.join(RUNTIME, "home");
		fs.mkdirSync(home, { recursive: true });
		run(PY, ["-c", code], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				MODELSCOPE_CACHE: path.join(RUNTIME, "modelscope-cache"),
			},
		});
	}
	console.log(`  模型目录：${MODEL}`);
});

await step("6/7 下载参考音色", async () => {
	if (!fs.existsSync(PROMPT_WAV)) {
		const url = "https://raw.githubusercontent.com/QwenAudio/CosyVoice/main/asset/zero_shot_prompt.wav";
		const response = await fetch(url);
		if (!response.ok) throw new Error(`下载参考音色失败：${response.status}`);
		fs.writeFileSync(PROMPT_WAV, Buffer.from(await response.arrayBuffer()));
	}
	console.log(`  音色：${PROMPT_WAV}`);
});

await step("7/7 检查在线 LLM 配置（本机不再安装 LLM）", () => {
	const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
	const keyName = cfg.llm?.apiKeyEnv ?? "PI_VOICE_API_KEY";
	const hasKey = Boolean(
		process.env[keyName] ||
		process.env.DEEPSEEK_API_KEY ||
		process.env.OPENAI_API_KEY ||
		process.env.DASHSCOPE_API_KEY ||
		cfg.llm?.mock,
	);
	const configured = `在线模型：${cfg.llm?.model}（密钥已配置）`;
	const missing = `未配置密钥：设置环境变量 ${keyName}，或临时把 config.json 的 llm.mock 改成 true 做本地测试`;
	console.log(`  ${hasKey ? configured : missing}`);
});

fs.writeFileSync(
	path.join(RUNTIME, "setup-done.json"),
	JSON.stringify(
		{
			doneAt: new Date().toISOString(),
			python: PY,
			source: SOURCE,
			model: MODEL,
			promptWav: PROMPT_WAV,
			whisperSrc: path.dirname(WHISPER_SRC),
			antlrSrc: ANTLR_SRC,
		},
		null,
		2,
	),
);

console.log("\n全部就绪。运行：cd dev/emotional-voice && npm run start");
