import { makeT } from "./i18n.mjs";

/** 面板文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。 */
const t = makeT();

function appRoot() {
	try {
		const u = new URL(import.meta.url);
		const i = u.pathname.indexOf("/plugins/");
		return `${u.origin}${i >= 0 ? u.pathname.slice(0, i) : ""}`;
	} catch {
		return "";
	}
}
const base = () => `${appRoot()}/plugins-api/session-migrate`;

const CHUNK_KINDS = ["omp", "pi", "claude", "codex", "opencode", "grok", "kimi"];

function el(tag, style, text) {
	const node = document.createElement(tag);
	if (style) node.style.cssText = style;
	if (text != null) node.textContent = text;
	return node;
}

export default {
	mount(rootEl) {
		rootEl.innerHTML = "";
		const root = el(
			"div",
			"padding:16px;display:flex;flex-direction:column;gap:14px;font-size:13px;height:100%;box-sizing:border-box;",
		);

		// —— 扫描 / 导入磁盘会话 ——
		const row = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
		const sel = document.createElement("select");
		sel.innerHTML =
			`<option value="all">${t("sourceAll")}</option>` +
			CHUNK_KINDS.map((k) => `<option value="${k}">${t("onlyKind", { kind: k })}</option>`).join("");
		const scanBtn = el("button", null, t("scan"));
		const cwdInput = document.createElement("input");
		cwdInput.placeholder = t("cwdPlaceholder");
		cwdInput.style.cssText = "flex:1;min-width:180px;";
		const importBtn = el("button", null, t("importSelected"));
		row.append(sel, scanBtn, cwdInput, importBtn);

		// —— 上传导出文件导入（issue #887） ——
		const upRow = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.accept = ".jsonl,.json,application/json";
		fileInput.style.cssText = "flex:1;min-width:200px;";
		const uploadBtn = el("button", null, t("uploadImport"));
		const upHint = el("span", "opacity:.7;font-size:12px;", t("uploadHint"));
		upRow.append(fileInput, uploadBtn, upHint);

		const list = el("div", "display:flex;flex-direction:column;gap:6px;overflow:auto;flex:1;min-height:60px;");
		// 重名三选一：覆盖 / 另存副本 / 取消（只在 409 时出现）
		const conflict = el(
			"div",
			"display:none;gap:8px;align-items:center;flex-wrap:wrap;border:1px solid var(--border,#333);border-radius:6px;padding:8px;",
		);
		const out = el(
			"pre",
			"white-space:pre-wrap;background:rgba(0,0,0,.25);padding:10px;border-radius:6px;margin:0;max-height:40%;overflow:auto;font-size:12px;",
		);
		root.append(row, upRow, conflict, list, out);
		rootEl.appendChild(root);

		const say = (text) => {
			out.textContent = text;
		};

		const runScan = async () => {
			say(t("scanning"));
			const r = await fetch(`${base()}/scan`);
			const data = await r.json();
			const want = sel.value;
			const items = CHUNK_KINDS.filter((k) => want === "all" || want === k).flatMap((k) => data[k] || []);
			list.innerHTML = "";
			for (const it of items) {
				const rowEl = el(
					"label",
					"display:flex;gap:8px;align-items:flex-start;border:1px solid var(--border,#333);border-radius:6px;padding:8px;",
				);
				const cb = document.createElement("input");
				cb.type = "checkbox";
				cb.checked = it.source === "omp";
				cb.dataset.file = it.file;
				const info = el("div", "flex:1;min-width:0;overflow-wrap:anywhere;");
				info.textContent = `[${it.source}] ${it.id} · ${t("msgCount", { n: it.messages ?? 0 })} · ${it.cwd || "?"} · ${it.preview || it.error || ""}`;
				rowEl.append(cb, info);
				// 导出只对 pi / omp 会话库开放（服务端按根目录校验）
				if (it.source === "pi" || it.source === "omp") {
					const exp = el("button", "flex-shrink:0;", t("export"));
					exp.onclick = (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						const url = `${base()}/export?file=${encodeURIComponent(it.file)}`;
						const a = document.createElement("a");
						a.href = url;
						a.download = "";
						document.body.appendChild(a);
						a.click();
						a.remove();
						say(t("downloadStarted", { name: it.id }));
					};
					rowEl.append(exp);
				}
				list.appendChild(rowEl);
			}
			say(
				`omp ${data.omp?.length || 0} · pi ${data.pi?.length || 0} · claude ${data.claude?.length || 0} · codex ${data.codex?.length || 0} · opencode ${data.opencode?.length || 0} · grok ${data.grok?.length || 0} · kimi ${data.kimi?.length || 0}` +
					(data.notes?.length ? `\n${data.notes.join("\n")}` : ""),
			);
		};

		scanBtn.onclick = () => void runScan();

		importBtn.onclick = async () => {
			const files = [...list.querySelectorAll("input:checked")].map((c) => c.dataset.file);
			if (!files.length) {
				say(t("selectSessionsFirst"));
				return;
			}
			const r = await fetch(`${base()}/import`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ files, targetCwd: cwdInput.value || undefined }),
			});
			const data = await r.json();
			const ok = data.results.filter((x) => x.ok).length;
			const skip = data.results.filter((x) => x.skipped).length;
			say(
				t("importFinished", { ok, skip, failed: data.results.length - ok - skip }) +
					"\n" +
					JSON.stringify(data.results, null, 2) +
					"\n\n" +
					t("refreshHintAfterImport"),
			);
		};

		const upload = async (file, mode) => {
			const headers = { "Content-Type": "application/octet-stream" };
			if (cwdInput.value) headers["x-target-cwd"] = encodeURIComponent(cwdInput.value);
			if (mode) headers["x-session-mode"] = mode;
			const r = await fetch(`${base()}/import-file`, { method: "POST", headers, body: file });
			let data;
			try {
				data = await r.json();
			} catch {
				throw new Error(t("serverReturned", { status: r.status }));
			}
			return { status: r.status, data };
		};

		uploadBtn.onclick = async () => {
			const file = fileInput.files?.[0];
			if (!file) {
				say(t("selectFileFirst"));
				return;
			}
			conflict.style.display = "none";
			say(t("uploading", { size: (file.size / 1024).toFixed(1) }));
			try {
				const { status, data } = await upload(file);
				if (status === 409 && data?.duplicate) {
					conflict.innerHTML = "";
					conflict.append(
						el(
							"span",
							"flex:1;min-width:0;overflow-wrap:anywhere;",
							t("sessionExists", { id: data.sessionId, paths: (data.existing || []).join(" / ") }),
						),
					);
					const run = async (mode, busyText) => {
						conflict.style.display = "none";
						say(busyText);
						const { data: second } = await upload(file, mode);
						say(
							(second?.ok ? t("importDone") + "\n" : t("importFailed") + "\n") +
								JSON.stringify(second, null, 2) +
								(second?.ok ? "\n\n" + t("refreshHint") : ""),
						);
					};
					const overwriteBtn = el("button", null, t("overwrite"));
					overwriteBtn.onclick = () => void run("overwrite", t("overwriting"));
					const copyBtn = el("button", null, t("saveCopy"));
					copyBtn.onclick = () => void run("copy", t("savingCopy"));
					const cancelBtn = el("button", null, t("cancel"));
					cancelBtn.onclick = () => {
						conflict.style.display = "none";
						say(t("cancelled"));
					};
					conflict.append(overwriteBtn, copyBtn, cancelBtn);
					conflict.style.display = "flex";
					say(t("conflictPrompt"));
					return;
				}
				say(
					(data?.ok ? t("importDone") + "\n" : t("importFailed") + "\n") +
						JSON.stringify(data, null, 2) +
						(data?.ok ? "\n\n" + t("refreshHint") : ""),
				);
			} catch (err) {
				say(t("importFailedReason", { error: err?.message || err }));
			}
		};

		return () => {
			rootEl.innerHTML = "";
		};
	},
};
