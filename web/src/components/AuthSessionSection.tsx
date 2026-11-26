import { useCallback, useEffect, useState } from "react";
import { FiLogOut, FiShield, FiTrash2 } from "react-icons/fi";
import { logoutAuthSession, requestJson, revokeAuthSessions } from "../api-client";
import { clearAuthToken } from "../auth-token";
import { useT } from "../i18n";

interface PublicSessionItem {
	id: string;
	current: boolean;
	createdAt: number;
	lastSeen: number;
	expiresAt: number;
	ip?: string;
	userAgent?: string;
}

interface SessionListResponse {
	ok: boolean;
	authEnabled: boolean;
	currentId: string | null;
	sessions: PublicSessionItem[];
}

/**
 * 访问会话管理（issue #969 第二层）：
 * 仅在服务端启用口令认证时展示，支持退出当前登录、吊销单个设备会话、以及全部下线。
 */
export function AuthSessionSection() {
	const t = useT();
	const [data, setData] = useState<SessionListResponse | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await requestJson<SessionListResponse>("/__pi/session");
			setData(res);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	if (!data?.authEnabled) return null;

	const handleLogout = async () => {
		setBusy(true);
		try {
			await logoutAuthSession();
			window.location.reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	};

	const handleRevokeAll = async () => {
		setBusy(true);
		try {
			await revokeAuthSessions({ all: true });
			window.location.reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	};

	const handleRevokeOne = async (session: PublicSessionItem) => {
		setBusy(true);
		try {
			await revokeAuthSessions({ id: session.id });
			if (session.current) {
				clearAuthToken();
				window.location.reload();
				return;
			}
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiShield className="set-section-icon" />
				{t("authSessionsTitle")}
				<span className="set-count">{data.sessions.length}</span>
			</div>
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
				<button type="button" className="set-save-btn" disabled={busy} onClick={handleLogout}>
					<FiLogOut /> {t("authSessionsLogout")}
				</button>
				{data.sessions.length > 0 && (
					<button type="button" className="set-save-btn" disabled={busy} onClick={handleRevokeAll}>
						<FiTrash2 /> {t("authSessionsRevokeAll")}
					</button>
				)}
			</div>
			{error && <div style={{ color: "var(--red-text)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
			{data.sessions.length > 0 && (
				<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					{data.sessions.map((s) => (
						<div
							key={s.id}
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: 8,
								padding: "6px 10px",
								borderRadius: 6,
								background: "var(--bg-elev2)",
								fontSize: 12,
								minWidth: 0,
							}}
						>
							<div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
								<strong>{s.current ? t("authSessionsCurrentDevice") : s.ip || s.id}</strong>
								{s.current && s.ip ? ` (${s.ip})` : ""}
								{s.userAgent ? ` · ${s.userAgent}` : ""}
							</div>
							<button type="button" className="set-save-btn" disabled={busy} onClick={() => handleRevokeOne(s)}>
								{t("authSessionsRevoke")}
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
