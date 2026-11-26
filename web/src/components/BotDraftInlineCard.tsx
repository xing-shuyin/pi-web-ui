import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiCpu, FiCheck } from "react-icons/fi";
import { openBotChat } from "../bot-chat";
import { botDraftActionErrorText } from "../bot-draft-action";
import { useT } from "../i18n";
import { BotEditorForm, useBotOptions, type BotFormData } from "./BotEditorForm";
import { deviceGroupRequest } from "./DeviceGroupSection";
import "./agent-bots.css";

export interface AgentBotDraftDetail {
	id: string;
	name: string;
	description: string;
	systemPrompt?: string;
	trigger?: string;
	cwd: string;
	model?: { provider: string; modelId: string };
	tools: string[];
	skills?: string[];
	mcpServers?: string[];
	needsApproval?: string[];
	rationale?: string;
	settledStatus?: "created" | "revised" | "discarded";
	settledBotId?: string;
	settledFeedback?: string;
}

export function parseAgentBotDraftDetail(details: unknown): AgentBotDraftDetail | null {
	if (!details || typeof details !== "object" || Array.isArray(details)) return null;
	const raw = details as { op?: unknown; draft?: unknown; status?: unknown; botId?: unknown; feedback?: unknown };
	if (raw.op !== "draft" || !raw.draft || typeof raw.draft !== "object" || Array.isArray(raw.draft)) return null;
	const d = raw.draft as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id || typeof d.name !== "string") return null;
	const rawModel = d.model as { provider?: unknown; modelId?: unknown } | undefined;
	const model =
		rawModel && typeof rawModel.provider === "string" && typeof rawModel.modelId === "string"
			? { provider: rawModel.provider, modelId: rawModel.modelId }
			: undefined;
	const settledStatus =
		raw.status === "created" || raw.status === "revised" || raw.status === "discarded" ? raw.status : undefined;
	return {
		id: d.id,
		name: d.name,
		description: typeof d.description === "string" ? d.description : "",
		systemPrompt: typeof d.systemPrompt === "string" ? d.systemPrompt : "",
		trigger: typeof d.trigger === "string" ? d.trigger : "on_demand",
		cwd: typeof d.cwd === "string" ? d.cwd : "",
		model,
		tools: Array.isArray(d.tools) ? d.tools.filter((x): x is string => typeof x === "string") : [],
		skills: Array.isArray(d.skills) ? d.skills.filter((x): x is string => typeof x === "string") : [],
		mcpServers: Array.isArray(d.mcpServers) ? d.mcpServers.filter((x): x is string => typeof x === "string") : [],
		needsApproval: Array.isArray(d.needsApproval)
			? d.needsApproval.filter((x): x is string => typeof x === "string")
			: [],
		rationale: typeof d.rationale === "string" ? d.rationale : undefined,
		settledStatus,
		settledBotId: typeof raw.botId === "string" ? raw.botId : undefined,
		settledFeedback: typeof raw.feedback === "string" ? raw.feedback : undefined,
	};
}

export function parseAgentBotDraftDetailText(text: string | undefined): AgentBotDraftDetail | null {
	if (!text) return null;
	try {
		return parseAgentBotDraftDetail(JSON.parse(text));
	} catch {
		return null;
	}
}

export function parseAgentBotDraftArgs(argumentsText: string | undefined): AgentBotDraftDetail | null {
	if (!argumentsText) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(argumentsText);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const d = raw as Record<string, unknown>;
	if (d.op !== "draft" || typeof d.name !== "string" || !d.name.trim()) return null;
	const rawModel = d.model as { provider?: unknown; modelId?: unknown } | undefined;
	const model =
		rawModel && typeof rawModel.provider === "string" && typeof rawModel.modelId === "string"
			? { provider: rawModel.provider, modelId: rawModel.modelId }
			: undefined;
	return {
		id: "",
		name: d.name,
		description: typeof d.description === "string" ? d.description : "",
		systemPrompt: typeof d.systemPrompt === "string" ? d.systemPrompt : "",
		trigger: "on_demand",
		cwd: typeof d.cwd === "string" ? d.cwd : "",
		model,
		tools: Array.isArray(d.tools) ? d.tools.filter((x): x is string => typeof x === "string") : [],
		skills: Array.isArray(d.skills) ? d.skills.filter((x): x is string => typeof x === "string") : [],
		mcpServers: Array.isArray(d.mcpServers) ? d.mcpServers.filter((x): x is string => typeof x === "string") : [],
		rationale: typeof d.rationale === "string" ? d.rationale : undefined,
	};
}

