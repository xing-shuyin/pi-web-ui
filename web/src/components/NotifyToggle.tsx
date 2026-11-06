import { useEffect, useState } from "react";
import { FiBell } from "react-icons/fi";
import { getMobileRuntime } from "../mobile-runtime";
import { useT } from "../i18n";
import {
	loadNotifySettings,
	saveNotifySettings,
	notifyBlockReason,
	notificationPermission,
	setNotificationsEnabled,
	subscribeNotificationState,
	sendTestNotification,
	isWindowsPlatform,
	type NotifyDiagnostics,
	type NotifySettings,
	NOTIFY_EVENTS,
	type NotifyEventMode,
} from "../notify";

const SHOW_NOTIFY_TEST_PANEL = false;

export function NotifyToggle() {
	const t = useT();
	const [settings, setSettings] = useState<NotifySettings>(loadNotifySettings);
	const [perm, setPerm] = useState<NotificationPermission>(() => notificationPermission());
	const [test, setTest] = useState<NotifyDiagnostics | null>(null);
	const [pending, setPending] = useState(false);
	const [subscriptionError, setSubscriptionError] = useState("");
	const pushAdapter = getMobileRuntime()?.pushAdapter;
	const deviceAdapter = getMobileRuntime()?.deviceAdapter;

	const block = notifyBlockReason();
	const blocked = block !== null;
	const windows = isWindowsPlatform();

	useEffect(() => {
		const sync = () => {
			setPerm(notificationPermission());
			if (getMobileRuntime()) setSettings(loadNotifySettings());
		};
		const unsubscribe = subscribeNotificationState(sync);
		window.addEventListener("focus", sync);
		document.addEventListener("visibilitychange", sync);
		return () => {
			unsubscribe();
			window.removeEventListener("focus", sync);
			document.removeEventListener("visibilitychange", sync);
		};
	}, []);

	const toggle = async (enabled: boolean) => {
		setPending(true);
		setSubscriptionError("");
		try {
			const next: NotifySettings = { ...settings, enabled: await setNotificationsEnabled(enabled) };
			setSettings(next);
			saveNotifySettings(next);
		} catch (error) {
			console.warn("Notification subscription failed:", error);
			setSubscriptionError(error instanceof Error ? error.message : t("notifyUnsupported"));
			setSettings(loadNotifySettings());
		} finally {
			setPerm(notificationPermission());
			setPending(false);
		}
	};

	const runTest = async () => {
		setTest(null);
		const result = await sendTestNotification(t("notifyDoneTitle"), t("notifyTestBody"));
		setTest(result);
	};

	return (
		<div className="sound-menu notify-menu">
			<div className="dd-header">{t("notifyHeader")}</div>

			<label className={`sound-row sound-master${blocked ? " disabled" : ""}`}>
				<span className="sound-label">
					<FiBell className="sound-icon" />
					<span>{t("notifyEnable")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.enabled && !blocked}
					disabled={blocked || pending}
					onChange={(e) => toggle(e.target.checked)}
				/>
			</label>

			<div className="sound-hint">{t("notifyEnableDesc")}</div>
			{subscriptionError && (
				<div className="sound-hint" role="alert">
					{subscriptionError}
				</div>
			)}

			{pushAdapter?.openSettings && (
				<button type="button" className="sound-preview" onClick={() => pushAdapter.openSettings?.()}>
					{t("notifyHeader")}…
				</button>
			)}

			{deviceAdapter && (
				<button type="button" className="sound-preview" onClick={() => deviceAdapter.openDeviceCenter()}>
					{t("deviceCenter")}
				</button>
			)}

			<details>
				<summary className="sound-row">{t("notifyEventSettings")}</summary>
				{!getMobileRuntime() && <div className="sound-hint">{t("notifyEventSettingsDesc")}</div>}
				{NOTIFY_EVENTS.filter((kind) => !getMobileRuntime() || kind !== "start").map((kind) => (
					<label className="sound-row" key={kind}>
						<span className="sound-label">{t(`sound.${kind}`)}</span>
						<select
							aria-label={t(`sound.${kind}`)}
							value={settings.events?.[kind] ?? "follow"}
							disabled={blocked || !settings.enabled}
							onChange={(e) => {
								const next = { ...settings, events: { ...settings.events, [kind]: e.target.value as NotifyEventMode } };
								setSettings(next);
								saveNotifySettings(next);
							}}
						>
							{!getMobileRuntime()?.pushAdapter?.getState().kinds && (
								<option value="follow">{t("notifyEventFollow")}</option>
							)}
							<option value="on">{t("notifyEventOn")}</option>
							<option value="off">{t("notifyEventOff")}</option>
						</select>
					</label>
				))}
			</details>

			{block === "insecure" && <div className="sound-hint">{t("notifyInsecure")}</div>}
			{block === "unsupported" && <div className="sound-hint">{t("notifyUnsupported")}</div>}
			{!blocked && perm === "denied" && <div className="sound-hint">{t("notifyDenied")}</div>}
			{!blocked && windows && <div className="sound-hint">{t("notifyWindowsHint")}</div>}

			{SHOW_NOTIFY_TEST_PANEL && !blocked && (
				<>
					<div className="notify-actions">
						<button type="button" className="sound-preview" onClick={() => void runTest()}>
							{t("notifyTest")}
						</button>
					</div>
					{test && (
						<div className="sound-hint notify-test-result">
							<div>
								{test.path === "none"
									? t("notifyTestFailed", { error: test.error ?? "?" })
									: t("notifyTestSent", { path: test.path })}
							</div>
							<div>
								{t("notifyTestState", {
									focus: String(test.presence.hasFocus),
									visibility: test.presence.visibility || "?",
									minimized: String(test.presence.minimized),
									idle: String(Math.round(test.presence.idleMs / 1000)),
								})}
							</div>
							<div>{test.suppressed ? t("notifyTestGateSuppressed") : t("notifyTestGateOpen")}</div>
							{test.path === "sw" && test.held !== null && (
								<div>{test.held > 0 ? t("notifyTestHeld", { count: String(test.held) }) : t("notifyTestDropped")}</div>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}
