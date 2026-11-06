import { zh, type Translate } from "../../i18n";
import { isCanvasMessage } from "../../../../server/canvas/canvas-runtime-messages.js";

/** Translate only structured system messages; user and model text stays verbatim. */
export function formatCanvasMessage(message: unknown, fallback: string | undefined, t: Translate): string {
	return isCanvasMessage(message) && Object.hasOwn(zh, message.key)
		? t(message.key as keyof typeof zh, message.vars)
		: (fallback ?? "");
}

/** Wire enum values remain stable; only their UI labels are translated. */
export function getEdgeTypeLabels(t: Translate) {
	return {
		handoff: t("canvas.edges.type.handoff"),
		review: t("canvas.edges.type.review"),
		parallel: t("canvas.edges.type.parallel"),
		loop_back: t("canvas.edges.type.loop_back"),
		condition_true: t("canvas.edges.type.condition_true"),
		condition_false: t("canvas.edges.type.condition_false"),
		approve: t("canvas.edges.type.approve"),
		reject: t("canvas.edges.type.reject"),
	};
}
