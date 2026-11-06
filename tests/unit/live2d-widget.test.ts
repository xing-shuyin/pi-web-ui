import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LIVE2D_DIR = join(ROOT, "plugins", "live2d");

describe("plugins/live2d 挂件隐藏与穿透守卫", () => {
	it("manifest.json 版本号已正确声明", () => {
		const manifest = JSON.parse(readFileSync(join(LIVE2D_DIR, "manifest.json"), "utf-8"));
		expect(manifest.id).toBe("live2d");
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("styles.mjs 中隐藏状态必须对容器及所有子元素强制 visibility: hidden 与 pointer-events: none", () => {
		const stylesSrc = readFileSync(join(LIVE2D_DIR, "client", "styles.mjs"), "utf-8");

		expect(stylesSrc).toMatch(/#pi-live2d-companion\.pi-l2d-hidden\s*\{[^}]*pointer-events:\s*none\s*!important/);
		expect(stylesSrc).toMatch(/#pi-live2d-companion\.pi-l2d-hidden\s*\{[^}]*visibility:\s*hidden\s*!important/);

		expect(stylesSrc).toMatch(
			/#pi-live2d-companion\.pi-l2d-hidden\s*,\s*#pi-live2d-companion\.pi-l2d-hidden\s*\*\s*\{[^}]*pointer-events:\s*none\s*!important/,
		);
		expect(stylesSrc).toMatch(
			/#pi-live2d-companion\.pi-l2d-hidden\s*,\s*#pi-live2d-companion\.pi-l2d-hidden\s*\*\s*\{[^}]*visibility:\s*hidden\s*!important/,
		);
	});

	it("widget.mjs 中必须包含拖拽终止与隐藏显示安全控制", () => {
		const widgetSrc = readFileSync(join(LIVE2D_DIR, "client", "widget.mjs"), "utf-8");

		expect(widgetSrc).toContain("_abortDragging()");
		expect(widgetSrc).toContain("this.stage?.stop()");
		expect(widgetSrc).toContain('this.container.style.display = "none"');

		expect(widgetSrc).toMatch(/if\s*\(!this\.visible\s*\|\|\s*this\.config\.clickThrough\)\s*return;/);
		expect(widgetSrc).toMatch(/isPixelTransparent\(e\.clientX,\s*e\.clientY\)/);

		expect(widgetSrc).toContain('this.canvas.addEventListener("contextmenu"');
		expect(widgetSrc).toContain('this.canvas.addEventListener("dblclick"');
		expect(widgetSrc).toContain('this.container.addEventListener(\n\t\t\t"wheel"');
	});

	it("engine.mjs 必须实现 start/stop 渲染控制以及 isPixelTransparent 尺寸守卫", () => {
		const engineSrc = readFileSync(join(LIVE2D_DIR, "client", "engine.mjs"), "utf-8");

		expect(engineSrc).toContain("stop()");
		expect(engineSrc).toContain("this.app.ticker.stop()");
		expect(engineSrc).toContain("start()");
		expect(engineSrc).toContain("this.app.ticker.start()");
		expect(engineSrc).toContain("rect.width <= 0 || rect.height <= 0");
	});

	it("engine.mjs 与挂件必须集成音频口型对齐与自然眨眼管线", () => {
		const engineSrc = readFileSync(join(LIVE2D_DIR, "client", "engine.mjs"), "utf-8");
		const widgetSrc = readFileSync(join(LIVE2D_DIR, "client", "widget.mjs"), "utf-8");
		const indexSrc = readFileSync(join(LIVE2D_DIR, "index.mjs"), "utf-8");

		expect(engineSrc).toContain("AudioLipSyncEngine");
		expect(engineSrc).toContain("EyeBlinkEngine");
		expect(engineSrc).toContain("_hookModelLipSyncAndBlink");
		expect(engineSrc).toContain("beforeModelUpdate");
		expect(engineSrc).toContain("_applyBlink");
		expect(engineSrc).toContain("_applyMouth");

		expect(widgetSrc).toContain("openMusicPanel()");
		expect(widgetSrc).toContain("playAudio(");
		expect(widgetSrc).toContain("stopAudio()");
		expect(widgetSrc).toContain("triggerBlink(");
		expect(widgetSrc).toContain("showThought(");
		expect(widgetSrc).toContain("pi-l2d-bubble-thought");

		expect(indexSrc).toContain('name: "live2d"');
		expect(indexSrc).toContain('"play_audio"');
		expect(indexSrc).toContain('"stop_audio"');
		expect(indexSrc).toContain('"trigger_blink"');
		expect(indexSrc).toContain("host.registerMarker");
	});

	it("audio-lipsync.mjs 必须实现 Pro VAD 口型管线 (音量解耦 + 共振峰 + 通量 + AGC)", () => {
		const lipSrc = readFileSync(join(LIVE2D_DIR, "client", "audio-lipsync.mjs"), "utf-8");

		expect(lipSrc).toContain("this.analyser.connect(this.gainNode)");
		expect(lipSrc).toContain("setVoiceOnly");

		expect(lipSrc).toContain("280, 900");
		expect(lipSrc).toContain("900, 2800");
		expect(lipSrc).toContain("prevVocalBins");
		expect(lipSrc).toContain("vocalPeak");
		expect(lipSrc).toContain("sustainTimer");
		expect(lipSrc).toContain("syllablePulse");
	});

	it("audio-lipsync.mjs 必须实现鼓机拦截 (稳态基频 veto + 循环重复 veto + 延续窗)", () => {
		const lipSrc = readFileSync(join(LIVE2D_DIR, "client", "audio-lipsync.mjs"), "utf-8");

		expect(lipSrc).toContain("estimateVocalF0");
		expect(lipSrc).toContain("machineVeto");
		expect(lipSrc).toContain("hangoverBirth");

		expect(lipSrc).toContain("envRing");
		expect(lipSrc).toContain("loopVotes");
		expect(lipSrc).toContain("hangover");
		expect(lipSrc).toContain("killCooldownUntil");
	});
});
