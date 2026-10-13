import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LanguageProvider } from "./i18n";
import "./styles.css";
import "highlight.js/styles/github-dark.css";
import { applyTheme, loadTheme } from "./theme";
import { initAuthToken } from "./auth-token";
import { installScrollbarGutterVar } from "./scrollbar-gutter";
import { appBase } from "./base-url";

/** 根级错误边界：防止渲染期 JS 异常导致整棵 React 树卸载为纯黑屏。 */
class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	override state: { error: Error | null } = { error: null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidCatch(error: Error, info: unknown) {
		console.error("RootErrorBoundary caught error:", error, info);
	}

	override render() {
		if (this.state.error) {
			return (
				<div
					style={{
						minHeight: "100vh",
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						padding: "24px",
						background: "var(--bg, rgb(13, 14, 18))",
						color: "var(--text, #e2e8f0)",
						fontFamily: "system-ui, -apple-system, sans-serif",
						textAlign: "center",
					}}
				>
					<h2 style={{ fontSize: "18px", marginBottom: "12px", color: "var(--red, #f43f5e)" }}>
						页面加载出现异常 / App Failed to Render
					</h2>
					<pre
						style={{
							maxWidth: "600px",
							overflow: "auto",
							padding: "12px 16px",
							background: "rgba(0, 0, 0, 0.4)",
							borderRadius: "8px",
							fontSize: "12px",
							lineHeight: "1.5",
							marginBottom: "20px",
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							color: "#94a3b8",
						}}
					>
						{this.state.error.message || String(this.state.error)}
					</pre>
					<button
						type="button"
						style={{
							padding: "8px 20px",
							background: "var(--accent, #38bdf8)",
							color: "#0f172a",
							border: "none",
							borderRadius: "6px",
							fontWeight: 600,
							cursor: "pointer",
							fontSize: "13px",
						}}
						onClick={() => window.location.reload()}
					>
						刷新重试 / Reload
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

// 吸收地址栏 ?token=（PI_WEB_TOKEN 鉴权入口）并持久化，须在首次请求前执行
initAuthToken();

// Apply the persisted theme before first render so there's no flash of the
// wrong palette. The full stylesheet swap happens via an injected <link>.
applyTheme(loadTheme());
// 首帧前实测滚动条宽（scrollbar-gutter 预留 gutter 的宽度）→ 宽屏消息列与
// 输入列的对齐补偿变量 --msgs-gutter，见 scrollbar-gutter.ts。
installScrollbarGutterVar();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<RootErrorBoundary>
			<LanguageProvider>
				<App />
			</LanguageProvider>
		</RootErrorBoundary>
	</StrictMode>,
);

// PWA: register the service worker only in production builds so the Vite dev
// server (live reload / HMR) is never intercepted or cached. The scope is
// derived from the page URL (appBase), so sub-path deployments like /pi/ get
// a worker scoped to the app root instead of the site root.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
	// Register after load so it never blocks first paint.
	window.addEventListener("load", () => {
		const base = appBase();
		navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((err) => {
			console.warn("Service worker registration failed:", err);
		});
	});
}
