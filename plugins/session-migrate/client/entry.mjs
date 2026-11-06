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

export default {
	mount(el) {
		el.innerHTML = "";
		const root = document.createElement("div");
		root.style.cssText = "padding:16px;display:flex;flex-direction:column;gap:12px;font-size:13px;";
		const row = document.createElement("div");
		row.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
		const sel = document.createElement("select");
		sel.innerHTML = `<option value="all">全部来源</option><option value="omp">仅 omp</option><option value="pi">仅 pi</option><option value="claude">仅 claude</option><option value="codex">仅 codex</option><option value="opencode">仅 opencode</option><option value="grok">仅 grok</option><option value="kimi">仅 kimi</option>`;
		const scanBtn = document.createElement("button");
		scanBtn.textContent = "🔍 扫描";
		const cwdInput = document.createElement("input");
		cwdInput.placeholder = "目标 cwd（可选重定向）";
		cwdInput.style.cssText = "flex:1;min-width:180px;";
		const importBtn = document.createElement("button");
		importBtn.textContent = "📥 导入选中";
		row.append(sel, scanBtn, cwdInput, importBtn);
		const list = document.createElement("div");
		list.style.cssText = "display:flex;flex-direction:column;gap:6px;";
		const out = document.createElement("pre");
		out.style.cssText = "white-space:pre-wrap;background:rgba(0,0,0,.25);padding:10px;border-radius:6px;";
		root.append(row, list, out);
		el.appendChild(root);

		let items = [];
		scanBtn.onclick = async () => {
			out.textContent = "扫描中…";
			const r = await fetch(`${base()}/scan`);
			const data = await r.json();
			const want = sel.value;
			items = ["omp", "pi", "claude", "codex", "opencode", "grok", "kimi"]
				.filter((k) => want === "all" || want === k)
				.flatMap((k) => data[k] || []);
			list.innerHTML = "";
			for (const it of items) {
				const label = document.createElement("label");
				label.style.cssText =
					"display:flex;gap:8px;align-items:flex-start;border:1px solid var(--border,#333);border-radius:6px;padding:8px;";
				const cb = document.createElement("input");
				cb.type = "checkbox";
				cb.checked = it.source === "omp";
				cb.dataset.file = it.file;
				const div = document.createElement("div");
				div.textContent = `[${it.source}] ${it.id} · ${it.messages ?? 0}条 · ${it.cwd || "?"} · ${it.preview || it.error || ""}`;
				label.append(cb, div);
				list.appendChild(label);
			}
			out.textContent =
				`omp ${data.omp?.length || 0} · pi ${data.pi?.length || 0} · claude ${data.claude?.length || 0} · codex ${data.codex?.length || 0} · opencode ${data.opencode?.length || 0} · grok ${data.grok?.length || 0} · kimi ${data.kimi?.length || 0}` +
				(data.notes?.length ? `\n${data.notes.join("\n")}` : "");
		};
		importBtn.onclick = async () => {
			const files = [...list.querySelectorAll("input:checked")].map((c) => c.dataset.file);
			if (!files.length) {
				out.textContent = "请先勾选要导入的会话。";
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
			out.textContent =
				`导入完成：成功 ${ok}，跳过 ${skip}，失败 ${data.results.length - ok - skip}\n` +
				JSON.stringify(data.results, null, 2);
		};
		return () => (el.innerHTML = "");
	},
};
