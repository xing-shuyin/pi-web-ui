import { createHash } from "node:crypto";

export class SessionRoutes {
	constructor(bridge) {
		this.bridge = bridge;
		this.routes = new Map();
		this.completed = new Set();
	}
	account() {
		const cfg = this.bridge.getConfig();
		return createHash("sha256")
			.update(JSON.stringify([cfg.botToken || "", cfg.apiBase || "https://api.telegram.org"]))
			.digest("hex");
	}
	key(identity) {
		return identity.sessionId
			? `session:${identity.sessionId}`
			: identity.clientId && identity.conversationId
				? `owner:${JSON.stringify([identity.clientId, identity.conversationId])}`
				: "";
	}
	async ready() {
		if (!this.loading)
			this.loading = (async () => {
				const saved = await this.bridge.host.storage?.get("sessionRoutes");
				this.accountId = this.account();
				if (saved?.account !== this.accountId) {
					if (saved) await this.save();
					return;
				}
				this.routes = new Map(saved.routes || []);
				this.bridge.peerEpochs = new Map(saved.epochs || []);
				this.bridge.userConversations = new Map(saved.conversations || []);
			})();
		await this.loading;
		const account = this.account();
		if (account !== this.accountId) {
			this.accountId = account;
			for (const controller of this.bridge.peerCancels?.values() || []) controller.abort();
			this.bridge.peerCancels?.clear();
			this.bridge.pendingRuns.clear();
			this.bridge.userConversations.clear();
			this.routes.clear();
			await this.save();
		}
	}
	valid(route) {
		return (
			route &&
			!route.ambiguous &&
			route.account === this.account() &&
			route.epoch === (this.bridge.peerEpochs.get(route.peer) || 0)
		);
	}
	bind(identity, peer, msg) {
		const key = this.key(identity);
		if (!key) return;
		const old = this.routes.get(key);
		const route =
			old?.ambiguous || (this.valid(old) && old.peer !== peer)
				? { ambiguous: true }
				: {
						peer,
						msg: {
							chat: { id: msg.chat.id },
							from: { id: msg.from.id },
							message_thread_id: msg.message_thread_id,
							message_id: msg.message_id,
						},
						account: this.accountId,
						epoch: this.bridge.peerEpochs.get(peer) || 0,
					};
		this.routes.set(key, route);
		this.save();
		return route;
	}
	revoke(peer) {
		for (const [key, route] of this.routes) if (route.peer === peer) this.routes.delete(key);
		return this.save();
	}
	done(id) {
		if (id) this.completed.add(id);
		while (this.completed.size > 500) this.completed.delete(this.completed.values().next().value);
	}
	save() {
		while (this.routes.size > 200) this.routes.delete(this.routes.keys().next().value);
		const saved = structuredClone({
			account: this.accountId,
			routes: [...this.routes],
			epochs: [...this.bridge.peerEpochs],
			conversations: [...this.bridge.userConversations],
		});
		this.saving = (this.saving || Promise.resolve())
			.catch(() => {})
			.then(() => this.bridge.host.storage?.set("sessionRoutes", saved))
			.catch((err) => {
				this.bridge.status.lastError = `Session route save failed: ${err.message}`;
				this.bridge.log("warn", this.bridge.status.lastError);
			});
		return this.saving;
	}
}
