import type { ServerMessage } from "../protocol.js";

export interface TransportPort {
	send(msg: ServerMessage): void;
	isClosed(): boolean;
}

export interface ClockPort {
	now(): number;
	after(ms: number, fn: () => void): () => void;
}

export interface StatePort {
	read(key: string): unknown;
	write(key: string, value: unknown): void;
}
