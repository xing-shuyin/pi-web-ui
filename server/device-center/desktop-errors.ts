/** Stable native failure codes shared by the standalone pages and chat preview. */
export const DESKTOP_ISSUES = {
	MAC_SCREEN_PERMISSION_REQUIRED: [
		"被控 Mac 尚未授予屏幕录制权限。请在那台 Mac 本机打开 pi-web-ui → 设备中心 → 本机远程桌面申请权限，在系统设置中允许实际显示的应用，然后重启 pi-web-ui 服务。授权恢复后会自动重连；反复点击重试不会代替系统授权。",
		"Screen Recording permission is missing on the controlled Mac. On that Mac, open pi-web-ui → Device Center → Local remote desktop, request permission, allow the app macOS lists, then restart the pi-web-ui server. Capture retries automatically; Retry cannot grant system permission.",
	],
	MAC_ACCESSIBILITY_PERMISSION_REQUIRED: [
		"被控 Mac 尚未授予辅助功能权限。请在那台 Mac 本机的设备中心申请远程控制权限并在系统设置确认；也可以勾选只读查看画面。",
		"Accessibility permission is missing on the controlled Mac. Request remote control permission in its local Device Center and confirm in System Settings. View only can display the screen without control permission.",
	],
	MAC_DESKTOP_BUILD_FAILED: [
		"被控 Mac 的采集组件未能编译。请在那台 Mac 安装或更新 Apple Command Line Tools（xcode-select --install），然后重启 pi-web-ui。",
		"The controlled Mac could not build its desktop helper. Install or update Apple Command Line Tools (xcode-select --install) on that Mac, then restart pi-web-ui.",
	],
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
 return Object.hasOwn(DESKTOP_ISSUES,code)?{message:DESKTOP_ISSUES[code][zh?0:1],retry:!['WINDOWS_SESSION_ZERO','MAC_DESKTOP_BUILD_FAILED'].includes(code)}:undefined;
};`;
}
