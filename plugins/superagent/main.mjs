import { esc } from "../plugin-sdk/client-utils.mjs";

const appRoot = new URL("../../../", import.meta.url);
const appUrl = (path) => new URL(path.replace(/^\//, ""), appRoot).href;
const api = async (path, body, method = "POST") => {
	const response = await fetch(appUrl(`plugins-api/superagent${path}`), {
		credentials: "same-origin",
		...(body === undefined
			? {}
			: { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
	return data;
};
const secretLabels = {
	githubSecret: "Webhook Secret",
	githubToken: "GitHub API Token",
	feishuVerificationToken: "Verification Token",
	feishuEncryptKey: "签名 Encrypt Key",
	feishuAppSecret: "App Secret",
};
const lines = (value) =>
	value
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
const statusLabels = {
	open: "待处理",
	running: "执行中",
	waiting: "等待",
	blocked: "已暂停",
	completed: "已完成",
	cancelled: "已取消",
};

export default {
	mount(container) {
		let disposed = false;
		let selected;
		let workItems = [];
		container.innerHTML = `<link rel="stylesheet" href="${esc(appUrl("plugins-api/superagent/assets/style.css"))}">
		<div class="superagent-root">
			<header><div><h2>外部渠道与工单</h2><p>渠道接入 → 群组独立 AI Router → Bot 执行 → 原渠道回写</p></div><button data-action="refresh">刷新</button></header>
			<p class="sa-notice">默认仅观察。自动执行及外发需要明确启用 auto、房间映射和作者白名单；也可对单个工单人工授权。</p>
			<p role="status" class="sa-status">正在加载…</p>
			<div class="sa-layout"><section class="sa-settings"><h3>渠道配置</h3><form></form></section>
			<section class="sa-work"><div class="sa-toolbar"><h3>工单</h3><button data-action="deliver">重试到期回写</button></div><div class="sa-items"></div><article class="sa-detail"><p>选择工单查看详情。</p></article></section></div>
		</div>`;
		const root = container.querySelector(".superagent-root");
		const status = root.querySelector(".sa-status");
		const form = root.querySelector("form");
		const notify = (message, error = false) => {
			if (!disposed) {
				status.textContent = message;
				status.classList.toggle("sa-error", error);
			}
		};
		const showSecrets = (keys, state) =>
			keys
				.map(
					(key) =>
						`<label>${esc(secretLabels[key])}<small>${state[key] ? "已保存；不会显示原值" : "尚未配置"}</small><select name="${key}-action" aria-label="${esc(secretLabels[key])}操作"><option value="keep">保留</option><option value="set">替换</option><option value="clear">清空</option></select><input type="password" autocomplete="new-password" name="${key}" placeholder="选择替换后输入新值" disabled></label>`,
				)
				.join("");
		function renderConfig(saved, rooms) {
			form.innerHTML =
				["github", "feishu"]
					.map((provider) => {
						const cfg = saved.config[provider];
						return `<fieldset><legend>${provider === "github" ? "GitHub" : "飞书"}</legend>
				<label>模式<select name="${provider}-mode"><option value="observe"${cfg.mode === "observe" ? " selected" : ""}>observe · 仅观察</option><option value="auto"${cfg.mode === "auto" ? " selected" : ""}>auto · 允许名单内作者触发</option></select></label>
				${provider === "feishu" ? `<label>App ID<input name="feishu-appId" value="${esc(cfg.appId)}"></label>` : ""}
				<label>允许作者（${provider === "github" ? "GitHub 数字用户 ID" : "飞书 open_id"}，每行一个）<textarea name="${provider}-authors" rows="3">${esc(cfg.allowedAuthors.join("\n"))}</textarea></label>
				${provider === "github" ? `<label>允许仓库（owner/repo，每行一个）<textarea name="github-repos" rows="3">${esc(cfg.allowedRepos.join("\n"))}</textarea></label>` : ""}
				<label>房间映射（每行 ${provider === "github" ? "owner/repo" : "chat_id"}=roomId）<textarea name="${provider}-mappings" rows="3" spellcheck="false">${esc(cfg.mappings.map((m) => `${m.channelId}=${m.roomId}`).join("\n"))}</textarea></label>
				${showSecrets(provider === "github" ? ["githubSecret", "githubToken"] : ["feishuVerificationToken", "feishuEncryptKey", "feishuAppSecret"], saved.secrets)}
				<p class="sa-endpoint">Webhook：<code>${esc(appUrl(`api/superagent/webhooks/${provider}`))}</code></p>
				${provider === "feishu" ? "<p>支持带签名的文本消息事件及 AES 加密回调。先验证原始请求签名，再解密并校验 Token；Token 和 Encrypt Key 均必填。飞书发送结果不确定超过 45 分钟时需人工核对，不再自动发送。</p>" : ""}</fieldset>`;
					})
					.join("") +
				`<details><summary>可用房间 ID</summary><ul>${rooms.map((room) => `<li>${esc(room.name ?? room.title ?? room.id)}：<code>${esc(room.id)}</code></li>`).join("") || "<li>暂无房间，请先创建群组。</li>"}</ul></details><button type="submit" class="sa-primary">保存配置</button>`;
		}
		function renderItems() {
			root.querySelector(".sa-items").innerHTML = workItems.length
				? workItems
						.map(
							(item) =>
								`<button class="sa-item${selected === item.id ? " sa-selected" : ""}" data-id="${esc(item.id)}"><strong>${esc(item.title || item.id)}</strong><span>${esc(item.provider)} · ${esc(item.channelId)} ${esc(item.threadId)}</span><span>${esc(statusLabels[item.status] ?? item.status)} · ${item.authorized ? "已授权" : "仅观察"}</span></button>`,
						)
						.join("")
				: "<p>暂无工单。请配置渠道、房间映射并接收首个事件。</p>";
		}
		async function detail(id) {
			const { item } = await api(`/item?id=${encodeURIComponent(id)}`);
			if (disposed || selected !== id) return;
			const target = root.querySelector(".sa-detail");
			target.innerHTML = `<h3>${esc(item.title || item.id)}</h3><p>${esc(item.provider)} · ${esc(item.channelId)} ${esc(item.threadId)} · 作者 ${esc(item.authorId)}</p><p>状态：${esc(statusLabels[item.status] ?? item.status)} · ${item.authorized ? "已授权执行和回写" : "观察中"}</p><div class="sa-toolbar">${[
				["pause", "暂停"],
				["resume", "恢复"],
				["complete", "完成"],
				[item.authorized ? "observe" : "authorize", item.authorized ? "撤销授权" : "人工授权执行及回写"],
				...(item.authorized && item.pendingAuthorization ? [["authorize", "授权最新事件"]] : []),
			]
				.map(([action, label]) => `<button data-item-action="${action}">${label}</button>`)
				.join("")}</div><h4>工单记录</h4><pre></pre>`;
			target.querySelector("pre").textContent = JSON.stringify(item, null, 2);
		}
		async function refreshItems() {
			const data = await api("/items");
			if (disposed) return;
			workItems = data.items;
			renderItems();
			if (selected) await detail(selected);
		}
		async function load() {
			try {
				const [saved, roomData] = await Promise.all([api("/config"), api("/rooms")]);
				if (disposed) return;
				renderConfig(saved, roomData.rooms);
				await refreshItems();
				notify("配置已加载。密钥输入框留空并选择“保留”可保留现有值；清空必须显式选择。");
			} catch (error) {
				notify(error.message, true);
			}
		}
		const onChange = (event) => {
			if (event.target.name?.endsWith("-action")) {
				const key = event.target.name.slice(0, -7);
				const input = form.elements.namedItem(key);
				input.disabled = event.target.value !== "set";
				input.required = event.target.value === "set";
				if (input.disabled) input.value = "";
			}
		};
		const onSubmit = async (event) => {
			event.preventDefault();
			const data = new FormData(form);
			try {
				const config = {};
				for (const provider of ["github", "feishu"]) {
					config[provider] = {
						mode: data.get(`${provider}-mode`),
						allowedAuthors: lines(data.get(`${provider}-authors`)),
						mappings: String(data.get(`${provider}-mappings`))
							.split("\n")
							.map((s) => s.trim())
							.filter(Boolean)
							.map((row) => {
								const parts = row.split("=");
								if (parts.length !== 2) throw new Error("映射格式应为 channelId=roomId，每行一条。");
								return { channelId: parts[0].trim(), roomId: parts[1].trim() };
							}),
					};
				}
				config.github.allowedRepos = lines(data.get("github-repos"));
				config.feishu.appId = data.get("feishu-appId");
				const secrets = Object.fromEntries(
					Object.keys(secretLabels).map((key) => [
						key,
						{
							action: data.get(`${key}-action`),
							...(data.get(`${key}-action`) === "set" ? { value: data.get(key) } : {}),
						},
					]),
				);
				await api("/config", { config, secrets }, "PUT");
				await load();
				notify("配置已保存。");
			} catch (error) {
				notify(error.message, true);
			}
		};
		const onClick = async (event) => {
			const button = event.target.closest("button");
			if (!button || (button.form === form && button.type === "submit")) return;
			try {
				button.disabled = true;
				if (button.dataset.action === "refresh") {
					await refreshItems();
					notify("工单已刷新。");
				}
				if (button.dataset.action === "deliver") {
					const result = await api("/deliver", {});
					notify(`本轮回写成功 ${result.delivered}，失败 ${result.failed}。宿主持久队列按退避时间自动重试。`);
				}
				if (button.dataset.id) {
					selected = button.dataset.id;
					renderItems();
					await detail(selected);
				}
				if (button.dataset.itemAction && selected) {
					await api("/items/update", { id: selected, action: button.dataset.itemAction });
					await refreshItems();
					notify("工单已更新。");
				}
			} catch (error) {
				notify(error.message, true);
			} finally {
				button.disabled = false;
			}
		};
		root.addEventListener("click", onClick);
		form.addEventListener("submit", onSubmit);
		form.addEventListener("change", onChange);
		load();
		return () => {
			disposed = true;
			root.removeEventListener("click", onClick);
			form.removeEventListener("submit", onSubmit);
			form.removeEventListener("change", onChange);
			container.replaceChildren();
		};
	},
};
