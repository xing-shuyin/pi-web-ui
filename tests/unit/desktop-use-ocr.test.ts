import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, "../../plugins/desktop-use");
const SHOT_PS1 = join(PLUGIN_DIR, "ps/screenshot.ps1");

function runPs(script: string, args: string[] = []) {
	return new Promise<any>((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
			{ encoding: "utf8", timeout: 30000, windowsHide: true },
			(err, stdout, stderr) => {
				if (err) return reject(new Error(stderr || err.message));
				const text = stdout.trim();
				const start = text.indexOf("{");
				if (start < 0) return reject(new Error("No JSON: " + text));
				resolve(JSON.parse(text.slice(start)));
			},
		);
	});
}

function runPsCode(code: string) {
	return new Promise<string>((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", code],
			{ encoding: "utf8", timeout: 30000, windowsHide: true },
			(err, stdout, stderr) => {
				if (err) return reject(new Error(stderr || err.message));
				resolve(stdout.trim());
			},
		);
	});
}

test("WinRT OCR recognizes Chinese and English text with accurate coords", async () => {
	if (process.platform !== "win32") return;
	const testImg = join(tmpdir(), `test-ocr-${Date.now()}.png`);
	try {
		await runPsCode(`
			Add-Type -AssemblyName System.Drawing
			$bmp = New-Object System.Drawing.Bitmap(500, 200)
			$g = [System.Drawing.Graphics]::FromImage($bmp)
			$g.Clear([System.Drawing.Color]::White)
			$font = New-Object System.Drawing.Font('Microsoft YaHei', [float]18)
			$brush = [System.Drawing.Brushes]::Black
			$txtSend = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("5Y+R6YCB5raI5oGv")) # 发送消息
			$txtCancel = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("5Y+W5raI")) # 取消
			$g.DrawString($txtSend, $font, $brush, [float]30, [float]40)
			$g.DrawString($txtCancel, $font, $brush, [float]300, [float]40)
			$g.DrawString("Submit Button", $font, $brush, [float]30, [float]120)
			$g.Dispose()
			$bmp.Save('${testImg.replace(/\\/g, "/")}', [System.Drawing.Imaging.ImageFormat]::Png)
			$bmp.Dispose()
		`);

		const jsonStr = await runPsCode(`
			. '${SHOT_PS1.replace(/\\/g, "/")}'
			$items = Run-Ocr '${testImg.replace(/\\/g, "/")}'
			[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
			$items | ConvertTo-Json -Compress
		`);

		const lines = String(jsonStr)
			.split(/\r?\n/)
			.map((l: string) => l.trim())
			.filter((l: string) => l.startsWith("[") || l.startsWith("{"));
		const lastLine = lines.pop() || "[]";
		const items = JSON.parse(lastLine);
		expect(items).toBeInstanceOf(Array);
		expect(items.length).toBeGreaterThan(0);

		for (const it of items as any[]) {
			expect(typeof it.text).toBe("string");
			expect(typeof it.x).toBe("number");
			expect(typeof it.y).toBe("number");
			expect(typeof it.w).toBe("number");
			expect(typeof it.h).toBe("number");
			expect(typeof it.cx).toBe("number");
			expect(typeof it.cy).toBe("number");
			expect(Math.abs(it.cx - (it.x + Math.floor(it.w / 2)))).toBeLessThanOrEqual(1);
			expect(Math.abs(it.cy - (it.y + Math.floor(it.h / 2)))).toBeLessThanOrEqual(1);
		}

		const allText = (items as any[]).map((it: any) => it.text).join(" ");
		expect(allText).toMatch(/发送|消息|取消|Submit/);
	} finally {
		try {
			rmSync(testImg, { force: true });
		} catch {}
	}
}, 45000);

test("resolvePoint matches OCR text and converts to screen coords", () => {
	const shots = new Map();
	const shotKey = "s1";
	shots.set(shotKey, {
		at: Date.now(),
		winX: 100,
		winY: 200,
		winW: 1920,
		winH: 1080,
		imgW: 1280,
		imgH: 720,
		ocr: [
			{ text: "文件传输助手", x: 20, y: 50, w: 100, h: 30, cx: 70, cy: 65 },
			{ text: "搜索联系人", x: 20, y: 10, w: 120, h: 25, cx: 80, cy: 22 },
			{ text: "发送(S)", x: 1000, y: 650, w: 80, h: 40, cx: 1040, cy: 670 },
		],
	});

	function resolvePoint({ shot, text, x, y }: { shot: string; text?: string; x?: number; y?: number }) {
		const s = shots.get(String(shot));
		if (!s) throw new Error("没有这张截图");
		let imgX = x;
		let imgY = y;
		let viaText = "";

		if (text !== undefined && text !== null && String(text).trim() !== "") {
			const q = String(text).trim();
			const ocrList = s.ocr ?? [];
			const qNoSpace = q.replace(/\s+/g, "").toLowerCase();
			let hit = ocrList.find((it: any) => it.text === q);
			if (!hit) hit = ocrList.find((it: any) => it.text.replace(/\s+/g, "").toLowerCase() === qNoSpace);
			if (!hit) hit = ocrList.find((it: any) => it.text.toLowerCase().includes(q.toLowerCase()));
			if (!hit) hit = ocrList.find((it: any) => q.toLowerCase().includes(it.text.toLowerCase()));
			if (!hit) throw new Error(`未找到文字「${q}」`);
			imgX = hit.cx;
			imgY = hit.cy;
			viaText = `OCR文字「${hit.text}」中心(${hit.cx},${hit.cy}) `;
		}

		const sx = Math.round(s.winX + (imgX! * s.winW) / s.imgW);
		const sy = Math.round(s.winY + (imgY! * s.winH) / s.imgH);
		return { x: sx, y: sy, via: `截图 ${shot} ${viaText}图内(${imgX},${imgY})→屏幕(${sx},${sy})` };
	}

	const pt1 = resolvePoint({ shot: "s1", text: "文件传输助手" });
	expect(pt1.via).toContain("OCR文字「文件传输助手」中心(70,65)");
	expect(pt1.x).toBe(Math.round(100 + (70 * 1920) / 1280));
	expect(pt1.y).toBe(Math.round(200 + (65 * 1080) / 720));

	const pt2 = resolvePoint({ shot: "s1", text: "发送" });
	expect(pt2.via).toContain("OCR文字「发送(S)」中心(1040,670)");
	expect(pt2.x).toBe(Math.round(100 + (1040 * 1920) / 1280));

	const pt3 = resolvePoint({ shot: "s1", text: "搜索 联系人" });
	expect(pt3.via).toContain("OCR文字「搜索联系人」中心(80,22)");

	expect(() => resolvePoint({ shot: "s1", text: "不存在的按钮" })).toThrow("未找到文字「不存在的按钮」");
});
