import { esc, apiBase as getSharedApiBase } from "@pi-web-ui/plugin-sdk/client";
import { inspectionToText } from "./preview.mjs";
import { attachCanvasBroker } from "./canvas-broker.mjs";

function resolveApi(ctx, path, params) {
	if (typeof ctx?.apiUrl === "function") return ctx.apiUrl(path, params);
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined) query.set(key, String(value));
	}
	const qs = query.toString();
	return `${getSharedApiBase("office")}${path}${qs ? `?${qs}` : ""}`;
}

function createScope() {
	let active = true;
	const lifetime = new AbortController();
	const controllers = new Set();
	const timers = new Set();
	const children = new Set();
	function later(fn, ms) {
		const timer = setTimeout(() => {
			timers.delete(timer);
			if (active) fn();
		}, ms);
		timers.add(timer);
		return () => {
			clearTimeout(timer);
			timers.delete(timer);
		};
	}
	return {
		get active() {
			return active;
		},
		signal: lifetime.signal,
		later,
		child() {
			const child = createScope();
			children.add(child);
			return child;
		},
		async request(url, init = {}, timeoutMs = 30_000, onData) {
			if (!active || init.signal?.aborted) throw new DOMException("已取消", "AbortError");
			const controller = new AbortController();
			const abort = () => controller.abort();
			init.signal?.addEventListener("abort", abort, { once: true });
			controllers.add(controller);
			let timedOut = false;
			const cancelTimeout = later(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);
			try {
				const response = await fetch(url, { ...init, signal: controller.signal });
				let data;
				try {
					data = await response.json();
				} catch {
					const error = new Error(response.ok ? "服务器返回了无效 JSON" : `HTTP ${response.status}`);
					error.status = response.status;
					throw error;
				}
				onData?.(data);
				if (!active || controller.signal.aborted) throw new DOMException("已取消", "AbortError");
				if (!response.ok || data?.ok === false) {
					const error = new Error(
						`${response.ok ? "" : `HTTP ${response.status}: `}${typeof data?.error === "string" ? data.error : data?.error?.message || "请求失败"}`,
					);
					error.status = response.status;
					throw error;
				}
				if (!data || typeof data !== "object") throw new Error("服务器返回了无效数据");
				return data;
			} catch (error) {
				if (timedOut) throw new Error("请求超时，请重试；服务器操作可能仍在继续");
				throw error;
			} finally {
				cancelTimeout();
				init.signal?.removeEventListener("abort", abort);
				controllers.delete(controller);
			}
		},
		dispose() {
			if (!active) return;
			active = false;
			lifetime.abort();
			for (const child of children) child.dispose();
			children.clear();
			for (const controller of controllers) controller.abort();
			for (const timer of timers) clearTimeout(timer);
			controllers.clear();
			timers.clear();
		},
	};
}

