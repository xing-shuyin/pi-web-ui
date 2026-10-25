/**
 * office 客户端入口 —— 接管 .pptx / .docx / .xlsx 文件的 1:1 Canvas 真实渲染与双向编辑。
 */
import { esc, apiBase as getSharedApiBase } from "@pi-web-ui/plugin-sdk/client";

function apiBase() {
	return getSharedApiBase("office");
}

function resolveApi(ctx, path, params) {
	if (typeof ctx?.apiUrl === "function") {
		return ctx.apiUrl(path, params);
	}
	const suffix = String(path ?? "").startsWith("/") ? String(path) : `/${String(path ?? "")}`;
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined) query.set(key, String(value));
	}
	const qs = query.toString();
	return `${apiBase()}${suffix}${qs ? `?${qs}` : ""}`;
}

export const fileHandlers = [
	{
		id: "office",
		mount(container, file, ctx) {
			container.style.cssText =
				"width: 100%; height: 100%; position: relative; display: flex; flex-direction: column; overflow: hidden; background: #16181f; color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;";

			const topBar = document.createElement("div");
			topBar.style.cssText =
				"height: 38px; min-height: 38px; display: flex; align-items: center; justify-content: space-between; padding: 0 14px; background: #1e222d; border-bottom: 1px solid #2d3343; font-size: 13px; z-index: 20;";
			topBar.innerHTML = `
				<div style="display: flex; align-items: center; gap: 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">
					<span style="font-size: 15px;">📑</span>
					<span style="font-weight: 600; color: #f8fafc;">${esc(file.name)}</span>
					<span style="font-size: 11px; opacity: 0.6; margin-left: 4px;">Univer 1:1 Canvas</span>
				</div>
				<div style="display: flex; align-items: center; gap: 8px;">
					<span data-el="save-hint" style="font-size: 12px; color: #10b981; display: none;">✓ 已保存到磁盘</span>
					<button data-act="save" type="button" style="display: inline-flex; align-items: center; gap: 5px; background: #3b82f6; color: #fff; border: none; border-radius: 5px; padding: 4px 12px; font-size: 12px; font-weight: 500; cursor: pointer; transition: opacity .15s;">
						<span>💾 保存</span>
						<span style="opacity: 0.75; font-size: 10.5px;">(Ctrl+S)</span>
					</button>
				</div>
			`;
			container.appendChild(topBar);

			const mainWrap = document.createElement("div");
			mainWrap.style.cssText = "flex: 1; width: 100%; position: relative; overflow: hidden;";
			container.appendChild(mainWrap);

			const loading = document.createElement("div");
			loading.style.cssText =
				"position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #16181f; color: #fff; z-index: 10;";
			loading.innerHTML = `
				<div style="text-align: center;">
					<div style="font-size: 36px; margin-bottom: 12px; display: inline-block;">📑</div>
					<div style="font-size: 15px; font-weight: 600; margin-bottom: 6px; color: #f1f5f9;">正在检测并拉起 Univer 原生渲染…</div>
					<div style="font-size: 12px; color: #94a3b8;">矢量形状 · 母版主题 · 精确排版 · 双向编辑</div>
				</div>
			`;
			mainWrap.appendChild(loading);

			let disposed = false;
			let iframe = null;

			// 检查运行时就绪状态
			function checkAndLoad() {
				fetch(resolveApi(ctx, "/status"))
					.then((r) => r.json())
					.then((st) => {
						if (disposed) return;
						if (st.ready) {
							loadDoc();
						} else if (st.hasArtifacts) {
							// 本地已有包，正启动中，稍等后重试
							setTimeout(checkAndLoad, 500);
						} else {
							// 缺少运行时，展示按需下载引导
							renderProvisionPrompt();
						}
					})
					.catch(() => {
						if (disposed) return;
						loadDoc();
					});
			}

			function renderProvisionPrompt() {
				loading.innerHTML = `
					<div style="text-align: center; max-width: 480px; padding: 32px 24px; background: #1e222d; border: 1px solid #333a4d; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.4);">
						<div style="font-size: 42px; margin-bottom: 14px;">📑</div>
						<div style="font-size: 16px; font-weight: 600; margin-bottom: 8px; color: #f8fafc;">需要就绪 Univer 高保真运行时</div>
						<div style="font-size: 12.5px; color: #94a3b8; line-height: 1.6; margin-bottom: 20px;">
							Univer 原生 Canvas 渲染与 1:1 双向编辑需要一次性下载独立运行时组件（压缩包约 34MB，不占用 npm 发布体积）。安装完成后永久本地离线运行。
						</div>
						<div data-el="prog-wrap" style="display: none; margin-bottom: 18px;">
							<div style="height: 6px; background: #333a4d; border-radius: 3px; overflow: hidden; margin-bottom: 6px;">
								<div data-el="prog-bar" style="width: 0%; height: 100%; background: #3b82f6; transition: width .2s ease;"></div>
							</div>
							<div data-el="prog-text" style="font-size: 11.5px; color: #94a3b8;">正在下载运行时组件…</div>
						</div>
						<button data-act="start-download" type="button" style="background: #3b82f6; color: #fff; border: none; border-radius: 6px; padding: 8px 20px; font-size: 13.5px; font-weight: 600; cursor: pointer; transition: background .15s;">
							⚡ 一键自动下载并激活 (~34MB)
						</button>
					</div>
				`;

				const btn = loading.querySelector("[data-act='start-download']");
				const progWrap = loading.querySelector("[data-el='prog-wrap']");
				const progBar = loading.querySelector("[data-el='prog-bar']");
				const progText = loading.querySelector("[data-el='prog-text']");

				btn.onclick = () => {
					btn.style.display = "none";
					progWrap.style.display = "block";

					fetch(resolveApi(ctx, "/provision-runtime"), { method: "POST" })
						.then((r) => r.json())
						.then(() => {
							pollDownload();
						})
						.catch((err) => {
							progText.textContent = "下载失败: " + err.message;
							progText.style.color = "#ef4444";
							btn.style.display = "inline-block";
						});

					function pollDownload() {
						fetch(resolveApi(ctx, "/status"))
							.then((r) => r.json())
							.then((s) => {
								if (disposed) return;
								if (s.ready) {
									progText.textContent = "✓ 运行时就绪，正在打开文档…";
									setTimeout(loadDoc, 400);
								} else if (s.error) {
									progText.textContent = "安装失败: " + s.error;
									progText.style.color = "#ef4444";
									btn.style.display = "inline-block";
								} else {
									const p = s.progress || 0;
									progBar.style.width = p + "%";
									progText.textContent = `正在下载运行时: ${p}% (${Math.round((s.downloaded || 0) / 1024 / 1024)}MB / ${Math.round((s.total || 0) / 1024 / 1024)}MB)`;
									setTimeout(pollDownload, 500);
								}
							})
							.catch(() => setTimeout(pollDownload, 1000));
					}
				};
			}

			function loadDoc() {
				fetch(resolveApi(ctx, "/open", { path: file.path }))
					.then((r) => r.json())
					.then((data) => {
						if (disposed) return;
						if (!data.ok) throw new Error(data.error || "无法加载文档");

						iframe = document.createElement("iframe");
						iframe.src = data.viewerUrl;
						iframe.style.cssText = "width: 100%; height: 100%; border: none; flex: 1; background: #fff;";
						iframe.allow = "fullscreen";
						iframe.onload = () => {
							loading.remove();
						};
						mainWrap.appendChild(iframe);
					})
					.catch((err) => {
						if (disposed) return;
						loading.innerHTML = `
							<div style="text-align: center; color: #ef4444; padding: 24px;">
								<div style="font-size: 36px; margin-bottom: 12px;">⚠️</div>
								<div style="font-size: 15px; font-weight: 600; margin-bottom: 6px;">Univer 原生画布渲染启动失败</div>
								<div style="font-size: 12px; opacity: 0.85; max-width: 450px; word-break: break-all; margin: 0 auto; line-height: 1.5;">${esc(err.message)}</div>
							</div>
						`;
					});
			}

			// 保存逻辑
			const saveBtn = topBar.querySelector("[data-act='save']");
			const saveHint = topBar.querySelector("[data-el='save-hint']");
			let saving = false;

			function doSave() {
				if (saving) return;
				saving = true;
				saveBtn.textContent = "⏳ 保存中…";
				saveBtn.style.opacity = "0.7";

				fetch(resolveApi(ctx, "/save"), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: file.path }),
				})
					.then((r) => r.json())
					.then((res) => {
						saving = false;
						saveBtn.innerHTML = `<span>💾 保存</span><span style="opacity: 0.75; font-size: 10.5px;">(Ctrl+S)</span>`;
						saveBtn.style.opacity = "1";
						if (res.ok) {
							saveHint.textContent = `✓ 已保存 (${res.size} B)`;
							saveHint.style.display = "inline";
							setTimeout(() => {
								saveHint.style.display = "none";
							}, 3000);
						} else {
							alert("保存失败: " + (res.error || "未知原因"));
						}
					})
					.catch((err) => {
						saving = false;
						saveBtn.innerHTML = `<span>💾 保存</span><span style="opacity: 0.75; font-size: 10.5px;">(Ctrl+S)</span>`;
						saveBtn.style.opacity = "1";
						alert("保存请求失败: " + (err.message || String(err)));
					});
			}

			saveBtn.onclick = () => doSave();

			const onKeyDown = (e) => {
				if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
					e.preventDefault();
					doSave();
				}
			};
			window.addEventListener("keydown", onKeyDown);

			checkAndLoad();

			return () => {
				disposed = true;
				window.removeEventListener("keydown", onKeyDown);
				container.innerHTML = "";
			};
		},
	},
];

