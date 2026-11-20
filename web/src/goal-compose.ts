import { useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();

function emit(): void {
	for (const fn of [...listeners]) fn();
}

function subscribe(fn: Listener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

function readToggle(key: string, fallback: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		return raw === "1";
	} catch {
		return fallback;
	}
}

function writeToggle(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, value ? "1" : "0");
	} catch {}
}

const REFINE_KEY = "pi-web-ui:goal-refine";
const PLAN_KEY = "pi-web-ui:goal-plan";

let compose = false;
let refine = readToggle(REFINE_KEY, false);
let plan = readToggle(PLAN_KEY, false);

function getCompose(): boolean {
	return compose;
}

function getRefine(): boolean {
	return refine;
}

function getPlan(): boolean {
	return plan;
}

/** 进入 / 退出「在主输入框撰写目标」模式（发送走 set_goal / start_goal_wizard）。 */
export function setGoalCompose(next: boolean): void {
	if (compose === next) return;
	compose = next;
	emit();
}

/** 下一次目标发送是否走提炼（start_goal_wizard），否则直设（set_goal）。 */
export function setGoalRefine(next: boolean): void {
	if (refine === next) return;
	refine = next;
	writeToggle(REFINE_KEY, next);
	emit();
}

/** 目标发送时是否顺带打开计划模式。 */
export function setGoalPlan(next: boolean): void {
	if (plan === next) return;
	plan = next;
	writeToggle(PLAN_KEY, next);
	emit();
}

export function isGoalCompose(): boolean {
	return compose;
}

export function useGoalCompose(): boolean {
	return useSyncExternalStore(subscribe, getCompose, getCompose);
}

export function useGoalRefine(): boolean {
	return useSyncExternalStore(subscribe, getRefine, getRefine);
}

export function useGoalPlan(): boolean {
	return useSyncExternalStore(subscribe, getPlan, getPlan);
}
