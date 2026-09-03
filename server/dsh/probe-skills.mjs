// Temp probe: DSH skills UI (#18) — validate filterSkillCatalogMessage (pure),
// runtime skills/register + skills/list, and skills/set-disabled round-trip.
// Zero key: no model needed (PI_WEB_DSH_DEBUG=1 enables skills/register).
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = resolve(import.meta.dirname ?? ".");
const JSONRPC_ENTRY = resolve(
	HERE,
	"..",
	"..",
	"node_modules",
	"@deepseek-ai",
	"dsh-sdk-jsonrpc-server",
	"lib",
	"index.js",
);

// ---- 1. 纯函数单测：filterSkillCatalogMessage（直接从 goal-rpc.mjs 导入）----
// 源码兜底路径按 dist 布局计算（up-4），直接导入前需让 JSONRPC_ENTRY 指向项目 node_modules。
process.env.PI_WEB_DSH_JSONRPC_ENTRY = JSONRPC_ENTRY;
const { filterSkillCatalogMessage } = await import(pathToFileURL(join(HERE, "runtime", "goal-rpc.mjs")).href);
{
	const mkCatalog = (entries) => ({
		source: { kind: "skill-catalog", entries },
		content: [
			{
				type: "text",
				text: [
					"<system-reminder>",
					"A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
					"",
					"<available_skills>",
					...entries.map((e) => `- \`${e.name}\`: ${e.description}`),
					"</available_skills>",
					"",
					"If the user names a skill, call the `skill` tool with the exact skill name.",
					"</system-reminder>",
				].join("\n"),
			},
		],
	});
	const cat = mkCatalog([
		{ name: "alpha", description: "alpha skill" },
		{ name: "beta", description: "beta skill" },
		{ name: "gamma", description: "gamma skill" },
	]);
	const filtered = filterSkillCatalogMessage(cat, new Set(["beta"]));
	const kept = filtered.source.entries.map((e) => e.name);
	if (kept.join(",") !== "alpha,gamma") {
		console.error("FAIL filter entries:", JSON.stringify(kept));
		process.exit(1);
	}
	const text = filtered.content[0].text;
	if (!text.includes("`alpha`") || !text.includes("`gamma`") || text.includes("`beta`")) {
		console.error("FAIL filter text:", text.slice(0, 200));
		process.exit(1);
	}
	if (!text.includes("</available_skills>") || !text.includes("<available_skills>")) {
		console.error("FAIL filter markers:", text.slice(0, 200));
		process.exit(1);
	}
	// 无禁用 → 原样返回。
	if (filterSkillCatalogMessage(cat, new Set()) !== cat) {
		console.error("FAIL no-op filter should return same message");
		process.exit(1);
	}
	// 全部禁用 → 占位文本。
	const allDisabled = filterSkillCatalogMessage(cat, new Set(["alpha", "beta", "gamma"]));
	if (!allDisabled.content[0].text.includes("本会话无可启用技能")) {
		console.error("FAIL all-disabled placeholder:", allDisabled.content[0].text.slice(0, 120));
		process.exit(1);
	}
	console.log("✓ filterSkillCatalogMessage 纯函数单测通过");
}

// ---- 2. 运行时：register → list → set-disabled 往返 ----
const tmp = join(HERE, "..", "..", ".tmp-skills-probe");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const proc = spawn(process.execPath, [join(HERE, "runtime", "launcher.mjs")], {
	cwd: HERE,
	env: {
		...process.env,
		PI_WEB_DSH_DEBUG: "1",
		PI_WEB_DSH_JSONRPC_ENTRY: JSONRPC_ENTRY,
		DSH_SESSION_ROOT: join(tmp, "sessions"),
		DSH_CWD: HERE,
	},
	stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (d) => process.stderr.write("[rt] " + d));

let buf = "";
const pending = new Map();
let nextId = 1;
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			continue;
		}
		if (m.id !== undefined && pending.has(m.id)) {
			const p = pending.get(m.id);
			pending.delete(m.id);
			if (m.error) {
				p.reject(new Error(JSON.stringify(m.error)));
			} else {
				p.resolve(m.result);
			}
		}
	}
});
proc.on("exit", (code) => {
	for (const p of pending.values()) p.reject(new Error(`launcher exited early (code=${code})`));
	pending.clear();
});
const req = (method, params) =>
	new Promise((resolve2, reject) => {
		const id = nextId++;
		pending.set(id, { resolve: resolve2, reject });
		proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});

const fail = (msg) => {
	console.error("PROBE FAILED:", msg);
	try {
		proc.kill();
	} catch {
		/* already dead */
	}
	process.exit(1);
};

try {
	await req("initialize", { cwd: HERE, provider: "deepseek-official", model: "deepseek-v4-flash" });
	console.log("initialize OK");

	await req("skills/register", { name: "alpha", description: "alpha skill", content: "alpha content" });
	await req("skills/register", { name: "beta", description: "beta skill", content: "beta content" });

	const listRes = await req("skills/list", {});
	const names = (listRes.skills ?? []).map((s) => s.name);
	console.log("skills/list ->", JSON.stringify(names));
	if (!names.includes("alpha") || !names.includes("beta"))
		fail("list missing registered skills: " + JSON.stringify(names));

	const setRes = await req("skills/set-disabled", { skills: ["beta"] });
	console.log("skills/set-disabled ->", JSON.stringify(setRes));
	if (!(setRes.disabled ?? []).includes("beta")) fail("set-disabled not applied");

	const getRes = await req("skills/get", { name: "alpha" });
	if (!getRes.skill || getRes.skill.name !== "alpha") fail("skills/get failed: " + JSON.stringify(getRes));

	await new Promise((r) => setTimeout(r, 300));
	await req("shutdown", {});

	console.log("SKILLS BRIDGE OK");
	proc.stdin.end();
	process.exit(0);
} catch (err) {
	fail(err.message);
}