function shell(container) {
	const root = document.createElement("div");
	root.className = "office-client";
	root.innerHTML = `<style>
		.office-client { box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; height: 100%; display: flex; flex-direction: column; overflow: hidden; background: var(--bg, #16181f); color: var(--text, #f1f5f9); font: 13px/1.5 system-ui, sans-serif; }
		.office-client * { box-sizing: border-box; }
		.office-client [hidden] { display: none !important; }
		.office-client .office-toolbar, .office-client .office-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
		.office-client .office-toolbar { flex: none; padding: 8px 12px; background: var(--bg-elev, #1e222d); border-bottom: 1px solid var(--border, #475569); }
		.office-client .office-name { flex: 1 1 180px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
		.office-client button, .office-client input { font: inherit; color: inherit; border: 1px solid var(--border, #475569); border-radius: 5px; background: var(--bg-elev2, #232734); padding: 6px 10px; min-height: 32px; max-width: 100%; }
		.office-client button { cursor: pointer; }
		.office-client button:disabled { opacity: .55; cursor: not-allowed; }
		.office-client button:focus-visible, .office-client input:focus-visible { outline: 2px solid var(--accent, #a78bfa); outline-offset: 2px; }
		.office-client .office-primary { background: var(--accent, #a78bfa); color: var(--accent-contrast, #16181f); border-color: transparent; }
		.office-client .office-notice, .office-client .office-hint { flex: none; margin: 0; padding: 6px 12px; overflow-wrap: anywhere; word-break: break-word; }
		.office-client .office-hint { color: var(--text-muted, #cbd5e1); font-size: 12px; }
		.office-client [data-tone="error"] { color: var(--red-text, #fda4af); }
		.office-client [data-tone="success"] { color: var(--green, #86efac); }
		.office-client .office-save-as { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; min-width: 0; }
		.office-client .office-save-as label { flex: 1 1 220px; min-width: 0; }
		.office-client .office-save-as input { width: 100%; }
		.office-client .office-main { position: relative; flex: 1; min-height: 160px; min-width: 0; overflow: hidden; }
		.office-client iframe { width: 100%; height: 100%; border: 0; background: var(--bg, #16181f); }
		.office-client .office-loading { position: absolute; inset: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; overflow: auto; overscroll-behavior: contain; background: var(--bg, #16181f); text-align: center; overflow-wrap: anywhere; word-break: break-word; }
		.office-client .office-loading > * { flex-shrink: 0; max-width: 100%; }
		.office-client .office-preview { margin: 0; padding: 16px; height: 100%; overflow: auto; overscroll-behavior: contain; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: inherit; }
		.office-client .office-list { padding: 12px; overflow: auto; overscroll-behavior: contain; display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr)); }
		.office-client .office-card { text-align: left; overflow-wrap: anywhere; word-break: break-word; }
		@media (max-width: 480px) { .office-client .office-toolbar { padding: 6px; } .office-client .office-name { flex-basis: 100%; } .office-client .office-actions { width: 100%; } .office-client .office-actions button { flex: 1; } }
	</style>`;
	container.appendChild(root);
	return root;
}

