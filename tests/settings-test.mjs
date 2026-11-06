import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.argv[2] || 8931);
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-set-test-"));
console.log("data-dir:", DATA_DIR);

const server = spawn(process.execPath, ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: DATA_DIR,
		PI_WEB_CWD: process.cwd(),
		PI_CODING_AGENT_DIR: join(DATA_DIR, "agent"),
		PI_WEB_PRESET_REPO: "0",
		PI_WEB_PRESET_CATALOG_URL: "https://127.0.0.1/index.json",
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv-err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		ws.on("message", (d) => this.received.push(JSON.parse(d.toString())));
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	async waitFor(type, timeout = 8000, pred) {
		const start = Date.now();
		const types = Array.isArray(type) ? type : [type];
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (!types.includes(m.type)) continue;
				this.received.splice(i, 1);
				if (!pred || pred(m)) return m;
				i--;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
}

async function connect() {
	for (let i = 0; i < 60; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			return new Client(ws);
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name} ${extra}`);
	}
}

let c;
try {
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor(["snapshot", "snapshot_delta"]);
	const st0 = await c.waitFor("settings_state");
	check("settings_state pushed on attach", !!st0.settings);
	check("has skills array", Array.isArray(st0.settings.skills));
	check("has extensions array", Array.isArray(st0.settings.extensions));
	check("has presets array", Array.isArray(st0.settings.presets));
	check(
		"settings_state carries compose template + overrides (default empty)",
		typeof st0.settings.promptTemplate === "string" &&
			st0.settings.promptTemplate === "" &&
			typeof st0.settings.promptOverrides === "object" &&
			typeof st0.settings.promptSourceDefaults === "object" &&
			typeof st0.settings.effectiveSystemPrompt === "string" &&
			typeof st0.settings.visionBridgeDefaultPrompt === "string" &&
			st0.settings.visionBridgeDefaultPrompt.length > 0,
	);
	console.log(`  skills=${st0.settings.skills.length} extensions=${st0.settings.extensions.length}`);

	c.send({ type: "get_settings" });
	const st1 = await c.waitFor("settings_state");
	check("get_settings echoes state", typeof st1.settings.promptTemplate === "string");

	const SAVED_TEMPLATE = "{{soul}}\n\n我的固定开场。\n\n{{context}}";
	const SAVED_SOUL = "你是降世神龙，专精代码重构。";
	c.send({ type: "set_settings", promptTemplate: SAVED_TEMPLATE });
	const st2 = await c.waitFor("settings_state", 8000, (m) => m.settings.promptTemplate === SAVED_TEMPLATE);
	check("compose template persisted", st2.settings.promptTemplate === SAVED_TEMPLATE);
	const stEff = await c.waitFor("settings_state", 10000, (m) =>
		(m.settings.effectiveSystemPrompt ?? "").includes("我的固定开场。"),
	);
	check(
		"effective prompt = compose render（只拼模板里的 token）",
		stEff.settings.effectiveSystemPrompt.includes("我的固定开场。") &&
			stEff.settings.effectiveSystemPrompt.includes("<project_context>") &&
			stEff.settings.effectiveSystemPrompt.includes("You are an expert coding assistant") &&
			!stEff.settings.effectiveSystemPrompt.includes("Available tools:") &&
			!stEff.settings.effectiveSystemPrompt.includes("{{soul}}") &&
			!stEff.settings.effectiveSystemPrompt.includes("{{context}}"),
	);
	const dflt = stEff.settings.promptSourceDefaults ?? {};
	check(
		"promptSourceDefaults = per-source auto text（soul/cwd 等未覆盖时展开值）",
		typeof dflt === "object" &&
			typeof dflt.soul === "string" &&
			dflt.soul.includes("You are an expert coding assistant") &&
			typeof dflt.cwd === "string" &&
			dflt.cwd.startsWith("Current working directory:"),
	);
	c.send({ type: "set_settings", promptOverrides: { soul: SAVED_SOUL } });
	const stOv = await c.waitFor("settings_state", 8000, (m) => m.settings.promptOverrides?.soul === SAVED_SOUL);
	check("per-source override persisted", stOv.settings.promptOverrides?.soul === SAVED_SOUL);
	const stEff2 = await c.waitFor("settings_state", 10000, (m) =>
		(m.settings.effectiveSystemPrompt ?? "").includes(SAVED_SOUL),
	);
	check(
		"override 替换灵魂段生效",
		stEff2.settings.effectiveSystemPrompt.includes(SAVED_SOUL) &&
			!stEff2.settings.effectiveSystemPrompt.includes("You are an expert coding assistant"),
	);

	c.send({ type: "set_settings", terminalToolsEnabled: true });
	await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === true);

	c.send({ type: "save_preset", name: "测试预设" });
	const st6 = await c.waitFor("settings_state", 8000, (m) => m.settings.presets.some((p) => p.name === "测试预设"));
	check(
		"preset saved",
		st6.settings.presets.some((p) => p.name === "测试预设"),
	);

	c.send({ type: "set_settings", promptOverrides: { soul: "" } });
	const stOv2 = await c.waitFor("settings_state", 8000, (m) => !("soul" in (m.settings.promptOverrides ?? {})));
	check("override cleared when sent empty", !("soul" in stOv2.settings.promptOverrides));
	c.send({ type: "set_settings", promptTemplate: "" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptTemplate === "");

	check("terminalToolsEnabled defaults off", st0.settings.terminalToolsEnabled === false);
	c.send({ type: "set_settings", terminalToolsEnabled: false });
	const stT = await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === false);
	check("terminalToolsEnabled off persisted", stT.settings.terminalToolsEnabled === false);
	check("terminalBash defaults off", st0.settings.terminalBash === false);
	check("terminalBashIdleMs defaults 15000", st0.settings.terminalBashIdleMs === 15000);
	check("terminalBashMaxForegroundMs defaults 60000", st0.settings.terminalBashMaxForegroundMs === 60000);
	c.send({ type: "set_settings", terminalBash: true, terminalBashIdleMs: 5000, terminalBashMaxForegroundMs: 30000 });
	const stTB = await c.waitFor("settings_state", 8000, (m) => m.settings.terminalBash === true);
	check("terminalBash on round-trips", stTB.settings.terminalBash === true);
	check("terminalBashIdleMs round-trips", stTB.settings.terminalBashIdleMs === 5000);
	check("terminalBashMaxForegroundMs round-trips", stTB.settings.terminalBashMaxForegroundMs === 30000);
	c.send({ type: "set_settings", terminalBash: false });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptMode === "append");
	check("thinkingWrap defaults off", st0.settings.thinkingWrap === false);
	c.send({ type: "set_settings", thinkingWrap: false });
	const stTW = await c.waitFor("settings_state", 8000, (m) => m.settings.thinkingWrap === false);
	check("thinkingWrap off round-trips", stTW.settings.thinkingWrap === false);
	c.send({ type: "set_settings", thinkingWrap: true });
	await c.waitFor("settings_state", 8000, (m) => m.settings.thinkingWrap === true);

	check("retainFinishedConversations defaults off", st0.settings.retainFinishedConversations === false);
	c.send({ type: "set_settings", retainFinishedConversations: true });
	const stRF = await c.waitFor("settings_state", 8000, (m) => m.settings.retainFinishedConversations === true);
	check("retainFinishedConversations on round-trips", stRF.settings.retainFinishedConversations === true);
	c.send({ type: "set_settings", retainFinishedConversations: false });
	await c.waitFor("settings_state", 8000, (m) => m.settings.retainFinishedConversations === false);

	const skillName = st0.settings.skills[0]?.name;
	if (skillName) {
		c.send({ type: "set_settings", disabledSkills: [skillName] });
		const st3 = await c.waitFor("settings_state", 8000, (m) => m.settings.disabledSkills.includes(skillName));
		check("skill disabled", st3.settings.disabledSkills.includes(skillName));
		const s = st3.settings.skills.find((x) => x.name === skillName);
		check("disabled skill still listed (re-enableable)", s && !s.enabled);
		c.send({ type: "set_settings", disabledSkills: [] });
		const st4 = await c.waitFor(
			"settings_state",
			8000,
			(m) =>
				m.settings.disabledSkills.length === 0 && m.settings.skills.find((x) => x.name === skillName)?.enabled === true,
		);
		check("skill re-enabled", st4.settings.skills.find((x) => x.name === skillName)?.enabled === true);
	} else {
		console.log("  (no skills loaded — skipping)");
	}

	const extId = st0.settings.extensions[0]?.id;
	if (extId) {
		c.send({ type: "set_settings", disabledExtensions: [extId] });
		const st5 = await c.waitFor("settings_state", 8000, (m) => m.settings.disabledExtensions.includes(extId));
		check("extension disabled", st5.settings.disabledExtensions.includes(extId));
		const e = st5.settings.extensions.find((x) => x.id === extId);
		check("disabled extension still listed", e && !e.enabled);
		c.send({ type: "set_settings", disabledExtensions: [] });
		await c.waitFor("settings_state", 8000, (m) => m.settings.disabledExtensions.length === 0);
		check("extension re-enabled", true);
	} else {
		console.log("  (no extensions loaded — skipping)");
	}

	c.send({ type: "set_settings", promptTemplate: "临时模板 {{cwd}}" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptTemplate === "临时模板 {{cwd}}");
	c.send({ type: "apply_preset", name: "测试预设" });
	const st7 = await c.waitFor(
		"settings_state",
		8000,
		(m) => m.settings.promptTemplate === SAVED_TEMPLATE && m.settings.promptOverrides?.soul === SAVED_SOUL,
	);
	check("preset applied (template restored)", st7.settings.promptTemplate === SAVED_TEMPLATE);
	check("preset applied (override restored)", st7.settings.promptOverrides?.soul === SAVED_SOUL);
	check("preset applied (terminal toggle restored to captured value)", st7.settings.terminalToolsEnabled === true);

	c.send({ type: "delete_preset", name: "测试预设" });
	const st8 = await c.waitFor("settings_state", 8000, (m) => !m.settings.presets.some((p) => p.name === "测试预设"));
	check("preset deleted", !st8.settings.presets.some((p) => p.name === "测试预设"));

	const EXPORT_TEMPLATE = "导出用模板 {{cwd}}";
	c.send({ type: "set_settings", promptTemplate: EXPORT_TEMPLATE, promptOverrides: { soul: SAVED_SOUL } });
	await c.waitFor(
		"settings_state",
		8000,
		(m) => m.settings.promptTemplate === EXPORT_TEMPLATE && m.settings.promptOverrides?.soul === SAVED_SOUL,
	);
	c.send({ type: "preset_export", source: "current", requestId: "ex1" });
	const ex1 = await c.waitFor("preset_export_result", 8000, (m) => m.requestId === "ex1");
	check("preset_export ok", ex1.ok === true && typeof ex1.json === "string" && ex1.json.length > 0);
	check("preset_export file name", /^[a-z0-9-]+-[0-9a-f]{7}\.json$/.test(String(ex1.fileName)));
	const exportDoc = JSON.parse(ex1.json);
	check(
		"export doc shape (format/version/settings)",
		exportDoc.format === "pi-web-ui-preset" &&
			exportDoc.version === 1 &&
			typeof exportDoc.settings === "object" &&
			exportDoc.settings.promptTemplate === EXPORT_TEMPLATE &&
			exportDoc.settings.promptOverrides?.soul === SAVED_SOUL,
	);
	check("export doc carries no name inside settings", !("name" in exportDoc.settings));
	check(
		"export doc 带全量字段（含以前排除的运行开关与 UI 偏好）",
		typeof exportDoc.settings.toolLazyLoading === "boolean" &&
			typeof exportDoc.settings.readDirEnabled === "boolean" &&
			typeof exportDoc.settings.toolPromptOverrides === "object" &&
			typeof exportDoc.settings.uiLayout === "object" &&
			typeof exportDoc.settings.thinkingWrap === "boolean",
	);

	c.send({ type: "preset_import", json: ex1.json, dryRun: true, requestId: "im1" });
	const im1 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im1");
	check(
		"preset_import dryRun preview",
		im1.ok === true && im1.dryRun === true && Array.isArray(im1.preview?.fields) && im1.preview.fields.length > 0,
	);
	check("preview reports no replace for a fresh name", im1.preview?.replaces === false);

	c.send({ type: "set_settings", promptTemplate: "被导入覆盖掉的模板" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptTemplate === "被导入覆盖掉的模板");
	c.send({ type: "preset_import", json: ex1.json, name: "导入的预设", apply: true, requestId: "im2" });
	const im2 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im2");
	check("preset_import saved", im2.ok === true && im2.dryRun === false && im2.preview?.name === "导入的预设");
	const stImp = await c.waitFor(
		"settings_state",
		8000,
		(m) => m.settings.presets.some((p) => p.name === "导入的预设") && m.settings.promptTemplate === EXPORT_TEMPLATE,
	);
	check(
		"imported preset listed",
		stImp.settings.presets.some((p) => p.name === "导入的预设"),
	);
	check("import with apply restored the exported template", stImp.settings.promptTemplate === EXPORT_TEMPLATE);
	check("import with apply restored the exported override", stImp.settings.promptOverrides?.soul === SAVED_SOUL);

	c.send({
		type: "preset_import",
		json: JSON.stringify({
			format: "pi-web-ui-preset",
			version: 1,
			name: "净化测试",
			settings: { customSystemPrompt: "ok", evil: { a: 1 }, disabledSkills: "nope" },
		}),
		dryRun: true,
		requestId: "im3",
	});
	const im3 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im3");
	check("unknown fields reported as ignored", im3.preview?.ignored?.includes("evil") === true);
	check("wrong-typed field reported as rejected", im3.preview?.rejected?.includes("disabledSkills") === true);
	check("whitelisted field survives sanitizing", im3.preview?.customSystemPrompt === "ok");

	c.send({
		type: "preset_import",
		json: JSON.stringify({
			format: "pi-web-ui-preset",
			version: 1,
			name: "部分导入",
			settings: { customSystemPrompt: "partial-only", disabledSkills: ["s1"] },
		}),
		fields: ["customSystemPrompt"],
		requestId: "im3b",
	});
	const im3b = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im3b");
	check("可选导入回执只列实际写入的字段", im3b.ok === true && im3b.preview?.fields?.join(",") === "customSystemPrompt");
	c.send({
		type: "preset_import",
		json: JSON.stringify({
			format: "pi-web-ui-preset",
			version: 1,
			name: "空选",
			settings: { customSystemPrompt: "x" },
		}),
		fields: [],
		requestId: "im3c",
	});
	const im3c = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im3c");
	check("一个字段都没勾时拒绝导入", im3c.ok === false && typeof im3c.error === "string");

	c.send({ type: "preset_import", json: "{oops", requestId: "im4" });
	const im4 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im4");
	check("bad JSON returns ok:false + error", im4.ok === false && typeof im4.error === "string");

	c.send({ type: "preset_import_url", url: "http://127.0.0.1/preset.json", requestId: "im5" });
	const im5 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im5");
	check("url import blocks loopback hosts", im5.ok === false && typeof im5.error === "string");
	c.send({ type: "preset_import_url", url: "file:///etc/passwd", requestId: "im6" });
	const im6 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im6");
	check("url import rejects non-http schemes", im6.ok === false);

	c.send({ type: "preset_share", name: "导入的预设", requestId: "sh1" });
	const sh1 = await c.waitFor("preset_share_result", 8000, (m) => m.requestId === "sh1");
	check("share disabled by env returns ok:false", sh1.ok === false && typeof sh1.error === "string");
	check("share still returns the JSON for manual sharing", typeof sh1.json === "string" && sh1.json.length > 0);

	c.send({ type: "preset_catalog", requestId: "ct1" });
	const ct1 = await c.waitFor("preset_catalog_result", 10000, (m) => m.requestId === "ct1");
	check(
		"catalog result shape",
		Array.isArray(ct1.entries) && typeof ct1.source === "string" && typeof ct1.cached === "boolean",
	);
	check("catalog refuses a loopback source", ct1.ok === false && typeof ct1.error === "string");

	c.send({ type: "delete_preset", name: "导入的预设" });
	await c.waitFor("settings_state", 8000, (m) => !m.settings.presets.some((p) => p.name === "导入的预设"));
	c.send({ type: "set_settings", promptTemplate: SAVED_TEMPLATE });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptTemplate === SAVED_TEMPLATE);

	c.send({ type: "set_settings", keepRecentMessages: 9999 });
	const stK = await c.waitFor("settings_state", 8000, (m) => m.settings.keepRecentMessages === 100);
	check("keepRecentMessages clamped to 100 over the wire", stK.settings.keepRecentMessages === 100);
	c.send({ type: "set_settings", keepRecentMessages: 45 });
	await c.waitFor("settings_state", 8000, (m) => m.settings.keepRecentMessages === 45);

	c.send({ type: "set_settings", terminalToolsEnabled: false });
	await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === false);
	c.ws.close();
	await sleep(300);
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor(["snapshot", "snapshot_delta"]);
	const st9 = await c.waitFor("settings_state");
	check("compose template survives reconnect", st9.settings.promptTemplate === SAVED_TEMPLATE);
	check("override survives reconnect", st9.settings.promptOverrides?.soul === SAVED_SOUL);
	check("terminalToolsEnabled survives reconnect (off)", st9.settings.terminalToolsEnabled === false);
	check("keepRecentMessages survives reconnect", st9.settings.keepRecentMessages === 45);
	c.send({ type: "set_settings", keepRecentMessages: 15 });
	await c.waitFor("settings_state", 8000, (m) => m.settings.keepRecentMessages === 15);
	c.send({ type: "set_settings", terminalToolsEnabled: false });
	await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === false);

	c.send({ type: "extensions_reload" });
	await c.waitFor("settings_state", 15000);
	check("extensions_reload re-pushes settings", true);
	c.ws.close();

	console.log(`\n${pass} passed, ${fail} failed`);
} catch (err) {
	console.error("TEST ERROR:", err.message);
	fail++;
} finally {
	server.kill("SIGTERM");
	await sleep(300);
}
process.exit(fail > 0 ? 1 : 0);
