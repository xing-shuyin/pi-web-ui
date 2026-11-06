import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../tests/lib/chrome.mjs";

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
	console.error("用法：node scripts/theme-diff.mjs <beforeDir> <afterDir> [--threshold 0.0005]");
	process.exit(2);
}
const ti = process.argv.indexOf("--threshold");
const rawThreshold = ti > 0 ? process.argv[ti + 1] : undefined;
const THRESHOLD = rawThreshold === undefined ? 0.0005 : Number(rawThreshold);
if (!Number.isFinite(THRESHOLD) || THRESHOLD < 0) {
	console.error(`--threshold 必须是 >= 0 的数字，收到: ${rawThreshold}`);
	process.exit(2);
}
const OUT_DIR = join(afterDir, "..", "diff");
const oi = process.argv.indexOf("--only");
const ONLY = oi > 0 && process.argv[oi + 1] ? process.argv[oi + 1].split(",") : null;

const files = readdirSync(beforeDir).filter(
	(f) => f.endsWith(".png") && (!ONLY || ONLY.includes(f.replace(/\.png$/, ""))),
);
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage();
await page.setContent("<canvas id=c></canvas>");

async function compare(aB64, bB64) {
	return page.evaluate(
		async ({ aB64, bB64 }) => {
			const load = (src) =>
				new Promise((res, rej) => {
					const img = new Image();
					img.onload = () => res(img);
					img.onerror = rej;
					img.src = src;
				});
			const [a, b] = await Promise.all([load(aB64), load(bB64)]);
			const w = Math.min(a.width, b.width);
			const h = Math.min(a.height, b.height);
			const c = document.getElementById("c");
			c.width = w;
			c.height = h;
			const ctx = c.getContext("2d", { willReadFrequently: true });
			ctx.drawImage(a, 0, 0);
			const da = ctx.getImageData(0, 0, w, h);
			ctx.clearRect(0, 0, w, h);
			ctx.drawImage(b, 0, 0);
			const db = ctx.getImageData(0, 0, w, h);
			const out = ctx.createImageData(w, h);
			let changed = 0;
			for (let i = 0; i < da.data.length; i += 4) {
				const d =
					Math.abs(da.data[i] - db.data[i]) +
					Math.abs(da.data[i + 1] - db.data[i + 1]) +
					Math.abs(da.data[i + 2] - db.data[i + 2]);
				if (d > 8) {
					changed++;
					out.data[i] = 255;
					out.data[i + 1] = 0;
					out.data[i + 2] = 0;
					out.data[i + 3] = 255;
				} else {
					const l = (db.data[i] * 0.3 + db.data[i + 1] * 0.59 + db.data[i + 2] * 0.11) * 0.25;
					out.data[i] = l;
					out.data[i + 1] = l;
					out.data[i + 2] = l;
					out.data[i + 3] = 255;
				}
			}
			ctx.putImageData(out, 0, 0);
			const sizeDiff = a.width !== b.width || a.height !== b.height;
			return { total: w * h, changed, ratio: changed / (w * h), diffPng: c.toDataURL("image/png"), sizeDiff };
		},
		{ aB64, bB64 },
	);
}

const rows = [];
let failures = 0;
for (const f of files) {
	const before = join(beforeDir, f);
	const after = join(afterDir, f);
	if (!existsSync(after)) {
		rows.push({ theme: basename(f, ".png"), ratio: 1, note: "缺少 after 截图" });
		failures++;
		continue;
	}
	const toUrl = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
	const r = await compare(toUrl(before), toUrl(after));
	const diffFile = join(OUT_DIR, f);
	writeFileSync(diffFile, Buffer.from(r.diffPng.split(",")[1], "base64"));
	const pct = (r.ratio * 100).toFixed(4);
	const bad = r.ratio > THRESHOLD;
	if (bad) failures++;
	rows.push({ theme: basename(f, ".png"), ratio: r.ratio, pct, bad, note: r.sizeDiff ? "尺寸不一致" : "" });
}

rows.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
console.log(`阈值 ${(THRESHOLD * 100).toFixed(4)}%  |  差异图：${OUT_DIR}`);
for (const r of rows) {
	const flag = r.bad ? "✗" : "✓";
	console.log(`  ${flag} ${String(r.theme).padEnd(20)} 差异 ${String(r.pct ?? "-").padStart(8)}%  ${r.note ?? ""}`);
}
await browser.close();
if (failures > 0) {
	console.log(`\n${failures} 个主题超出阈值 → 视作回归`);
	process.exit(1);
}
console.log(`\n全部 ${rows.length} 个主题在阈值内 ✓`);