function draftActionWords(t: ReturnType<typeof useT>) {
	return {
		"needs-approval": t("agentBotsDraftNeedsApproval"),
		"cwd-invalid": t("agentBotsDraftCwdInvalid"),
		busy: t("agentBotsDraftBusy"),
		missing: t("agentBotsDraftMissing"),
		failed: t("agentBotsDraftActionFailed"),
	};
}

export function BotDraftInlineCard({ draft }: { draft: AgentBotDraftDetail }) {
	const t = useT();
	const [form, setForm] = useState<BotFormData>({
		name: draft.name,
		description: draft.description,
		systemPrompt: draft.systemPrompt ?? "",
		cwd: draft.cwd,
		model: draft.model,
		tools: draft.tools,
		skills: draft.skills ?? [],
		mcpServers: draft.mcpServers ?? [],
	});
	const [resolvedId, setResolvedId] = useState(draft.id);
	const effectiveId = draft.id || resolvedId;
	const [granted, setGranted] = useState<string[]>([]);
	const [feedback, setFeedback] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [status, setStatus] = useState<"pending" | "created" | "revised" | "discarded" | "missing">(
		draft.settledStatus ?? "pending",
	);
	const [createdBotId, setCreatedBotId] = useState<string | null>(draft.settledBotId ?? null);
	const dirtyRef = useRef(false);

	useEffect(() => {
		if (!dirtyRef.current && status === "pending") {
			setForm({
				name: draft.name,
				description: draft.description,
				systemPrompt: draft.systemPrompt ?? "",
				cwd: draft.cwd,
				model: draft.model,
				tools: draft.tools,
				skills: draft.skills ?? [],
				mcpServers: draft.mcpServers ?? [],
			});
		}
	}, [
		draft.id,
		draft.name,
		draft.description,
		draft.systemPrompt,
		draft.cwd,
		draft.model,
		draft.tools,
		draft.skills,
		draft.mcpServers,
		status,
	]);

	useEffect(() => {
		if (draft.settledStatus && status === "pending") {
			setStatus(draft.settledStatus);
		}
		if (draft.settledBotId && !createdBotId) {
			setCreatedBotId(draft.settledBotId);
		}
	}, [draft.settledStatus, draft.settledBotId, status, createdBotId]);
	const {
		options,
		loading: optionsLoading,
		error: optionsError,
		reload: reloadOptions,
	} = useBotOptions(status === "pending");

	// 同步服务端最新草案（补齐完整字段、解析运行中的草案 ID，或更新已处理状态）。
	useEffect(() => {
		if (draft.settledStatus) return;
		let stopped = false;
		const controller = new AbortController();
		const sync = async () => {
			try {
				const panel = await deviceGroupRequest<{
					drafts?: Array<{
						id: string;
						name: string;
						description: string;
						systemPrompt?: string;
						cwd: string;
						model?: { provider: string; modelId: string };
						tools: string[];
						skills?: string[];
						mcpServers?: string[];
					}>;
				}>("bot-panel", controller.signal);
				if (controller.signal.aborted || stopped) return false;
				const list = panel.drafts ?? [];
				const live = draft.id
					? list.find((item) => item.id === draft.id)
					: list.find((item) => item.name === draft.name);
				if (!live) {
					if (draft.id) setStatus((cur) => (cur === "pending" ? "missing" : cur));
					return false;
				}
				if (!draft.id) setResolvedId(live.id);
				setForm((cur) => ({
					name: cur.name === draft.name ? live.name : cur.name,
					description: cur.description === draft.description ? live.description : cur.description,
					cwd: cur.cwd === draft.cwd ? live.cwd : cur.cwd,
					systemPrompt:
						cur.systemPrompt === (draft.systemPrompt ?? "") && typeof live.systemPrompt === "string"
							? live.systemPrompt
							: cur.systemPrompt,
					model: cur.model ?? live.model,
					tools: cur.tools.length === draft.tools.length ? live.tools : cur.tools,
					skills: cur.skills.length === (draft.skills?.length ?? 0) && live.skills ? live.skills : cur.skills,
					mcpServers:
						cur.mcpServers.length === (draft.mcpServers?.length ?? 0) && live.mcpServers
							? live.mcpServers
							: cur.mcpServers,
				}));
				return true;
			} catch {
				return false;
			}
		};
		let timer: number | undefined;
		void sync().then((ok) => {
			if (!ok && !draft.id && !stopped) {
				timer = window.setInterval(() => {
					void sync().then((found) => {
						if (found && timer !== undefined) {
							window.clearInterval(timer);
							timer = undefined;
						}
					});
				}, 600);
			}
		});
		return () => {
			stopped = true;
			if (timer !== undefined) window.clearInterval(timer);
			controller.abort();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draft.id, draft.name, draft.settledStatus]);

	const highPrivSet = useMemo(() => {
		const set = new Set(draft.needsApproval ?? []);
		for (const entry of options?.tools ?? []) {
			if (entry.warning === "high_privilege") set.add(entry.id);
		}
		return set;
	}, [draft.needsApproval, options?.tools]);

	const activeHighPriv = useMemo(() => form.tools.filter((tool) => highPrivSet.has(tool)), [form.tools, highPrivSet]);
	const ready =
		status === "pending" &&
		Boolean(effectiveId) &&
		form.name.trim().length > 0 &&
		form.cwd.trim().length > 0 &&
		form.systemPrompt.trim().length > 0 &&
		activeHighPriv.every((tool) => granted.includes(tool));

	const toggleGrant = useCallback((tool: string, checked: boolean) => {
		setGranted((cur) => (checked ? [...new Set([...cur, tool])] : cur.filter((x) => x !== tool)));
	}, []);

	const handleApprove = useCallback(async () => {
		if (!ready || busy || !effectiveId) return;
		setBusy(true);
		setError("");
		const controller = new AbortController();
		try {
			const approvedTools = [...new Set([...form.tools.filter((tool) => !highPrivSet.has(tool)), ...granted])];
			const result = await deviceGroupRequest<{ bot?: { id: string } }>(
				`bot-drafts/${encodeURIComponent(effectiveId)}/approve`,
				controller.signal,
				{
					name: form.name.trim(),
					description: form.description.trim(),
					systemPrompt: form.systemPrompt.trim(),
					cwd: form.cwd.trim(),
					model: form.model ?? null,
					tools: form.tools,
					skills: form.skills,
					mcpServers: form.mcpServers,
					approvedTools,
				},
			);
			window.dispatchEvent(new CustomEvent("pi-web-ui:device-bots-changed"));
			setCreatedBotId(result.bot?.id ?? null);
			setStatus("created");
		} catch (cause) {
			setError(botDraftActionErrorText(cause, draftActionWords(t)));
		} finally {
			setBusy(false);
		}
	}, [busy, effectiveId, form, granted, highPrivSet, ready, t]);

	const handleDiscard = useCallback(async () => {
		if (busy || status !== "pending" || !effectiveId) return;
		setBusy(true);
		setError("");
		const controller = new AbortController();
		try {
			await deviceGroupRequest(`bot-drafts/${encodeURIComponent(effectiveId)}/discard`, controller.signal, {});
			window.dispatchEvent(new CustomEvent("pi-web-ui:device-bots-changed"));
			setStatus("discarded");
		} catch (cause) {
			setError(botDraftActionErrorText(cause, draftActionWords(t)));
		} finally {
			setBusy(false);
		}
	}, [busy, effectiveId, status, t]);

	const handleRevise = useCallback(async () => {
		const clean = feedback.trim();
		if (busy || status !== "pending" || !clean || !effectiveId) return;
		setBusy(true);
		setError("");
		const controller = new AbortController();
		try {
			await deviceGroupRequest(`bot-drafts/${encodeURIComponent(effectiveId)}/revise`, controller.signal, {
				feedback: clean,
			});
			setStatus("revised");
		} catch (cause) {
			setError(botDraftActionErrorText(cause, draftActionWords(t)));
		} finally {
			setBusy(false);
		}
	}, [busy, effectiveId, feedback, status, t]);

	if (status === "created") {
		return (
			<div className="bot-draft-inline is-settled">
				<div className="bot-draft-inline-head">
					<div className="bot-draft-inline-title">
						<span className="bot-draft-inline-icon is-ok" aria-hidden="true">
							<FiCheck size={13} />
						</span>
						<strong>{form.name}</strong>
					</div>
					<span className="bot-draft-inline-status is-ok">{t("agentBotsInlineCreated")}</span>
				</div>
				{form.description && <p className="bot-draft-inline-sub">{form.description}</p>}
				{createdBotId && (
					<div className="bot-draft-inline-actions">
						<button type="button" className="lp-bot-draft-primary" onClick={() => openBotChat(createdBotId)}>
							{t("agentBotsMenuChat")}
						</button>
					</div>
				)}
			</div>
		);
	}

	if (status === "revised" || status === "discarded" || status === "missing") {
		return (
			<div className="bot-draft-inline is-settled">
				<div className="bot-draft-inline-head">
					<div className="bot-draft-inline-title">
						<span className="bot-draft-inline-icon" aria-hidden="true">
							<FiCpu size={13} />
						</span>
						<strong>{form.name}</strong>
					</div>
					<span className="bot-draft-inline-status">
						{status === "revised"
							? t("agentBotsInlineRevised")
							: status === "discarded"
								? t("agentBotsInlineDiscarded")
								: t("agentBotsInlineHandled")}
					</span>
				</div>
				{status === "revised" && (feedback.trim() || draft.settledFeedback) && (
					<p className="bot-draft-inline-sub">{feedback.trim() || draft.settledFeedback}</p>
				)}
			</div>
		);
	}

	return (
		<div className="bot-draft-inline">
			<div className="bot-draft-inline-head">
				<div className="bot-draft-inline-title">
					<span className="bot-draft-inline-icon" aria-hidden="true">
						<FiCpu size={13} />
					</span>
					<strong>{t("agentBotsInlineTitle")}</strong>
				</div>
				<span className="lp-bot-draft-badge">{t("agentBotsTriggerOnDemand")}</span>
			</div>
			{draft.rationale && <p className="bot-draft-inline-sub">{draft.rationale}</p>}

			<BotEditorForm
				variant="inline"
				value={form}
				onChange={(next) => {
					dirtyRef.current = true;
					setForm(next);
				}}
				options={options}
				optionsLoading={optionsLoading}
				optionsError={optionsError}
				onReloadOptions={reloadOptions}
				busy={busy}
				baseCwd={options?.defaultCwd || form.cwd}
			/>

			{activeHighPriv.length > 0 && (
				<div className="bot-draft-inline-grants">
					<span className="bot-draft-inline-hint">{t("agentBotsDraftHint")}</span>
					<div className="bot-draft-inline-grant-list">
						{activeHighPriv.map((tool) => (
							<label key={tool} className="bot-draft-inline-chip is-high">
								<input
									type="checkbox"
									checked={granted.includes(tool)}
									disabled={busy}
									onChange={(e) => toggleGrant(tool, e.target.checked)}
								/>
								<span>{tool}</span>
							</label>
						))}
					</div>
				</div>
			)}

			{error && (
				<div className="lp-bot-drafts-error" role="alert">
					<span>{error}</span>
				</div>
			)}

			<div className="bot-draft-inline-revise">
				<input
					type="text"
					value={feedback}
					disabled={busy}
					placeholder={t("agentBotsRevisePlaceholder")}
					onChange={(e) => setFeedback(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.nativeEvent.isComposing && feedback.trim()) {
							e.preventDefault();
							void handleRevise();
						}
					}}
				/>
				<button type="button" disabled={busy || !feedback.trim()} onClick={() => void handleRevise()}>
					{t("agentBotsReviseBtn")}
				</button>
			</div>

			<div className="bot-draft-inline-actions">
				<button
					type="button"
					className="lp-bot-draft-primary"
					disabled={!ready || busy}
					onClick={() => void handleApprove()}
				>
					{busy ? t("agentBotsApproving") : t("agentBotsApprove")}
				</button>
				<button type="button" disabled={busy} onClick={() => void handleDiscard()}>
					{t("agentBotsDiscard")}
				</button>
			</div>
		</div>
	);
}
