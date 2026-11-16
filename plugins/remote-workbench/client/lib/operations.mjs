import { esc } from "@pi-web-ui/plugin-sdk/client";
import { makeT } from "../i18n.mjs";

const t = makeT();

export function createOperations({ root, api, hosts, post }) {
	let panel = null,
		timer = null,
		generation = 0;
	function close() {
		generation++;
		clearTimeout(timer);
		panel?.remove();
		panel = null;
	}
	function open(title) {
		close();
		panel = document.createElement("div");
		panel.className = "rw-modal-overlay";
		panel.innerHTML = `<div class="rw-modal" style="width:850px;max-height:85vh;overflow:auto;overscroll-behavior:contain"><div class="rw-modal-title">${esc(title)}</div><button class="rw-btn rw-ops-close">${t("close")}</button><div class="rw-ops-content"></div></div>`;
		root.append(panel);
		panel.querySelector(".rw-ops-close").onclick = close;
		return panel.querySelector(".rw-ops-content");
	}
	function error(box, err) {
		const el = document.createElement("pre");
		el.textContent = err.message;
		box.append(el);
	}
	async function health(host) {
		const box = open(t("healthTitle", { name: host.name, env: host.environment || t("noEnvironment") })),
			version = generation;
		const refresh = document.createElement("button");
		refresh.className = "rw-btn";
		refresh.textContent = t("refreshHealth");
		const output = document.createElement("pre");
		box.append(refresh, output);
		async function load() {
			refresh.disabled = true;
			output.textContent = t("checking");
			try {
				const value = await post("/health", { hostName: host.name });
				if (version !== generation) return;
				output.textContent = `${new Date(value.checkedAt).toLocaleString()}\n${value.error || ""}\n${JSON.stringify(value.metrics, null, 2)}\n${value.output || ""}`;
			} catch (err) {
				if (version === generation) output.textContent = err.message;
			} finally {
				refresh.disabled = false;
			}
		}
		refresh.onclick = load;
		load();
	}
	function tasks() {
		const box = open(t("tasksCenter")),
			version = generation;
		box.innerHTML = `<form class="rw-task-form"><div class="rw-task-targets">${hosts()
			.map(
				(h, i) =>
					`<label><input type="checkbox" name="target" value="${i}">${esc(h.name)} · ${esc(h.group || t("ungrouped"))} · ${esc(h.environment || t("noEnvironment"))}</label>`,
			)
			.join(
				"",
			)}</div><label>${t("commandLabel")}<textarea name="cmd" required rows="3"></textarea></label><label>${t("cwdLabel")}<input name="cwd" placeholder="${t("optional")}"></label><label>${t("concurrencyLabel")}<input name="concurrency" type="number" min="1" max="8" value="2"></label><label>${t("timeoutLabel")}<input name="timeout" type="number" min="1" max="120" value="60"></label><button class="rw-btn primary">${t("runOnSelected")}</button></form><div class="rw-task-error" role="alert"></div><div class="rw-task-list"></div>`;
		const rowStates = new Map();
		let lastRevision = "";
		const snapshot = [...hosts()],
			form = box.querySelector("form"),
			list = box.querySelector(".rw-task-list"),
			errBox = box.querySelector(".rw-task-error");
		form.onsubmit = async (event) => {
			event.preventDefault();
			const button = form.querySelector("button");
			const hostNames = [...form.querySelectorAll('[name="target"]:checked')].map(
				(el) => snapshot[Number(el.value)].name,
			);
			if (!hostNames.length) {
				errBox.textContent = t("selectTargetsFirst");
				return;
			}
			if (
				!confirm(
					t("confirmRunOnHosts", {
						hosts: snapshot
							.filter((h) => hostNames.includes(h.name))
							.map((h) => `${h.name} [${h.environment || t("noEnvironment")}]`)
							.join("\n"),
						cmd: form.elements.cmd.value,
					}),
				)
			)
				return;
			button.disabled = true;
			try {
				await post("/tasks/start", {
					hostNames,
					cmd: form.elements.cmd.value,
					cwd: form.elements.cwd.value,
					concurrency: Number(form.elements.concurrency.value),
					timeout: Number(form.elements.timeout.value),
				});
				errBox.textContent = "";
				await load();
			} catch (err) {
				errBox.textContent = err.message;
			} finally {
				button.disabled = false;
			}
		};
		async function action(path, payload) {
			try {
				await post(path, payload);
				await load();
			} catch (err) {
				errBox.textContent = err.message;
			}
		}
		async function load() {
			clearTimeout(timer);
			try {
				const data = await api("/tasks");
				if (version !== generation) return;
				errBox.textContent = data.storageError || data.error || "";
				const revision = JSON.stringify(data.tasks);
				if (revision === lastRevision) {
					if (data.tasks.some((task) => task.status === "running")) timer = setTimeout(load, 2000);
					return;
				}
				lastRevision = revision;
				const scrollTop = panel.scrollTop;
				list.querySelectorAll("details").forEach((el) => {
					const state = rowStates.get(el.dataset.key);
					if (state) state.open = el.open;
				});
				list.replaceChildren();
				for (const task of data.tasks || []) {
					const card = document.createElement("section");
					card.className = "rw-task-card";
					card.innerHTML = `<strong>${esc(task.cmd)}</strong> · ${esc(task.status)} · ${t("concurrencyValue", { n: task.concurrency })}<button class="rw-btn rw-task-cancel">${t("cancelTask")}</button><button class="rw-btn rw-task-retry">${t("retryFailed")}</button>`;
					card.querySelector(".rw-task-cancel").disabled = task.status !== "running";
					card.querySelector(".rw-task-cancel").onclick = () => action("/tasks/cancel", { taskId: task.id });
					card.querySelector(".rw-task-retry").disabled = !task.items.some((item) => item.status === "failed");
					card.querySelector(".rw-task-retry").onclick = () =>
						action("/tasks/retry", {
							taskId: task.id,
							hostNames: task.items.filter((i) => i.status === "failed").map((i) => i.hostName),
						});
					for (const item of task.items) {
						const key = `${task.id}:${item.hostName}`;
						const state = rowStates.get(key) || {
							open: false,
							offset: 0,
							text: "",
							eof: false,
							decoder: new TextDecoder(),
						};
						rowStates.set(key, state);
						const row = document.createElement("details");
						row.dataset.key = key;
						row.open = state.open;
						row.ontoggle = () => {
							state.open = row.open;
						};
						row.innerHTML = `<summary>${esc(item.hostName)} · ${esc(item.status)} · ${t("attemptNth", { n: item.attempt })}</summary>`;
						const pre = document.createElement("pre");
						pre.textContent = [
							item.result?.output,
							item.error,
							item.result?.error,
							item.result?.storageError,
							task.storageError,
							task.error,
							item.result?.stopGuarantee,
							item.result?.truncated ? t("outputTruncated") : "",
						]
							.filter(Boolean)
							.join("\n");
						if (state.offset) pre.textContent = state.text;
						row.append(pre);
						if (["queued", "running"].includes(item.status)) {
							const cancel = document.createElement("button");
							cancel.className = "rw-btn";
							cancel.textContent = t("cancelHost");
							cancel.onclick = () => action("/tasks/cancel", { taskId: task.id, hostName: item.hostName });
							row.append(cancel);
						}
						if (item.result?.logId) {
							const more = document.createElement("button");
							more.className = "rw-btn";
							more.textContent = t("readMoreLog");
							more.disabled = state.eof;
							more.onclick = async () => {
								more.disabled = true;
								try {
									const page = await api(
										`/logs?logId=${encodeURIComponent(item.result.logId)}&offset=${state.offset}&limit=65536`,
									);
									if (version !== generation) return;
									if (!state.offset) pre.textContent = "";
									pre.textContent += state.decoder.decode(
										Uint8Array.from(atob(page.b64), (c) => c.charCodeAt(0)),
										{ stream: !page.eof },
									);
									state.offset = page.nextOffset;
									state.text = pre.textContent;
									state.eof = page.eof;
									more.disabled = page.eof;
								} catch (err) {
									error(row, err);
									more.disabled = false;
								}
							};
							row.append(more);
						}
						card.append(row);
					}
					list.append(card);
				}
				panel.scrollTop = scrollTop;
				if (!data.tasks.some((task) => task.status === "running")) return;
			} catch (err) {
				if (version === generation) errBox.textContent = err.message;
			}
			if (version === generation) timer = setTimeout(load, 2000);
		}
		load();
	}
	return { tasks, health, dispose: close };
}
