/**
 * 前台推送提示：应用可见时 JPush 不会弹系统通知，壳层用这条可点的提示补上
 * （后台仍由系统通知负责，点击后走 notificationOpened 的跳转）。
 */
const KIND_LABELS: Record<string, string> = {
	question: "有问题等待回答",
	approval: "有操作等待审批",
	done: "任务已完成",
	error: "任务需要关注",
	subagentDone: "子任务已完成",
};

const LEAVE_MS = 200;
let current: HTMLDivElement | null = null;
let timer: number | undefined;

export function showPushToast(options: { kind?: string; onClick?: () => void }): void {
	if (typeof document === "undefined") return;
	dismissPushToast();
	const toast = document.createElement("div");
	toast.className = "mobile-push-toast";
	toast.setAttribute("role", "status");
	toast.setAttribute("aria-live", "polite");
	const title = document.createElement("p");
	title.className = "mobile-push-toast-title";
	title.textContent = KIND_LABELS[options.kind ?? ""] ?? "收到新通知";
	const hint = document.createElement("p");
	hint.className = "mobile-push-toast-hint";
	hint.textContent = "点击查看";
	toast.append(title, hint);
	toast.addEventListener("click", () => {
		const run = options.onClick;
		dismissPushToast();
		run?.();
	});
	document.body.appendChild(toast);
	current = toast;
	// 先落一帧再加 is-visible，才有入场过渡。
	requestAnimationFrame(() => toast.classList.add("is-visible"));
	timer = window.setTimeout(() => dismissPushToast(), 6000);
}

export function dismissPushToast(): void {
	if (timer !== undefined) {
		window.clearTimeout(timer);
		timer = undefined;
	}
	const toast = current;
	current = null;
	if (!toast) return;
	toast.classList.remove("is-visible");
	toast.classList.add("is-leaving");
	window.setTimeout(() => toast.remove(), LEAVE_MS);
}