export const fileHandlers = [
	{
		id: "office",
		mount(container, file, ctx) {
			const root = shell(container);
			root.insertAdjacentHTML(
				"beforeend",
				`<div class="office-toolbar">
					<span class="office-name" title="${esc(file.path)}">📑 ${esc(file.name)}</span>
					<div class="office-actions">
						<button data-act="reload" type="button">重新加载</button>
						<button data-act="save-as" type="button" disabled>另存为</button>
						<button data-act="save" class="office-primary" type="button" disabled>保存 (Ctrl/⌘+S)</button>
					</div>
				</div>
				<p class="office-hint">编辑后请手动保存。当前未接入查看器编辑事件，修改与同步状态尚未确认；保存结果仅表示服务器写盘结果。快捷键仅在此面板获得键盘事件时生效。</p>
				<p data-el="notice" class="office-notice" role="status" aria-live="polite" aria-atomic="true"></p>
				<form class="office-save-as" hidden>
					<label>工作区内的副本路径（已有文件可能被覆盖，请使用新路径）<input name="targetPath" type="text" required autocomplete="off" /></label>
					<button type="submit">保存副本</button><button data-act="cancel-copy" type="button">取消</button>
				</form>
				<div class="office-main"><div class="office-loading" role="status" aria-live="polite"></div></div>`,
			);
			const find = (selector) => root.querySelector(selector);
			const main = find(".office-main");
			const loading = find(".office-loading");
			const notice = find('[data-el="notice"]');
			const saveBtn = find('[data-act="save"]');
			const copyBtn = find('[data-act="save-as"]');
			const reloadBtn = find('[data-act="reload"]');
			const copyForm = find("form");
			const targetInput = find("input");
			const copySubmit = find('[type="submit"]');
			let disposed = false;
			let scope;
			let iframe = null;
			let disposeCanvas;
			const hint = find(".office-hint");
			const editingHint = hint.textContent;
			let loaded = false;
			let opening = false;
			let saving = false;
			let conflict = false;

			function updateButtons() {
				saveBtn.disabled = !loaded || saving || conflict;
				copyBtn.disabled = !loaded || saving;
				copySubmit.disabled = !loaded || saving;
				targetInput.disabled = saving;
				reloadBtn.disabled = saving;
				saveBtn.textContent = saving ? "正在保存…" : "保存 (Ctrl/⌘+S)";
				reloadBtn.textContent = loaded ? "重新加载（放弃当前编辑）" : "重新加载";
			}
			function announce(message, tone = "") {
				notice.textContent = message;
				notice.dataset.tone = tone;
			}
			function removeFrame() {
				disposeCanvas?.();
				disposeCanvas = undefined;
				if (!iframe) return;
				iframe.onload = null;
				iframe.onerror = null;
				iframe.remove();
				iframe = null;
			}
			function showLoading(message, action, label = "重试") {
				loading.hidden = false;
				loading.replaceChildren();
				const text = document.createElement("div");
				text.textContent = message;
				loading.appendChild(text);
				if (action) {
					const button = document.createElement("button");
					button.type = "button";
					button.textContent = label;
					button.onclick = action;
					loading.appendChild(button);
				}
			}
			function fail(operation, error) {
				if (!operation.active) return;
				operation.dispose();
				loaded = false;
				opening = false;
				removeFrame();
				updateButtons();
				showLoading(`打开失败：${error.message}`, () => void restart(true));
			}
			function closeCanvas(token) {
				const cleanup = createScope();
				void cleanup
					.request(
						resolveApi(ctx, "/canvas-close"),
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ token }),
						},
						5000,
					)
					.catch(() => {})
					.finally(() => cleanup.dispose());
			}
			async function readonlyPreview(operation, error) {
				if (!operation.active) return;
				loaded = false;
				removeFrame();
				updateButtons();
				showLoading("编辑器不可用，正在读取文档的只读文本预览…");
				try {
					const inspection = await operation.request(
						resolveApi(ctx, "/inspect"),
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ path: file.path }),
						},
						60_000,
					);
					if (!operation.active) return;
					const preview = document.createElement("pre");
					preview.className = "office-preview";
					preview.tabIndex = 0;
					preview.setAttribute("aria-label", "Office 只读文本预览");
					preview.textContent = inspectionToText(inspection.result);
					main.appendChild(preview);
					opening = false;
					loading.hidden = true;
					announce(`编辑器不可用：${error.message}。当前为只读文本预览，编辑和保存已禁用。`);
					hint.textContent = "此预览展示服务器返回的有限文本内容，可能省略格式或数据。";
					updateButtons();
				} catch (inspectionError) {
					fail(operation, new Error(`编辑器不可用：${error.message}；只读预览失败：${inspectionError.message}`));
				}
			}
			async function openCanvas(operation) {
				const canvas = operation.child();
				let token;
				let released = false;
				let closed = false;
				let broker;
				let cancelTimeout;
				function releaseToken() {
					if (!token || released) return;
					released = true;
					closeCanvas(token);
				}
				disposeCanvas = () => {
					closed = true;
					cancelTimeout?.();
					broker?.();
					canvas.dispose();
					releaseToken();
				};
				const unavailable = (error) => {
					if (!operation.active || closed) return;
					void readonlyPreview(operation, error);
				};
				showLoading("正在启动安全画布编辑器…");
				try {
					const data = await canvas.request(
						resolveApi(ctx, "/canvas-create"),
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ path: file.path }),
						},
						120_000,
						(data) => {
							if (typeof data?.token === "string" && data.token) token = data.token;
							if (!canvas.active || closed) releaseToken();
						},
					);
					if (!canvas.active) return;
					if (
						!token ||
						typeof data.srcdoc !== "string" ||
						!data.srcdoc ||
						typeof data.channel !== "string" ||
						!data.channel
					)
						throw new Error("安全画布返回了无效数据");
					const frame = document.createElement("iframe");
					iframe = frame;
					frame.title = `Office 文档：${file.name}`;
					frame.setAttribute("sandbox", "allow-scripts allow-downloads");
					frame.allow = "fullscreen";
					cancelTimeout = canvas.later(() => unavailable(new Error("安全画布启动超时")), 60_000);
					broker = attachCanvasBroker({
						iframe: frame,
						channel: data.channel,
						signal: canvas.signal,
						request: async (message, { signal } = {}) => {
							const reply = await canvas.request(resolveApi(ctx, "/canvas-rpc"), {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ token, message }),
								signal,
							});
							return reply.result;
						},
						onReady: () => {
							if (!canvas.active || iframe !== frame) return;
							cancelTimeout();
							opening = false;
							loaded = true;
							loading.hidden = true;
							updateButtons();
						},
						onError: unavailable,
					});
					frame.onerror = () => unavailable(new Error("安全画布加载失败"));
					frame.srcdoc = data.srcdoc;
					main.appendChild(frame);
				} catch (error) {
					unavailable(error);
				}
			}
			async function openDoc(operation, reload = false) {
				if (!operation.active || opening || iframe) return;
				opening = true;
				showLoading("正在启动运行时并打开文档…");
				try {
					await operation.request(
						resolveApi(ctx, "/open", { path: file.path, ...(reload ? { reload: 1 } : {}) }),
						{},
						120_000,
					);
					if (!operation.active) return;
					await openCanvas(operation);
				} catch (error) {
					fail(operation, error);
				}
			}

			function provision(parent, reload = false) {
				if (!parent.active) return;
				const operation = parent.child();
				showLoading("正在下载运行时组件…");
				const deadline = Date.now() + 600_000;
				let polls = 0;
				let failures = 0;
				const expired = () => Date.now() >= deadline || polls >= 600;
				const cancelDeadline = operation.later(() => fail(parent, new Error("运行时安装等待超时")), 600_000);
				async function poll() {
					if (!operation.active || opening || iframe) return;
					try {
						if (expired()) throw new Error("运行时安装等待超时");
						polls++;
						const status = await operation.request(resolveApi(ctx, "/status"));
						if (!operation.active || opening || iframe) return;
						if (status.ready || status.hasArtifacts) {
							cancelDeadline();
							operation.dispose();
							void openDoc(parent, reload);
							return;
						}
						if (status.error) throw new Error(String(status.error));
						failures = 0;
						const percent = Math.max(0, Math.min(100, Number(status.progress) || 0));
						showLoading(`正在安装运行时：${percent}%`);
					} catch (error) {
						if (!operation.active || opening || iframe) return;
						if (expired() || ++failures >= 3 || !(error instanceof TypeError)) {
							fail(parent, error);
							return;
						}
						showLoading(`进度查询失败，正在重试 (${failures}/3)：${error.message}`);
					}
					if (operation.active) operation.later(poll, 1000);
				}
				void operation.request(resolveApi(ctx, "/provision-runtime"), { method: "POST" }, 600_000).catch((error) => {
					if (operation.active && !opening && !iframe) fail(parent, error);
				});
				void poll();
			}

			async function restart(reload = true) {
				if (disposed || saving) return;
				scope?.dispose();
				scope = createScope();
				const operation = scope;
				loaded = false;
				opening = false;
				conflict = false;
				removeFrame();
				main.querySelector(".office-preview")?.remove();
				copyForm.hidden = true;
				hint.textContent = editingHint;
				announce("");
				updateButtons();
				showLoading("正在检查 Office 运行时…");
				try {
					const status = await operation.request(resolveApi(ctx, "/status"));
					if (!operation.active) return;
					if (status.ready || status.hasArtifacts) void openDoc(operation, reload);
					else if (status.error) throw new Error(String(status.error));
					else if (status.downloading) provision(operation, reload);
					else showLoading("需要下载 Office 运行时组件（约 34MB）。", () => provision(operation, reload), "下载并打开");
				} catch (error) {
					fail(operation, error);
				}
			}
			function showCopy() {
				copyForm.hidden = false;
				if (!targetInput.value) {
					const path = file.path;
					const dot = path.lastIndexOf(".");
					targetInput.value =
						dot > path.lastIndexOf("/") ? `${path.slice(0, dot)}-copy${path.slice(dot)}` : `${path}-copy`;
				}
				targetInput.focus();
			}
			async function save(targetPath) {
				if (!loaded || saving || disposed || (!targetPath && conflict)) return;
				const operation = scope;
				if (!operation.active) return;
				if (targetPath && targetPath.replaceAll("\\", "/") === file.path.replaceAll("\\", "/")) {
					announce("另存为需要使用不同的新文件路径。", "error");
					return;
				}
				saving = true;
				updateButtons();
				announce("正在保存…");
				try {
					const result = await operation.request(
						resolveApi(ctx, "/save"),
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ path: file.path, ...(targetPath ? { targetPath } : {}) }),
						},
						60_000,
					);
					if (!operation.active) return;
					announce(
						`✓ ${targetPath ? "副本已保存" : "已保存到磁盘"}：${result.path || targetPath || file.path}${Number.isFinite(result.size) ? ` (${result.size} B)` : ""}${conflict ? "；原文件冲突仍需重新加载处理。" : ""}`,
						"success",
					);
					copyForm.hidden = true;
				} catch (error) {
					if (!operation.active) return;
					if ([409, 412].includes(error.status)) {
						conflict = true;
						announce(`保存冲突：${error.message}。请重新加载（放弃当前编辑），或另存为新文件以保留当前内容。`, "error");
						showCopy();
					} else announce(`保存失败：${error.message}`, "error");
				} finally {
					if (operation.active) {
						saving = false;
						updateButtons();
					}
				}
			}
			saveBtn.onclick = () => void save();
			copyBtn.onclick = showCopy;
			find('[data-act="cancel-copy"]').onclick = () => (copyForm.hidden = true);
			copyForm.onsubmit = (event) => {
				event.preventDefault();
				const targetPath = targetInput.value.trim();
				if (targetPath) void save(targetPath);
			};
			reloadBtn.onclick = () => void restart(true);
			const onKeyDown = (event) => {
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !event.repeat) {
					event.preventDefault();
					void save();
				}
			};
			root.addEventListener("keydown", onKeyDown);
			void restart(false);
			return () => {
				disposed = true;
				scope.dispose();
				removeFrame();
				root.removeEventListener("keydown", onKeyDown);
				root.remove();
			};
		},
	},
];

