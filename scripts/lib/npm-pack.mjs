// scripts/lib/npm-pack.mjs
// 「打出一个能直接发布的 tarball」的唯一入口：npm pack → 归一化 bin 可执行位 → 复查。
// 为什么不让 npm 自己发目录：npm publish <目录> 内部会重新 pack，权限位又回到平台默认值，
// 归一化白做。所以发布链路只认这里产出的文件，见 scripts/publish-npm.mjs。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { npmCall, runCollect } from "./npm-cli.mjs";
import { normalizeNpmTarball, inspectNpmTarball } from "./npm-tarball.mjs";

const REQUIRED_BUILD_OUTPUTS = ["dist/server/index.js", "dist/server/resolve-global-sdk.js", "web/dist/index.html"];

export class PackageError extends Error {}

/** 没构建就打包，会静默发出「缺 dist 的包」；宁可在包成之前拦下。 */
function assertBuildOutputs(root) {
	const missing = REQUIRED_BUILD_OUTPUTS.filter((entry) => !existsSync(join(root, entry)));
	if (missing.length) throw new PackageError(`缺少构建产物：${missing.join("、")}（先跑 npm run build:release）`);
}

/** npm pack --json 的输出可能混着脚本日志，只取数组那一段。 */
function parsePackOutput(text) {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) throw new PackageError(`看不懂 npm pack 的输出：\n${text.trim()}`);
	const [info] = JSON.parse(text.slice(start, end + 1));
	if (!info?.filename) throw new PackageError(`npm pack 没有给出文件名：\n${text.trim()}`);
	return info;
}

function writeAtomic(file, buffer) {
	const temporary = `${file}.tmp`;
	writeFileSync(temporary, buffer);
	renameSync(temporary, file);
}

/**
 * @param {{ root: string, destination?: string }} options destination 省略时用 root 下的 cwd 约定（npm 默认）
 * @returns {Promise<{ file: string, filename: string, size: number, changes: { name: string, from: number, to: number }[], inspection: ReturnType<typeof inspectNpmTarball> }>}
 */
export async function packAndNormalize({ root, destination }) {
	assertBuildOutputs(root);
	if (destination) mkdirSync(destination, { recursive: true });
	const argv = ["pack", "--json"];
	if (destination) argv.push("--pack-destination", destination);
	const result = await runCollect(npmCall(argv, { cwd: root }), { echo: false });
	if (result.code !== 0) throw new PackageError(`npm pack 失败：\n${result.out.trim()}`);

	const info = parsePackOutput(result.out);
	const file = resolve(destination ?? root, info.filename);
	const original = readFileSync(file);
	const { buffer, changes } = normalizeNpmTarball(original);
	if (changes.length) writeAtomic(file, buffer);
	return { file, filename: info.filename, size: statSync(file).size, changes, inspection: inspectNpmTarball(buffer) };
}
