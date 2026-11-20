/**
 * 环境变量单源清单（唯一事实源）。
 *
 * 为什么需要它：代码里出现的 `PI_*` 环境变量一度逼近 200 个名字，其中既有用户该调的配置，
 * 也有进程间握手（`PI_WEB_RESTART_CHILD`）、构建期（`PI_FFMPEG_URL`）、测试管道
 * （`PI_WEB_TEST_TAKEOVER_FAIL_INSERT`）和插件私有项。混在一起的结果是：
 * 「变量是不是太多了」无法回答，新增变量也没人拦。此清单把每个名字归到唯一 scope，
 * 由 `tests/unit/env-registry.test.ts` 强制：
 *
 * 1. 代码里读到的每个 `PI_*` 必须在这里登记（新增变量 = 必须分类，不能悄悄出现）；
 * 2. `public` 必须能在文档里查到（用户能调的东西必须写下来）；
 * 3. `env-vars.*.md` 三种语言的变量名集合必须一致（防只改中文漏掉英文）；
 * 4. `deprecated` 不允许再出现在 `env-vars.md`（不宣传待删开关）；
 * 5. `docOnly` 必须确实**不在**代码里（文档承诺了没实现的开关，反过来也提醒实现后摘标记）。
 *
 * 判断口径：
 * - `public`：部署方/用户真的要设（端口、目录、口令、引擎、桌面、设备、推送…）。
 * - `internal`：进程间或平台内部管道，**设了会坏事**，文档不必写；登记在此只为说清「这不是配置」。
 * - `plugin`：插件私有（插件自己的 README 说明），宿主不背书。
 * - `build`：只在打包/构建脚本里用的产物参数。
 * - `test`：只服务测试与 CI。
 * - `deprecated`：待合并/删除的遗留名（`note` 写清归宿）。
 * - `docOnly`：文档已承诺、代码尚未实现的开关（当前实现后请摘标记并改 scope）。
 *
 * 新增变量的正确姿势：先想清楚它属于哪一档；`public` 就同时补 `docs/env-vars.md` 三语表。
 */
export type EnvScope = "public" | "internal" | "plugin" | "build" | "test" | "deprecated";

export type EnvSpec = {
	name: string;
	scope: EnvScope;
	/** `public` 条目必须出现在哪份文档（相对仓库根，默认 `docs/env-vars.md`）。 */
	doc?: string;
	/** 文档承诺但代码尚未实现（守卫会要求它「不在代码里」）。 */
	docOnly?: boolean;
	/** scope 为 deprecated / internal 时说明缘由与归宿。 */
	note?: string;
};

const DEFAULT_DOC = "docs/env-vars.md";
const HUB_DOC = "docs/device-center.md";

