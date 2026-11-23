/**
 * 手机操控的审批分档（单源）：哪几个 op 算「操控档」、按风险怎么拆档、规则的 params 正则。
 *
 * 抽到内核对因为内置审批规则表（`approval-default-rules`）与手机工具本身读的是同一份：
 * 各写一份，加一个 op 时必然漏一边。真正驱动手机的代码仍在宿主 `server/phone-tool.ts`。
 */

export const PHONE_CONTROL_OPS = ["tap", "long_press", "swipe", "input", "key", "launch"] as const;

/** 操控档按风险拆档（#902）：每档一条内置审批规则，用户可独立开关、同意时可选「记住本类」。
 *  读屏档（PHONE_READ_OPS）不拦截，直接执行。 */
export const PHONE_APPROVAL_GROUPS = [
	{
		id: "phone.gesture",
		ops: ["tap", "long_press", "swipe"],
		label: "手机操控：点击 / 长按 / 滑动",
		labelEn: "Phone control: tap / long-press / swipe",
		reason: "模型要在你的手机屏幕上点击或滑动",
		reasonEn: "The model wants to tap or swipe on your phone screen",
	},
	{
		id: "phone.input",
		ops: ["input"],
		label: "手机操控：输入文本",
		labelEn: "Phone control: type text",
		reason: "模型要向手机当前输入框打字（聊天、短信、搜索框等）",
		reasonEn: "The model wants to type into the focused input on your phone (chat, SMS, search field)",
	},
	{
		id: "phone.key",
		ops: ["key"],
		label: "手机操控：系统按键",
		labelEn: "Phone control: system keys",
		reason: "模型要按返回 / 主页 / 最近任务等系统按键",
		reasonEn: "The model wants to press system keys (back / home / recents)",
	},
	{
		id: "phone.launch",
		ops: ["launch"],
		label: "手机操控：启动应用",
		labelEn: "Phone control: launch app",
		reason: "模型要启动手机上的某个应用",
		reasonEn: "The model wants to launch an app on your phone",
	},
] as const;

/** 审批规则的 `params` 正则（规则按 `JSON.stringify(params)` 匹配，见 `server/approval-rules.ts`）。
 *  工具会对 `op` 做 `trim()`，因此正则也容得下引号内外的空白，不留 `" launch"` 绕过口子。 */
export function phoneOpRulePattern(ops: readonly string[]): string {
	const escaped = ops.map((op) => op.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`));
	return `"op"\\s*:\\s*"\\s*(?:${escaped.join("|")})\\s*"`;
}
