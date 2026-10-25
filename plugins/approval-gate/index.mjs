/**
 * approval-gate —— 服务端入口。
 * 职责：
 *  1. host.route 暴露 HTTP API（/plugins-api/approval-gate/...）给通用 CLI：
 *     GET  /list       全量列表
 *     POST /register   登记拍板项 {task,title,summary?,project?,conversationId?}（当日同 task+title 幂等去重）
 *     POST /update     局部回填 {id, conversationId?}（--auto-session 流程：先登记拿 id，建会话后回填）
 *     POST /resolve    标记 {id, status: resolved|dismissed}
 *  2. host.storage 持久化台账（宿主管，升级/重装不丢）
 *  3. broadcast 推送变更给所有打开拍板页的客户端
 */
import { definePlugin } from "./sdk/index.mjs";

const MAX_ITEMS = 200;
const KEEP_RESOLVED_MS = 7 * 24 * 3600 * 1000;

function load(host) {
	const items = host.storage.get("items");
	return Array.isArray(items) ? items : [];
}

function save(host, items) {
	host.storage.set("items", items.slice(0, MAX_ITEMS));
}

function prune(items, now = Date.now()) {
	return items.filter((it) => {
		if (it.status === "pending") return true;
		const t = Date.parse(it.resolvedAt || it.createdAt || "");
		return Number.isFinite(t) ? now - t < KEEP_RESOLVED_MS : true;
	});
}

/** 校验会话标识符格式及在宿主中的存在性。 */
async function validateConversationId(host, convId) {
	if (!convId) return true;
	const cid = String(convId).trim();
	if (!cid) return true;
	// 基础格式与路径穿越防范
	if (cid.length > 128 || /\.\./.test(cid) || !/^[a-zA-Z0-9_.:/\\-]+$/.test(cid)) {
		return false;
	}
	try {
		const active = host.conversations?.get?.(cid);
		if (active) return true;
		const list = await host.conversations?.list?.();
		if (Array.isArray(list) && list.length > 0) {
			const found = list.some((c) => {
				if (!c || !c.id) return false;
				const idStr = String(c.id);
				return idStr === cid || idStr.includes(cid) || cid.includes(idStr);
			});
			if (found) return true;
			return false;
		}
	} catch {
		// 宿主调用异常时宽容降级，避免阻塞合法流程
	}
	return true;
}

export default definePlugin({
	activate(host) {
		host.log("approval-gate activated v2-code-marker");
		const push = () => host.broadcast({ type: "approval:state", items: load(host) });

		// 视图内 RPC（ctx.send / onData）
		const offMsg = host.onClientMessage((msg, reply) => {
			if (!msg || typeof msg !== "object") return;
			if (msg.type === "approval:list") {
				reply({ ok: true, items: load(host) });
				return;
			}
			if (msg.type === "approval:resolve") {
				const items = load(host);
				const it = items.find((x) => x.id === msg.id);
				if (it) {
					it.status = msg.status === "dismissed" ? "dismissed" : "resolved";
					it.resolvedAt = new Date().toISOString();
					save(host, prune(items));
					push();
				}
				reply({ ok: true, items: load(host) });
			}
		});

		// HTTP API（CLI 用；PI_WEB_TOKEN 未设时本机免鉴权）
		const offList = host.route("GET", "/list", (_req, res) => {
			res.json({ ok: true, items: load(host) });
		});

		const offRegister = host.route("POST", "/register", async (req, res) => {
			const b = req.body ?? {};
			const task = String(b.task ?? "").trim();
			const title = String(b.title ?? "").trim();
			if (!task || !title) {
				res.status(400).json({ ok: false, error: "task 与 title 必填" });
				return;
			}
			const rawConvId = b.conversationId !== undefined ? String(b.conversationId).trim().slice(0, 128) : "";
			if (rawConvId) {
				const valid = await validateConversationId(host, rawConvId);
				if (!valid) {
					res.status(404).json({ ok: false, error: `未找到关联会话 ${rawConvId}` });
					return;
				}
			}
			const items = load(host);
			const today = new Date().toISOString().slice(0, 10);
			const dup = items.find(
				(x) =>
					x.task === task &&
					x.title === title &&
					x.status === "pending" &&
					String(x.createdAt || "").slice(0, 10) === today,
			);
			if (dup) {
				res.json({ ok: true, duplicate: true, item: dup });
				return;
			}
			const item = {
				id: `apv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
				task,
				title: title.slice(0, 200),
				summary: String(b.summary ?? "").slice(0, 500),
				project: String(b.project ?? "").slice(0, 300),
				conversationId: rawConvId,
				createdAt: new Date().toISOString(),
				status: "pending",
			};
			save(host, prune([item, ...items]));
			push();
			res.json({ ok: true, item });
		});

		const offUpdate = host.route("POST", "/update", async (req, res) => {
			const { id, conversationId } = req.body ?? {};
			const items = load(host);
			const it = items.find((x) => x.id === id);
			if (!it) {
				res.status(404).json({ ok: false, error: `未找到拍板项 ${id}` });
				return;
			}
			if (conversationId !== undefined) {
				const cid = String(conversationId).trim().slice(0, 128);
				if (cid) {
					const valid = await validateConversationId(host, cid);
					if (!valid) {
						res.status(404).json({ ok: false, error: `未找到关联会话 ${cid}` });
						return;
					}
					it.conversationId = cid;
				} else {
					it.conversationId = "";
				}
			}
			save(host, items);
			push();
			res.json({ ok: true, item: it });
		});

		const offResolve = host.route("POST", "/resolve", (req, res) => {
			const { id, status } = req.body ?? {};
			const items = load(host);
			const it = items.find((x) => x.id === id);
			if (!it) {
				res.status(404).json({ ok: false, error: `未找到拍板项 ${id}` });
				return;
			}
			it.status = status === "dismissed" ? "dismissed" : "resolved";
			it.resolvedAt = new Date().toISOString();
			save(host, prune(items));
			push();
			res.json({ ok: true, item: it });
		});

		return () => {
			offMsg();
			offList();
			offRegister();
			offUpdate();
			offResolve();
			host.log("approval-gate deactivated");
		};
	},
});
