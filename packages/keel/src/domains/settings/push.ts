import { join } from "node:path";
import { SettingsService, type SettingsHost } from "../../../../../server/settings-service.js";
import { ApprovalRulesStore } from "../../approval-rules.js";
import { SubagentTemplatesStore } from "../../subagent-templates.js";
import type { TransportPort } from "../../contracts/ports.js";

export interface SettingsPusherOptions {
	host: SettingsHost;
	/** 只用来判「通道已关」：关掉之后不再出帧（老实现由 `isDisposed()` 兜，这里是第二道闸）。 */
	transport: TransportPort;
	/** 模板存储；缺省按老树同一路径 `stateStore.dataDir/subagent-templates.json` 构造（构造本身不读盘）。 */
	templates?: SubagentTemplatesStore;
	/**
	 * 审批规则库。**不给就不是降级而是静默失效**：`SettingsService` 的四个规则方法在它为空时
	 * 直接 `return`（无帧、无错）—— 调用方会以为存上了。所以缺省按老树同一路径自建一份。
	 */
	approvalRules?: ApprovalRulesStore;
}

export interface SettingsPusher {
	/** 老树 `ClientSession.pushSettings()` 的等价物：重算并下发一帧 `settings_state`。 */
	push(): void;
	/** 同一份服务实例：设置变更的其它入口（`set` / `refreshResources` / 共享设置订阅）都从这里走。 */
	service: SettingsService;
}

export function createSettingsPusher(options: SettingsPusherOptions): SettingsPusher {
	const templates =
		options.templates ?? new SubagentTemplatesStore(join(options.host.stateStore.dataDir, "subagent-templates.json"));
	const approvalRules =
		options.approvalRules ?? new ApprovalRulesStore(join(options.host.stateStore.dataDir, "approval-rules.json"));
	const service = new SettingsService(options.host, templates, approvalRules);
	return {
		push(): void {
			if (options.transport.isClosed()) return;
			service.push();
		},
		service,
	};
}
