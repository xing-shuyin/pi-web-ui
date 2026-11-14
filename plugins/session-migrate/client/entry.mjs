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
			`<option value="all">全部来源</option>` +
			CHUNK_KINDS.map((k) => `<option value="${k}">仅 ${k}</option>`).join("");
		const scanBtn = el("button", null, "🔍 扫描");
		const cwdInput = document.createElement("input");
		cwdInput.placeholder = "目标 cwd（可选重定向）";
		cwdInput.style.cssText = "flex:1;min-width:180px;";
		const importBtn = el("button", null, "📥 导入选中");
		row.append(sel, scanBtn, cwdInput, importBtn);

		// —— 上传导出文件导入（issue #887） ——
		const upRow = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.accept = ".jsonl,.json,application/json";
		fileInput.style.cssText = "flex:1;min-width:200px;";
		const uploadBtn = el("button", null, "⬆️ 上传导入");
		const upHint = el("span", "opacity:.7;font-size:12px;", "导出过的 .jsonl / 其它机器的会话文件");
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
			say("扫描中…");
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
				info.textContent = `[${it.source}] ${it.id} · ${it.messages ?? 0}条 · ${it.cwd || "?"} · ${it.preview || it.error || ""}`;
				rowEl.append(cb, info);
				// 导出只对 pi / omp 会话库开放（服务端按根目录校验）
				if (it.source === "pi" || it.source === "omp") {
					const exp = el("button", "flex-shrink:0;", "⬇ 导出");
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
						say(`已开始下载：${it.id}.jsonl`);
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
				say("请先勾选要导入的会话。");
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
				`导入完成：成功 ${ok}，跳过 ${skip}，失败 ${data.results.length - ok - skip}\n` +
					JSON.stringify(data.results, null, 2) +
					"\n\n导入后回到左栏「历史会话」刷新即可看到。",
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
				throw new Error(`服务端返回 ${r.status}`);
			}
			return { status: r.status, data };
		};

		uploadBtn.onclick = async () => {
			const file = fileInput.files?.[0];
			if (!file) {
				say("请先选择要导入的 .jsonl 文件。");
				return;
			}
			conflict.style.display = "none";
			say(`上传中…（${(file.size / 1024).toFixed(1)} KB）`);
			try {
				const { status, data } = await upload(file);
				if (status === 409 && data?.duplicate) {
					conflict.innerHTML = "";
					conflict.append(
						el(
							"span",
							"flex:1;min-width:0;overflow-wrap:anywhere;",
							`会话 ${data.sessionId} 已存在：${(data.existing || []).join(" / ")}`,
						),
					);
					const run = async (mode, label) => {
						conflict.style.display = "none";
						say(`${label}中…`);
						const { data: second } = await upload(file, mode);
						say(
							(second?.ok ? "导入完成：\n" : "导入失败：\n") +
								JSON.stringify(second, null, 2) +
								(second?.ok ? "\n\n回到左栏「历史会话」刷新即可看到。" : ""),
						);
					};
					const overwriteBtn = el("button", null, "覆盖原会话");
					overwriteBtn.onclick = () => void run("overwrite", "覆盖");
					const copyBtn = el("button", null, "另存副本");
					copyBtn.onclick = () => void run("copy", "另存副本");
					const cancelBtn = el("button", null, "取消");
					cancelBtn.onclick = () => {
						conflict.style.display = "none";
						say("已取消导入。");
					};
					conflict.append(overwriteBtn, copyBtn, cancelBtn);
					conflict.style.display = "flex";
					say("该会话已存在于本机会话库，请选择处理方式。");
					return;
				}
				say(
					(data?.ok ? "导入完成：\n" : "导入失败：\n") +
						JSON.stringify(data, null, 2) +
						(data?.ok ? "\n\n回到左栏「历史会话」刷新即可看到。" : ""),
				);
			} catch (err) {
				say(`导入失败：${err?.message || err}`);
			}
		};

		return () => {
			rootEl.innerHTML = "";
		};
	},
};
