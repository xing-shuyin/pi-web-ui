import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "./types";
import { normalizeSessionPathKey } from "./use-chat";

type Request = { type: "list_sessions"; path?: string; limit?: number };
export function useSessionListRequests({
	send,
	ready,
	status,
	engine,
	cwd,
	sessions,
	projectSessions,
}: {
	send: (message: Request) => boolean;
	ready: boolean;
	status: string;
	engine?: string;
	cwd: string;
	sessions: SessionSummary[];
	projectSessions?: Record<string, SessionSummary[]>;
}) {
	const requests = useRef(
		new Map<
			string,
			{ baseline?: SessionSummary[]; timer: ReturnType<typeof setTimeout>; deadline: number; timedOut?: boolean }
		>(),
	);
	const scope = `${ready}:${status}:${engine ?? ""}`;
	const previousScope = useRef(scope);
	const [pending, setPending] = useState<Set<string>>(() => new Set());
	const [failed, setFailed] = useState<Set<string>>(() => new Set());
	const current = useRef({ cwd, sessions, projectSessions });
	current.current = { cwd, sessions, projectSessions };
	const remove = (values: Set<string>, key: string) => {
		if (!values.has(key)) return values;
		const next = new Set(values);
		next.delete(key);
		return next;
	};
	const expire = useCallback((key: string) => {
		const item = requests.current.get(key);
		if (item) item.timedOut = true;
		setPending((prev) => remove(prev, key));
		setFailed((prev) => new Set(prev).add(key));
	}, []);
	useEffect(() => {
		if (previousScope.current !== scope) {
			requests.current.clear();
			setPending(new Set());
			setFailed(new Set());
			previousScope.current = scope;
		}
		for (const [key, item] of requests.current) {
			if (!item.timedOut) item.timer = setTimeout(() => expire(key), Math.max(0, item.deadline - Date.now()));
		}
		return () => {
			for (const item of requests.current.values()) clearTimeout(item.timer);
		};
	}, [scope, expire]);
	useEffect(() => {
		for (const [key, item] of requests.current) {
			const response = projectSessions?.[key] ?? (key === normalizeSessionPathKey(cwd) ? sessions : undefined);
			if (response === undefined || response === item.baseline) continue;
			clearTimeout(item.timer);
			requests.current.delete(key);
			setPending((prev) => remove(prev, key));
			setFailed((prev) => remove(prev, key));
		}
	}, [projectSessions, sessions, cwd]);
	const request = useCallback(
		(message: Request) => {
			if (!ready || status !== "open") return false;
			const state = current.current;
			const key = normalizeSessionPathKey(message.path ?? state.cwd);
			const previous = requests.current.get(key);
			if (previous && !previous.timedOut) return true;
			if (previous) clearTimeout(previous.timer);
			if (!send(message)) return false;
			const baseline =
				state.projectSessions?.[key] ?? (key === normalizeSessionPathKey(state.cwd) ? state.sessions : undefined);
			const timer = setTimeout(() => expire(key), 20000);
			requests.current.set(key, { baseline, timer, deadline: Date.now() + 20000 });
			setPending((prev) => new Set(prev).add(key));
			setFailed((prev) => remove(prev, key));
			return true;
		},
		[send, ready, status, expire],
	);
	return { request, pending, failed };
}
