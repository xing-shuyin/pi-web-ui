/**
 * `docs/README.md` 文档总索引守卫。
 *
 * 背景：`AGENTS.md` 瘦成「功能 → 事实源 → 文档」映射后，索引本身必须有唯一入口，
 * 否则新文档写出来没人能找到（历史上 docs/ 里已有 30 份文档，缺总索引后
 * 只有靠 grep 发现）。本测试锁住：
 *   1. `docs/*.md` 每一份都在 `docs/README.md` 里登记（含权重标记），反向链接不悬空；
 *   2. 索引里的全部相对链接（含 `#锚点`）与子目录都真实存在；
 *   3. 每条登记行都带权重标记（★★★ / ★★ / ★ / ○）——不允许无权重裸登记。
 *
 * 只读文件系统，毫秒级，零外部依赖（CI 必跑）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = join(here, "..", "..", "docs");
const indexPath = join(docsDir, "README.md");
const index = readFileSync(indexPath, "utf8");

/** GitHub 风格锚点 slug（小写、去标点、空格转连字符）。 */
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

/** 索引里指向 docs 内的相对链接（文件或目录）。 */
function relativeLinks(markdown: string): { target: string; anchor?: string }[] {
	const out: { target: string; anchor?: string }[] = [];
	for (const m of markdown.matchAll(/\]\(([^)#\s][^)\s]*)\)/g)) {
		const raw = m[1];
		if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith("#")) continue;
		const [target, anchor] = raw.split("#");
		if (!target) continue;
		out.push({ target, anchor });
	}
	return out;
}

const docFiles = readdirSync(docsDir).filter((name) => name.endsWith(".md"));

describe("docs/README.md 是完整的文档总索引", () => {
	it("覆盖 docs/ 下所有 Markdown 文档", () => {
		const linked = new Set(relativeLinks(index).map((link) => link.target.replace(/^\.\//, "")));
		const missing = docFiles.filter((name) => name !== "README.md" && !linked.has(name));
		expect(missing, `docs/README.md 未登记：${missing.join(", ")}`).toEqual([]);
	});

	it("索引里的相对链接与锚点都真实存在", () => {
		const links = relativeLinks(index);
		expect(links.length).toBeGreaterThan(20);
		const broken: string[] = [];
		for (const link of links) {
			const abs = join(docsDir, link.target);
			if (!existsSync(abs)) {
				broken.push(`${link.target}（不存在）`);
				continue;
			}
			if (link.anchor && statSync(abs).isFile()) {
				if (!headingsOf(abs).includes(link.anchor)) broken.push(`${link.target}#${link.anchor}（无此标题）`);
			}
		}
		expect(broken, `docs/README.md 死链：\n${broken.join("\n")}`).toEqual([]);
	});

	it("每份文档都登记在带权重标记的分组里", () => {
		// 权重图例与四个分组必须存在。
		for (const marker of ["★★★", "★★", "★", "○"]) expect(index).toContain(marker);
		for (const group of ["全局必读", "模块专题", "运维与接入", "参考材料"]) {
			expect(index, `缺少分组：${group}`).toContain(group);
		}

		// 按 `## ` 切分：只有标题里带权重标记的分组才算「登记区」，
		// 头部图例、§五 阅读路线与§六 维护约定里的链接不算登记。
		const sections = index.split(/^## /m).slice(1);
		const registered = new Set<string>();
		for (const section of sections) {
			const [heading, ...rest] = section.split("\n");
			if (!/★|○/.test(heading)) continue;
			for (const m of rest.join("\n").matchAll(/\]\(([\w./-]+\.md)(?:#[^)]*)?\)/g)) registered.add(m[1]);
		}
		const unweighted = docFiles.filter((name) => name !== "README.md" && !registered.has(name));
		expect(unweighted, `以下文档未登记在带权重（★★★/★★/★/○）的分组里：${unweighted.join(", ")}`).toEqual([]);
	});
});
