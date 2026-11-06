import { describe, expect, it } from "vitest";
import { calculateHostMetrics, createHostMetricsSampler, meanCpuPercent } from "../../server/host-metrics.js";

describe("calculateHostMetrics", () => {
	it("正常输入：计算处理器与内存百分比", () => {
		const prev = { cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 };
		const curr = { cpuIdle: 140, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 };
		const res = calculateHostMetrics(prev, curr);
		expect(res.cpuPercent).toBeCloseTo(60);
		expect(res.memoryPercent).toBeCloseTo(75);
	});

	it("总时间差为 0 时处理器结果为 null", () => {
		const prev = { cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 };
		const curr = { cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 };
		const res = calculateHostMetrics(prev, curr);
		expect(res.cpuPercent).toBeNull();
		expect(res.memoryPercent).toBeCloseTo(75);
	});

	it("处理器空闲时间回退时将使用率限制为 100", () => {
		const previous = { cpuIdle: 200, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 };
		const current = { cpuIdle: 100, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 };
		const metrics = calculateHostMetrics(previous, current);
		expect(metrics.cpuPercent).toBe(100);
	});

	it("处理器空闲增量超过总增量时将使用率限制为 0", () => {
		const previous = { cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 };
		const current = { cpuIdle: 300, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 };
		const metrics = calculateHostMetrics(previous, current);
		expect(metrics.cpuPercent).toBe(0);
	});

	it("总内存为 0 时内存结果为 0", () => {
		const prev = { cpuIdle: 100, cpuTotal: 400, memoryFree: 0, memoryTotal: 0 };
		const curr = { cpuIdle: 140, cpuTotal: 500, memoryFree: 0, memoryTotal: 0 };
		const res = calculateHostMetrics(prev, curr);
		expect(res.memoryPercent).toBe(0);
	});
});

describe("createHostMetricsSampler", () => {
	it("可注入采样器连续读取三个快照，基线按次推进（窗口=1 时为瞬时值）", () => {
		const snapshots = [
			{ cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 },
			{ cpuIdle: 140, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 },
			{ cpuIdle: 160, cpuTotal: 600, memoryFree: 100, memoryTotal: 1000 },
		];
		let idx = 0;
		const readSnapshot = () => snapshots[idx++];
		const sampler = createHostMetricsSampler(readSnapshot, 1);

		const firstMetrics = sampler();
		expect(firstMetrics.cpuPercent).toBeCloseTo(60);
		expect(firstMetrics.memoryPercent).toBeCloseTo(75);

		const secondMetrics = sampler();
		expect(secondMetrics.cpuPercent).toBeCloseTo(80);
		expect(secondMetrics.memoryPercent).toBeCloseTo(90);
	});

	it("默认上报窗口内均值：单次毛刺被摊平", () => {
		const snapshots = [
			{ cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 },
			{ cpuIdle: 140, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 },
			{ cpuIdle: 160, cpuTotal: 600, memoryFree: 250, memoryTotal: 1000 },
		];
		let idx = 0;
		const sampler = createHostMetricsSampler(() => snapshots[idx++]);
		expect(sampler().cpuPercent).toBeCloseTo(60);
		expect(sampler().cpuPercent).toBeCloseTo(70);
	});

	it("窗口截断：只保留最近 N 次", () => {
		const snapshots = [
			{ cpuIdle: 0, cpuTotal: 0, memoryFree: 500, memoryTotal: 1000 },
			{ cpuIdle: 0, cpuTotal: 100, memoryFree: 500, memoryTotal: 1000 },
			{ cpuIdle: 50, cpuTotal: 200, memoryFree: 500, memoryTotal: 1000 },
			{ cpuIdle: 50, cpuTotal: 300, memoryFree: 500, memoryTotal: 1000 },
			{ cpuIdle: 100, cpuTotal: 400, memoryFree: 500, memoryTotal: 1000 },
		];
		let idx = 0;
		const sampler = createHostMetricsSampler(() => snapshots[idx++], 2);
		expect(sampler().cpuPercent).toBeCloseTo(100);
		expect(sampler().cpuPercent).toBeCloseTo(75);
		expect(sampler().cpuPercent).toBeCloseTo(75);
		expect(sampler().cpuPercent).toBeCloseTo(75);
	});

	it("meanCpuPercent：空序列回 null，前端显示 —", () => {
		expect(meanCpuPercent([])).toBeNull();
		expect(meanCpuPercent([30])).toBeCloseTo(30);
		expect(meanCpuPercent([10, 20, 30])).toBeCloseTo(20);
	});

	it("totalDelta<=0 的 null 读数不进历史，均值保持", () => {
		const snapshots = [
			{ cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 },
			{ cpuIdle: 140, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 },
			{ cpuIdle: 140, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 },
		];
		let idx = 0;
		const sampler = createHostMetricsSampler(() => snapshots[idx++]);
		expect(sampler().cpuPercent).toBeCloseTo(60);
		expect(sampler().cpuPercent).toBeCloseTo(60);
	});
});
