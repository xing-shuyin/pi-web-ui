export type * from "../../server/protocol";

import type { FileEntry } from "../../server/protocol";
export type { FileEntry };

export type ConnStatus = "connecting" | "open" | "closed";

export interface FileListing {
	path: string;
	parent: string | null;
	entries: FileEntry[];
	truncated: boolean;
	absolute?: boolean;
}

export interface FileContent {
	path: string;
	name: string;
	kind: "image" | "video" | "audio" | "text" | "none";
	text: string;
	truncated: boolean;
	binary: boolean;
	lines: number;
	size: number;
}

export interface ToolStatus {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	exitCode?: number;
	durationMs?: number;
}
