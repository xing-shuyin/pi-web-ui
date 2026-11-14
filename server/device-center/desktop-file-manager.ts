export type DesktopFileRequest = (path: string, method?: string, body?: any) => Promise<any>;

/** Runs only in the trusted controller document. Remote messages cannot initiate local IO. */
export function desktopFileManager(options: {
	remote: DesktopFileRequest;
	local?: DesktopFileRequest;
	crc: (data: Uint8Array, previous?: number) => number;
	browser: () => any;
}) {
	const doc = Reflect.get(globalThis, "document") as any,
		win = Reflect.get(globalThis, "window") as any;
	const zh = (win.navigator.language || "en").startsWith("zh"),
		t = (cn: string, en: string) => (zh ? cn : en);
	const el = (tag: string, text = "", cls = "") => {
		const n = doc.createElement(tag);
		n.textContent = text;
		n.className = cls;
		return n;
	};
	const size = (n: number) =>
		n < 1024
			? n + " B"
			: n < 1024 ** 2
				? (n / 1024).toFixed(1) + " KB"
				: n < 1024 ** 3
					? (n / 1024 ** 2).toFixed(1) + " MB"
					: (n / 1024 ** 3).toFixed(2) + " GB";
	const random = () =>
		Array.from(win.crypto.getRandomValues(new Uint8Array(16)), (v: any) => v.toString(16).padStart(2, "0")).join("");
	const style = el("style");
	style.nonce = doc.querySelector("script[nonce]")?.nonce || "";
	style.textContent = `
.pi-files{--fm-bg:var(--bg-elev,var(--bg,#171c23));--fm-line:var(--border,#46505d);box-sizing:border-box;color:var(--text,#e6edf3);background:var(--fm-bg);border:1px solid var(--fm-line);border-radius:12px;width:min(1120px,96vw);height:min(760px,91dvh);max-height:94dvh;padding:0;font:13px system-ui;overflow:hidden;box-shadow:0 20px 70px #0005}
.pi-files::backdrop{background:#0005}.pi-files *{box-sizing:border-box}.pi-files .fm-shell{height:100%;display:flex;flex-direction:column;min-width:0}.pi-files button,.pi-files input,.pi-files select{font:inherit;color:inherit;background:var(--bg,#171c23);border:1px solid var(--fm-line);border-radius:6px;padding:6px 9px;min-width:0;max-width:100%;line-height:1.4}.pi-files button{cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:5px}.pi-files button:disabled{opacity:.45;cursor:default}.pi-files button:hover:not(:disabled){border-color:var(--accent,#8ab4f8)}.pi-files button:focus-visible,.pi-files input:focus-visible,.pi-files select:focus-visible{outline:2px solid var(--accent,#8ab4f8);outline-offset:2px}.pi-files input[type=checkbox]{width:14px;height:14px;accent-color:var(--accent,#8ab4f8)}.pi-files .fm-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--fm-line)}.pi-files .fm-head strong{font-size:16px}.pi-files .fm-muted{color:var(--text-dim,var(--text,#b3bac5));font-size:12px}.pi-files .fm-panes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;padding:16px 18px 10px;min-height:180px;flex:1.4;overflow:hidden}.pi-files .fm-pane{min-width:0;display:flex;flex-direction:column;overflow:hidden}.pi-files .fm-device{display:flex;align-items:center;gap:8px;margin-bottom:10px;min-width:0}.pi-files .fm-device strong{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pi-files .fm-badge{font-size:11px;padding:2px 6px;border:1px solid var(--fm-line);border-radius:4px;flex:none}.pi-files .fm-device button{margin-left:auto}.pi-files .fm-nav{display:flex;gap:5px;margin-bottom:6px;min-width:0}.pi-files .fm-path{flex:1;width:0}.pi-files .fm-roots{width:100%;margin-bottom:6px}.pi-files .fm-grid{overflow:auto;min-height:80px;border:1px solid var(--fm-line);border-radius:7px;flex:1;overscroll-behavior:contain}.pi-files table{color:inherit;width:100%;border-collapse:collapse;text-align:left;font-size:12px;table-layout:fixed}.pi-files th{font-weight:500;color:var(--text-dim,var(--text,#b3bac5));position:sticky;top:0;background:var(--fm-bg);z-index:1}.pi-files td,.pi-files th{padding:7px 8px;border-bottom:1px solid var(--fm-line);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pi-files th:first-child,.pi-files td:first-child{width:30px}.pi-files .fm-name{width:43%}.pi-files .fm-date{width:27%}.pi-files tr[aria-selected=true]{background:color-mix(in srgb,var(--accent,#8ab4f8) 15%,transparent)}.pi-files tbody tr:hover{background:color-mix(in srgb,var(--accent,#8ab4f8) 9%,transparent)}.pi-files .fm-empty{text-align:center;padding:24px;white-space:normal;color:var(--text-dim,var(--text,#b3bac5))}.pi-files .fm-foot{padding:7px 2px;font-size:12px;min-height:30px;overflow-wrap:anywhere;word-break:break-word}.pi-files .fm-actions{display:flex;gap:8px;flex-wrap:wrap}.pi-files .fm-queue{display:flex;flex-direction:column;min-height:140px;flex:1;padding:4px 18px 16px;overflow:hidden}.pi-files .fm-queue-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0 8px;flex-wrap:wrap}.pi-files .fm-tasks th:first-child,.pi-files .fm-tasks td:first-child{width:19%}.pi-files .fm-tasks th:nth-child(2){width:24%}.pi-files .fm-tasks th:nth-child(3){width:10%}.pi-files .fm-tasks th:last-child{width:16%}.pi-files .fm-tasks td{white-space:normal;overflow-wrap:anywhere;word-break:break-word;vertical-align:top}.pi-files progress{display:block;width:100%;height:5px;margin-top:7px;accent-color:var(--accent,#8ab4f8)}.pi-files .fm-note{padding:0 18px 8px;overflow-wrap:anywhere;word-break:break-word;min-height:22px}.pi-files .fm-note[role=alert]{color:var(--red,#ff9a9a)}.pi-files .fm-task-actions{display:flex;gap:4px;flex-wrap:wrap}.pi-files .fm-task-actions button{font-size:11px;padding:3px 6px}.pi-files [hidden]{display:none!important}@media(max-width:700px){.pi-files .fm-panes{gap:8px;padding:10px;}.pi-files .fm-date{display:none}.pi-files .fm-name{width:65%}.pi-files .fm-nav{flex-wrap:wrap}.pi-files .fm-path{flex-basis:100%;width:100%;order:2}.pi-files .fm-device{flex-wrap:wrap}.pi-files .fm-device strong{max-width:100%;font-size:12px}.pi-files .fm-queue{padding:4px 10px 10px}.pi-files .fm-tasks th:nth-child(4),.pi-files .fm-tasks td:nth-child(4),.pi-files .fm-tasks th:nth-child(5),.pi-files .fm-tasks td:nth-child(5){display:none}.pi-files .fm-tasks th:last-child{width:24%}.pi-files .fm-device button{margin-left:0}}
`;
	doc.head.append(style);
	const dialog = el("dialog", "", "pi-files");
	dialog.id = "file-transfer-dialog";
	const shell = el("div", "", "fm-shell"),
		head = el("div", "", "fm-head"),
		hide = el("button", t("收起", "Hide"));
	head.append(el("strong", t("文件传输", "File transfer")), hide);
	hide.onclick = () => dialog.close();
	const panes = el("div", "", "fm-panes"),
		note = el("div", "", "fm-note fm-muted"),
		queue = el("div", "", "fm-queue"),
		qhead = el("div", "", "fm-queue-head"),
		qactions = el("div", "", "fm-actions");
	qhead.append(el("strong", t("传输列表", "Transfers")), qactions);
	const qgrid = el("div", "", "fm-grid"),
		qtable = el("table", "", "fm-tasks"),
		qbody = el("tbody"),
		qrow = el("tr");
	for (const text of [
		t("名称 / 方向", "Name / direction"),
		t("状态 / 进度", "Status / progress"),
		t("大小", "Size"),
		t("发送路径", "Source"),
		t("接收路径", "Destination"),
		t("操作", "Actions"),
	])
		qrow.append(el("th", text));
	const qthead = el("thead");
	qthead.append(qrow);
	qtable.append(qthead, qbody);
	qgrid.append(qtable);
	queue.append(qhead, qgrid);
	shell.append(head, panes, note, queue);
	dialog.append(shell);
	doc.body.append(dialog);
	const browser = !options.local ? options.browser() : undefined;
	let disposed = false,
		initialized = false,
		running = false;
	const tasks: any[] = [];
	const report = (message: string, error = false) => {
		note.textContent = message;
		note.setAttribute("role", error ? "alert" : "status");
	};
	const help = t(
		"双击文件夹打开；选中文件后按箭头传输。同名文件自动重命名，保留两份。",
		"Double-click folders to open. Select files, then send. Existing files are kept; duplicates are renamed.",
	);
	report(help);
	let sides: any[] = [];
	function panel(index: number, request: DesktopFileRequest) {
		const box = el("section", "", "fm-pane"),
			device = el("div", "", "fm-device"),
			name = el("strong", index ? t("远程设备", "Remote device") : t("我的设备", "My device")),
			send = el("button", index ? t("← 接收", "← Receive") : t("发送 →", "Send →"));
		const badge = el("span", index ? t("远程", "Remote") : t("本机", "Local"), "fm-badge");
		device.append(name, badge, send);
		const nav = el("div", "", "fm-nav"),
			back = el("button", "←"),
			up = el("button", "↑"),
			refresh = el("button", "↻"),
			mkdir = el("button", "＋"),
			path = el("input", "", "fm-path"),
			roots = el("select", "", "fm-roots"),
			grid = el("div", "", "fm-grid"),
			table = el("table"),
			thead = el("thead"),
			tbody = el("tbody"),
			row = el("tr"),
			all = el("input"),
			first = el("th"),
			foot = el("div", "", "fm-foot fm-muted");
		back.title = t("后退", "Back");
		up.title = t("上一级", "Parent folder");
		refresh.title = t("刷新", "Refresh");
		mkdir.title = t("新建文件夹", "New folder");
		path.setAttribute("aria-label", index ? t("远程路径", "Remote path") : t("本机路径", "Local path"));
		all.type = "checkbox";
		all.setAttribute("aria-label", t("全选", "Select all"));
		first.append(all);
		row.append(
			first,
			el("th", t("名称", "Name"), "fm-name"),
			el("th", t("修改日期", "Modified"), "fm-date"),
			el("th", t("大小", "Size")),
		);
		thead.append(row);
		table.append(thead, tbody);
		grid.append(table);
		nav.append(back, up, refresh, mkdir, path);
		box.append(device, nav, roots, grid, foot);
		panes.append(box);
		const p: any = {
			request,
			index,
			path: "",
			parent: "",
			entries: [],
			selected: new Set<string>(),
			history: [],
			name: "",
			info: null,
			revision: 0,
			loading: false,
		};
		function update() {
			const remoteReadOnly = index === 0 && sides[1]?.info?.readOnly === true;
			send.disabled = p.loading || !p.selected.size || remoteReadOnly;
			send.title = remoteReadOnly ? t("只读模式不能发送文件", "Sending is disabled in view-only mode") : "";
			if (index === 1) mkdir.disabled = p.info?.readOnly === true;
			all.checked = p.entries.length > 0 && p.selected.size === p.entries.length;
			all.indeterminate = p.selected.size > 0 && !all.checked;
			back.disabled = !p.history.length;
			up.disabled = !p.parent || p.parent === p.path;
			foot.textContent = `${p.entries.length} ${t("项", "items")} · ${t("已选择", "Selected")} ${p.selected.size}`;
		}
		p.update = update;
		function draw() {
			tbody.replaceChildren();
			for (const item of p.entries) {
				const tr = el("tr"),
					check = el("input"),
					cell = el("td"),
					label = el("td", (item.directory ? "📁 " : "▤ ") + item.name),
					date = el("td", item.modified ? new Date(item.modified).toLocaleString() : "—", "fm-date");
				check.type = "checkbox";
				check.checked = p.selected.has(item.path);
				check.setAttribute("aria-label", item.name);
				tr.setAttribute("aria-selected", String(check.checked));
				cell.append(check);
				label.title = item.name;
				tr.append(cell, label, date, el("td", item.directory ? t("文件夹", "Folder") : size(item.size)));
				check.onchange = () => {
					if (check.checked) p.selected.add(item.path);
					else p.selected.delete(item.path);
					tr.setAttribute("aria-selected", String(check.checked));
					update();
				};
				tr.onclick = (event: any) => {
					if (event.target === check) return;
					check.checked = !check.checked;
					check.onchange();
				};
				tr.ondblclick = () => {
					if (item.directory) void p.load(item.path);
				};
				tbody.append(tr);
			}
			if (!p.entries.length) {
				const r = el("tr"),
					c = el("td", t("此文件夹为空", "This folder is empty"), "fm-empty");
				c.colSpan = 4;
				r.append(c);
				tbody.append(r);
			}
			update();
		}
		p.load = async (next: string, remember = true) => {
			const revision = ++p.revision;
			p.loading = true;
			send.disabled = true;
			try {
				const data = await request("list?path=" + encodeURIComponent(next));
				if (disposed || revision !== p.revision) return;
				if (remember && p.path && p.path !== data.path) p.history.push(p.path);
				p.path = data.path;
				p.parent = data.parent;
				p.entries = data.entries.sort(
					(a: any, b: any) =>
						Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }),
				);
				p.selected.clear();
				path.value = p.path;
				roots.value = p.path;
				if (roots.selectedIndex < 0) roots.value = "";
				draw();
				if (data.truncated)
					report(t("目录只显示前 2000 项，请进入子目录。", "Only the first 2000 entries are shown; open a subfolder."));
			} catch (error: any) {
				report(error.message, true);
				path.value = p.path;
			} finally {
				if (revision === p.revision) {
					p.loading = false;
					update();
				}
			}
		};
		p.init = async () => {
			p.info = await request("info");
			if (index === 1 && !win.getComputedStyle(doc.documentElement).getPropertyValue("--bg").trim())
				for (const key of ["--bg", "--bg-elev", "--border", "--text", "--text-dim", "--accent", "--red"]) {
					const value = p.info.theme?.[key];
					if (typeof value === "string" && value.length <= 128 && win.CSS.supports("color", value))
						dialog.style.setProperty(key, value);
				}
			p.name = p.info.device;
			name.textContent = p.name;
			name.title = p.name;
			roots.replaceChildren();
			const quick = el("option", t("快速访问…", "Quick access…"));
			quick.value = "";
			quick.disabled = true;
			roots.append(quick);
			for (const root of p.info.roots || []) {
				const o = el(
					"option",
					(
						{
							Home: t("主目录", "Home"),
							Desktop: t("桌面", "Desktop"),
							Downloads: t("下载", "Downloads"),
							Documents: t("文档", "Documents"),
						} as any
					)[root.name] || root.name,
				);
				o.value = root.path;
				roots.append(o);
			}
			await p.load(p.info.home, false);
			for (const side of sides) side.update();
		};
		roots.onchange = () => void p.load(roots.value);
		path.onkeydown = (e: any) => {
			if (e.key === "Enter") void p.load(path.value);
		};
		refresh.onclick = () => void p.load(p.path, false);
		up.onclick = () => void p.load(p.parent);
		back.onclick = () => void p.load(p.history.pop() || p.path, false);
		mkdir.onclick = async () => {
			const value = win.prompt(t("新文件夹名称", "New folder name"));
			if (!value) return;
			try {
				await request("mkdir", "POST", { path: p.path, name: value });
				await p.load(p.path, false);
			} catch (error: any) {
				report(error.message, true);
			}
		};
		all.onchange = () => {
			p.selected = all.checked ? new Set(p.entries.map((i: any) => i.path)) : new Set();
			draw();
		};
		send.onclick = () => void enqueue(p);
		if (index === 0 && browser) {
			const controls = el("div", "", "fm-actions"),
				choose = el("button", t("选择本机目录", "Choose local folder")),
				files = el("button", t("选择文件", "Choose files")),
				folder = el("button", t("选择文件夹", "Choose folder"));
			controls.style.marginBottom = "6px";
			controls.append(choose, files, folder);
			box.insertBefore(controls, nav);
			choose.hidden = !browser.canChoose;
			choose.onclick = async () => {
				try {
					await browser.choose();
					await p.init();
				} catch (error: any) {
					if (error.name !== "AbortError") report(error.message, true);
				}
			};
			files.onclick = () => browser.pick(false, () => void p.init());
			folder.onclick = () => browser.pick(true, () => void p.init());
			mkdir.disabled = !browser.canChoose;
		}
		update();
		return p;
	}
	sides = [panel(0, options.local ?? browser.request), panel(1, options.remote)];
	function renderTasks() {
		qbody.replaceChildren();
		if (!tasks.length) {
			const r = el("tr"),
				c = el(
					"td",
					t(
						"选择文件和接收目录后，传输任务会显示在这里。",
						"Choose files and a destination. Transfers will appear here.",
					),
					"fm-empty",
				);
			c.colSpan = 6;
			r.append(c);
			qbody.append(r);
			return;
		}
		for (const task of tasks) {
			const row = el("tr"),
				title = el("td", task.name + "\n" + (task.from.index ? "←" : "→")),
				state = el("td"),
				progress = el("progress"),
				src = el("td", task.source),
				dst = el("td", task.destination),
				actions = el("div", "", "fm-task-actions"),
				actioncell = el("td");
			state.append(
				el(
					"span",
					task.message ||
						(
							{
								queued: t("等待中", "Queued"),
								running: t("正在传输", "Transferring"),
								paused: t("已暂停", "Paused"),
								complete: t("已完成", "Completed"),
								cancelled: t("已取消", "Cancelled"),
								error: t("传输失败", "Failed"),
							} as any
						)[task.status],
				),
			);
			progress.max = task.total || 1;
			progress.value = task.done || 0;
			state.append(progress);
			src.title = task.source;
			dst.title = task.saved?.join("\n") || task.destination;
			if (!["complete", "cancelled"].includes(task.status)) {
				const toggle = el(
						"button",
						["paused", "error"].includes(task.status) ? t("继续", "Resume") : t("暂停", "Pause"),
					),
					cancel = el("button", t("取消", "Cancel"));
				toggle.onclick = () => {
					task.message = "";
					task.status = ["paused", "error"].includes(task.status) ? "queued" : "paused";
					renderTasks();
					void pump();
				};
				cancel.onclick = () => {
					task.status = "cancelled";
					task.message = "";
					if (!task.active) void cleanup(task);
					renderTasks();
				};
				actions.append(toggle, cancel);
			}
			actioncell.append(actions);
			row.append(title, state, el("td", size(task.total || 0)), src, dst, actioncell);
			qbody.append(row);
		}
	}
	async function cleanup(task: any) {
		if (task.job) await task.to.request("jobs/" + task.job.id, "DELETE").catch(() => {});
		if (task.export) await task.from.request("exports/" + task.export.id, "DELETE").catch(() => {});
	}
	async function enqueue(from: any) {
		const to = sides[1 - from.index];
		if (!to.info || !to.path) {
			report(t("请先选择接收目录。", "Choose a destination folder first."), true);
			return;
		}
		const selected = from.entries.filter((i: any) => from.selected.has(i.path));
		if (!selected.length) return;
		if (from.index === 0 && to.info.readOnly) {
			report(t("只读模式不能发送文件，请先切换到可控制模式。", "Sending files requires control mode."), true);
			return;
		}
		if (from.index === 1 && browser && !browser.writable) {
			try {
				for (const item of selected) {
					await from.request("download", "POST", { path: item.path });
					tasks.push({
						name: item.name,
						from,
						to,
						source: item.path,
						destination: t("浏览器下载位置", "Browser download location"),
						total: item.size,
						done: 0,
						status: "complete",
						message: t(
							"已交给浏览器下载，请在浏览器查看进度",
							"Download handed to browser; check its download progress",
						),
					});
				}
				report(
					t(
						"保存位置由浏览器下载设置决定；如需直接选择目录，请先点击“选择本机目录”，或从本机 pi-web-ui 打开。",
						"Your browser chooses the download location. To choose a destination here, grant a local folder or open this from your local pi-web-ui.",
					),
				);
				renderTasks();
			} catch (error: any) {
				report(error.message, true);
			}
			return;
		}
		const task: any = {
			key: random(),
			name: selected.length === 1 ? selected[0].name : `${selected.length} ${t("项", "items")}`,
			from,
			to,
			paths: selected.map((i: any) => i.path),
			source: from.path,
			destination: to.path,
			status: "queued",
			done: 0,
			total: selected.reduce((s: number, i: any) => s + (i.directory ? 0 : i.size), 0),
		};
		tasks.push(task);
		report(help);
		renderTasks();
		void pump();
	}
	async function retry(work: () => Promise<any>) {
		let error: any;
		for (let n = 0; n < 3; n++) {
			try {
				return await work();
			} catch (e) {
				error = e;
				if (disposed) break;
				await new Promise((r) => win.setTimeout(r, 300 * (n + 1)));
			}
		}
		throw error;
	}
	async function pump() {
		if (running || disposed) return;
		running = true;
		try {
			for (;;) {
				const task = tasks.find((t) => t.status === "queued");
				if (!task || disposed) break;
				task.active = true;
				task.status = "running";
				renderTasks();
				try {
					if (!task.export) task.export = await task.from.request("exports", "POST", { paths: task.paths });
					const manifest = task.export.entries;
					if (!Array.isArray(manifest) || manifest.length > 10000)
						throw new Error(t("无效文件清单", "Invalid file list"));
					task.total = manifest.reduce((n: number, e: any) => n + e.size, 0);
					if (!Number.isSafeInteger(task.total) || task.total < 0 || task.total > 16 * 1024 ** 3)
						throw new Error(t("单次传输最多 16 GB", "Transfer limit: 16 GiB"));
					task.job = await retry(() =>
						task.to.request("jobs", "POST", { key: task.key, entries: manifest, destination: task.destination }),
					);
					task.done = task.job.entries.reduce((n: number, e: any) => n + e.offset, 0);
					for (let i = 0; i < manifest.length; i++) {
						const entry = manifest[i],
							state = task.job.entries[i];
						while (state.offset < entry.size) {
							if (task.status !== "running" || disposed) break;
							const chunk = await retry(() =>
								task.from.request(`exports/${task.export.id}/chunk?entry=${i}&offset=${state.offset}`),
							);
							if (typeof chunk.data !== "string" || chunk.data.length > 1398104) throw new Error("Invalid file chunk");
							const bytes = Uint8Array.from(win.atob(chunk.data), (c: any) => c.charCodeAt(0));
							if (bytes.length !== chunk.length || options.crc(bytes) !== chunk.crc)
								throw new Error(t("文件校验失败", "File checksum mismatch"));
							const expected = options.crc(bytes, state.crc);
							const ack = await retry(() =>
								task.to.request(`jobs/${task.job.id}/chunk?entry=${i}&offset=${state.offset}&crc=${chunk.crc}`, "PUT", {
									data: chunk.data,
								}),
							);
							if (ack.offset !== state.offset + bytes.length || ack.crc !== expected)
								throw new Error(t("文件校验失败", "File checksum mismatch"));
							task.done += bytes.length;
							state.offset = ack.offset;
							state.crc = ack.crc;
							task.message = `${t("正在传输", "Transferring")} ${task.total ? Math.round((task.done / task.total) * 100) : 100}%`;
							renderTasks();
						}
						if (task.status !== "running" || disposed) break;
					}
					if (task.status === "running" && !disposed) {
						const result = await retry(() =>
							task.to.request(`jobs/${task.job.id}/finish`, "POST", {
								checksums: task.job.entries.map((e: any) => e.crc),
							}),
						);
						task.saved = result.saved;
						task.status = "complete";
						task.message = t("已完成 · 文件已校验", "Completed · verified");
						await cleanup(task);
						if (task.to.path === task.destination) await task.to.load(task.destination, false);
					}
				} catch (error: any) {
					if (task.status !== "cancelled") {
						task.status = "error";
						task.message = error.message;
						report(error.message, true);
					}
				} finally {
					task.active = false;
					if (task.status === "cancelled" || disposed) await cleanup(task);
					if (task.status === "paused") task.message = "";
					renderTasks();
				}
			}
		} finally {
			running = false;
		}
	}
	for (const [label, action] of [
		[
			t("全部继续", "Resume all"),
			() => {
				for (const task of tasks)
					if (["paused", "error"].includes(task.status)) {
						task.status = "queued";
						task.message = "";
					}
				void pump();
			},
		],
		[
			t("全部暂停", "Pause all"),
			() => {
				for (const task of tasks) if (["queued", "running"].includes(task.status)) task.status = "paused";
			},
		],
		[
			t("清除已完成", "Clear finished"),
			() => {
				for (let i = tasks.length - 1; i >= 0; i--)
					if (["complete", "cancelled"].includes(tasks[i].status)) tasks.splice(i, 1);
			},
		],
	] as const) {
		const button = el("button", label);
		button.onclick = () => {
			action();
			renderTasks();
		};
		qactions.append(button);
	}
	renderTasks();
	return {
		async open() {
			if (disposed) return;
			if (!dialog.open) dialog.showModal();
			if (!initialized) {
				initialized = true;
				await Promise.all(
					sides.map(async (p) => {
						try {
							await p.init();
						} catch (error: any) {
							initialized = false;
							report(error.message, true);
						}
					}),
				);
			} else {
				try {
					sides[1].info = await options.remote("info");
					for (const side of sides) side.update();
				} catch (error: any) {
					report(error.message, true);
				}
			}
		},
		close() {
			disposed = true;
			for (const task of tasks) {
				if (!["complete", "cancelled"].includes(task.status)) {
					task.status = "cancelled";
					if (!task.active) void cleanup(task);
				}
			}
			browser?.close();
			dialog.remove();
			style.remove();
		},
	};
}
