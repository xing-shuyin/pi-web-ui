import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const WEB_ROOT = join(ROOT, "web", "src");
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "vendor"]);

function walkFiles(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (EXCLUDED_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		const isDirectory = entry.isSymbolicLink() ? statSync(full).isDirectory() : entry.isDirectory();
		if (isDirectory) walkFiles(full, accept, out);
		else if (accept(entry.name)) out.push(full);
	}
	return out;
}

const pluginFiles = walkFiles(join(ROOT, "plugins"), (n) => n.endsWith(".mjs") && !n.includes(".test."));
const serverFiles = walkFiles(join(ROOT, "server"), (n) => n.endsWith(".ts"));
const webFiles = walkFiles(WEB_ROOT, (n) => n.endsWith(".ts") || n.endsWith(".tsx"));
const sourceCache = new Map<string, string>();

function checkFiles(files: string[], violates: (source: string) => boolean, message: string): void {
	expect(files.length, "守卫必须扫描到有效源码").toBeGreaterThan(0);
	const violations = files
		.filter((file) => {
			let source = sourceCache.get(file);
			if (source === undefined) {
				source = readFileSync(file, "utf8");
				sourceCache.set(file, source);
			}
			return violates(source);
		})
		.map((file) => relative(ROOT, file).replaceAll("\\", "/"));
	expect(violations, `${message}:\n${violations.join("\n")}`).toEqual([]);
}

describe("共享工具收敛与防回潮守卫 (Issue #730)", () => {
	it("1. HTML 转义守卫：插件 client 与 web 组件严禁内联手写 esc/escapeHtml", () => {
		const exclusions = [
			"plugin-sdk",
			"vendor",
			"dist",
			join("sdk", "client-utils.mjs"),
			join("vscode-editor", "client", "entry.mjs"),
			join("db-client", "client", "entry.mjs"),
		];
		const files = [...pluginFiles, ...webFiles].filter(
			(file) =>
				!exclusions.some((part) => file.includes(part)) && (file.includes("client") || file.startsWith(WEB_ROOT + sep)),
		);
		checkFiles(
			files,
			(source) => /function\s+(?:esc|escapeHtml)\s*\(/.test(source),
			'发现插件客户端或前端内联手写 esc/escapeHtml，请统一改为 import { esc } from "@pi-web-ui/plugin-sdk/client"',
		);
	});

	it("2. JSON 注释剥离守卫：服务端严禁手搓 stripJsonComments，必须从 json-utils 导入", () => {
		checkFiles(
			serverFiles.filter((file) => !file.endsWith("json-utils.ts")),
			(source) => /function\s+stripJsonComments\s*\(/.test(source),
			"发现服务端重复实现 stripJsonComments，请统一从 server/json-utils.js 导入",
		);
	});

	it("3. 原子写盘守卫：服务端严禁裸写 writeFileSync(tmp) + renameSync，必须使用 atomic-file", () => {
		checkFiles(
			serverFiles.filter((file) => !file.endsWith("atomic-file.ts")),
			(source) => source.includes("renameSync") && source.includes("writeFileSync") && /\.tmp/i.test(source),
			"发现服务端存在裸写 tmp+renameSync，请改用 server/atomic-file.js 的 writeAtomicSync / writeJsonAtomicSync",
		);
	});

	it("4. Markdown Chunks 守卫：官方插件 markdown-chunks.mjs 必须是委托转发（行数 ≤ 10）", () => {
		checkFiles(
			pluginFiles.filter((file) => file.endsWith(`${sep}markdown-chunks.mjs`)),
			(source) => source.trim().split("\n").length > 10,
			"发现重复拷贝的 markdown-chunks.mjs 全量实现，请统一委托转发至 plugin-sdk/client-utils.mjs",
		);
	});

	it("5. 复制反馈守卫：Web 组件严禁同时手写 clipboard.writeText + setCopied + setTimeout", () => {
		const files = webFiles.filter(
			(file) =>
				file.startsWith(join(WEB_ROOT, "components") + sep) &&
				file.endsWith(".tsx") &&
				!file.endsWith("SaveImageDialog.tsx"),
		);
		checkFiles(
			files,
			(source) =>
				source.includes("navigator.clipboard") &&
				/setCopied\w*\s*\(\s*true\s*\)/.test(source) &&
				/setTimeout\s*\(\s*\(\)\s*=>\s*setCopied\w*\s*\(\s*false\s*\)/.test(source),
			"发现组件存在内联复制反馈三件套，请统一使用 web/src/use-copy-feedback.ts 的 useCopyFeedback",
		);
	});
});
