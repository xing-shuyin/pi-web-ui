import { useEffect, useState, useSyncExternalStore } from "react";
import { PiPhoneControl } from "@pi-mobile/native-phone-control";
import { PiPush } from "@pi-mobile/native-push";
import type { PushController } from "./push-controller";
import type { PushKind } from "./connection";
import type { SavedConnection } from "./connections";

const KIND_LABELS: Record<PushKind, string> = {
	done: "任务完成",
	error: "任务失败",
	question: "需要回答",
	approval: "需要审批",
	subagentDone: "子任务完成",
};

export function NotificationSettings({
	controller,
	connection,
	onClose,
	onDisconnect,
	onChooseDevice,
	deviceName,
}: {
	controller: PushController;
	connection: SavedConnection;
	onClose: () => void;
	onDisconnect: () => Promise<void>;
	onChooseDevice?: () => void;
	deviceName?: string;
}) {
	const state = useSyncExternalStore(controller.subscribe, controller.getDetails);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const run = async (action: () => Promise<unknown>) => {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "操作未完成，请重试。");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="mobile-settings-backdrop" onClick={onClose}>
			<section
				className="mobile-settings-panel"
				role="dialog"
				aria-modal="true"
				aria-labelledby="mobile-settings-title"
				onClick={(event) => event.stopPropagation()}
			>
				<header className="mobile-settings-header">
					<div>
						<p className="mobile-eyebrow">PI MOBILE</p>
						<h1 id="mobile-settings-title">连接与通知</h1>
					</div>
					<button type="button" className="btn" onClick={onClose} aria-label="关闭设置">
						关闭
					</button>
				</header>
				<p className="mobile-server-address">
					{connection.serverUrl}
					{deviceName ? ` · ${deviceName}` : ""}
				</p>
				{onChooseDevice && (
					<button className="btn mobile-test-button" onClick={onChooseDevice}>
						切换工作设备
					</button>
				)}
				<div className="mobile-status-list">
					<div>
						<span>连接方式</span>
						<strong>
							{connection.mode === "hub" ? "设备中心" : connection.mode === "local" ? "本机运行" : "设备直连"}
						</strong>
					</div>
					<div>
						<span>服务器推送</span>
						<strong>{state.configured ? "已配置" : "尚未配置"}</strong>
					</div>
					<div>
						<span>系统通知权限</span>
						<strong>
							{!state.supported
								? "请使用手机安装包"
								: state.permission === "granted"
									? "已允许"
									: state.permission === "denied"
										? "已关闭"
										: "尚未授权"}
						</strong>
					</div>
					<div>
						<span>本机通知</span>
						<strong>{state.pendingDisable ? "等待同步关闭" : state.enabled ? "已开启" : "已关闭"}</strong>
					</div>
				</div>
				{!state.configured && <p className="mobile-hint">请联系服务器管理员配置推送服务，再刷新状态。</p>}
				<div className="mobile-settings-actions">
					<button
						className="btn primary"
						disabled={busy || !state.supported}
						onClick={() => void run(() => controller.setEnabled(!state.enabled))}
					>
						{state.enabled ? "关闭通知" : "开启通知"}
					</button>
					<button className="btn" disabled={busy} onClick={() => void run(() => controller.refresh())}>
						刷新状态
					</button>
					{state.supported && state.permission === "denied" && (
						<button className="btn" disabled={busy} onClick={() => void run(() => PiPush.openSystemSettings())}>
							打开系统设置
						</button>
					)}
				</div>
				<fieldset className="mobile-notification-kinds" disabled={busy}>
					<legend>接收这些通知</legend>
					{(Object.keys(KIND_LABELS) as PushKind[]).map((kind) => (
						<label key={kind}>
							<span>{KIND_LABELS[kind]}</span>
							<input
								type="checkbox"
								checked={state.kinds.includes(kind)}
								onChange={(event) => {
									const selected = event.target.checked
										? [...state.kinds, kind]
										: state.kinds.filter((value) => value !== kind);
									void run(() => controller.setKinds(selected));
								}}
							/>
						</label>
					))}
				</fieldset>
				<p className="mobile-hint">
					锁屏通知仅显示任务状态。对话内容、文件路径和工具参数留在服务器上；点通知后查看对应会话。
				</p>
				<button
					className="btn mobile-test-button"
					disabled={busy || !state.enabled || state.permission !== "granted"}
					onClick={() => void run(() => controller.sendTest())}
				>
					发送测试通知
				</button>
				{state.testQueued && (
					<p className="mobile-hint" role="status">
						测试通知已排队。请检查系统通知栏，并在锁屏后再次确认。
					</p>
				)}
				{(error || state.error) && (
					<p className="mobile-error" role="alert">
						{error || state.error}
					</p>
				)}
				<PhoneControlSection />
				<footer className="mobile-settings-footer">
					<button className="btn" disabled={busy} onClick={() => void run(onDisconnect)}>
						断开并更换连接方式
					</button>
				</footer>
			</section>
		</div>
	);
}

