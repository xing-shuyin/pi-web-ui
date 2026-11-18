import { createPortal } from "react-dom";
import { LocalBots } from "./LocalBots";
import { openBotChat } from "../bot-chat";

/**
 * 「新建智能体」的手动填写弹窗。
 *
 * 复用设备中心那份 Bot 编辑器（`LocalBots createOnly`）——编辑器的字段、校验、高权限工具勾选
 * 只写一次；这里只负责「就地弹出 + 建完直接进私聊」。抽屉本身是 `<dialog>`（顶层渲染），
 * 所以挂在左栏的组件树里也不会被侧栏布局裁剪。
 */
export function BotCreateDialog({ onClose, cwd }: { onClose: () => void; cwd?: string | null }) {
	return createPortal(
		<LocalBots
			createOnly
			initialCwd={cwd ?? undefined}
			onCancel={onClose}
			onCreated={(bot) => {
				onClose();
				if (bot?.id) openBotChat(bot.id);
			}}
		/>,
		document.body,
	);
}
