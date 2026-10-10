/**
 * 输入框上方那条带子：**显示的是消息正文**，快捷短语行 / 目标药丸 / 浮标都只是
 * 浮在它上面。
 *
 * 病根：以前 `.messages-wrap` 的底缘停在输入区上沿，`--composer-pad-top` + 快捷
 * 短语行那一整条带子属于输入区 —— 向上翻阅时半行正文在那条带子上被硬切，看着
 * 像被下面一条不透明的带子「遮挡」（用户实报「输入框这条线上边要能看到消息」）。
 *
 * 现在两件事一起做，缺一不可：
 *   1. `.messages-wrap` 按 `--composer-strip` 负 margin 往下铺一层（输入区上内边距
 *      + 快捷短语行高 + 它的 6px 下外边距）。带子多高由 ChatInput 实测行高写入
 *      `--quick-row-h` 决定（行不在/短语关掉 → 0，只剩内边距），所以折行自适应。
 *   2. 短语芯片是**实底**小卡片（`--bg-elev`）：它现在就压在正文上，半透的话
 *      字会从芯片里透出来、读不清；透图主题自己去覆盖（translucent/
 *      transparent 两个主题已各有一条覆盖）。
 *
 * 随之而来的三条连带约束（都挂了 --composer-strip 回补）：
 *   · `.messages` 底部留白要加上行高 —— 钉底时最后一条消息停在芯片**上面**；
 *   · `.scroll-bottom` / `.qn-rail` 都以浮动容器底缘定位，要补回带子高度，
 *     否则一个掉进短语行、一个被拉低半格。
 *
 * 另外：**不给 `.messages` 加 mask/filter**（那是第一版的解法）—— 会让滚动容器成为
 * 内部 position:fixed 后代的包含块（消息里的下拉菜单、图片灯箱会跟着内容滚走），
 * 项目已在 `.messages-wrap` 的 container-type 上踩过同一类坑。
 *
 * 本测试只读 web/src/styles.css：毫秒级、零端口、零浏览器（CI 必跑）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 锚到仓库根（不用 process.cwd()，同 text-wrap.test.ts 的理由）。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

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
		// 输入区自己也得用同一个 token（两边算的是同一条带子）
		expect(bodyOf(".inputbar")).toMatch(/padding:\s*var\(--composer-pad-top\)/);
		// 窄屏窄内边距同步改
		expect(CSS).toMatch(/--composer-pad-top:\s*10px/);
	});

	it("滚动容器按 --composer-strip 往下铺一层（不是一个写死的像素）", () => {
		const wrap = bodyOf(".messages-wrap");
		expect(wrap).toMatch(/margin-bottom:\s*calc\(-1 \* var\(--composer-strip\)\)/);
		// 上沿不许动：目标药丸（bottom:100%）与浮标的锚点都在这个元素的底缘上
		expect(wrap).not.toMatch(/top:/);
	});

	it("芯片是实底小卡片（压在正文上不能半透），行本身仍是流内项", () => {
		const chip = bodyOf(".quick-chip");
		expect(chip).toMatch(/background:\s*var\(--bg-elev\)/);
		expect(chip, "压在正文上：不用 backdrop 模糊那一套（半透才需要它）").not.toMatch(/backdrop-filter/);
		// 行本身必须是流内项（浮动版会让行与药丸/浮标抢同一条带子）
		const row = bodyOf(".quick-row");
		expect(row).not.toMatch(/position:\s*absolute/);
		// 文件引用/附件芯片（.attach-chip 及其变体）同样位于输入区上方带子内，背景必须与 --bg-elev 实底混合不透明
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

	it("不给 .messages 加 mask/filter（那会让内部 fixed 后代改包含块）", () => {
		const body = bodyOf(".messages");
		expect(/mask(-image)?\s*:/.test(body), "滚动容器上出现 mask 会打歪 fixed 下拉/灯箱").toBe(false);
		expect(/filter\s*:/.test(body), "滚动容器上出现 filter 同样会改包含块").toBe(false);
	});
});
