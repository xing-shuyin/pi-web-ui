import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function runAudioProcess(
	command: string,
	args: string[],
	{ input, signal, timeoutMs = 60000 }: { input?: string | Buffer; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Buffer> {
	const abortSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { windowsHide: true, signal: abortSignal, stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = "";
		let failure: Error | undefined;
		child.stdout.on("data", (chunk) => {
			size += chunk.length;
			if (size > 16 * 1024 * 1024) {
				failure = new Error("语音音频超过 16MB 上限");
				child.kill();
			} else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr = `${stderr}${chunk}`.slice(-2048);
		});
		child.on("error", (error) => {
			failure = error;
		});
		child.on("close", (code) => {
			if (abortSignal.aborted) reject(abortSignal.reason);
			else if (failure) reject(failure);
			else if (code !== 0) reject(new Error(`${command} 语音处理失败 (${code}): ${stderr.trim()}`));
			else resolve(Buffer.concat(chunks));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

const WINDOWS_PREFIX = `[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
`;

export async function listSystemSpeechVoices({ signal }: { signal?: AbortSignal } = {}): Promise<
	{ id: string; label: string }[]
> {
	if (process.platform === "win32") {
		const script = `${WINDOWS_PREFIX}
try {
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
    @{ id = $_.VoiceInfo.Name; label = $_.VoiceInfo.Name + ' (' + $_.VoiceInfo.Culture.Name + ')' }
  })
  ConvertTo-Json -InputObject $voices -Compress
} finally { $synth.Dispose() }`;
		const output = await runAudioProcess(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
			{ signal, timeoutMs: 15000 },
		);
		return JSON.parse(
			output
				.toString("utf8")
				.replace(/^\uFEFF/, "")
				.trim() || "[]",
		);
	}
	if (process.platform === "darwin") {
		const output = await runAudioProcess("say", ["-v", "?"], { signal, timeoutMs: 15000 });
		return output
			.toString("utf8")
			.split("\n")
			.flatMap((line) => {
				const match = line.match(/^(.+?)\s+([a-z]{2,3}(?:[_-][A-Z]{2})?)\s+#/);
				return match ? [{ id: match[1]!.trim(), label: `${match[1]!.trim()} (${match[2]})` }] : [];
			});
	}
	if (process.platform === "linux") {
		let output: Buffer;
		try {
			output = await runAudioProcess("espeak-ng", ["--voices"], { signal, timeoutMs: 15000 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			output = await runAudioProcess("espeak", ["--voices"], { signal, timeoutMs: 15000 });
		}
		return output
			.toString("utf8")
			.split("\n")
			.flatMap((line) => {
				const match = line.match(/^\s*\d+\s+(\S+)\s+\S+\s+(\S+)\s+(\S+)/);
				return match ? [{ id: match[3]!, label: `${match[2]!.replace(/_/g, " ")} (${match[1]})` }] : [];
			});
	}
	return [];
}

export async function synthesizeSystemSpeech(
	text: string,
	{ voice = "", rate = 1, signal }: { voice?: string; rate?: number; signal?: AbortSignal } = {},
): Promise<{ buffer: Buffer; format: "wav" }> {
	if (!String(text ?? "").trim()) throw new Error("语音文本不能为空");
	const speed = Math.max(0.5, Math.min(2, Number(rate) || 1));
	const dir = await mkdtemp(join(tmpdir(), "pi-qq-speech-"));
	const file = join(dir, "speech.wav");
	try {
		let buffer: Buffer;
		if (process.platform === "win32") {
			const script = `${WINDOWS_PREFIX}
try {
  $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($data.voice) { $synth.SelectVoice($data.voice) }
  else {
    $chinese = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
    if ($chinese) { $synth.SelectVoice($chinese.VoiceInfo.Name) }
  }
  $synth.Rate = [int]$data.rate
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($data.file, $format)
  $synth.Speak([string]$data.text)
} finally { $synth.Dispose() }`;
			await runAudioProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
				input: JSON.stringify({ text: String(text), voice, rate: Math.round(Math.log2(speed) * 5), file }),
				signal,
			});
			buffer = await readFile(file);
		} else if (process.platform === "darwin") {
			await runAudioProcess(
				"say",
				[
					"-o",
					file,
					"--file-format=WAVE",
					"--data-format=LEI16@24000",
					"-r",
					String(Math.round(180 * speed)),
					...(voice ? ["-v", voice] : []),
					"-f",
					"-",
				],
				{ input: String(text), signal },
			);
			buffer = await readFile(file);
		} else if (process.platform === "linux") {
			const args = ["--stdout", "--stdin", "-v", voice || "zh", "-s", String(Math.round(175 * speed))];
			try {
				buffer = await runAudioProcess("espeak-ng", args, { input: String(text), signal });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				buffer = await runAudioProcess("espeak", args, { input: String(text), signal });
			}
		} else throw new Error("当前系统不支持本机语音合成，请安装并配置 TTS 插件");
		if (!buffer?.length || buffer.length <= 44) throw new Error("系统语音未生成有效音频，请检查系统音色");
		return { buffer, format: "wav" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error("未找到系统语音程序；Linux 请安装 espeak-ng，或选择已配置的 TTS 插件");
		throw error;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
