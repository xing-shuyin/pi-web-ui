import { useEffect, useState, useRef } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
import type { DeviceTaskInteraction, DeviceTaskInteractionAnswer, QuestionAnswer } from "../types";

export function GroupNativeInteractions({
	roomId,
	disabled,
	refreshKey = 0,
	connected = false,
}: {
	roomId: string;
	disabled: boolean;
	refreshKey?: number;
	connected?: boolean;
}) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [items, setItems] = useState<DeviceTaskInteraction[]>([]);
	const [error, setError] = useState("");
	const [refresh, setRefresh] = useState(0);
	const mutation = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			mutation.current?.abort();
			mutation.current = null;
		},
		[roomId, disabled],
	);
	const url = withToken(appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/interactions`));
	useEffect(() => {
		setError("");
		if (disabled) {
			setItems([]);
			return;
		}
		const controller = new AbortController();
		let busy = false;
		async function load() {
			if (busy || document.visibilityState === "hidden") return;
			busy = true;
			try {
				const res = await fetch(url, { credentials: "same-origin", signal: controller.signal });
				const data = await res.json();
				if (!res.ok) throw new Error(data.error || String(res.status));
				if (!controller.signal.aborted) {
					setItems(
						Array.isArray(data.interactions)
							? data.interactions.filter(
									(item: DeviceTaskInteraction) =>
										item &&
										typeof item.id === "string" &&
										item.roomId === roomId &&
										["question", "approval"].includes(item.kind),
								)
							: [],
					);
					setError("");
				}
			} catch (e) {
				if (!controller.signal.aborted) setError(String(e));
			} finally {
				busy = false;
			}
		}
		void load();
		const timer = connected ? undefined : setInterval(() => void load(), 2000);
		const visible = () => {
			if (document.visibilityState !== "hidden") void load();
		};
		document.addEventListener("visibilitychange", visible);
		return () => {
			controller.abort();
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [url, disabled, refresh, refreshKey, connected]);
	useEffect(() => {
		setItems([]);
	}, [roomId]);
	async function answer(item: DeviceTaskInteraction, value: Partial<DeviceTaskInteractionAnswer>) {
		mutation.current?.abort();
		const controller = new AbortController();
		mutation.current = controller;
		try {
			const res = await fetch(url, {
				method: "POST",
				credentials: "same-origin",
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ taskId: item.taskId, attemptId: item.attemptId, interactionId: item.id, ...value }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || String(res.status));
			if (!controller.signal.aborted) setRefresh((n) => n + 1);
		} finally {
			if (mutation.current === controller) mutation.current = null;
		}
	}
	if (!items.length && !error) return null;
	return (
		<div className="gd-content dg-native-interactions-wrap">
			{error && <p role="alert">{error}</p>}
			{items.map((item) => (
				<InteractionCard key={`${roomId}:${item.id}`} item={item} zh={zh} answer={(value) => answer(item, value)} />
			))}
		</div>
	);
}
function InteractionCard({
	item,
	zh,
	answer,
}: {
	item: DeviceTaskInteraction;
	zh: boolean;
	answer: (value: Partial<DeviceTaskInteractionAnswer>) => Promise<void>;
}) {
	const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function submit(value: Partial<DeviceTaskInteractionAnswer>) {
		setBusy(true);
		setError("");
		try {
			await answer(value);
		} catch (e) {
			setError(String(e));
			setBusy(false);
		}
	}
	const visible = (item.questions ?? []).filter(
		(q) =>
			!q.dependsOn ||
			(answers[q.dependsOn.questionId] &&
				(!q.dependsOn.value ||
					[q.dependsOn.value].flat().some((v) => answers[q.dependsOn!.questionId].selected.includes(v)))),
	);
	const complete = visible.every((q) => answers[q.id]?.selected.length || answers[q.id]?.custom?.trim());
	return (
		<section className="gd-card">
			<strong>
				{item.kind === "approval"
					? zh
						? "工具审批 · 仅本次"
						: "Tool approval · once"
					: zh
						? "模型提问"
						: "Model question"}{" "}
				· {item.botId}
			</strong>
			{item.deadline && (
				<p>
					{zh ? "截止时间：" : "Deadline: "}
					{new Date(item.deadline).toLocaleString()}
				</p>
			)}
			{item.kind === "approval" ? (
				<>
					<p>{item.toolName}</p>
					<pre>{item.paramsPreview}</pre>
					<p>{item.reason}</p>
					<button className="btn" disabled={busy} onClick={() => void submit({ decision: "approve" })}>
						{zh ? "批准本次" : "Approve once"}
					</button>
					<button className="btn" disabled={busy} onClick={() => void submit({ decision: "deny" })}>
						{zh ? "拒绝" : "Deny"}
					</button>
				</>
			) : (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (!complete) return;
						void submit({ answers: visible.map((q) => answers[q.id] ?? { id: q.id, selected: [] }) });
					}}
				>
					{visible.map((q) => {
						const current = answers[q.id] ?? { id: q.id, selected: [] };
						const options =
							q.optionsMap && q.dependsOn
								? (q.optionsMap[answers[q.dependsOn.questionId]?.selected[0]] ?? q.options)
								: q.options;
						return (
							<fieldset key={q.id} disabled={busy}>
								<legend>{q.question}</legend>
								{q.detail && <p>{q.detail}</p>}
								{options?.map((o) => (
									<label key={o.label}>
										<input
											type={q.multiSelect ? "checkbox" : "radio"}
											name={`${item.id}:${q.id}`}
											checked={current.selected.includes(o.label)}
											onChange={(e) =>
												setAnswers((prev) => ({
													...prev,
													[q.id]: {
														...current,
														selected: q.multiSelect
															? e.target.checked
																? [...current.selected, o.label]
																: current.selected.filter((v) => v !== o.label)
															: [o.label],
													},
												}))
											}
										/>
										{o.label}
										{o.description && ` · ${o.description}`}
									</label>
								))}
								<textarea
									aria-label={q.question}
									maxLength={4000}
									value={current.custom ?? ""}
									onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: { ...current, custom: e.target.value } }))}
								/>
							</fieldset>
						);
					})}
					<button type="submit" className="btn" disabled={busy || !complete}>
						{zh ? "提交回答" : "Submit answer"}
					</button>
					<button
						type="button"
						className="btn"
						disabled={busy}
						onClick={() => void submit({ answers: [], cancelled: true })}
					>
						{zh ? "取消问卷" : "Cancel question"}
					</button>
				</form>
			)}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
