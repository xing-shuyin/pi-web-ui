interface StreamSegments {
	frozen: string[];
	active: string;
	inFence: boolean;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/;

function isBlank(line: string): boolean {
	return line.trim() === "";
}

function fenceMarker(line: string): string | null {
	const m = FENCE_RE.exec(line);
	return m ? m[1] : null;
}

export function segmentStream(text: string): StreamSegments {
	const lines = text.split("\n");
	const frozen: string[] = [];
	let current: string[] = [];
	let fence: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (fence !== null) {
			const marker = fenceMarker(line);
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
				fence = null;
			}
			current.push(line);
			continue;
		}

		const marker = fenceMarker(line);
		if (marker && !isBlank(line)) {
			fence = marker;
			current.push(line);
			continue;
		}

		if (isBlank(line)) {
			let j = i;
			while (j < lines.length && isBlank(lines[j])) j++;
			const nextIsList = j < lines.length && LIST_RE.test(lines[j]);
			if (!nextIsList && current.length > 0) {
				frozen.push(current.join("\n"));
				current = [];
				continue;
			}
			current.push(line);
			continue;
		}

		current.push(line);
	}

	return { frozen, active: current.join("\n"), inFence: fence !== null };
}

export function stepSmoothStream(targetText: string, displayedLen: number, finishing = false): number {
	const targetLen = targetText.length;
	if (displayedLen >= targetLen) return targetLen;
	if (displayedLen < 0) displayedLen = 0;

	const backlog = targetLen - displayedLen;
	let step: number;
	if (finishing) {
		step = backlog <= 16 ? Math.max(2, Math.ceil(backlog / 6)) : Math.ceil(backlog / 8);
	} else if (backlog <= 32) {
		step = 1;
	} else if (backlog <= 90) {
		step = 2;
	} else if (backlog <= 240) {
		step = Math.ceil(backlog / 28);
	} else {
		step = Math.ceil(backlog / 18);
	}

	let nextLen = Math.min(targetLen, displayedLen + step);
	if (nextLen < targetLen) {
		const code = targetText.charCodeAt(nextLen - 1);
		if (code >= 0xd800 && code <= 0xdbff) {
			nextLen = Math.min(targetLen, nextLen + 1);
		}
	}
	return nextLen;
}