export default {
	fileHandlers,
	mount(container, ctx) {
		const root = shell(container);
		root.insertAdjacentHTML(
			"beforeend",
			`<div class="office-toolbar"><strong class="office-name">📑 Office</strong><button data-act="refresh" type="button">刷新</button></div><div class="office-list" aria-live="polite"></div>`,
		);
		const body = root.querySelector(".office-list");
		const refresh = root.querySelector("button");
		let disposed = false;
		let scope;
		async function loadList() {
			if (disposed) return;
			scope?.dispose();
			scope = createScope();
			const operation = scope;
			body.textContent = "正在扫描工作区中的 Office 文档…";
			try {
				const data = await operation.request(resolveApi(ctx, "/list"));
				if (!operation.active) return;
				if (!Array.isArray(data.files)) throw new Error("文档列表格式无效");
				body.replaceChildren();
				if (!data.files.length) body.textContent = "工作区暂无 Office 文档";
				for (const path of data.files) {
					if (typeof path !== "string") continue;
					const card = document.createElement("button");
					card.type = "button";
					card.className = "office-card";
					card.textContent = `📑 ${path}`;
					card.onclick = () => window.__piWebUiHost?.openFile?.(path);
					body.appendChild(card);
				}
			} catch (error) {
				if (!operation.active) return;
				body.textContent = `加载列表失败：${error.message}`;
				body.dataset.tone = "error";
			}
		}
		refresh.onclick = () => {
			body.dataset.tone = "";
			void loadList();
		};
		void loadList();
		return () => {
			disposed = true;
			scope.dispose();
			root.remove();
		};
	},
};
