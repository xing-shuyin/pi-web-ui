import { deviceGroupRequest } from "./components/DeviceGroupSection";

/**
 * 导入 Bot（迁移包 JSON）——设备中心 Bot 管理的入口，不再挂在左栏加号上。
 *
 * 与服务端 `bot-import` 对应：包里的 Bot 会被规范化后写入本机注册表，
 * 返回它在导入过程中跳过/新建了多少条记忆或字段。
 */
export interface BotImportResult {
	name: string;
	imported: number;
	skipped: number;
}

export async function importBotBundle(file: File, signal?: AbortSignal): Promise<BotImportResult> {
	let bundle: unknown;
	try {
		bundle = JSON.parse(await file.text());
	} catch {
		throw new Error("Bot bundle is not valid JSON");
	}
	const data = await deviceGroupRequest<{ bot?: { name?: string }; imported?: number; skipped?: number }>(
		"bot-import",
		signal ?? new AbortController().signal,
		{ bundle },
	);
	window.dispatchEvent(new CustomEvent("pi-web-ui:device-bots-changed"));
	return { name: data?.bot?.name ?? file.name, imported: data?.imported ?? 0, skipped: data?.skipped ?? 0 };
}
