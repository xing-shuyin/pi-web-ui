import { useEffect, useRef, useState } from "react";
import { CanvasClient } from "./canvas/canvas-client";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useAppField } from "../app-globals";
import { useT } from "../i18n";
import type { ServerMessage } from "../types";

export interface GroupCanvasReference {
	deviceId: string;
	graphId: string;
	cwd: string;
	title: string;
}
type GraphSummary = Extract<ServerMessage, { type: "canvas_list_result" }>["graphs"][number];

export function GroupCanvasBinding({
	roomId,
	binding,
	onSaved,
}: {
	roomId: string;
	binding?: GroupCanvasReference;
	onSaved(): void;
}) {
	const t = useT();
	const currentCwd = useAppField("cwd");
	const client = useRef<CanvasClient | null>(null);
	const operation = useRef<AbortController | null>(null);
	const [graphs, setGraphs] = useState<GraphSummary[]>([]);
	const [graphId, setGraphId] = useState(binding?.graphId ?? "");
	const [cwd, setCwd] = useState(binding?.cwd ?? currentCwd);
	const [deviceId, setDeviceId] = useState("");
	const [connected, setConnected] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		operation.current = controller;
		setBusy(false);
		void fetch(withToken(appUrl("/api/device-center/chat-status")), { signal: controller.signal })
			.then(async (res) => {
				const data = await res.json();
				if (!res.ok || !data.deviceId) throw new Error(data.error ?? "Local device identity unavailable");
				setDeviceId(data.deviceId);
			})
			.catch((error) => {
				if (!controller.signal.aborted) setStatus(String(error.message));
			});
		const channel = new CanvasClient({ loadGraphOnConnect: false });
		client.current = channel;
		const off = channel.subscribe((msg) => {
			if (msg.type === "canvas_list_result") setGraphs(msg.graphs);
			if (msg.type === "canvas_error" && msg.graphId === binding?.graphId) setStatus(msg.message);
			if (msg.type === "canvas_node_event" && msg.graphId === binding?.graphId)
				setStatus(`${msg.nodeId}: ${msg.event}`);
		});
		const offConnection = channel.subscribeConnection(setConnected);
		channel.connect();
		return () => {
			controller.abort();
			off();
			offConnection();
			channel.dispose();
			client.current = null;
		};
	}, [binding?.graphId, roomId]);
	useEffect(() => {
		setGraphId(binding?.graphId ?? "");
		setCwd(binding?.cwd ?? currentCwd);
	}, [binding?.graphId, binding?.cwd, currentCwd]);
	const local = !!deviceId && (!binding || binding.deviceId === deviceId);
	async function save(clear = false) {
		const controller = operation.current;
		if (!controller || controller.signal.aborted) return;
		setBusy(true);
		setStatus("");
		try {
			const graph = graphs.find((item) => item.id === graphId);
			if (!clear && (!graph || !cwd.trim() || !deviceId)) throw new Error("Select a local graph and workspace");
			const response = await fetch(withToken(appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/canvas`)), {
				method: "POST",
				signal: controller.signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ binding: clear ? null : { deviceId, graphId, cwd: cwd.trim(), title: graph!.name } }),
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Canvas binding failed");
			if (controller.signal.aborted) return;
			onSaved();
			setStatus(t("groupCanvasBinding.saved"));
		} catch (error) {
			if (!controller.signal.aborted) setStatus((error as Error).message);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	return (
		<details className="group-ecosystem-panel">
			<summary>
				{t("groupCanvasBinding.title")}
				{binding ? ` · ${binding.title}` : ""}
			</summary>
			<p>{t("groupCanvasBinding.hint")}</p>
			{binding && (
				<p>
					{binding.deviceId} · {binding.graphId} · {binding.cwd}
				</p>
			)}
			{!local && binding && <p role="status">{t("groupCanvasBinding.remoteHint")}</p>}
			<label>
				{t("groupCanvasBinding.localGraph")}
				<select value={graphId} onChange={(event) => setGraphId(event.target.value)}>
					<option value="">{t("groupCanvasBinding.selectCanvas")}</option>
					{graphs.map((graph) => (
						<option key={graph.id} value={graph.id}>
							{graph.name}
						</option>
					))}
				</select>
			</label>
			<label>
				{t("groupCanvasBinding.localWorkspace")}
				<input value={cwd} onChange={(event) => setCwd(event.target.value)} />
			</label>
			<button
				className="btn"
				disabled={busy || !connected || !deviceId || !graphId || !cwd.trim()}
				onClick={() => void save()}
			>
				{t("groupCanvasBinding.save")}
			</button>
			{binding && (
				<>
					<button className="btn" disabled={busy} onClick={() => void save(true)}>
						{t("groupCanvasBinding.unbind")}
					</button>
					<button
						className="btn primary"
						disabled={!connected || !local || busy}
						onClick={() => {
							if (!binding || !local) return;
							setStatus(
								client.current?.send({ type: "canvas_run_all", graphId: binding.graphId, cwd: binding.cwd })
									? t("groupCanvasBinding.runRequested")
									: t("groupCanvasBinding.disconnected"),
							);
						}}
					>
						{t("groupCanvasBinding.run")}
					</button>
				</>
			)}
			{status && <p role="status">{status}</p>}
		</details>
	);
}
