const mails = [
	{
		id: 1,
		from: "alice@example.com",
		subject: "欢迎使用 pi-web-ui 插件",
		date: new Date().toISOString(),
		body:
			"这是一个由插件提供的界面组件：目录放在 <dataDir>/plugins/demo-mailbox/，" +
			"删掉目录即卸载。服务端入口（本文件）可以访问 Node 全部能力。",
	},
	{
		id: 2,
		from: "bob@example.com",
		subject: "试试发一封",
		date: new Date(Date.now() - 3600_000).toISOString(),
		body: "在下方表单里填收件人和正文，点发送——消息经 WebSocket 到达本文件，再广播回所有打开的页面。",
	},
];
let nextId = 3;

export default {
	activate(host) {
		const off = host.onMessage((payload) => {
			const msg = payload ?? {};
			switch (msg.action) {
				case "list":
					host.broadcast({ mails });
					break;
				case "notify":
					host.notify("info", String(msg.text ?? "插件通知测试"));
					break;
				case "send": {
					const mail = {
						id: nextId++,
						from: "me@local",
						to: String(msg.to ?? ""),
						subject: String(msg.subject ?? "(无主题)"),
						date: new Date().toISOString(),
						body: String(msg.body ?? ""),
						outgoing: true,
					};
					mails.unshift(mail);
					host.log("sent:", mail.to, mail.subject);
					host.broadcast({ mails });
					break;
				}
				default:
					host.log("unknown action:", msg.action);
			}
		});
		host.log("activated; mails in memory:", mails.length);

		return () => {
			off();
			host.log("deactivated");
		};
	},
};
