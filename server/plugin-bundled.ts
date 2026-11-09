import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { BUILTIN_MODULE_IDS, isBuiltinModule } from "./builtin-modules.js";
import { isMaterialized, materializePlugin, type MaterializeOutcome } from "./plugin-materialize.js";

const ID_RE = /^[A-Za-z0-9_-]+$/;

function preparePayload(dataDir: string, catalogPath: string, id: string): MaterializeOutcome {
	return materializePlugin({
		id,
		sourceDir: join(dirname(catalogPath), id),
		targetDir: join(dataDir, "plugins", id),
	});
}

/**
 * 把随包分发的插件（内置模块 + `preinstall` 候选）物化到数据目录。
 *
 * 「目录存在」不再等于「已准备」：完整性由物化回执裁定，半残目录会被就地修复，
 * 而不是留下一个永远报 `manifest.json 缺失或解析失败` 的空壳（issue #856）。
 */
export function prepareBundledPlugins(
	dataDir: string,
	catalogPath: string,
	overriddenIds = new Set<string>(),
): MaterializeOutcome[] {
	const outcomes: MaterializeOutcome[] = [];
	for (const id of BUILTIN_MODULE_IDS) outcomes.push(preparePayload(dataDir, catalogPath, id));

	const catalog: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
	if (!Array.isArray(catalog)) return outcomes;
	const optional = catalog.filter(
		(entry) =>
			entry &&
			entry.preinstall === true &&
			typeof entry.id === "string" &&
			ID_RE.test(entry.id) &&
			!isBuiltinModule(entry.id),
	);
	if (!optional.length) return outcomes;
	const receiptPath = join(dataDir, "bundled-plugin-installs.json");
	let initialized = new Set<string>();
	if (existsSync(receiptPath)) {
		// 回执损坏时不猜：直接报错，绝不能当成「没装过」把用户卸掉的预装插件重新装回来
		const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
		if (
			!receipt ||
			typeof receipt !== "object" ||
			!("ids" in receipt) ||
			!Array.isArray(receipt.ids) ||
			!receipt.ids.every((id) => typeof id === "string" && ID_RE.test(id))
		) {
			throw new Error("Invalid bundled plugin installation receipt");
		}
		initialized = new Set(receipt.ids);
	}
	let changed = false;
	for (const entry of optional) {
		const id: string = entry.id;
		if (overriddenIds.has(id)) continue;
		const targetDir = join(dataDir, "plugins", id);
		if (initialized.has(id)) {
			// 预装过一次就不再复活：用户主动删掉目录就当卸载，但半残目录必须修
			if (!existsSync(targetDir) || isMaterialized(targetDir, id)) continue;
			const outcome = preparePayload(dataDir, catalogPath, id);
			outcomes.push(outcome);
			if (outcome.status === "failed" || outcome.status === "source-invalid") {
				console.warn(`[plugins] 修复预装插件 ${id} 失败：${outcome.error ?? outcome.status}`);
			}
			continue;
		}
		const outcome = preparePayload(dataDir, catalogPath, id);
		outcomes.push(outcome);
		if (outcome.status === "source-invalid" || outcome.status === "failed") continue;
		initialized.add(id);
		changed = true;
	}
	if (changed) writeJsonAtomicSync(receiptPath, { version: 1, ids: [...initialized].sort() });
	return outcomes;
}
