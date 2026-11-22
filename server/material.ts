import { cp, mkdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { saveAttachment } from "./attachment-store.js";

/**
 * 材料规格层（Material Spec）—— ⚠ 这是**服务端内部实现**，不是 AI 面概念。
 *
 * 设计前提（docs/proposals/material-spec-unified.md）：
 * - 规格（目标 / 定时任务 / 画布节点）只存**路径字符串** `materials?: string[]`；
 * - AI 只看到「几行路径」，永远不需要知道这里有任何结构；
 * - 「能不能读到」由本模块负责：归一 → 清单 → 投递策略 → 跨 cwd 复制。
 *
 * 依赖只有 node 内置：可单测，不碰会话、不碰 React、不解析内容
 * （内容解析永远只有 `attachments.ts#buildAttachmentMessages` 一条路）。
 */

export type MaterialKind = "file" | "image" | "dir" | "url";

export interface MaterialRef {
	kind: MaterialKind;
	/** 规格里保存的原始字符串（工作区相对优先，AI/用户看到的就是它） */
	ref: string;
	/** 服务端归一后的绝对地址；url 与原始字符串相同 */
	abs: string;
}

export interface MaterialCtx {
	/** 解释相对路径的基准（默认用会话 cwd） */
	cwd: string;
}

export const MATERIAL_LIMITS = {
	maxItems: 12,
	/** 单个内联 blob 的上限（设目标时随消息上的粘贴图） */
	maxBlobBytes: 8 * 1024 * 1024,
} as const;

export type MaterialDropReason = "empty" | "invalid" | "duplicate" | "missing" | "over-cap";

export interface DroppedMaterial {
	value: string;
	reason: MaterialDropReason;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"]);
/** `https:` / `data:` / `browser:` / `remote-workspace://` 之类的非文件地址：原样保留，不做 stat。 */
const URI_REF = /^[a-z][a-z0-9+.-]*:/i;

function isImagePath(p: string): boolean {
	return IMAGE_EXT.has(extname(p).toLowerCase());
}

function resolveRef(ref: string, ctx: MaterialCtx): string {
	return isAbsolute(ref) ? ref : resolve(ctx.cwd, ref);
}

/**
 * 把规格里的 `string[]` 归一成可用的材料引用。
 * 脏数据一律**不抛错**：丢项 + 记账，调用方决定怎么回执（日志 / notice / 回执里的 skipped）。
 */
export async function normalizeMaterials(
	raw: unknown,
	ctx: MaterialCtx,
): Promise<{ materials: MaterialRef[]; dropped: DroppedMaterial[] }> {
	const materials: MaterialRef[] = [];
	const dropped: DroppedMaterial[] = [];
	const seen = new Set<string>();
	const items: unknown[] = Array.isArray(raw) ? raw : [];

	for (const item of items) {
		if (typeof item !== "string") {
			dropped.push({ value: String(item), reason: "invalid" });
			continue;
		}
		const ref = item.trim();
		if (!ref) {
			dropped.push({ value: item, reason: "empty" });
			continue;
		}
		if (URI_REF.test(ref) && !ref.startsWith("file:")) {
			// 远程工作区 / 网页 / data URL：原样保留，可达性交给下游（executor 自己用工具取）。
			if (seen.has(ref)) {
				dropped.push({ value: ref, reason: "duplicate" });
				continue;
			}
			if (materials.length >= MATERIAL_LIMITS.maxItems) {
				dropped.push({ value: ref, reason: "over-cap" });
				continue;
			}
			seen.add(ref);
			materials.push({ kind: "url", ref, abs: ref });
			continue;
		}
		const abs = resolveRef(ref.startsWith("file:") ? ref.slice("file:".length) : ref, ctx);
		if (seen.has(abs)) {
			dropped.push({ value: ref, reason: "duplicate" });
			continue;
		}
		let kind: MaterialKind;
		try {
			const st = await stat(abs);
			kind = st.isDirectory() ? "dir" : isImagePath(abs) ? "image" : "file";
		} catch {
			dropped.push({ value: ref, reason: "missing" });
			continue;
		}
		if (materials.length >= MATERIAL_LIMITS.maxItems) {
			dropped.push({ value: ref, reason: "over-cap" });
			continue;
		}
		seen.add(abs);
		materials.push({ kind, ref, abs });
	}

	return { materials, dropped };
}

/**
 * 渲染成给模型看的「材料清单」。
 *
 * 刻意做成**极小形态**：材料 ≤3 且全是可寻址文件时只出一行（10~20 tokens），
 * 数量多才升级成清单块。别在这里加格式、加字段说明——AI 只需要路径。
 */
export function describeMaterials(materials: readonly MaterialRef[]): string {
	if (materials.length === 0) return "";
	if (materials.length <= 3) {
		return `材料：${materials.map((m) => m.ref).join("、")}`;
	}
	const lines = materials.map((m) => `- ${m.kind}: ${m.ref}`);
	return ["【材料（动手前先读，不要凭印象改）】", ...lines].join("\n");
}

export interface DeliveryContext {
	/** 执行侧模型是否具备视觉能力（决定图片能否直接给） */
	vision: boolean;
	/** 执行侧是否能读写文件（无 fs 的引擎才需要把内容整段塞进上下文） */
	hasFs: boolean;
}

export interface DeliveryPlan {
	/** 随上下文一起给（图片 / 无 fs 引擎） */
	inline: MaterialRef[];
	/** 只给路径，由执行者自己的 read / bash 去取 */
	pointers: MaterialRef[];
	/** 给不了的：明确记账，由调用方写进 notice / prompt，绝不静默 */
	degraded: Array<{ ref: string; reason: "no-vision" | "no-fs" }>;
}

/**
 * 投递策略单源：**载体只调用它，不许自己判断**。
 * 这是"AI 可以选择挂哪些材料，但不能选择材料以什么形式进上下文"的落点。
 */
export function planMaterialDelivery(materials: readonly MaterialRef[], ctx: DeliveryContext): DeliveryPlan {
	const plan: DeliveryPlan = { inline: [], pointers: [], degraded: [] };
	for (const m of materials) {
		// 执行侧有文件系统：一律给指针（它自己 read；图片在同一路径上也能读到）。
		// 只有"没有 fs 的引擎"才必须把内容塞进上下文，此时才可能出现降级。
		if (ctx.hasFs) {
			plan.pointers.push(m);
			continue;
		}
		if (m.kind === "image" && !ctx.vision) plan.degraded.push({ ref: m.ref, reason: "no-vision" });
		else plan.inline.push(m);
	}
	return plan;
}

/** 工作区内的材料暂存目录名：跨 worktree / 沙盒 / 远程时把文件搬到这里。 */
export const MATERIAL_STAGE_DIR = ".pi-materials";

/** 随消息上传的内联材料（粘贴图）：**只在线上瞬态存在**，落盘后只留路径。 */
export interface MaterialBlob {
	name?: string;
	mimeType?: string;
	/** base64 */
	data: string;
}

export interface PersistedMaterialBlobs {
	paths: string[];
	dropped: DroppedMaterial[];
}

/**
 * 把瞬态 blob 落盘成内容寻址文件（`dataDir/attachments/<sha256>.<ext>`），返回**路径**。
 * 这是 R1 的唯一合法出口：线上可以带 base64，规格只能存字符串。
 */
export async function persistMaterialBlobs(raw: unknown): Promise<PersistedMaterialBlobs> {
	const paths: string[] = [];
	const dropped: DroppedMaterial[] = [];
	const items: unknown[] = Array.isArray(raw) ? raw : [];
	for (const item of items) {
		const blob = (item ?? {}) as Partial<MaterialBlob>;
		const data = typeof blob.data === "string" ? blob.data.trim() : "";
		if (!data) {
			dropped.push({ value: String(blob.name ?? "(blob)"), reason: "invalid" });
			continue;
		}
		if (Math.floor((data.length * 3) / 4) > MATERIAL_LIMITS.maxBlobBytes) {
			dropped.push({ value: String(blob.name ?? "(blob)"), reason: "over-cap" });
			continue;
		}
		try {
			const ext = extname(String(blob.name ?? "")) || undefined;
			const rec = await saveAttachment(
				Buffer.from(data, "base64"),
				String(blob.mimeType ?? "application/octet-stream"),
				ext,
			);
			if (!paths.includes(rec.filePath)) paths.push(rec.filePath);
		} catch (error) {
			console.warn(`[material] blob persist failed — ${error instanceof Error ? error.message : String(error)}`);
			dropped.push({ value: String(blob.name ?? "(blob)"), reason: "invalid" });
		}
	}
	return { paths, dropped };
}

/** 把持久化路径与已有指针合并（去重、保序）。 */
export function mergeMaterialRefs(base: string[] | undefined, extra: readonly string[]): string[] | undefined {
	const out = [...(base ?? [])];
	for (const path of extra) if (path && !out.includes(path)) out.push(path);
	return out.length > 0 ? out : undefined;
}

/**
 * 把材料搬到 `targetCwd` 能读到的地方（跨 worktree / 沙盒 / 远程时用）。
 * 同 cwd 的可达材料原样返回；搬不动的进 `failed`，由调用方明示。
 */
export async function stageMaterials(
	materials: readonly MaterialRef[],
	targetCwd: string,
): Promise<{ staged: MaterialRef[]; failed: Array<{ ref: string; reason: string }> }> {
	const staged: MaterialRef[] = [];
	const failed: Array<{ ref: string; reason: string }> = [];
	const dir = join(targetCwd, MATERIAL_STAGE_DIR);
	for (const m of materials) {
		if (m.kind === "url" || isAbsolute(m.ref)) {
			staged.push(m);
			continue;
		}
		const dest = join(dir, basename(m.abs));
		try {
			await mkdir(dir, { recursive: true });
			// 目录材料要递归复制（画布线报的坑：非递归 cp 必然 failed）
			await cp(m.abs, dest, { force: true, recursive: true });
			staged.push({ ...m, ref: join(MATERIAL_STAGE_DIR, basename(m.abs)).split("\\").join("/") });
		} catch (error) {
			failed.push({ ref: m.ref, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { staged, failed };
}
