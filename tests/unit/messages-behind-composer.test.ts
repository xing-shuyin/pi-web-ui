import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8").replace(/^\t/gm, "");

function bodyOf(selector: string): string {
	const re = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
	const hit = re.exec(CSS)?.[1];
	expect(hit, `styles.css 里没有规则：${selector}`).toBeDefined();
	return hit!;
}

describe("输入框上方的带子里是消息正文", () => {
	it("--composer-strip = 上内边距 + 快捷短语行高 + 6px，且行高由 JS 实测", () => {
		const main = bodyOf(".main");
		expect(main, "--composer-pad-top 是输入区上内边距的唯一来源").toMatch(/--composer-pad-top:\s*12px/);
		expect(main).toMatch(/--composer-strip:\s*calc\(var\(--composer-pad-top\) \+ var\(--quick-row-h,\s*0px\) \+ 6px\)/);
		expect(bodyOf(".inputbar")).toMatch(/padding:\s*var\(--composer-pad-top\)/);
		expect(CSS).toMatch(/--composer-pad-top:\s*10px/);
	});

	it("滚动容器按 --composer-strip 往下铺一层（不是一个写死的像素）", () => {
		const wrap = bodyOf(".messages-wrap");
		expect(wrap).toMatch(/margin-bottom:\s*calc\(-1 \* var\(--composer-strip\)\)/);
		expect(wrap).not.toMatch(/top:/);
	});

	it("芯片是悬浮半透明毛玻璃小卡片，行本身仍是流内项", () => {
		const chip = bodyOf(".quick-chip");
		expect(chip).toMatch(/background:\s*color-mix\(in srgb,\s*var\(--bg-elev\)/);
		expect(chip).toMatch(/backdrop-filter:\s*blur/);
		const row = bodyOf(".quick-row");
		expect(row).not.toMatch(/position:\s*absolute/);
		for (const sel of [
			".attach-chip",
			".attach-chip.reference",
			".attach-chip.lines",
			".attach-chip.image",
			".attach-chip.file",
			".attach-chip.page",
			".file-attach.ref",
			".file-attach.download",
			".file-attach.copy",
		]) {
			const b = bodyOf(sel);
			expect(b, `${sel} 背景必须是不透明实底混合`).toMatch(
				/background:\s*color-mix\(in srgb,[^;]+,\s*var\(--bg-elev\)\)/,
			);
		}
		expect(bodyOf(".file-pill:hover")).toMatch(/background:\s*color-mix\(in srgb,[^;]+,\s*var\(--bg-elev2\)\)/);
	});

	it("钉底时最后一条消息停在芯片上面（底部留白带上行高）", () => {
		const messages = bodyOf(".messages");
		expect(messages).toMatch(/padding-block:\s*20px calc\([^)]*var\(--quick-row-h,\s*0px\)\)/);
	});

	it("浮标 / 提问导航条都补回带子高度（都以浮动容器底缘定位）", () => {
		expect(bodyOf(".scroll-bottom")).toMatch(/bottom:\s*calc\(4px \+ var\(--composer-strip\)\)/);
		expect(
			bodyOf(".main:has(.goalbar-collapsed):not(:has(.plan-board)):not(:has(.dialog-inline)) .scroll-bottom"),
		).toMatch(/bottom:\s*calc\(32px \+ var\(--composer-strip\)\)/);
		expect(bodyOf(".qn-rail")).toMatch(/bottom:\s*calc\(10px \+ var\(--composer-strip\)\)/);
	});

	it("目标条展开、任务看板或内联对话框在场时，取消 .messages-wrap 负外边距以防遮挡首行输入框 (#623)", () => {
		expect(
			bodyOf(
				".main:has(.goalbar) .messages-wrap,\n.main:has(.plan-board) .messages-wrap,\n.main:has(.dialog-inline) .messages-wrap",
			),
		).toMatch(/margin-bottom:\s*0/);
		expect(
			bodyOf(
				".main:has(.goalbar) .scroll-bottom,\n.main:has(.plan-board) .scroll-bottom,\n.main:has(.dialog-inline) .scroll-bottom",
			),
		).toMatch(/bottom:\s*4px/);
		expect(
			bodyOf(".main:has(.goalbar) .qn-rail,\n.main:has(.plan-board) .qn-rail,\n.main:has(.dialog-inline) .qn-rail"),
		).toMatch(/bottom:\s*10px/);
		const goalbar = bodyOf(".goalbar");
		expect(goalbar).toMatch(/position:\s*relative/);
		expect(goalbar).toMatch(/z-index:\s*2/);
	});

	it("不给 .messages 加 mask/filter（那会让内部 fixed 后代改包含块）", () => {
		const body = bodyOf(".messages");
		expect(/mask(-image)?\s*:/.test(body), "滚动容器上出现 mask 会打歪 fixed 下拉/灯箱").toBe(false);
		expect(/filter\s*:/.test(body), "滚动容器上出现 filter 同样会改包含块").toBe(false);
	});

	it("主题样式表 themes/*.css 中不得将 .inputbar 声明为实底背景，确保快捷短语所在带子能透出底层消息正文", () => {
		const themesDir = join(ROOT, "themes");
		const themeFiles = readdirSync(themesDir).filter((f) => f.endsWith(".css"));
		for (const file of themeFiles) {
			const content = readFileSync(join(themesDir, file), "utf8");
			const re = /(?:^|\})\s*([^}{]*\.inputbar[^}{]*)\{([^}]*)\}/gm;
			let m: RegExpExecArray | null;
			while ((m = re.exec(content)) !== null) {
				const selector = m[1];
				const block = m[2];
				if (/\.inputbar\b/.test(selector)) {
					const bgMatch = /background(?:-color)?\s*:\s*([^;]+);/i.exec(block);
					if (bgMatch) {
						const val = bgMatch[1]
							.replace(/!important/i, "")
							.trim()
							.toLowerCase();
						if (val !== "transparent" && val !== "none") {
							expect.fail(
								`${file} 中的 ${selector.trim()} 声明了非透明背景 (${val})，会导致快捷短语底部带子不透明遮挡正文`,
							);
						}
					}
				}
			}
		}
	});
});
