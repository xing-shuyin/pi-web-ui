import { randomUUID } from "node:crypto";
import { saveTrustedHostKey } from "../../../plugin-sdk/ssh-host-trust.mjs";

export function createTrustChallenges({ save = saveTrustedHostKey, now = Date.now } = {}) {
	const pending = new Map();
	function prune() {
		for (const [id, item] of pending) if (item.expires <= now()) pending.delete(id);
	}
	return {
		capture(error, cwd) {
			if (!error?.hostTrust || !Buffer.isBuffer(error.hostKey)) return undefined;
			prune();
			if (pending.size >= 64) pending.delete(pending.keys().next().value);
			const token = randomUUID();
			pending.set(token, {
				challenge: error.hostTrust,
				key: Buffer.from(error.hostKey),
				cwd,
				expires: now() + 300_000,
			});
			return { ...error.hostTrust, token };
		},
		async accept(body, cwd) {
			prune();
			const item = pending.get(body?.token);
			if (!item || item.cwd !== cwd)
				throw new Error(
					"主机信任请求已过期或工作区已切换，请重新连接 / Trust request expired or workspace changed; reconnect.",
				);
			if (body.fingerprint !== item.challenge.fingerprint || body.confirmed !== true)
				throw new Error("请先核对并确认主机指纹 / Verify and confirm the host fingerprint first.");
			if (item.challenge.status === "revoked")
				throw new Error("主机密钥已撤销，不能通过插件信任 / Revoked host key cannot be trusted.");
			if (item.challenge.status === "changed" && body.replace !== true)
				throw new Error(
					"主机密钥已变更，需要明确确认替换 / Changed host key requires explicit replacement confirmation.",
				);
			const result = await save({ ...item.challenge, key: item.key, replace: body.replace === true });
			pending.delete(body.token);
			return result;
		},
	};
}
