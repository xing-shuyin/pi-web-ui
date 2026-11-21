import { useEffect, useState } from "react";
import { appUrl } from "../base-url";
import { useT } from "../i18n";
import { parseKernelStatus, splitKernelUptime, type KernelStatusModel } from "../kernel-status";

/**
 * 只读的内核状态行（Web 端）。
 *
 * 装了系统服务之后内核独立于任何客户端，浏览器里也该能确认"我连的内核常驻吗、归谁托管、跑的哪一版"。
 * 装服务只能由桌面壳做，所以这里只展示、不给按钮（见 docs/architecture-kernel.md §5）。
 */
export function KernelStatusCard() {
	const t = useT();
	const [model, setModel] = useState<KernelStatusModel | null>(null);

	useEffect(() => {
		let alive = true;
		void fetch(appUrl("/api/health"))
			.then((response) => (response.ok ? response.json() : null))
			.then((body: unknown) => {
				if (alive) setModel(parseKernelStatus(body));
			})
			.catch(() => {
				if (alive) setModel({ tone: "unknown" });
			});
		return () => {
			alive = false;
		};
	}, []);

	if (!model) return null;
	return (
		<div className="set-row set-field-row">
			<span className="set-row-name">{t("kernelStatusTitle")}</span>
			<span title={t("kernelStatusHint")}>{describe(model, t)}</span>
		</div>
	);
}

type Translate = ReturnType<typeof useT>;

function describe(model: KernelStatusModel, t: Translate): string {
	if (model.tone === "unknown") return t("kernelStatusUnknown");
	const parts: string[] = [];
	if (model.tone === "supervised") parts.push(model.supervisor ?? t("kernelStatusSupervised"));
	else parts.push(t("kernelStatusStandalone"));
	if (model.version) parts.push(`v${model.version}`);
	const uptime = splitKernelUptime(model.uptimeMs);
	if (uptime && uptime.unit === "minutes")
		parts.push(
			uptime.minutes < 1 ? t("kernelUptimeUnderMinute") : t("kernelUptimeMinutes", { minutes: uptime.minutes }),
		);
	if (uptime && uptime.unit === "hours")
		parts.push(t("kernelUptimeHours", { hours: uptime.hours, minutes: uptime.minutes }));
	if (uptime && uptime.unit === "days") parts.push(t("kernelUptimeDays", { days: uptime.days, hours: uptime.hours }));
	return parts.join(" · ");
}
