import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
export const IMESSAGE_BOT_PREFIX = "🤖 PI\n";

export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function peerAccountId(senderId, prefix = "im") {
	const raw = String(senderId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

export function cleanIMessageText(textRaw = "") {
	let text = String(textRaw || "").trim();
	if (!text) return "";
	if (text.startsWith(IMESSAGE_BOT_PREFIX)) return "";
	return text.replace(/^@\S+\s+/g, "").trim();
}

export async function sendMacOSIMessage(address, text, { execFileImpl, file } = {}) {
	const chatId = typeof address === "object" ? String(address?.chatId || "").trim() : "";
	const safeAddress = chatId || String(address || "").trim();
	const safeText = String(text || "").trim();
	if (!safeAddress) throw new Error("iMessage recipient address is required.");
	if (!safeText && !file) throw new Error("Message text or file is required.");
	const filePath = file ? resolve(file) : "";
	if (filePath && !(await stat(filePath)).isFile()) throw new Error("Attachment must be a regular local file.");

	if (process.platform !== "darwin" && !execFileImpl) {
		throw new Error(`iMessage is only available on macOS (current platform: ${process.platform}).`);
	}

	const runExec = execFileImpl || execFileAsync;
	const script = `
		tell application "Messages"
			${chatId ? `set targetBuddy to chat id ${JSON.stringify(chatId)}` : `set targetService to 1st service whose service type = iMessage\nset targetBuddy to buddy ${JSON.stringify(safeAddress)} of targetService`}
			${safeText ? `send ${JSON.stringify(safeText)} to targetBuddy` : ""}
			${filePath ? `send (POSIX file ${JSON.stringify(filePath)}) to targetBuddy` : ""}
		end tell
	`;

	await runExec("/usr/bin/osascript", ["-e", script], { timeout: 15000 });
	return { success: true };
}

export { IMessageBotBridge } from "./bridge.mjs";
import { IMessageBotBridge } from "./bridge.mjs";

export function stripSecretsFromConfig(cfg) {
	return { ...(cfg || {}) };
}

export function mergeSavedSecrets(incoming, prev = {}) {
	return { ...(prev || {}), ...(incoming || {}) };
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	localConfig = mergeSavedSecrets(localConfig, {});

	const botBridge = new IMessageBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	await botBridge.restoreRoutes();

	if (localConfig.botEnabled) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `iMessage bot start note: ${err.message}`);
		});
	}

	host.registerTool?.({
		name: "imessage",
		description:
			"Send text or local image, audio, video and file attachments via macOS Messages. Requires Apple automation permission.",
		promptSnippet: "send messages to iMessage recipients",
		promptGuidelines: [
			"Confirm recipient address (Apple ID or phone number) and message text with the user once before action=send",
			"Use action=status to query bot connection status",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["send", "status"],
					description: "action to perform (send: send message; status: query connection status).",
				},
				address: {
					type: "string",
					description: "send: target Apple ID email or phone number.",
				},
				file: { type: "string", description: "Absolute path to a local file, image, audio or video attachment." },
				text: {
					type: "string",
					description: "send: message content to send.",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const to = args.address?.trim() || localConfig.defaultRecipient?.trim();
					if (!to) throw new Error("recipient address is required.");
					const res = await sendMacOSIMessage(to, args.text || "", { file: args.file });
					return JSON.stringify(res, null, 2);
				}
				case "status": {
					return JSON.stringify(botBridge.getStatus(), null, 2);
				}
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
	});

	host.onClientMessage?.(async (msg, reply) => {
		try {
			switch (msg.type) {
				case "get_state": {
					reply({
						type: "state",
						config: {
							defaultRecipient: localConfig.defaultRecipient || "",
							workspace: localConfig.workspace || "",
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || [],
						},
						botStatus: botBridge.getStatus(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "save_config": {
					const incoming = msg.config || {};
					const nextConfig = mergeSavedSecrets(incoming, localConfig);
					await host.storage.set("config", stripSecretsFromConfig(nextConfig));
					const previousAccount = botBridge.accountIdentity();
					localConfig = nextConfig;
					if (previousAccount !== botBridge.accountIdentity()) {
						await botBridge.invalidateAccount();
					}

					if (localConfig.botEnabled) {
						await botBridge.start();
					} else {
						await botBridge.stop().catch(() => {});
					}

					reply({ type: "save_config_done", success: true, botStatus: botBridge.getStatus() });
					break;
				}

				case "test_config": {
					const isDarwin = process.platform === "darwin";
					reply({
						type: "test_config_done",
						success: isDarwin,
						message: isDarwin
							? "环境检测通过：运行于 macOS 原生环境，支持通过 Apple Messages 自动化收发。"
							: `当前运行平台为 ${process.platform}，不支持 iMessage；须在 macOS 授予完整磁盘访问及 Messages 自动化权限。`,
					});
					break;
				}

				case "send_message": {
					const to = msg.address?.trim() || localConfig.defaultRecipient?.trim();
					if (!to) throw new Error("recipient address is required.");
					const res = await sendMacOSIMessage(to, msg.text || "", { file: msg.file });
					reply({ type: "send_done", success: true, res });
					break;
				}

				case "start_bot": {
					localConfig.botEnabled = true;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.start();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				case "stop_bot": {
					localConfig.botEnabled = false;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.stop();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				default:
					reply({ type: "error", message: `Unknown message type: ${msg.type}` });
					break;
			}
		} catch (err) {
			reply({ type: "error", message: err.message });
		}
	});

	return async () => {
		await botBridge.stop().catch(() => {});
	};
}
