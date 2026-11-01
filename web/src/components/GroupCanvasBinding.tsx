import { useEffect, useRef, useState } from "react";
import { CanvasClient } from "./canvas/canvas-client";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useAppField } from "../app-globals";
import { isZhLocale, useI18n } from "../i18n";
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
	const zh = isZhLocale(useI18n().locale);
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
			setStatus(
				zh ? "群画布引用已保存；点击启动才会执行。" : "Group canvas reference saved. Run explicitly to execute.",
			);
		} catch (error) {
			if (!controller.signal.aborted) setStatus((error as Error).message);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	return (
		<details className="group-ecosystem-panel">
			<summary>
				{zh ? "群画布" : "Group canvas"}
				{binding ? ` · ${binding.title}` : ""}
			</summary>
			<p>
				{zh
					? "引用保存在群组中。运行发生在绑定设备，使用下方工作目录；保存引用不会运行。"
					: "References are saved with the group. Runs use the bound device and workspace. Saving does not run the graph."}
			</p>
			{binding && (
				<p>
					{binding.deviceId} · {binding.graphId} · {binding.cwd}
				</p>
			)}
			{!local && binding && (
				<p role="status">
					{zh
						? "此画布属于另一台设备，请在该设备打开群组后运行。可选择本机画布重新绑定。"
						: "This canvas belongs to another device. Open the group there to run it, or bind a local canvas."}
				</p>
			)}
			<label>
				{zh ? "本机工程" : "Local graph"}
				<select value={graphId} onChange={(event) => setGraphId(event.target.value)}>
					<option value="">{zh ? "选择画布" : "Select canvas"}</option>
					{graphs.map((graph) => (
						<option key={graph.id} value={graph.id}>
							{graph.name}
						</option>
					))}
				</select>
			</label>
			<label>
				{zh ? "本机工作目录" : "Local workspace"}
				<input value={cwd} onChange={(event) => setCwd(event.target.value)} />
			</label>
			<button
				className="btn"
				disabled={busy || !connected || !deviceId || !graphId || !cwd.trim()}
				onClick={() => void save()}
			>
				{zh ? "保存群引用" : "Save group reference"}
			</button>
			{binding && (
				<>
					<button className="btn" disabled={busy} onClick={() => void save(true)}>
						{zh ? "解除引用" : "Unbind"}
					</button>
					<button
						className="btn primary"
						disabled={!connected || !local || busy}
						onClick={() => {
							if (!binding || !local) return;
							setStatus(
								client.current?.send({ type: "canvas_run_all", graphId: binding.graphId, cwd: binding.cwd })
									? zh
										? "已请求启动，等待画布运行状态。"
										: "Run requested; waiting for canvas status."
									: zh
										? "画布连接已断开。"
										: "Canvas disconnected.",
							);
						}}
					>
						{zh ? "启动绑定画布" : "Run bound canvas"}
					</button>
				</>
			)}
			{status && <p role="status">{status}</p>}
		</details>
	);
}
