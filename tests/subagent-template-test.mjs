//   - settings_state carries subagentTemplates (empty initially, global file);
import WebSocket from "ws";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.argv[2] || 8951);
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-satpl-test-"));
const TPL_FILE = join(DATA_DIR, "subagent-templates.json");
console.log("data-dir:", DATA_DIR);

const server = spawn(process.execPath, ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: DATA_DIR,
		PI_WEB_CWD: process.cwd(),
		PI_CODING_AGENT_DIR: join(DATA_DIR, "agent"),
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
		throw new Error(`timeout waiting for ${JSON.stringify(types)}`);
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

async function main() {
	const c = await connect();
	c.send({ type: "hello", clientId: "satpl-smoke" });
	await c.waitFor("ready");

	let pass = 0;
	let fail = 0;
	const check = (name, cond, extra = "") => {
		if (cond) {
			pass++;
			console.log(`  ✓ ${name}`);
		} else {
			fail++;
			console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
		}
	};

	{
		const s = await c.waitFor("settings_state");
		check(
			"settings_state 携带 subagentTemplates 字段",
			Array.isArray(s.settings.subagentTemplates),
			JSON.stringify(s.settings.subagentTemplates),
		);
		check(
			"settings_state 携带 subagentDefaultTemplates（默认徽标源）",
			Array.isArray(s.settings.subagentDefaultTemplates) && s.settings.subagentDefaultTemplates.includes("review"),
		);
		const names = s.settings.subagentTemplates.map((t) => t.name);
		check(
			"初始列表已带内置默认模板",
			names.length >= 6 &&
				["review", "implement", "research", "scout", "audit", "delegate"].every((n) => names.includes(n)),
			JSON.stringify(names),
		);
	}

	{
		c.send({
			type: "save_subagent_template",
			template: {
				name: "reviewer",
				description: "只读审查子代理",
				promptMode: "replace",
				systemPrompt: "你是一名严格的代码审查者。",
				enabledSkills: ["code-review"],
				enabledExtensions: ["npm:pi-scm"],
				model: "anthropic/claude-opus-4-5",
				thinkingLevel: "high",
				enabled: true,
			},
		});
		const s = await c.waitFor("settings_state", 8000, (m) =>
			m.settings.subagentTemplates.some((t) => t.name === "reviewer"),
		);
		const tpl = s.settings.subagentTemplates.find((t) => t.name === "reviewer");
		check("保存后列表含新模板", !!tpl);
		check(
			"promptMode / 白名单 / 模型 / 思考强度 / 简介 完整",
			tpl?.promptMode === "replace" &&
				tpl?.enabledSkills[0] === "code-review" &&
				tpl?.enabledExtensions[0] === "npm:pi-scm" &&
				tpl?.model === "anthropic/claude-opus-4-5" &&
				tpl?.thinkingLevel === "high" &&
				tpl?.description === "只读审查子代理",
		);
		check("默认 enabled=true", tpl?.enabled === true);
		check(
			"内置模板不预设思考强度（空 = 跟随主对话）",
			s.settings.subagentTemplates.find((t) => t.name === "review")?.thinkingLevel === "",
		);
	}

	{
		c.send({
			type: "save_subagent_template",
			template: {
				name: "reviewer",
				description: "v2",
				promptMode: "append",
				systemPrompt: "追加一段。",
				enabledSkills: [],
				enabledExtensions: [],
				enabled: false,
			},
		});
		const s = await c.waitFor("settings_state", 8000, (m) =>
			m.settings.subagentTemplates.some((t) => t.name === "reviewer" && t.enabled === false),
		);
		const tpl = s.settings.subagentTemplates.find((t) => t.name === "reviewer");
		check("同名校验：停用后仍保留在面板", !!tpl && tpl?.enabled === false);
		check("覆盖生效（append + 空白名单）", tpl?.promptMode === "append" && tpl?.enabledSkills.length === 0);
		check("覆盖时未传模型 → 归一为空串（跟随主对话）", tpl?.model === "");
		check("覆盖时未传思考强度 → 归一为空串（跟随主对话）", tpl?.thinkingLevel === "");
	}

	{
		c.send({
			type: "save_subagent_template",
			template: {
				name: "badthink",
				description: "非法强度",
				promptMode: "append",
				systemPrompt: "x",
				enabledSkills: [],
				enabledExtensions: [],
				thinkingLevel: "ultra",
				enabled: true,
			},
		});
		const s = await c.waitFor("settings_state", 8000, (m) =>
			m.settings.subagentTemplates.some((t) => t.name === "badthink"),
		);
		check(
			"未知档位归一为空串（不报错、不猜，回落跟随主对话）",
			s.settings.subagentTemplates.find((t) => t.name === "badthink")?.thinkingLevel === "",
		);
		c.send({ type: "delete_subagent_template", name: "badthink" });
	}

	{
		const onDisk = existsSync(TPL_FILE) ? JSON.parse(readFileSync(TPL_FILE, "utf8")) : [];
		check(
			"模板持久化到 <dataDir>/subagent-templates.json（默认 + 用户）",
			Array.isArray(onDisk) &&
				onDisk.some((t) => t.name === "review") &&
				onDisk.some((t) => t.name === "reviewer" && t.enabled === false) &&
				onDisk.find((t) => t.name === "reviewer")?.thinkingLevel === "",
			JSON.stringify(onDisk?.map?.((t) => t.name)),
		);
	}

	{
		c.send({ type: "delete_subagent_template", name: "reviewer" });
		const s = await c.waitFor(
			"settings_state",
			8000,
			(m) => !m.settings.subagentTemplates.some((t) => t.name === "reviewer"),
		);
		check(
			"删除后用户模板消失（默认模板仍在）",
			s.settings.subagentTemplates.some((t) => t.name === "review"),
		);
		await sleep(300);
		const onDisk = existsSync(TPL_FILE) ? JSON.parse(readFileSync(TPL_FILE, "utf8")) : [];
		check(
			"磁盘同步删除用户模板",
			Array.isArray(onDisk) && !onDisk.some((t) => t.name === "reviewer"),
			JSON.stringify(onDisk?.map?.((t) => t.name)),
		);
	}

	{
		c.send({ type: "get_settings" });
		const s0 = await c.waitFor("settings_state", 8000, (m) => m.settings.subagentDefaultModel !== undefined);
		check("默认模型初始为 null（跟随主对话）", s0.settings.subagentDefaultModel === null);
		check("subagentModels 字段存在（零模型环境为空数组）", Array.isArray(s0.settings.subagentModels));
		c.send({ type: "set_settings", subagentDefaultModel: "dashscope/qwen-max" });
		const s1 = await c.waitFor("settings_state", 8000, (m) => m.settings.subagentDefaultModel === "dashscope/qwen-max");
		check("set_settings 更新 subagentDefaultModel", s1.settings.subagentDefaultModel === "dashscope/qwen-max");
		c.send({ type: "set_settings", subagentDefaultModel: null });
		const s2 = await c.waitFor("settings_state", 8000, (m) => m.settings.subagentDefaultModel === null);
		check("置空恢复跟随主对话", s2.settings.subagentDefaultModel === null);
	}

	{
		c.send({
			type: "save_subagent_template",
			template: {
				name: "   ",
				description: "",
				promptMode: "replace",
				systemPrompt: "",
				enabledSkills: [],
				enabledExtensions: [],
				enabled: true,
			},
		});
		const notice = await c.waitFor("notice", 8000, (m) => m.level === "error");
		c.send({ type: "get_settings" });
		const s = await c.waitFor("settings_state");
		check("非法名：错误 notice", notice.level === "error" && /模板/.test(notice.text), notice.text);
		check(
			"非法名：列表未被污染（默认仍在、无 reviewer）",
			s.settings.subagentTemplates.some((t) => t.name === "review") &&
				!s.settings.subagentTemplates.some((t) => t.name === "reviewer"),
		);
	}

	{
		const review = (s) => s.settings.subagentTemplates.find((t) => t.name === "review");
		const isHant = (m) => /程式碼/.test(review(m)?.description ?? "") && !/代码/.test(review(m)?.description ?? "");
		const isHans = (m) => /代码/.test(review(m)?.description ?? "");

		c.send({ type: "set_locale", locale: "zh" });
		const zhSnap = await c.waitFor("settings_state", 8000, isHans);
		check("简中界面：内置模板是出厂简中", isHans(zhSnap));

		c.send({ type: "set_locale", locale: "zh-TW" });
		const twSnap = await c.waitFor("settings_state", 8000, isHant);
		check("zh → zh-TW：补推快照，内置模板换成繁中", isHant(twSnap));
		check(
			"繁中视图：提示词也是繁中，英文字段不动",
			/審查類型/.test(review(twSnap).systemPrompt) && /Code \/ plan/.test(review(twSnap).descriptionEn ?? ""),
		);

		c.send({ type: "save_subagent_template", template: { ...review(twSnap), enabled: false } });
		const toggled = await c.waitFor("settings_state", 8000, (m) => review(m)?.enabled === false);
		check("繁中界面点开关：保存成功且仍显示繁中", isHant(toggled));
		const onDisk = JSON.parse(readFileSync(TPL_FILE, "utf8")).find((t) => t.name === "review");
		check(
			"落盘文字仍是出厂简中（没被改写成繁体）",
			onDisk.enabled === false && /代码/.test(onDisk.description) && /审查类型/.test(onDisk.systemPrompt),
			onDisk.description,
		);

		c.send({ type: "set_locale", locale: "zh-HK" });
		c.send({ type: "get_settings" });
		const hkSnap = await c.waitFor("settings_state", 8000, isHant);
		check("zh-HK 同样是繁中视图", isHant(hkSnap));

		c.send({ type: "set_locale", locale: "en" });
		const enSnap = await c.waitFor("settings_state", 8000, isHans);
		check("切回英文：显示出厂简中（库未被繁中操作污染）", isHans(enSnap) && review(enSnap).enabled === false);

		c.send({ type: "save_subagent_template", template: { ...review(enSnap), enabled: true } });
		await c.waitFor("settings_state", 8000, (m) => review(m)?.enabled === true);
	}

	console.log(`\nsubagent-template-test: ${pass} 通过, ${fail} 失败`);
	server.kill();
	process.exit(fail ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	server.kill();
	process.exit(1);
});
