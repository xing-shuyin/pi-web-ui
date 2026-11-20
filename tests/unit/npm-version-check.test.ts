import { describe, expect, it } from "vitest";
import { compareVersions, evaluateNpmVersion } from "../../scripts/lib/npm-version.mjs";

const doc = (latest: string | null, versions: string[]) => ({
	"dist-tags": latest ? { latest } : {},
	versions: Object.fromEntries(versions.map((v) => [v, { version: v }])),
});

describe("npm 版本自检（issue #949）", () => {
	it("compareVersions 只比数值段，预发布小于正式版", () => {
		expect(compareVersions("0.121.3", "0.121.0")).toBeGreaterThan(0);
		expect(compareVersions("0.121.0", "0.121.0")).toBe(0);
		expect(compareVersions("0.120.0", "0.121.0")).toBeLessThan(0);
		expect(compareVersions("0.121.0-rc.1", "0.121.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0", "0.999.999")).toBeGreaterThan(0);
	});

	it("版本已发且 latest 指向它 → 通过", () => {
		const r = evaluateNpmVersion({
			name: "pi-web-ui",
			version: "0.121.3",
			doc: doc("0.121.3", ["0.120.0", "0.121.3"]),
		});
		expect(r.ok).toBe(true);
		expect(r.problems).toEqual([]);
	});

	it("仓库版本没发 → 报缺版本（issue #949 的真实状态：仓库 0.121.3 / registry 0.120.0）", () => {
		const r = evaluateNpmVersion({
			name: "pi-web-ui",
			version: "0.121.3",
			doc: doc("0.120.0", ["0.119.0", "0.120.0"]),
		});
		expect(r.ok).toBe(false);
		expect(r.problems.join("\n")).toContain("registry 上没有 pi-web-ui@0.121.3");
		expect(r.problems.join("\n")).toContain("latest = 0.120.0");
	});

	it("发上去了但 latest dist-tag 还指着旧版 → 全局安装装不到新版，也算漂移", () => {
		const r = evaluateNpmVersion({ name: "pi-web-ui", version: "0.121.3", doc: doc("0.121.0", ["0.121.3"]) });
		expect(r.ok).toBe(false);
		expect(r.problems.join("\n")).toContain("latest 还停在 0.121.0");
	});

	it("registry 比本地新 → 本地落后，先拉代码", () => {
		const r = evaluateNpmVersion({
			name: "pi-web-ui",
			version: "0.121.3",
			doc: doc("0.122.0", ["0.121.3", "0.122.0"]),
		});
		expect(r.ok).toBe(false);
		expect(r.problems.join("\n")).toContain("比待发版本（0.121.3）新");
	});

	it("registry 上根本没有这个包 → 明确报出来", () => {
		const r = evaluateNpmVersion({ name: "pi-web-ui", version: "0.121.3", doc: null });
		expect(r.ok).toBe(false);
		expect(r.problems[0]).toContain("找不到包 pi-web-ui");
	});
});