/**
 * 手机操控：让智能体读写当前界面。无障碍权限只能由用户在系统设置里手动勾选，
 * 所以这里只负责「状态 + 去开启 + 两个自检」，真正的工具调用由服务端下发。
 */
function PhoneControlSection() {
	const [status, setStatus] = useState<{ enabled: boolean; canScreenshot: boolean } | null>(null);
	const [probe, setProbe] = useState("");
	const [shot, setShot] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const refresh = async () => {
		try {
			setStatus(await PiPhoneControl.getStatus());
			setError("");
		} catch (cause) {
			setStatus({ enabled: false, canScreenshot: false });
			setError(cause instanceof Error ? cause.message : "读取手机操控状态失败。");
		}
	};

	useEffect(() => {
		void refresh();
		// 用户去系统设置开完回来，状态会变：回到前台就重查一次。
		const onVisible = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, []);

	const run = async (action: () => Promise<unknown>) => {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "操作未完成，请重试。");
		} finally {
			setBusy(false);
		}
	};

	const enabled = status?.enabled ?? false;

	return (
		<section className="mobile-settings-section" aria-label="手机操控">
			<h2 className="mobile-settings-section-title">手机操控</h2>
			<div className="mobile-status-list">
				<div>
					<span>无障碍服务</span>
					<strong>{enabled ? "已开启" : "未开启"}</strong>
				</div>
				<div>
					<span>截图能力</span>
					<strong>{status?.canScreenshot ? "可用" : "需要 Android 11+"}</strong>
				</div>
			</div>
			<p className="mobile-hint">
				开启后智能体可以读取当前界面并执行点击、滑动、输入。系统不允许应用自行授权，需要你在系统设置里手动勾选「pi
				手机操控」。
			</p>
			<div className="mobile-settings-actions">
				<button
					className="btn"
					disabled={busy}
					onClick={() => void run(() => PiPhoneControl.openAccessibilitySettings())}
				>
					去系统设置开启
				</button>
				<button className="btn" disabled={busy} onClick={() => void run(refresh)}>
					刷新状态
				</button>
				<button
					className="btn"
					disabled={busy || !enabled}
					onClick={() =>
						void run(async () => {
							const dump = await PiPhoneControl.dump({ maxNodes: 200 });
							setProbe(`${dump.packageName || "未知应用"} · ${dump.nodes.length} 个控件`);
						})
					}
				>
					读取界面自检
				</button>
				<button
					className="btn"
					disabled={busy || !enabled || !status?.canScreenshot}
					onClick={() =>
						void run(async () => {
							const result = await PiPhoneControl.screenshot({ maxWidth: 360 });
							setShot(`data:image/png;base64,${result.data}`);
						})
					}
				>
					截屏自检
				</button>
			</div>
			{probe && (
				<p className="mobile-hint" role="status">
					{probe}
				</p>
			)}
			{shot && <img className="mobile-shot-preview" src={shot} alt="当前屏幕缩略图" />}
			{error && (
				<p className="mobile-error" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
