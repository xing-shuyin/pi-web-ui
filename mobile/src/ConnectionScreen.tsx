import { useState, type FormEvent } from "react";
import type { ConnectionInput, ConnectionMode, SavedConnection } from "./connections";

interface Props {
	initialError?: string;
	saved?: SavedConnection;
	onConnect(input: ConnectionInput): Promise<void>;
	onRetry(connection: SavedConnection): Promise<void>;
}

export function ConnectionScreen({ initialError = "", saved, onConnect, onRetry }: Props) {
	const [mode, setMode] = useState<ConnectionMode>(saved?.mode ?? "hub");
	const [hubUrl, setHubUrl] = useState(
		saved?.mode === "hub" ? saved.serverUrl : (import.meta.env.VITE_PI_HUB_URL ?? ""),
	);
	const [deviceUrl, setDeviceUrl] = useState(
		saved?.mode === "direct" ? saved.serverUrl : (import.meta.env.VITE_PI_DEVICE_URL ?? ""),
	);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [token, setToken] = useState(saved?.mode === "direct" ? saved.token : "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(initialError);
	const hub = mode === "hub";
	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "连接失败，请检查地址、凭据和网络。");
		} finally {
			setBusy(false);
		}
	};
	const connect = (event: FormEvent) => {
		event.preventDefault();
		void run(() =>
			onConnect(
				hub ? { mode: "hub", serverUrl: hubUrl, username, password } : { mode: "direct", serverUrl: deviceUrl, token },
			),
		);
	};
	return (
		<main className="mobile-connect-screen">
			<div className="mobile-connect-content">
				<div className="mobile-logo" aria-hidden="true">
					π
				</div>
				<p className="mobile-eyebrow">PI MOBILE</p>
				<h1>把工作带在身边。</h1>
				<p className="mobile-connect-description">
					登录设备中心管理多台设备，或直接连接一台设备，继续对话并接收任务通知。
				</p>
				<div className="mobile-connection-modes" role="group" aria-label="连接方式">
					{(
						[
							["hub", "设备中心"],
							["direct", "直连设备"],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							className="btn"
							aria-pressed={mode === value}
							disabled={busy}
							onClick={() => {
								setMode(value);
								setError("");
							}}
						>
							{label}
						</button>
					))}
				</div>
				<form onSubmit={connect} className="mobile-connect-form">
					<label htmlFor="mobile-server-url">{hub ? "设备中心地址" : "设备地址"}</label>
					<input
						id="mobile-server-url"
						name="serverUrl"
						type="url"
						inputMode="url"
						autoCapitalize="none"
						autoCorrect="off"
						autoComplete="url"
						placeholder={hub ? "https://hub.example.com" : "https://pi.example.com"}
						value={hub ? hubUrl : deviceUrl}
						onChange={(event) => (hub ? setHubUrl : setDeviceUrl)(event.target.value)}
						required
						disabled={busy}
					/>
					{hub ? (
						<>
							<label htmlFor="mobile-username">账号</label>
							<input
								id="mobile-username"
								name="username"
								autoCapitalize="none"
								autoCorrect="off"
								autoComplete="username"
								placeholder="设备中心账号"
								value={username}
								onChange={(event) => setUsername(event.target.value)}
								required
								disabled={busy}
							/>
							<label htmlFor="mobile-password">密码</label>
							<input
								id="mobile-password"
								name="password"
								type="password"
								autoComplete="current-password"
								placeholder="设备中心密码"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								required
								disabled={busy}
							/>
						</>
					) : (
						<>
							<label htmlFor="mobile-device-token">访问令牌</label>
							<input
								id="mobile-device-token"
								name="deviceToken"
								type="password"
								autoCapitalize="none"
								autoCorrect="off"
								autoComplete="off"
								spellCheck={false}
								placeholder="设备的访问令牌"
								value={token}
								onChange={(event) => setToken(event.target.value)}
								required
								disabled={busy}
							/>
							<p className="mobile-hint">填写设备上 pi-web-ui 的地址与访问令牌。局域网可用 HTTP，公网请使用 HTTPS。</p>
						</>
					)}
					{error && (
						<p className="mobile-error" role="alert">
							{error}
						</p>
					)}
					<button type="submit" className="btn primary mobile-connect-button" disabled={busy}>
						{busy ? "正在连接…" : hub ? "登录设备中心" : "连接设备"}
						<span aria-hidden="true">→</span>
					</button>
				</form>
				{saved?.mode === mode && (
					<button className="btn mobile-retry-button" disabled={busy} onClick={() => void run(() => onRetry(saved))}>
						使用已保存的连接重试
					</button>
				)}
				<p className="mobile-hint">
					{hub ? "登录后选择工作设备，集中接收各设备通知。" : "直接进入这台设备的工作区，通知由该设备发送。"}
					连接凭据保存在手机安全存储中。
				</p>
				<div className="mobile-connect-note">
					<span className="mobile-status-dot" />
					任务在原设备上继续运行，手机可随时离开。
				</div>
			</div>
			<footer className="mobile-connect-footer">你的设备 · 你的工作区</footer>
		</main>
	);
}
