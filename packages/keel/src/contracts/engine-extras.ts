/**
 * 引擎专属面的窄口：DSH 补丁管理 6 个 + 引擎自带的权限模式 1 个。
 *
 * 这 7 个分发面成员**都不是本引擎（pi / keel）的语义**，所以内核不实现它们，只转发：
 * - DSH 补丁：只活在 `server/dsh/dsh-agent-service.ts`（pi 引擎从来没有这几口），前端由
 *   `engine === "dsh"` 门控；
 * - `setClaudePermissionMode`：claude driver 专属，写的是 `server/universal/drivers/claude-code.ts`
 *   的模块级单例（pi / codex / durable 没这个 driver）。
 *
 * 内核**不认识**补丁目录 / yaml / 市场清单 / driver 单例，也**不拼第二份帧**：
 * 那两份宿主实现自己 `emit`（`dsh_patches` / `dsh_market_data` / `claude_permission` / notice），
 * 内核只把调用转过去。签名与宿主现有方法逐字对齐（映射见 `server/core-engine-extras-adapter.ts`）。
 */

/**
 * DSH 用户补丁管理面（宿主 `DshClientSession` 的六个公开方法，`DshAgentService.get(clientId)` 拿到的那个会话）。
 *
 * 六个方法都是「自己出帧、自己发 notice、失败不 reject」的老口径：`Promise<void>` 就是全部回执，
 * 内核不额外回包（补丁目录、yaml 格式、市场缓存全在宿主）。
 */
export interface DshPatchPort {
	/** 宿主 `DshClientSession.listDshPatches()`：扫补丁目录 → `dsh_patches` 帧。 */
	listPatches(): Promise<void>;
	/** 宿主 `DshClientSession.rescanDshPatches()`：重启运行时重扫 → notice + `listPatches()`。 */
	rescanPatches(): Promise<void>;
	/** 宿主 `DshClientSession.installDshPatch(spec, id?)`：写 yaml → 重启 → 重扫。 */
	installPatch(spec: string, id?: string): Promise<void>;
	/** 宿主 `DshClientSession.toggleDshPatch(name, enabled)`：改 `.disabled` 后缀 → 重启 → 重扫。 */
	togglePatch(name: string, enabled: boolean): Promise<void>;
	/** 宿主 `DshClientSession.deleteDshPatch(name)`：删补丁文件 → 重启 → 重扫。 */
	deletePatch(name: string): Promise<void>;
	/** 宿主 `DshClientSession.fetchDshMarket(force?)`：拉市场清单 → `dsh_market_data` 帧。 */
	fetchMarket(force?: boolean): Promise<void>;
}

/**
 * 引擎自带的权限模式（宿主 `UniversalSession.setClaudePermissionMode`，`UniversalAgentService.get(clientId)` 那个会话）。
 *
 * 老实现三件事全在宿主：校验模式是否属于 driver 的 `permissionModeOptions()`、写 driver 的模块级单例、
 * 落设置（`claudePermissionMode`）+ 推 `claude_permission` 帧。内核只转发一个模式名。
 */
export interface EnginePermissionModePort {
	/** 宿主 `UniversalSession.setClaudePermissionMode(mode)`：未知模式只发 warning notice，默认值不改。 */
	setMode(mode: string): Promise<void>;
}
