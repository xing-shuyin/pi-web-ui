import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readThemeCss } from "../../server/themes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const variables = (css: string) =>
	new Map([...css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const defaults = variables(read("web/src/styles.css").match(/:root\s*\{[^}]*\}/)![0]);
const ratio = (a: string, b: string) => {
	const lum = (hex: string) =>
		hex
			.slice(1)
			.match(/../g)!
			.map((s) => parseInt(s, 16) / 255)
			.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
			.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
	const [x, y] = [lum(a), lum(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe("theme generation and inherited button colors", () => {
	it("reproduces shipped palettes without freezing shared defaults", () => {
		const out = mkdtempSync(join(tmpdir(), "pi-theme-generation-"));
		try {
			execFileSync(process.execPath, [join(ROOT, "make-light-theme.mjs")], {
				cwd: ROOT,
				env: { ...process.env, PI_THEMES_OUT_DIR: out },
			});
			for (const file of readdirSync(out)) {
				const generated = readFileSync(join(out, file), "utf8");
				expect(variables(generated), file).toEqual(variables(read(`themes/${file}`)));
				for (const [token, value] of variables(generated)) {
					if (!token.startsWith("--switch-")) {
						expect(value, `${file}: redundant ${token}`).not.toBe(defaults.get(token));
					}
				}
				if (file === "md-preview.css") {
					expect(generated).toContain('@import "./bases/statusbar-flat-base.css"');
					expect(generated).toContain("radial-gradient");
				}
			}
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});

	it("preserves the shared normal and hover statusbar structure through server imports", () => {
		for (const file of ["md-preview.css", "aetheris.css"]) {
			const css = readThemeCss(join(ROOT, "themes", file));
			expect(css).not.toContain("@import");
			expect(css.match(/\.statusbar \.engine-picker-btn \{/g)).toHaveLength(1);
			expect(css).toMatch(/\.statusbar \.engine-picker-btn:hover\s*\{[^}]*background: var\(--glow-12\)/);
		}
	});

	it("keeps send and stop hover foregrounds readable in every shipped theme", () => {
		for (const file of readdirSync(join(ROOT, "themes")).filter((f) => f.endsWith(".css"))) {
			const theme = new Map([...defaults, ...variables(readThemeCss(join(ROOT, "themes", file)))]);
			const resolve = (token: string): string => {
				const value = theme.get(token)!;
				const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
				return ref ? resolve(ref[1]) : value;
			};
			for (const action of ["send-blue", "stop-red"]) {
				const bg = resolve(`--${action}-hover`);
				const fg = resolve(`--on-${action}-hover`);
				expect(bg, `${file}: hover background`).toMatch(/^#[0-9a-f]{6}$/i);
				expect(fg, `${file}: hover foreground`).toMatch(/^#[0-9a-f]{6}$/i);
				expect(ratio(bg, fg), `${file}: ${action} hover`).toBeGreaterThanOrEqual(3);
			}
		}
	});
});
