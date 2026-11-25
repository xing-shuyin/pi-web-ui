import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 宿主面装配的**总闸**只有一处：`client-assembly.ts` 里 `createHostFaces({ … })` 那张表。
 *
 * `HostFaceFactories` 的成员全是可选的（缺省 = 能力未接，内核同步抛/回 ok:false），所以漏一行
 * **类型检查抓不到**：端口永远是 `undefined`，只在跑起来才表现成「这个功能一帧都不回」
 * （SCM 提交信息就是这么挂的：`scmCommitMessage` 没进这张表，`scm_commitmsg` 20s 零回执）。
 * 这里按名字对齐两处：工厂表里的每一项都必须被递进 `createHostFaces`。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST_FACES = join(ROOT, "packages/keel/src/app/host-faces.ts");
const CLIENT_ASSEMBLY = join(ROOT, "packages/keel/src/app/client-assembly.ts");

/** 取 `export interface <name> {` 到配平 `}` 的那一段。 */
function interfaceBody(source: string, name: string): string {
	const start = source.indexOf(`export interface ${name} {`);
	expect(start, `${name} 接口还在吗`).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = source.indexOf("{", start); i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`${name} 的括号没配平`);
}

/** 取 `createHostFaces({ … })` 那一整个对象字面量（按括号配平，不靠缩进猜）。 */
function assemblyCallBody(source: string): string {
	const start = source.indexOf("faces = createHostFaces({");
	expect(start, "client-assembly.ts 里的 createHostFaces({…}) 还在吗").toBeGreaterThan(-1);
	let depth = 0;
	for (let i = source.indexOf("{", start); i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error("createHostFaces 的参数括号没配平");
}

const factoryKeys = [
	...interfaceBody(readFileSync(HOST_FACES, "utf8"), "HostFaceFactories").matchAll(/^\t(\w+)\??:/gm),
].map((m) => m[1]);
const passedKeys = new Set(
	[...assemblyCallBody(readFileSync(CLIENT_ASSEMBLY, "utf8")).matchAll(/^\t\t(\w+):/gm)].map((m) => m[1]),
);

describe("宿主面装配：`HostFaceFactories` ↔ `createHostFaces({…})`", () => {
	/**
	 * 存量漏接（同一类问题，但不归这次修）：附件面与预设转录面还没进这张表，
	 * 各自的功能面在别的轨道上装配。它们接上后这里就自动变得多余——**不许往里加新的**。
	 */
	const KNOWN_UNWIRED = ["attachments", "presetTranscript"];

	it("工厂表解析得到（别把守卫自己变成空转）", () => {
		expect(factoryKeys.length).toBeGreaterThan(10);
		expect(factoryKeys).toContain("scmCommitMessage");
	});

	it("每一个宿主面工厂都被递进 createHostFaces（漏一行 = 该功能恒「未接」）", () => {
		const missing = factoryKeys.filter((key) => !passedKeys.has(key) && !KNOWN_UNWIRED.includes(key));
		expect(missing).toEqual([]);
	});
});
