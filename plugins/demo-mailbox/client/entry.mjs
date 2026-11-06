import { esc } from "@pi-web-ui/plugin-sdk/client";

let uid = 0;

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="mbx">
	<style>
		.mbx { max-width: 760px; margin: 0 auto; font-size: 13px; }
		.mbx h2 { margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
		.mbx .hint { opacity: .6; margin: 0 0 12px; }
		.mbx ul { list-style: none; padding: 0; display: grid; gap: 8px; }
		.mbx li { border: 1px solid var(--border, #333); border-radius: 8px; padding: 10px 12px; }
		.mbx .meta { display: flex; gap: 10px; opacity: .65; font-size: 12px; margin-bottom: 4px; }
		.mbx form { display: grid; grid-template-columns: 1fr 2fr auto; gap: 8px; margin: 14px 0; }
		.mbx input, .mbx textarea {
			background: var(--bg-elev, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px; padding: 6px 8px;
			font: inherit; resize: vertical;
		}
		.mbx button {
			background: var(--accent, #7c5cff); color: var(--accent-contrast, #fff); border: 0;
			border-radius: 6px; padding: 6px 14px; cursor: pointer; font: inherit;
		}
		/* 手机竖屏：表单单列（textarea 本来就占 1/-1），大字号防 iOS 聚焦缩放，按钮全宽高点击区 */
		@media (max-width: 640px) {
			.mbx form { grid-template-columns: 1fr; }
			.mbx input, .mbx textarea { font-size: 16px; }
			.mbx button { min-height: 40px; width: 100%; }
		}
	</style>
	<h2>📬 邮箱 <small style="opacity:.5;font-weight:normal">插件视图示例</small></h2>
	<p class="hint">来自 &lt;dataDir&gt;/plugins/demo-mailbox/ — 删除该目录并刷新即卸载。</p>
	<ul></ul>
	<form>
		<input name="to" placeholder="收件人" required />
		<input name="subject" placeholder="主题" />
		<button type="submit">发送</button>
		<textarea name="body" rows="3" placeholder="正文…" style="grid-column:1/-1"></textarea>
	</form>
</div>`;

		const root = container.querySelector(".mbx");
		const listEl = root.querySelector("ul");
		const form = root.querySelector("form");

		function render(mails) {
			listEl.innerHTML = (mails ?? [])
				.map(
					(m) => `
<li>
	<div class="meta">
		<b>${esc(m.outgoing ? `发往 ${m.to}` : m.from)}</b>
		<span>${esc(new Date(m.date).toLocaleString())}</span>
	</div>
	<div><b>${esc(m.subject)}</b></div>
	<div style="white-space:pre-wrap;margin-top:4px">${esc(m.body)}</div>
</li>`,
				)
				.join("");
		}

		form.addEventListener("submit", (e) => {
			e.preventDefault();
			const fd = new FormData(form);
			ctx.send({
				action: "send",
				to: fd.get("to"),
				subject: fd.get("subject"),
				body: fd.get("body"),
			});
			form.reset();
		});

		const off = ctx.onData((payload) => {
			if (payload && Array.isArray(payload.mails)) render(payload.mails);
		});
		ctx.send({ action: "list" });

		return () => {
			off();
			root.remove();
		};
	},
};