export default {
	fileHandlers,
	mount(container, ctx) {
		container.innerHTML = `
<div class="uop" style="max-width: 900px; margin: 0 auto; padding: 20px 16px; font-family: sans-serif; color: var(--text, #fff);">
	<style>
		.uop .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; border-bottom: 1px solid var(--border, #333); padding-bottom: 12px; }
		.uop .head h2 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
		.uop .file-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
		.uop .file-card { padding: 12px 14px; border: 1px solid var(--border, #333); border-radius: 8px; background: var(--bg-elev, #1a1d26); cursor: pointer; transition: all .15s ease; text-align: left; color: inherit; font: inherit; }
		.uop .file-card:hover { border-color: var(--accent, #7c5cff); background: var(--bg-elev2, #232734); }
		.uop .file-name { font-weight: 600; font-size: 13px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.uop .file-meta { font-size: 11.5px; opacity: 0.65; }
	</style>
	<div class="head">
		<h2>📑 office</h2>
		<button data-act="refresh" style="background: none; border: 1px solid var(--border, #333); color: inherit; border-radius: 6px; padding: 4px 10px; cursor: pointer;">↻ 刷新</button>
	</div>
	<div data-body class="file-list"><div style="opacity: 0.6; padding: 20px;">正在扫描工作区中的 Office 文档…</div></div>
</div>`;

		const bodyEl = container.querySelector("[data-body]");
		const refreshBtn = container.querySelector("[data-act='refresh']");

		function loadList() {
			bodyEl.innerHTML = `<div style="opacity: 0.6; padding: 20px;">正在扫描工作区中的 Office 文档…</div>`;
			fetch(resolveApi(ctx, "/list"))
				.then((r) => r.json())
				.then((data) => {
					if (!data.files || data.files.length === 0) {
						bodyEl.innerHTML = `<div style="opacity: 0.6; padding: 20px;">工作区暂无 .pptx / .docx / .xlsx 文档</div>`;
						return;
					}
					bodyEl.innerHTML = "";
					for (const f of data.files) {
						const ext = f.split(".").pop()?.toLowerCase();
						const icon = ext.startsWith("ppt") ? "📊" : ext.startsWith("xls") ? "📈" : "📝";
						const card = document.createElement("button");
						card.className = "file-card";
						card.innerHTML = `
							<div class="file-name">${icon} ${esc(f)}</div>
							<div class="file-meta">点击直接在 Univer 原生画布中打开</div>
						`;
						card.onclick = () => {
							const host = window.__piWebUiHost;
							if (host?.openFile) {
								host.openFile(f);
							}
						};
						bodyEl.appendChild(card);
					}
				})
				.catch((err) => {
					bodyEl.innerHTML = `<div style="color: var(--red, #ef4444); padding: 20px;">加载列表失败: ${esc(err.message)}</div>`;
				});
		}

		refreshBtn.onclick = () => loadList();
		loadList();

		return () => {
			container.innerHTML = "";
		};
	},
};
