import { useCallback, useEffect, useRef, useState } from "react";
import { FiCopy, FiRefreshCw } from "react-icons/fi";
import type { ChatState, useChat } from "../use-chat";
import type { NativeCliConversation, NativeCliStatus } from "../types";
import { registerComposerTarget, type ComposerPayload } from "../composer-bridge";
import { planNativeCliReferences } from "../native-cli-reference";
import { collectClipboardFiles } from "../clipboard-files";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";
import { isNativeCliRemoteCwd } from "../native-cli";
import { requestNativeCliControl, type NativeCliControlAction } from "../native-cli-events";
import { TermXterm, type TermXtermHandle } from "./TermXterm";

export interface NativeCliPanelProps {
	chat: ChatState;
	terminal: Pick<ReturnType<typeof useChat>["terminal"], "register">;
	send: ReturnType<typeof useChat>["send"];
	conversationId: string;
	nativeCli: NativeCliConversation;
	cwd: string;
	active: boolean;
	onAddFiles: (files: File[]) => Promise<void>;
	pushNotice: (level: "info" | "warning" | "error", text: string) => void;
}

const phaseKeys = {
	starting: "nativeCliSession.starting",
	running: "nativeCliSession.running",
	working: "nativeCliSession.working",
	waiting_input: "nativeCliSession.waitingInput",
	waiting_approval: "nativeCliSession.waitingApproval",
	disconnected: "nativeCliSession.disconnected",
	exited: "nativeCliSession.exited",
	error: "nativeCliSession.error",
} as const;

export function nativeCliDisplayPhase(status: NativeCliStatus): NativeCliStatus["phase"] {
	if (!status.nativeEvents && ["working", "waiting_input", "waiting_approval"].includes(status.phase)) return "running";
	return status.phase;
}