export const ENV_SPECS: readonly EnvSpec[] = [
	// ── 构建 / 打包 ───────────────────────────────────────────────────────────
	{ name: "PI_BUNDLE_PORTABLE_GIT", scope: "build" },
	{ name: "PI_BUNDLE_PORTABLE_NODE", scope: "build" },
	{ name: "PI_FFMPEG_BUILD_DIR", scope: "build" },
	{ name: "PI_FFMPEG_SHA256", scope: "build" },
	{ name: "PI_FFMPEG_URL", scope: "build" },
	{ name: "PI_THEMES_OUT_DIR", scope: "build" },

	// ── 测试 / CI ────────────────────────────────────────────────────────────
	{ name: "PI_DEVICE_P2P_TEST_LOOPBACK", scope: "test" },
	{ name: "PI_HUB_TEST_TMP", scope: "test" },
	{ name: "PI_WEB_SUBAGENT_WAIT_CAP_SECONDS", scope: "test" },
	{ name: "PI_WEB_TEST_TAKEOVER_FAIL_INSERT", scope: "test" },

	// ── 插件私有 ─────────────────────────────────────────────────────────────
	{ name: "PI_DB_CLIENT_NO_AUTOINSTALL", scope: "plugin" },
	{ name: "PI_TUNNEL_NAME", scope: "plugin" },
	{ name: "PI_TUNNEL_TOKEN", scope: "plugin" },
	{ name: "PI_TUNNEL_WS", scope: "plugin" },
	{ name: "PI_WEB_OFFICE_IDLE_TIMEOUT_MS", scope: "plugin" },
	{ name: "PI_WEB_PM2", scope: "plugin" },
	{ name: "PI_WEB_UNIVER_RUNTIME_URL", scope: "plugin" },

	// ── 遗留名（待合并/删除，不对外宣传）─────────────────────────────────────
	{
		name: "PI_WEB_ALLOW_INSECURE_NO_AUTH",
		scope: "deprecated",
		note: "PI_WEB_INSECURE_NO_AUTH 的纯别名（server/index.ts 兜底读取）。两个名字指向同一个「全开放免密」危险开关，收敛成一个后删除。",
	},
	{
		name: "PI_WEB_INSECURE_NO_AUTH",
		scope: "deprecated",
		note: "非回环且无口令时的「全开放免密」开关，故意不进 env-vars.md：归一为 PI_WEB_AUTH_MODE=token|auto|open 后再决定是否公开。",
	},
	{
		name: "PI_WEB_REQUIRE_AUTH",
		scope: "deprecated",
		note: "只在「已开免密且无口令」分支里才被读，单独设置无效（server/index.ts）。语义应与免密开关合并为单一鉴权模式。",
	},

	// ── 文档承诺、代码尚未实现 ───────────────────────────────────────────────
	{
		name: "PI_WEB_SSH_KNOWN_HOSTS",
		scope: "public",
		docOnly: true,
		note: "env-vars.md 宣称可指定另一份 known_hosts，但 server/plugins 全无读取点（knownHostsFile 只存在于 protocol 类型与 UI 文案）。实现后请摘掉 docOnly，或从文档撤下该段。",
	},

	// ── 内部管道（设了会坏事，仅登记以示「不是配置」）────────────────────────
	{ name: "PI_CODING_AGENT_SESSION_DIR", scope: "internal" },
	{ name: "PI_EVAL_PROJECT_DIR", scope: "internal" },
	{ name: "PI_EVAL_WORKDIR", scope: "internal" },
	{ name: "PI_LOCAL_VERIFICATION_COMMAND", scope: "internal" },
	{ name: "PI_LOCAL_VERIFICATION_PIPE", scope: "internal" },
	{ name: "PI_PORTABLE", scope: "internal" },
	{ name: "PI_PORTABLE_DATA_DIR", scope: "internal" },
	{ name: "PI_PORTABLE_HOME", scope: "internal" },
	{ name: "PI_PORTABLE_ROOT", scope: "internal" },
	{ name: "PI_SUBAGENTS_TEMP_ROOT", scope: "internal" },
	{ name: "PI_DEVICE_HUB_BOOT_ID", scope: "internal", note: "Hub 进程自述，部署方不要设。" },
	{ name: "PI_DEVICE_HUB_INSTANCE_ID", scope: "internal" },
	{ name: "PI_DEVICE_HUB_PACKAGE_ROOT", scope: "internal" },
	{ name: "PI_DEVICE_HUB_SERVICE_CONFIG", scope: "internal" },
	{ name: "PI_WEB_ASSET_AUTO_MIRROR", scope: "internal" },
	{ name: "PI_WEB_ASSET_MIRROR", scope: "internal" },
	{ name: "PI_WEB_ASYNC_SESSION_OPEN", scope: "internal" },
	{ name: "PI_WEB_CLAUDE_PERMISSION_MODE", scope: "internal" },
	{ name: "PI_WEB_CLAUDE_PERMISSION_PROMPTS", scope: "internal" },
	{ name: "PI_WEB_CLI_API_KEY", scope: "internal" },
	{ name: "PI_WEB_DESKTOP_URL", scope: "internal" },
	{ name: "PI_WEB_DEV_CACHE", scope: "internal", note: "开发期缓存开关，env-vars.md 里有记但只给开发用。" },
	{ name: "PI_WEB_DSH_JSONRPC_ENTRY", scope: "internal" },
	{ name: "PI_WEB_DSH_RUNTIME_BASE", scope: "internal" },
	{ name: "PI_WEB_NATIVE_CLI_APPROVAL", scope: "internal" },
	{ name: "PI_WEB_NATIVE_CLI_KEY", scope: "internal" },
	{ name: "PI_WEB_PKG_ROOT", scope: "internal" },
	{ name: "PI_WEB_PLUGIN_FORCE_REMOTE", scope: "internal" },
	{ name: "PI_WEB_RESTART_CHILD", scope: "internal" },
	{ name: "PI_WEB_SDK_DIR", scope: "internal" },
	{ name: "PI_WEB_SHOW_CONSOLE", scope: "internal" },

	// ── 对外配置（用户/部署方真的要设）──────────────────────────────────────
	{ name: "PI_CODING_AGENT_DIR", scope: "public" },
	{ name: "PI_DESKTOP_FFMPEG", scope: "public" },
	{ name: "PI_DESKTOP_RUNTIME_AUTOAPPLY", scope: "public" },
	{ name: "PI_DESKTOP_RUNTIME_AUTOCHECK", scope: "public" },
	{ name: "PI_DESKTOP_RUNTIME_ROOT", scope: "public" },
	{ name: "PI_DESKTOP_SERVICE_AUTO", scope: "public" },
	{ name: "PI_DESKTOP_UPDATE_FEED", scope: "public" },
	{ name: "PI_DESKTOP_UPDATE_MODE", scope: "public" },
	{ name: "PI_DEVICE_DESKTOP", scope: "public" },
	{ name: "PI_DEVICE_HUB_ALLOW_REGISTRATION", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_DATA_DIR", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_DEVICE_DOMAIN", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_HOST", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_HTTPS", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_LEGACY_ORIGINS", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_PATH_ACCESS", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_PORT", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_PORTAL_PORTS", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_PUBLIC_URL", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_SERVICE_NAME", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_HUB_UPDATE_SOURCE", scope: "public", doc: HUB_DOC },
	{ name: "PI_DEVICE_P2P", scope: "public" },
	{ name: "PI_DEVICE_P2P_GO", scope: "public" },
	{ name: "PI_DEVICE_P2P_HELPER", scope: "public" },
	{ name: "PI_DEVICE_P2P_STUN", scope: "public" },
	{ name: "PI_DEVICE_TURN", scope: "public" },
	{ name: "PI_DEVICE_TURN_CREDENTIAL", scope: "public" },
	{ name: "PI_DEVICE_TURN_USERNAME", scope: "public" },
	{ name: "PI_MOBILE_JPUSH_APP_KEY", scope: "public" },
	{ name: "PI_WEB_ALLOW_HOSTS", scope: "public" },
	{ name: "PI_WEB_ALLOW_ORIGINS", scope: "public" },
	{ name: "PI_WEB_BASH_TIMEOUT_SEC", scope: "public" },
	{ name: "PI_WEB_CWD", scope: "public" },
	{ name: "PI_WEB_DATA_DIR", scope: "public" },
	{ name: "PI_WEB_DSH_CUSTOM_PROMPT", scope: "public" },
	{ name: "PI_WEB_DSH_DATA_DIR", scope: "public" },
	{ name: "PI_WEB_DSH_DEBUG", scope: "public" },
	{ name: "PI_WEB_DSH_PATCH_DIR", scope: "public" },
	{ name: "PI_WEB_DSH_PRESET_PATCH", scope: "public" },
	{ name: "PI_WEB_DSH_QUESTION_TIMEOUT_MS", scope: "public" },
	{ name: "PI_WEB_DSH_RUNTIME", scope: "public" },
	{ name: "PI_WEB_DSH_SESSION_RETENTION_DAYS", scope: "public" },
	{ name: "PI_WEB_DSH_STRICT_VERSION", scope: "public" },
	{ name: "PI_WEB_DSH_TOOL_TIMEOUT_MS", scope: "public" },
	{ name: "PI_WEB_ENGINE", scope: "public" },
	{ name: "PI_WEB_EXEC_LOOKUP", scope: "public" },
	{ name: "PI_WEB_FAVICON_COLOR", scope: "public" },
	{ name: "PI_WEB_GIT_EXTENSION_CHECK", scope: "public" },
	{ name: "PI_WEB_GIT_TIMEOUT_MS", scope: "public" },
	{ name: "PI_WEB_HEALTH_TIMEOUT_MS", scope: "public" },
	{ name: "PI_WEB_HISTORY_WINDOW", scope: "public" },
	{ name: "PI_WEB_HOST", scope: "public" },
	{ name: "PI_WEB_INSTANCE_NAME", scope: "public" },
	{ name: "PI_WEB_JPUSH_APNS_PRODUCTION", scope: "public" },
	{ name: "PI_WEB_JPUSH_APP_KEY", scope: "public" },
	{ name: "PI_WEB_JPUSH_MASTER_SECRET", scope: "public" },
	{ name: "PI_WEB_LAUNCHED_BY", scope: "public" },
	{ name: "PI_WEB_LOAD_TIMING", scope: "public" },
	{ name: "PI_WEB_LOCALE", scope: "public" },
	{ name: "PI_WEB_LOCALE_BASE_URL", scope: "public" },
	{ name: "PI_WEB_MANAGED", scope: "public" },
	{ name: "PI_WEB_MAX_OPEN_CONVERSATIONS", scope: "public" },
	{ name: "PI_WEB_MAX_SUBAGENTS", scope: "public" },
	{ name: "PI_WEB_OFFLINE_ROWS_TTL_MS", scope: "public" },
	{ name: "PI_WEB_PATH_CAPTURE", scope: "public" },
	{ name: "PI_WEB_PATH_CAPTURE_TIMEOUT_MS", scope: "public" },
	{ name: "PI_WEB_PLUGIN_CATALOG_INSTALL", scope: "public" },
	{ name: "PI_WEB_PLUGIN_CATALOG_URL", scope: "public" },
	{ name: "PI_WEB_PORT", scope: "public" },
	{ name: "PI_WEB_PRESET_CATALOG_URL", scope: "public" },
	{ name: "PI_WEB_PRESET_GH", scope: "public" },
	{ name: "PI_WEB_PRESET_REPO", scope: "public" },
	{ name: "PI_WEB_PRESET_TOKEN", scope: "public" },
	{ name: "PI_WEB_SDK", scope: "public" },
	{ name: "PI_WEB_SERVICE_NAME", scope: "public" },
	{ name: "PI_WEB_SHELL", scope: "public" },
	{ name: "PI_WEB_STALL_NOTIFY_MS", scope: "public" },
	{ name: "PI_WEB_SUBAGENT_AUTO_WAKE_MAX_TURNS", scope: "public" },
	{ name: "PI_WEB_SUBAGENT_LEDGER_MAX_RUNS", scope: "public" },
	{ name: "PI_WEB_SUBAGENT_MAX_SPAWNS_PER_RUN", scope: "public" },
	{ name: "PI_WEB_SUBAGENT_RECYCLE_MS", scope: "public" },
	{ name: "PI_WEB_TABS", scope: "public" },
	{ name: "PI_WEB_TERMINAL_IDLE_LINES", scope: "public" },
	{ name: "PI_WEB_TERMINAL_IDLE_MS", scope: "public" },
	{ name: "PI_WEB_TOKEN", scope: "public" },
	{ name: "PI_WEB_TOOL_LAZY_LOADING", scope: "public" },
	{ name: "PI_WEB_TOOL_TIMEOUT_MS", scope: "public" },
	{ name: "PI_WEB_UNATTENDED_APPROVAL_TIMEOUT", scope: "public" },
	{ name: "PI_WEB_UPLOAD_RETENTION_DAYS", scope: "public" },
	{ name: "PI_WEB_VISION_TIMEOUT_MS", scope: "public" },
];

const BY_NAME = new Map(ENV_SPECS.map((spec) => [spec.name, spec]));

export function envSpecOf(name: string): EnvSpec | undefined {
	return BY_NAME.get(name);
}

export function envNamesOfScope(scope: EnvScope): string[] {
	return ENV_SPECS.filter((spec) => spec.scope === scope).map((spec) => spec.name);
}

/** `public` 条目必须落到的文档文件（相对仓库根）。 */
export function envDocOf(spec: EnvSpec): string {
	return spec.doc ?? DEFAULT_DOC;
}
