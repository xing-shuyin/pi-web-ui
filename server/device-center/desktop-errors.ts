/** Stable native failure codes shared by the standalone pages and chat preview. */
export const DESKTOP_ISSUES = {
	WINDOWS_SESSION_DISCONNECTED: [
		"采集所在的 Windows 会话已断开。安装桌面后台服务后可跟随当前桌面并显示锁屏；否则需在被控机恢复登录会话。",
		"The Windows capture session is disconnected. Install the desktop service to follow the active desktop and show the lock screen, or restore the signed-in session on the controlled computer.",
	],
	WINDOWS_DESKTOP_UNAVAILABLE: [
		"Windows 桌面暂不可访问。请在被控机解锁桌面或完成系统安全提示；恢复后会自动重连。",
		"The Windows desktop is unavailable. Unlock the controlled computer or complete its system security prompt; capture will reconnect automatically.",
	],
	WINDOWS_SESSION_ZERO: [
		"桌面采集运行在 Windows 服务会话中。请在被控机已登录的用户会话中启动 pi-web-ui。",
		"Desktop capture is running in the Windows service session. Start pi-web-ui in the signed-in user's session on the controlled computer.",
	],
} as const;

export function desktopErrorScript() {
	return `const DESKTOP_ISSUES=${JSON.stringify(DESKTOP_ISSUES)};
const desktopIssue=(message,zh)=>{
 const code=message.split(':',1)[0];
 return Object.hasOwn(DESKTOP_ISSUES,code)?{message:DESKTOP_ISSUES[code][zh?0:1],retry:code!=='WINDOWS_SESSION_ZERO'}:undefined;
};`;
}
