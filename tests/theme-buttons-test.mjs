import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function inlineCss(path, ancestors = new Set()) {
	assert(!ancestors.has(path), `Circular CSS import: ${path}`);
	const next = new Set([...ancestors, path]);
	return readFileSync(path, "utf8").replace(/@import\s+["']([^"']+)["']\s*([^;]*);/g, (_, href, layer) => {
		const css = inlineCss(resolve(dirname(path), href), next);
		const name = /^layer\(([^)]+)\)$/.exec(layer.trim());
		assert(!layer.trim() || name, `Unsupported import qualifier: ${layer}`);
		return name ? `@layer ${name[1]} {${css}}` : css;
	});
}

if (!CHROME_PATH) {
	console.log("SKIP theme-buttons: Chrome unavailable (set PI_WEB_CHROME)");
} else {
	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	try {
		const page = await browser.newPage();
		const base = inlineCss(join(root, "web/src/styles.css"));
		const themes = ["default", ...readdirSync(join(root, "themes")).filter((f) => f.endsWith(".css"))];
		const variants = [
			["normal", '<button class="btn">Normal</button>'],
			["primary", '<button class="btn primary">Primary</button>'],
			["danger", '<button class="btn sm danger">Danger</button>'],
			["editor-primary", '<div class="msg-editor-actions"><button class="btn primary">Save</button></div>'],
			["cwd-primary", '<button class="cwd-choose-btn primary">Choose</button>'],
			["template-send", '<button class="template-btn send">Send</button>'],
			["canvas-primary", '<button class="canvas-toolbar-btn primary">Run</button>'],
			["install", '<button class="smart-btn-action install">Install</button>'],
			["send", '<div class="inputbox"><button class="btn send">↑</button></div>'],
			["stop", '<div class="inputbox"><button class="btn stop">■</button></div>'],
		];
		const failures = [];
		for (const theme of themes) {
			const css = theme === "default" ? "" : inlineCss(join(root, "themes", theme));
			await page.setContent(
				`<style>${base}\n@layer theme {${css}}\nbutton {transition:none !important;animation:none !important} body {padding:24px} .sample {display:inline-block;margin:12px}</style>${variants.map(([id, html]) => `<div class="sample" id="${id}">${html}</div>`).join("")}`,
			);
			for (const [id] of variants) {
				const button = page.locator(`#${id} button`);
				for (const state of ["normal", "hover"]) {
					if (state === "hover") await button.hover();
					else await page.mouse.move(0, 0);
					const colors = await button.evaluate((el) => {
						const rgb = (v) => v.match(/[\d.]+/g).map(Number);
						const over = (a, b) => {
							const alpha = a[3] ?? 1;
							return a.slice(0, 3).map((v, i) => v * alpha + b[i] * (1 - alpha));
						};
						let bg = [255, 255, 255];
						const ancestors = [];
						for (let node = el; node; node = node.parentElement) ancestors.unshift(node);
						for (const node of ancestors) bg = over(rgb(getComputedStyle(node).backgroundColor), bg);
						const style = getComputedStyle(el);
						const fg = over(rgb(style.color), bg);
						const lum = (c) =>
							c
								.map((v) => v / 255)
								.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
								.reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
						const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
						return {
							ratio: (hi + 0.05) / (lo + 0.05),
							fg: style.color,
							bg: style.backgroundColor,
							filter: style.filter,
						};
					});
					if (colors.ratio < 3) failures.push({ theme, id, state, ...colors });
				}
			}
		}
		assert.deepEqual(failures, [], `Unreadable button states:\n${JSON.stringify(failures, null, 2)}`);
		console.log(`PASS ${themes.length} themes × ${variants.length} button variants × 2 states (contrast >= 3:1)`);
	} finally {
		await browser.close();
	}
}
