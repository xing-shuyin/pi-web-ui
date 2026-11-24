import {
	MATERIAL_LIMITS,
	mergeMaterialRefs,
	normalizeMaterials,
	persistMaterialBlobs,
	stageMaterials,
	type DroppedMaterial,
	type MaterialBlob,
	type MaterialRef,
} from "./material.js";
import { composeGoalMaterials } from "./goal-run-prompts.js";
import type { ServerMessage } from "./protocol.js";

/**
 * 目标材料的两段纯流程（老实现 `GoalService.applyMaterialBlobs` / `planRoundMaterials`）：
 * 粘进来的内联材料落盘并进规格，以及每轮按「目标 cwd → 执行侧 cwd」归一 / stage 后产出清单。
 *
 * 材料清单的文案只由 `composeGoalMaterials()`（`describeMaterials()`）产出，这里不另写材料话术。
 */

export interface GoalMaterialNotice {
	text: string;
	textEn: string;
}

export interface GoalMaterialBlobsResult {
	/** 落盘后并进规格的指针（R1：只存字符串） */
	refs: string[] | undefined;
	/** 存不下、被跳过的项（调用方负责告知用户；R6 不静默） */
	dropped: DroppedMaterial[];
}

/** 把随消息上传的内联材料落盘成内容寻址路径，并入规格。落盘失败/超大只记账，不阻断设目标。 */
export async function applyGoalMaterialBlobs(
	base: string[] | undefined,
	blobs: MaterialBlob[] | undefined,
): Promise<GoalMaterialBlobsResult> {
	if (!Array.isArray(blobs) || blobs.length === 0) return { refs: base, dropped: [] };
	const { paths, dropped } = await persistMaterialBlobs(blobs);
	return { refs: mergeMaterialRefs(base, paths), dropped };
}

/** 超限材料的用户回执文案（单张上限从 `MATERIAL_LIMITS` 推导，禁另写一个数字）。 */
export function goalMaterialOverflowText(dropped: readonly DroppedMaterial[]): GoalMaterialNotice {
	const names = dropped.map((d) => d.value).join("、");
	return {
		text: `${names} 无法保存为目标材料（单张上限 ${Math.round(MATERIAL_LIMITS.maxBlobBytes / 1024 / 1024)}MB），已跳过。`,
		textEn: `${names} could not be saved as goal material (limit ${Math.round(MATERIAL_LIMITS.maxBlobBytes / 1024 / 1024)}MB each) and was skipped.`,
	};
}

export interface GoalRoundMaterials {
	/** 给模型的清单文本（`describeMaterials()` 唯一产物）；空串 = 没有材料 */
	block: string;
	/** 记账回执（R6 / R7 不许静默）：`null` = 无需告知 */
	notice: GoalMaterialNotice | null;
}

/**
 * 一轮的材料：归一（记目标 cwd）→ 必要时 stage 到执行侧 cwd → 清单（执行者与审查者共用）。
 *
 * 无材料时**不做任何 IO**、不产生 notice（R10）；不可归一的项一律记账（R6）。
 * `execCwd` 与目标 cwd 不同（worktree / 沙箱 / 换了工作区）时，材料必须先搬到执行侧能读到的位置（R7）。
 */
export async function planGoalRoundMaterials(input: {
	refs: string[] | undefined;
	goalCwd: string;
	execCwd: string;
}): Promise<GoalRoundMaterials> {
	const raw = input.refs ?? [];
	if (raw.length === 0) return { block: "", notice: null };
	const { materials, dropped } = await normalizeMaterials(raw, { cwd: input.goalCwd });
	let refs: MaterialRef[] = materials;
	let failed: Array<{ ref: string; reason: string }> = [];
	if (input.execCwd !== input.goalCwd) {
		const staged = await stageMaterials(materials, input.execCwd);
		refs = staged.staged;
		failed = staged.failed;
	}
	const composed = composeGoalMaterials(refs, failed, dropped);
	return { block: composed.block, notice: composed.notice };
}

/**
 * 材料账的报送口：同一份账只报一次（避免每轮刷屏），`null` 时把账清掉。
 * 返回 ``(key, notice) => void``，`key` 是对话 id（老实现按对话记账，新适配器按目标记账）。
 */
export function createGoalMaterialReporter(
	emit: (msg: ServerMessage) => void,
): (key: string, notice: GoalMaterialNotice | null) => void {
	const reported = new Map<string, string>();
	return (key, notice) => {
		if (!notice) {
			reported.delete(key);
			return;
		}
		if (reported.get(key) === notice.text) return;
		reported.set(key, notice.text);
		console.warn(`[goal] materials skipped (${key}): ${notice.text}`);
		emit({ type: "notice", level: "warning", text: notice.text, textEn: notice.textEn });
	};
}
