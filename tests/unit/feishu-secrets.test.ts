import { describe, expect, it } from "vitest";
import {
	SECRET_APP_SECRET,
	SECRET_WEBHOOK_SECRET,
	mergeSavedSecrets,
	redactConfig,
	stripSecretsFromConfig,
} from "../../plugins/feishu/index.mjs";

describe("Feishu 密钥管理与脱敏持久化测试", () => {
	it("redactConfig 正确脱敏 App Secret 与 Webhook Secret，仅保留存在标志", () => {
		const raw = {
			preset: "feishu",
			appId: "cli_123456",
			appSecret: "super-secret-key",
			webhookUrl: "https://open.feishu.cn/hook/123",
			webhookSecret: "hook-secret",
		};

		const redacted = redactConfig(raw);
		expect(redacted.appSecret).toBe("");
		expect(redacted.webhookSecret).toBe("");
		expect(redacted.hasAppSecret).toBe(true);
		expect(redacted.hasWebhookSecret).toBe(true);
		expect(redacted.appId).toBe("cli_123456");

		const fromStorage = { preset: "feishu", appId: "cli_123456" };
		const redactedWithFlags = redactConfig(fromStorage, { hasAppSecret: true, hasWebhookSecret: false });
		expect(redactedWithFlags.hasAppSecret).toBe(true);
		expect(redactedWithFlags.hasWebhookSecret).toBe(false);
	});

	it("stripSecretsFromConfig 在落盘明文 storage 前剥离敏感字段与状态标记", () => {
		const configToSave = {
			preset: "feishu",
			appId: "cli_123456",
			appSecret: "plain-secret",
			webhookUrl: "https://open.feishu.cn/hook/123",
			webhookSecret: "plain-hook-secret",
			hasAppSecret: true,
			hasWebhookSecret: true,
			pollSec: 60,
		};

		const stripped = stripSecretsFromConfig(configToSave);
		expect(stripped.appSecret).toBeUndefined();
		expect(stripped.webhookSecret).toBeUndefined();
		expect(stripped.hasAppSecret).toBeUndefined();
		expect(stripped.hasWebhookSecret).toBeUndefined();
		expect(stripped.appId).toBe("cli_123456");
		expect(stripped.pollSec).toBe(60);
	});

	it("mergeSavedSecrets 在前端二次保存留空时沿用已存机密，仅在显式置空或清空配置时抹除", () => {
		const savedSecrets = {
			[SECRET_APP_SECRET]: "existing-app-secret",
			[SECRET_WEBHOOK_SECRET]: "existing-hook-secret",
		};
		const prevConfig = {
			appId: "cli_123456",
			webhookUrl: "https://open.feishu.cn/hook/123",
		};

		const incomingEmpty = {
			appId: "cli_123456",
			appSecret: "",
			webhookUrl: "https://open.feishu.cn/hook/123",
			webhookSecret: "",
		};
		const merged = mergeSavedSecrets(incomingEmpty, prevConfig, savedSecrets);
		expect(merged.appSecret).toBe("existing-app-secret");
		expect(merged.webhookSecret).toBe("existing-hook-secret");

		const incomingNew = {
			appId: "cli_123456",
			appSecret: "new-app-secret",
			webhookUrl: "https://open.feishu.cn/hook/123",
		};
		const mergedNew = mergeSavedSecrets(incomingNew, prevConfig, savedSecrets);
		expect(mergedNew.appSecret).toBe("new-app-secret");
		expect(mergedNew.webhookSecret).toBe("existing-hook-secret");

		const incomingClear = {
			appId: "cli_123456",
			clearAppSecret: true,
			webhookUrl: "https://open.feishu.cn/hook/123",
			clearWebhookSecret: true,
		};
		const mergedClear = mergeSavedSecrets(incomingClear, prevConfig, savedSecrets);
		expect(mergedClear.appSecret).toBe("");
		expect(mergedClear.webhookSecret).toBe("");
		expect(mergedClear.clearAppSecret).toBeUndefined();
	});
});
