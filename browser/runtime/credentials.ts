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

/**
 * 把 6 位动态码填进当前页面的验证码框（只在用户点按钮时调用，永不提交表单）。
 *
 * 站位顺序：`autocomplete="one-time-code"` → 一组单字符输入框（分格验证码）→ 名称/占位符像验证码的
 * 单框 → 当前聚焦的输入框。每条路径都不校验站点，因为是用户当面对着屏幕点的。
 */
export async function fillTotpCode(contents: WebContents, code: string): Promise<void> {
	if (!isWebUrl(contents.getURL())) throw new Error("Open the website you want to fill first");
	if (!/^\d{6,8}$/.test(code)) throw new Error("Invalid verification code");
	const fill = (value: string): void => {
		const visible = (node: Element) => {
			const box = node.getBoundingClientRect();
			return box.width > 0 && box.height > 0;
		};
		const editable = (node: HTMLInputElement) =>
			!node.disabled && !node.readOnly && visible(node) && !/^(hidden|submit|button|checkbox|radio)$/i.test(node.type);
		const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		if (!set) throw new Error("This page cannot be filled");
		const type = (node: HTMLInputElement, text: string): void => {
			set.call(node, text);
			node.dispatchEvent(new Event("input", { bubbles: true }));
			node.dispatchEvent(new Event("change", { bubbles: true }));
		};
		const inputs = [...document.querySelectorAll("input")].filter(editable);
		const otp = inputs.find((node) => node.autocomplete === "one-time-code");
		if (otp) {
			type(otp, value);
			otp.focus();
			return;
		}
		// 分格验证码：一串 maxlength=1 的输入框，逐格填
		const cells = inputs.filter((node) => node.maxLength === 1 && /^\d*$/.test(node.value));
		if (cells.length >= value.length && cells.length >= 4) {
			[...value].forEach((digit, index) => type(cells[index], digit));
			cells[Math.min(value.length, cells.length) - 1]?.focus();
			return;
		}
		const hint = /one-?time|otp|totp|2fa|mfa|auth|verif|code|code|pin|token|验证码|校验码|动态码/i;
		const hinted = inputs.find((node) =>
			hint.test(
				[
					node.name,
					node.id,
					node.getAttribute("autocomplete") ?? "",
					node.getAttribute("aria-label") ?? "",
					node.placeholder,
				].join(" "),
			),
		);
		const target = hinted ?? (document.activeElement instanceof HTMLInputElement ? document.activeElement : undefined);
		if (!target || !editable(target)) throw new Error("Click the verification code field on the page first");
		type(target, value);
		target.focus();
	};
	await contents.executeJavaScript(`(${fill.toString()})(${JSON.stringify(code)})`);
}