export function NativeCliPanel({
	chat,
	terminal,
	send,
	conversationId,
	nativeCli,
	cwd,
	active,
	onAddFiles,
	pushNotice,
}: NativeCliPanelProps) {
	const t = useT();
	const handle = useRef<TermXtermHandle | null>(null);
	const terminalInfo = chat.terminals.find(
		(item) =>
			item.id === nativeCli.terminalId && item.ownerKind === "conversation" && item.conversationId === conversationId,
	);
	const readOnly = chat.state?.sharedConversation?.readOnly === true;
	const status = nativeCli.status;
	const phase = !chat.ready
		? "disconnected"
		: status
			? nativeCliDisplayPhase(status)
			: terminalInfo?.running === false
				? "exited"
				: terminalInfo?.running
					? "running"
					: "starting";
	const persistent = status?.persistent === true && isNativeCliRemoteCwd(cwd);
	const processEnded = phase === "exited" || phase === "error";
	const canWrite = !readOnly && chat.ready && phase !== "disconnected" && !processEnded;
	const latest = useRef({ ready: canWrite, running: terminalInfo?.running, pushNotice, t });
	latest.current = { ready: canWrite, running: terminalInfo?.running, pushNotice, t };
	const targetKey = JSON.stringify([conversationId, nativeCli.terminalId]);
	const currentTarget = useRef<string | null>(null);
	currentTarget.current = active ? targetKey : null;
	const controlController = useRef<AbortController | null>(null);
	const [pending, setPending] = useState<{ target: string; action: NativeCliControlAction } | null>(null);
	const busy = active && pending?.target === targetKey;
	useEffect(() => {
		setPending(null);
		return () => {
			controlController.current?.abort();
			controlController.current = null;
		};
	}, [conversationId, nativeCli.terminalId, active, chat.ready, readOnly]);
	const control = async (action: NativeCliControlAction) => {
		if (readOnly || !chat.ready || !active || controlController.current) return;
		const controller = new AbortController();
		controlController.current = controller;
		setPending({ target: targetKey, action });
		const result = await requestNativeCliControl(
			send,
			{
				terminalId: nativeCli.terminalId,
				conversationId,
				action,
			},
			{ signal: controller.signal },
		);
		if (controller.signal.aborted || currentTarget.current !== targetKey) return;
		controlController.current = null;
		setPending(null);
		if (!result.ok) {
			pushNotice(
				"error",
				t("nativeCliSession.controlFailed", {
					error:
						result.reason === "timeout"
							? t("nativeCliSession.timeout")
							: result.error || t("nativeCliSession.unavailable"),
				}),
			);
		}
	};
	const lastActivity = status?.lastActivityAt;
	const activityTime = lastActivity !== undefined && Number.isFinite(lastActivity) ? new Date(lastActivity) : null;
	const ready = useCallback((value: TermXtermHandle | null) => {
		handle.current = value;
	}, []);

	const compose = useCallback(
		(payload: ComposerPayload): boolean => {
			if (!latest.current.ready || latest.current.running === false) {
				latest.current.pushNotice(
					"warning",
					latest.current.t("nativeCliPasteFailed", {
						error: latest.current.t(latest.current.ready ? "nativeCliExited" : "nativeCliDisconnected", { code: "" }),
					}),
				);
				return false;
			}
			let references: ReturnType<typeof planNativeCliReferences>;
			try {
				references = planNativeCliReferences(payload.attachments ?? []);
			} catch (error) {
				latest.current.pushNotice("error", latest.current.t("nativeCliPasteFailed", { error: String(error) }));
				return false;
			}
			const data = [payload.text, references.text].filter(Boolean).join("\n\n");
			if (!data.trim() && !references.attachments.length) return false;
			const sent = send({
				type: "terminal_cli_paste",
				requestId: randomUuid(),
				terminalId: nativeCli.terminalId,
				ownerKind: "conversation",
				conversationId,
				data,
				attachments: references.attachments,
			});
			if (sent) handle.current?.focus();
			return sent;
		},
		[conversationId, nativeCli.terminalId, send],
	);

	useEffect(() => {
		if (!active || readOnly) return;
		const unregister = registerComposerTarget({
			compose,
			insertText: (text) => compose({ text }),
			focus: () => {
				handle.current?.focus();
				return true;
			},
		});
		const onFill = (event: Event) => {
			const text = (event as CustomEvent<unknown>).detail;
			if (typeof text === "string") compose({ text });
		};
		window.addEventListener("pi-web:fill", onFill);
		return () => {
			unregister();
			window.removeEventListener("pi-web:fill", onFill);
		};
	}, [active, compose, readOnly]);

	return (
		<section
			className="native-cli-panel"
			aria-label={t("nativeCliTitle")}
			onPasteCapture={(event) => {
				const files = collectClipboardFiles(event.clipboardData?.items, event.clipboardData?.files);
				if (!files.length) return;
				event.preventDefault();
				event.stopPropagation();
				if (!readOnly) void onAddFiles(files);
			}}
		>
			<div className="native-cli-session-status" role="status" aria-live="polite">
				<strong>{t(phaseKeys[phase])}</strong>
				{!status?.nativeEvents && <span>{t("nativeCliSession.processOnly")}</span>}
				{persistent && <span>{t("nativeCliSession.persistent")}</span>}
				{activityTime && (
					<time dateTime={activityTime.toISOString()}>
						{t("nativeCliSession.lastActivity", { time: activityTime.toLocaleString() })}
					</time>
				)}
				{status?.resumable && <span>{t("nativeCliSession.resumable")}</span>}
				{status?.exitCode != null && processEnded && (
					<span>{t("nativeCliSession.exitCode", { code: status.exitCode })}</span>
				)}
				{status?.error && <span>{status.error}</span>}
				{status?.sessionId && (
					<div className="native-cli-session-id">
						<span>
							{t("nativeCliSession.nativeId")}: <code>{status.sessionId}</code>
						</span>
						<button
							type="button"
							className="btn"
							aria-label={t("nativeCliSession.copyId")}
							title={t("nativeCliSession.copyId")}
							onClick={() => {
								void (async () => {
									try {
										await navigator.clipboard.writeText(status.sessionId!);
									} catch (error) {
										if (currentTarget.current === targetKey)
											pushNotice("error", t("nativeCliSession.copyFailed", { error: String(error) }));
									}
								})();
							}}
						>
							<FiCopy aria-hidden="true" />
						</button>
					</div>
				)}
			</div>
			{!readOnly && (
				<TermXterm
					conversationId={conversationId}
					terminalId={nativeCli.terminalId}
					ownerKind="conversation"
					cwd={cwd}
					active={active}
					running={phase === "disconnected" ? undefined : terminalInfo?.running}
					exitCode={terminalInfo?.exitCode}
					register={terminal.register}
					onReady={ready}
				/>
			)}
			{!readOnly && persistent && (
				<div className="native-cli-restart" aria-busy={busy}>
					{phase === "disconnected" || processEnded ? (
						<button type="button" disabled={!chat.ready || busy || !active} onClick={() => void control("reconnect")}>
							{t(processEnded && status?.resumable ? "nativeCliSession.resume" : "nativeCliSession.reconnect")}
						</button>
					) : (
						<button
							type="button"
							disabled={!chat.ready || busy || !active}
							title={t("nativeCliSession.detachHint")}
							onClick={() => void control("detach")}
						>
							{t("nativeCliSession.detach")}
						</button>
					)}
					<button type="button" disabled={!chat.ready || busy || !active} onClick={() => void control("stop")}>
						{t("nativeCliSession.stop")}
					</button>
					{busy && <span role="status">{t("nativeCliSession.pending")}</span>}
				</div>
			)}
			{!readOnly && !persistent && (terminalInfo?.running === false || processEnded) && (
				<div className="native-cli-restart">
					<button
						type="button"
						disabled={!chat.ready}
						onClick={() =>
							send({
								type: "terminal_create",
								terminalId: nativeCli.terminalId,
								ownerKind: "conversation",
								conversationId,
								cwd,
								nativeCli: nativeCli.config,
								cols: terminalInfo?.cols ?? 100,
								rows: terminalInfo?.rows ?? 30,
							})
						}
					>
						<FiRefreshCw aria-hidden="true" />
						{t(status?.resumable ? "nativeCliSession.resume" : "nativeCliStart")}
					</button>
				</div>
			)}
		</section>
	);
}
