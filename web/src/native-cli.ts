import type { NativeCliConversation } from "./types";

export function isNativeCliRemoteCwd(cwd: string): boolean {
	return /^ssh:\/\//i.test(cwd.trim());
}

export function nativeCliArgumentLines(text: string): string[] {
	return text.split(/\r?\n/).filter((line) => line.length > 0);
}

/** 左栏 CLI 会话行要区分四态：单轮在跑 / 等用户输入或授权 / 进程已结束 / 进程活着但空闲。 */
export type NativeCliRowState = "busy" | "waiting" | "ended" | "idle";

/**
 * `phase` 只说进程生死，`activity` 才说单轮是否在跑：hook 会话在 `done` 之后进程继续活着
 * （`phase` 回到 `running`），只有 `activity: "idle"` 能说明这一轮已经结束。
 * 没有 hook 通道的引擎（`nativeEvents === false`）拿不到单轮事件，活着的进程按在跑处理。
 * `nativeCli` 为空表示这个 CLI 会话只有磁盘历史、没有活进程，按已结束处理。
 */
export function nativeCliRowState(
	nativeCli?: Pick<NativeCliConversation, "status">,
	error?: string,
): NativeCliRowState {
	const status = nativeCli?.status;
	const phase = status?.phase;
	if (!phase) return nativeCli && !error ? "busy" : "ended";
	if (phase === "exited" || phase === "disconnected" || phase === "error") return "ended";
	if (phase === "starting") return "busy";
	if (phase === "waiting_input" || phase === "waiting_approval") return "waiting";
	const activity = status?.activity;
	if (activity === "idle") return "idle";
	if (activity === "waiting_input" || activity === "waiting_approval") return "waiting";
	if (activity === "working" || phase === "working") return "busy";
	return status?.nativeEvents === false ? "busy" : "idle";
}
