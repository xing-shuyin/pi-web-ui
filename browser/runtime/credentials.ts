import type { WebContents } from "electron";
import type { PasswordEntry } from "../storage/index.js";
import { isWebUrl } from "./urls.js";

export async function fillCredential(contents: WebContents, entry: PasswordEntry): Promise<void> {
	const url = contents.getURL();
	if (!isWebUrl(url) || !isWebUrl(entry.url) || new URL(url).origin !== new URL(entry.url).origin)
		throw new Error("This credential belongs to a different website");
	const fill = (origin: string, username: string, secret: string): void => {
		if (location.origin !== origin) throw new Error("The page navigated to a different website");
		const candidates = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(
			(node) => !node.disabled && !node.readOnly && node.getBoundingClientRect().width > 0,
		);
		if (candidates.length !== 1) throw new Error("Open a login form with a single password field first");
		const field = candidates[0];
		const container = field.form ?? document;
		const user = container.querySelector<HTMLInputElement>(
			'input[autocomplete="username"], input[type="email"], input[type="text"], input:not([type])',
		);
		const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		if (!set) throw new Error("This login form cannot be filled");
		for (const [node, value] of [
			[user, username],
			[field, secret],
		] as const) {
			if (!node || node.disabled || node.readOnly) continue;
			set.call(node, value);
			node.dispatchEvent(new Event("input", { bubbles: true }));
			node.dispatchEvent(new Event("change", { bubbles: true }));
		}
	};
	await contents.executeJavaScript(
		`(${fill.toString()})(${JSON.stringify(new URL(url).origin)},${JSON.stringify(entry.username)},${JSON.stringify(entry.password)})`,
	);
}
