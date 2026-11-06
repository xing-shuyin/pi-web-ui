import { opaquePortalEnvironment, restorePortalTheme } from "./portal-environment";
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LanguageProvider } from "./i18n";
import "./styles.css";
import "highlight.js/styles/github-dark.css";
import { applyTheme, loadTheme } from "./theme";
import { applyFavicon } from "./favicon-settings";
import { setupDesktopWindowDecorations } from "./desktop";
import { initAuthToken } from "./auth-token";
import { installScrollbarGutterVar } from "./scrollbar-gutter";
import { appBase } from "./base-url";
import { installChunkRecovery } from "./chunk-recovery";
import { isMobileRuntime } from "./mobile-runtime";
import { syncMobileNotificationKinds } from "./notify";

const recoverChunk = isMobileRuntime() ? () => false : installChunkRecovery(__BUILD_ID__);

class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	override state: { error: Error | null } = { error: null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidCatch(error: Error, info: unknown) {
		if (recoverChunk(error)) return;
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

initAuthToken();

if (isMobileRuntime()) {
	const syncKinds = () => {
		void syncMobileNotificationKinds().catch((error) => console.warn("Push event settings failed:", error));
	};
	syncKinds();
	window.addEventListener("pi-web-ui:sound-settings", syncKinds);
}

function renderApp() {
	applyTheme(loadTheme());
	createRoot(document.getElementById("root")!).render(
		<StrictMode>
			<RootErrorBoundary>
				<LanguageProvider>
					<App />
				</LanguageProvider>
			</RootErrorBoundary>
		</StrictMode>,
	);
}
applyFavicon();
setupDesktopWindowDecorations();
installScrollbarGutterVar();

if (opaquePortalEnvironment) void restorePortalTheme(window).then(renderApp);
else renderApp();

if (import.meta.env.PROD && !isMobileRuntime() && !opaquePortalEnvironment && "serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		const base = appBase();
		navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((err) => {
			console.warn("Service worker registration failed:", err);
		});
	});
}
