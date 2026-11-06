import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const agentsPath = join(root, "AGENTS.md");
const agents = readFileSync(agentsPath, "utf8");

const REQUIRED_DOCS = [
	"README.md",
	"architecture-core.md",
	"architecture-plugins.md",
	"architecture-canvas.md",
	"architecture-terminal.md",
	"architecture-attachments.md",
	"architecture-system-prompt.md",
	"architecture-sandbox.md",
	"directory-reference.md",
	"tool-context-budget.md",
	"goal-conversation-design.md",
	"preset-sharing.md",
	"dsh-engine.md",
	"development.md",
	"release.md",
	"deployment.md",
	"env-vars.md",
	"agent-rules.md",
	"device-collaboration.md",
	"device-center.md",
	"root-cause-boundaries.md",
];

function slugify(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
		.replace(/ /g, "-");
}

function headingsOf(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => /^#{1,6}\s/.test(line))
		.map((line) => slugify(line.replace(/^#{1,6}\s+/, "")));
}

interface DocLink {
	file: string;
	anchor?: string;
}

function docLinks(markdown: string): DocLink[] {
	const out: DocLink[] = [];
	for (const m of markdown.matchAll(/\]\((docs\/[^)\s]+)\)/g)) {
		const target = m[1];
		const [path, anchor] = target.split("#");
		out.push({ file: path, anchor });
	}
	return out;
}

describe("AGENTS.md 保持索引形态", () => {
	it("体量不超标（细则应写进 docs/）", () => {
		const lines = agents.split("\n").length;
		const bytes = statSync(agentsPath).size;
		expect(lines).toBeLessThanOrEqual(150);
		expect(bytes).toBeLessThanOrEqual(20 * 1024);
	});

	it("深层小节数量受控（正文式细则的典型信号）", () => {
		const deepHeadings = agents.split("\n").filter((line) => /^#{3,}\s/.test(line));
		expect(deepHeadings.length).toBeLessThanOrEqual(2);
	});

	it("链接到的 docs 文件与锚点都真实存在", () => {
		const links = docLinks(agents);
		expect(links.length).toBeGreaterThan(10);
		const broken: string[] = [];
		for (const link of links) {
			const abs = join(root, link.file);
			if (!existsSync(abs)) {
				broken.push(`${link.file}（文件不存在）`);
				continue;
			}
			if (link.anchor && !headingsOf(abs).includes(link.anchor)) {
				broken.push(`${link.file}#${link.anchor}（无此标题）`);
			}
		}
		expect(broken, `AGENTS.md 死链：\n${broken.join("\n")}`).toEqual([]);
	});

	it("关键能力文档仍在索引中", () => {
		const linked = new Set(docLinks(agents).map((link) => link.file));
		const missing = REQUIRED_DOCS.filter((doc) => !linked.has(`docs/${doc}`));
		expect(missing, `AGENTS.md 索引缺少：${missing.join(", ")}`).toEqual([]);
	});

	it("索引里点名的源文件路径都真实存在", () => {
		const files = [...agents.matchAll(/`((?:server|web\/src|desktop|plugins)\/[\w\-./]+\.(?:ts|tsx|mjs|css))`/g)].map(
			(m) => m[1],
		);
		expect(files.length).toBeGreaterThan(10);
		const missing = [...new Set(files)].filter((file) => !existsSync(join(root, file)));
		expect(missing, `AGENTS.md 指向了不存在的源文件：${missing.join(", ")}`).toEqual([]);
	});

	it("§3 红线表点名的守卫测试都必须存在", () => {
		const guardSection = agents.split("## 3. 红线")[1] ?? "";
		expect(guardSection).not.toBe("");
		const names = new Set<string>();
		for (const m of guardSection.matchAll(/`([a-z0-9-]+)`/g)) names.add(m[1]);
		const files = ["tests", join("tests", "unit")].flatMap((dir) =>
			readdirSync(join(root, dir))
				.filter((name) => name.endsWith(".ts") || name.endsWith(".mjs"))
				.map((name) => name.replace(/(?:\.test)?\.(?:ts|mjs)$/, "")),
		);
		const guardNames = [...names].filter((name) => !name.startsWith("-") && /-/.test(name));
		const missing = guardNames.filter((name) => !files.some((file) => file === name || file === `${name}-test`));
		expect(
			missing.map((name) => `${name} → ${relative(root, name)}`),
			`§3 红线表引用了不存在的守卫测试：${missing.join(", ")}`,
		).toEqual([]);
	});
});
