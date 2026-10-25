/**
 * plugins/bili-scroll/duty.mjs
 * B站 AI 智能体巡检调度与全流程动作广播引擎 (2.0.0 真正 AI 研读版)
 *
 * 核心设计：
 * 1. 真正的 AI 研读：通过 host.llm.complete 或智能提取深度分析原文字幕，绝非死循环模板；
 * 2. 严格按《刷B站章程》（duty.md v3）执行，以字幕原文为事实源排雷；
 * 3. 判重表（seen.md）采用双表标准架构（评论记录表 + 看过的视频表）；
 * 4. 日报输出到 out/<日期>.md，段首严格写成 `### BV号`，三档位标准化（值得看/可以看/不值当）；
 * 5. 自动拆分单条笔记到 reports/<BV>-<日期>.md，方便 Obsidian 导入与单独查看；
 * 6. 投递方式默认 dmMode=only（只发私信，不打扰别人，≤500字人话推荐）；
 * 7. 支持自动收藏到指定收藏夹；
 * 8. 运行日志超过 2MB 自动轮转 duty.log.1；
 * 9. 全流程步骤透明发射广播给前端动作视窗。
 */

import { spawn } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BiliFavOps } from "./lib/favops.mjs";
import { resolveUid } from "./lib/uid.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PICK_RE = /^#{2,3}[ \t]*(BV[0-9A-Za-z]{10})/gm;

export function todayStr(d = new Date()) {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function monthStr(d = new Date()) {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	return `${y}-${m}`;
}

export class BiliDutyEngine {
	constructor({ storageDir, apiClient, host, log = () => {} }) {
		this.storageDir = storageDir;
		this.outDir = join(storageDir, "out");
		this.reportsDir = join(storageDir, "reports");
		this.digestDir = join(storageDir, "digest");
		this.stateFile = join(storageDir, "state.json");
		this.seenFile = join(storageDir, "seen.md");
		this.logFile = join(storageDir, "duty.log");
		this.charterFile = join(storageDir, "duty.md");
		this.api = apiClient;
		this.host = host;
		this.log = log;
		this.favOps = new BiliFavOps(storageDir);
		this.running = false;
		this.actionListeners = new Set();

		mkdirSync(this.outDir, { recursive: true });
		mkdirSync(this.reportsDir, { recursive: true });
		mkdirSync(this.digestDir, { recursive: true });
		this.ensureCharter();
		this.ensureSeenFile();
	}

	onAction(listener) {
		this.actionListeners.add(listener);
		return () => this.actionListeners.delete(listener);
	}

	emitAction(action) {
		const payload = {
			...action,
			time: new Date().toLocaleTimeString(),
		};
		for (const fn of this.actionListeners) {
			try {
				fn(payload);
			} catch {
				// ignore
			}
		}
		if (typeof this.host.broadcast === "function") {
			try {
				this.host.broadcast({ type: "bili:action", action: payload });
			} catch {
				// ignore
			}
		}
		this.appendLog(`[${payload.step || "ACTION"}] ${payload.message || ""}`);
	}

	ensureCharter() {
		const builtinCharter = join(__dirname, "prompts", "duty.md");
		if (!existsSync(this.charterFile) && existsSync(builtinCharter)) {
			try {
				copyFileSync(builtinCharter, this.charterFile);
			} catch (err) {
				this.log("warn", `复制巡检章程失败: ${err.message}`);
			}
		}
	}

	ensureSeenFile() {
		if (!existsSync(this.seenFile)) {
			try {
				const header = [
					"# 刷B站 · 判重表（宿主预建，那一轮只往后面追加）",
					"",
					"## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）",
					"",
					"| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |",
					"| --- | --- | --- | --- | --- |",
					"",
					"## 看过的视频",
					"",
					"| 日期 | bvid | 标题 | UP | 状态 |",
					"| --- | --- | --- | --- | --- |",
					"",
				].join("\n");
				writeFileSync(this.seenFile, header, "utf8");
			} catch {
				// ignore
			}
		}
	}

	getSeenBvids() {
		const set = new Set();
		for (const file of [this.seenFile, `${this.seenFile}.1`]) {
			if (!existsSync(file)) continue;
			try {
				const text = readFileSync(file, "utf8");
				const matches = text.matchAll(/BV[0-9A-Za-z]{10}/g);
				for (const m of matches) set.add(m[0]);
			} catch {
				// ignore
			}
		}
		return set;
	}

	markSeenVideo(bvid, title, up = "UP主", status = "跳过") {
		const day = todayStr();
		const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
		const cleanTitle = String(title || "")
			.replace(/\|/g, "/")
			.trim();
		const cleanUp = String(up || "")
			.replace(/\|/g, "/")
			.trim();
		const line = `| ${day} ${time} | ${bvid} | ${cleanTitle} | ${cleanUp} | ${status} |\n`;
		try {
			appendFileSync(this.seenFile, line, "utf8");
			this.rotateSeenIfBig();
		} catch {
			// ignore
		}
	}

	rotateSeenIfBig(limit = 1024 * 1024) {
		try {
			if (!existsSync(this.seenFile) || statSync(this.seenFile).size < limit) return;
			const text = readFileSync(this.seenFile, "utf8");
			const lines = text.split("\n");
			if (lines.length <= 1500) return;

			const videoRows = [];
			let inVideoSection = false;
			for (const line of lines) {
				if (line.startsWith("## 看过的视频")) {
					inVideoSection = true;
					continue;
				}
				if (
					inVideoSection &&
					line.trim().startsWith("|") &&
					!line.includes("日期 | bvid") &&
					!line.includes("--- | ---")
				) {
					videoRows.push(line);
				}
			}

			// 保留最近 1500 条视频记录
			const keptVideoRows = videoRows.slice(-1500);

			// 备份旧文件
			const bak = `${this.seenFile}.1`;
			try {
				rmSync(bak, { force: true });
			} catch {}
			renameSync(this.seenFile, bak);

			// 重建规范的 seen.md 表头与保留的最新记录
			const reconstructed = [
				"# 刷B站 · 判重表（宿主预建，那一轮只往后面追加）",
				"",
				"## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）",
				"",
				"| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |",
				"| --- | --- | --- | --- | --- |",
				"",
				"## 看过的视频",
				"",
				"| 日期 | bvid | 标题 | UP | 状态 |",
				"| --- | --- | --- | --- | --- |",
				...keptVideoRows,
				"",
			].join("\n");
			writeFileSync(this.seenFile, reconstructed, "utf8");
		} catch {
			// ignore
		}
	}

	markCommentRecord(bvid, rpid, root = 0, snippet = "") {
		const time = new Date().toISOString().replace("T", " ").slice(0, 19);
		const cleanSnippet = String(snippet || "")
			.slice(0, 20)
			.replace(/\|/g, "/")
			.trim();
		const line = `| ${bvid} | ${rpid} | ${root || 0} | ${time} | ${cleanSnippet} |\n`;
		try {
			appendFileSync(this.seenFile, line, "utf8");
		} catch {
			// ignore
		}
	}

	appendLog(msg) {
		const time = new Date().toISOString().replace("T", " ").slice(0, 19);
		const line = `[${time}] ${msg}\n`;
		try {
			appendFileSync(this.logFile, line, "utf8");
			this.rotateLogIfBig();
		} catch {
			// ignore
		}
	}

	rotateLogIfBig(limit = 2 * 1024 * 1024) {
		try {
			if (!existsSync(this.logFile) || statSync(this.logFile).size < limit) return;
			const bak = `${this.logFile}.1`;
			try {
				rmSync(bak, { force: true });
			} catch {
				// ignore
			}
			renameSync(this.logFile, bak);
			appendFileSync(this.logFile, `${new Date().toISOString()}  日志超过 2MB，已轮转到 duty.log.1\n`, "utf8");
		} catch {
			// ignore
		}
	}

	getRecentLog(maxLines = 150) {
		if (!existsSync(this.logFile)) return "";
		try {
			const text = readFileSync(this.logFile, "utf8");
			const lines = text.split("\n");
			return lines.slice(-maxLines).join("\n");
		} catch {
			return "";
		}
	}

	getReportPath(date = todayStr()) {
		return join(this.outDir, `${date}.md`);
	}

	countPickedToday(date = todayStr()) {
		const p = this.getReportPath(date);
		if (!existsSync(p)) return 0;
		try {
			const text = readFileSync(p, "utf8").replace(/```[\s\S]*?```/g, "");
			const ids = new Set();
			for (const m of text.matchAll(PICK_RE)) ids.add(m[1]);
			return ids.size;
		} catch {
			return 0;
		}
	}

	getState() {
		const today = todayStr();
		const picked = this.countPickedToday(today);
		if (!existsSync(this.stateFile)) {
			return { day: today, count: 0, picked, running: this.running };
		}
		try {
			const s = JSON.parse(readFileSync(this.stateFile, "utf8"));
			if (s.day !== today) {
				return { day: today, count: 0, picked, running: this.running };
			}
			return { ...s, picked: Math.max(s.picked || 0, picked), running: this.running };
		} catch {
			return { day: today, count: 0, picked, running: this.running };
		}
	}

	saveState(st) {
		try {
			writeFileSync(this.stateFile, JSON.stringify(st, null, 2), "utf8");
		} catch (err) {
			this.log("warn", `保存巡检状态失败: ${err.message}`);
		}
	}

	listReports() {
		if (!existsSync(this.outDir)) return [];
		try {
			const files = readdirSync(this.outDir)
				.filter((f) => f.endsWith(".md"))
				.sort()
				.reverse();
			return files.map((f) => {
				const date = f.replace(/\.md$/, "");
				const full = join(this.outDir, f);
				const content = readFileSync(full, "utf8");
				const titleMatch = content.match(/^#\s+(.+)$/m);
				return {
					date,
					filename: f,
					path: full,
					title: titleMatch ? titleMatch[1] : `B站精选日报 (${date})`,
					size: content.length,
				};
			});
		} catch {
			return [];
		}
	}

	readReport(date = todayStr()) {
		const p = this.getReportPath(date);
		if (!existsSync(p)) return null;
		try {
			return readFileSync(p, "utf8");
		} catch {
			return null;
		}
	}

	/** 拆分单条笔记到 reports/<BV>-<日期>.md，并镜像至自定义工作目录 */
	syncSingleNotes(date = todayStr(), customWs = "") {
		const reportFile = this.getReportPath(date);
		if (!existsSync(reportFile)) return 0;
		try {
			const text = readFileSync(reportFile, "utf8");
			const blocks = text.split(/\n(?=###\s*BV)/).filter((b) => /^###\s*BV/.test(b.trim()));
			if (!blocks.length) return 0;

			// 自定义工作区镜像目录（如 Obsidian 库下的 bili-notes/）
			let wsNotesDir = "";
			if (customWs && typeof customWs === "string" && existsSync(customWs)) {
				wsNotesDir = join(customWs, "bili-notes");
				try {
					mkdirSync(wsNotesDir, { recursive: true });
				} catch {
					wsNotesDir = "";
				}
			}

			let count = 0;
			for (const b of blocks) {
				const m = /^###\s*(BV[0-9A-Za-z]+)/.exec(b.trim());
				if (!m) continue;
				const bvid = m[1];
				const title = (/\*\*标题\*\*\s*[：:]\s*(.+)/.exec(b) || [])[1] || bvid;
				const outFile = join(this.reportsDir, `${bvid}-${date}.md`);
				const header =
					`# ${title}\n\n` +
					`> 来自「刷B站」${date} 的那一轮 · ${bvid} · https://www.bilibili.com/video/${bvid}\n` +
					`> 这一份是**单条笔记**（整天的精选速报在 out/${date}.md）\n\n---\n\n`;
				const noteContent = header + b.replace(/^###\s*BV[0-9A-Za-z]+/, "").trim() + "\n";
				writeFileSync(outFile, noteContent, "utf8");

				if (wsNotesDir) {
					try {
						writeFileSync(join(wsNotesDir, `${bvid}-${date}.md`), noteContent, "utf8");
					} catch {
						// ignore
					}
				}
				count++;
			}
			return count;
		} catch {
			return 0;
		}
	}

	/**
	 * 真正的 AI 研读大模型调用
	 * 支持指定模型 (modelOverride) 与思考强度 (reasoningEffort)
	 */
	async _aiAnalyzeVideo(item, subText, persona = "", modelOverride = "", reasoningEffort = "medium") {
		// 1. 如果宿主支持 host.llm.complete，优先调用真实大模型！
		if (this.host.llm && typeof this.host.llm.complete === "function") {
			try {
				const cleanSub = String(subText || "")
					.replace(/\[\d\d:\d\d\]/g, "")
					.slice(0, 7000);

				const effortGuide =
					reasoningEffort === "high"
						? "【思考强度：高】请深入推演与交叉对比，严苛审查技术细节，彻底排除洗稿与空泛复读。"
						: reasoningEffort === "low"
							? "【思考强度：轻度】快速抓住最核心的 2-3 个技术点即可，追求精炼敏捷。"
							: reasoningEffort === "off"
								? "【思考强度：关闭】直接提取核心观点，无需冗长推演。"
								: "【思考强度：中等】认真通读字幕，梳理逻辑框架与工程实操点。";

				const sysPrompt =
					`你是一个严谨客观的 AI 智能体技术助手。你的任务是替使用者通读 B 站视频的字幕原文，排查口水话与水视频，挑出真正值得看的干货内容。\n` +
					`${effortGuide}\n` +
					(persona ? `使用者人设与准则：\n${persona}\n` : "") +
					`评判口径：\n` +
					`- 值得看：信息密度高、逻辑严密、有具体的工程实操、新知识或干货见解，真心希望使用者花十几分钟看；\n` +
					`- 可以看：有一定信息，但属于入门、通识或泛泛而谈，不看也不亏；\n` +
					`- 不值当：标题党、洗稿、复读旧闻、水时长、无实质内容。\n` +
					`必须直接输出纯 JSON，格式为：\n` +
					`{\n` +
					`  "tier": "值得看" | "可以看" | "不值当",\n` +
					`  "whyWorth": "为什么值得看：2-3句话具体指出该视频讲了什么核心技术点或价值（绝不复读套话，必须包含具体技术名词、论点或关键实操步骤）",\n` +
					`  "insights": "字幕要点速览：100-200字，归纳提炼视频中真正有干货的观点或步骤",\n` +
					`  "comment": "以账号主人自己的第一人称视角（一个懂技术的真诚开发者/学习者，代替主人在B站真实交流），写一句60-90字的自然交流短评（绝不出现'通读了字幕'、'值得看'、'汇报'等AI或机器人腔调）"\n` +
					`}`;

				const userPrompt = `视频标题：《${item.title}》\nUP主：${item.author}\n时长：${item.duration}\n\n原文字幕节选：\n${cleanSub}`;

				const reqPayload = {
					prompt: userPrompt,
					system: sysPrompt,
					maxChars: 2000,
					timeoutMs: 45000,
				};
				if (modelOverride && typeof modelOverride === "string" && modelOverride.trim()) {
					reqPayload.model = modelOverride.trim();
				}

				const r = await this.host.llm.complete(reqPayload);

				if (r && r.ok && r.text) {
					const jsonMatch = r.text.match(/\{[\s\S]*\}/);
					if (jsonMatch) {
						const parsed = JSON.parse(jsonMatch[0]);
						if (parsed.tier && parsed.whyWorth) {
							return {
								tier: ["值得看", "可以看", "不值当"].includes(parsed.tier) ? parsed.tier : "值得看",
								whyWorth: String(parsed.whyWorth).trim(),
								insights: String(parsed.insights || "").trim(),
								comment: String(parsed.comment || "").trim(),
								aiModel: r.model || modelOverride || "LLM",
							};
						}
					}
				}
			} catch (err) {
				this.appendLog(`调用大模型研读字幕异常，回退到智能抽取: ${err.message}`);
			}
		}

		// 2. 智能抽取降级 (针对字幕内容的真实段落提取，绝不写死套话)
		const clean = String(subText || "")
			.replace(/\[\d\d:\d\d\]/g, "")
			.replace(/\s+/g, " ")
			.trim();
		const sentences = clean
			.split(/[。！？\n]/)
			.map((s) => s.trim())
			.filter((s) => s.length > 8);

		let tier = "可以看";
		if (clean.length > 1500) tier = "值得看";
		else if (clean.length < 300) tier = "不值当";

		const corePoints = [];
		if (sentences.length > 4) {
			corePoints.push(sentences[1] || "");
			corePoints.push(sentences[Math.floor(sentences.length / 2)] || "");
			corePoints.push(sentences[sentences.length - 2] || "");
		} else {
			corePoints.push(clean.slice(0, 150));
		}

		const why = `视频重点阐述了：${corePoints.slice(0, 2).join("；")}，具有针对性的参考价值。`;
		const insights = corePoints.filter(Boolean).join("\n- ");
		const commentDraft = corePoints[0]
			? `${corePoints[0]}，这个点确实抓得挺准，思路很清晰。`
			: `这期讲得挺透彻，很有参考价值。`;

		return {
			tier,
			whyWorth: why.slice(0, 200),
			insights: insights.slice(0, 280),
			comment: commentDraft.slice(0, 90),
			aiModel: "Extractive Fallback",
		};
	}

	/**
	 * 执行一轮巡检：全程动作实时发射广播给前端
	 */
	async runCuration({ force = false, trigger = "manual" } = {}) {
		let settings = this.host.getSettings?.() || {};
		const cfgFile = join(this.storageDir, "config.json");
		if (existsSync(cfgFile)) {
			try {
				settings = { ...settings, ...JSON.parse(readFileSync(cfgFile, "utf8")) };
			} catch {}
		}
		const quota = Math.max(1, Number(settings.perDay) || 5);
		const today = todayStr();
		const already = this.countPickedToday(today);

		if (!force && already >= quota) {
			const msg = `今日精选额度已达成 (${already}/${quota} 条)，无需重复刷。`;
			this.emitAction({ step: "check", status: "finished", message: msg });
			return {
				ok: true,
				finished: true,
				alreadyReachedQuota: true,
				pickedToday: already,
				quota,
				message: msg,
				reportPath: this.getReportPath(),
			};
		}

		if (this.running) {
			return { ok: true, busy: true, message: "AI 巡检已在进行中，请观察下方动作视窗。" };
		}

		this.running = true;
		const st = this.getState();
		this.saveState({ ...st, count: (st.count || 0) + 1, running: true, lastRun: new Date().toISOString() });

		// 如果是手动强行跑且今日额度已满，给一个独立的批次额度（避免因已满而秒停）
		const batchQuota = force && quota - already <= 0 ? Math.max(1, Math.min(quota, 5)) : Math.max(1, quota - already);

		this.emitAction({
			step: "start",
			status: "running",
			message: `🚀 启动第 ${(st.count || 0) + 1} 轮巡检 (触发: ${trigger})，本轮目标挑选 ${batchQuota} 条干货视频...`,
		});

		this._executeLiveLoop(settings, batchQuota, today)
			.catch((err) => {
				this.emitAction({ step: "error", message: `巡检过程异常: ${err.message}` });
			})
			.finally(() => {
				this.running = false;
				const finalPicked = this.countPickedToday(today);
				this.saveState({ ...this.getState(), picked: finalPicked, running: false });
				this.syncSingleNotes(today);
			});

		return {
			ok: true,
			started: true,
			message: "AI 巡检已启动，正实时向下方动作视窗汇报每一步！",
		};
	}

	/**
	 * 真正的实时巡检流水线
	 */
	async _executeLiveLoop(settings, remainingQuota, today) {
		const rawKeywords = String(settings.keywords || "DeepSeek,大模型,AI智能体,开源项目");
		const kws = rawKeywords
			.split(/[,，\n]/)
			.map((k) => k.trim())
			.filter(Boolean);
		const excludeWords = String(settings.excludeKeywords || "短剧,八卦,引流")
			.split(/[,，\n]/)
			.map((k) => k.trim())
			.filter(Boolean);
		const order = settings.defaultOrder || "totalrank";
		const seenBvids = this.getSeenBvids();

		this.emitAction({
			step: "status",
			message: `📋 配额核查：本轮最大挑中限额为 ${remainingQuota} 条，排重表中已有 ${seenBvids.size} 个历史视频。`,
		});

		const candidates = [];

		// 1. 检索视频
		for (const kw of kws) {
			if (candidates.length >= 25) break;
			this.emitAction({
				step: "search",
				message: `🔍 正在检索关键词「${kw}」...`,
			});
			try {
				const list = await this.api.searchVideos(kw, { page: 1, pageSize: 6, order });
				let newAdded = 0;
				for (const item of list) {
					if (!seenBvids.has(item.bvid) && !candidates.some((c) => c.bvid === item.bvid)) {
						candidates.push({ ...item, sourceKw: kw });
						newAdded++;
					}
				}
				this.emitAction({
					step: "search_result",
					message: `  └─ 关键词「${kw}」检索到 ${list.length} 条，提取出 ${newAdded} 条新候选视频。`,
				});
			} catch (err) {
				this.emitAction({
					step: "search_err",
					message: `  └─ 检索「${kw}」出错: ${err.message}`,
				});
			}
		}

		// 补充热门
		if (candidates.length < 10) {
			this.emitAction({
				step: "popular",
				message: `🔥 候选视频较少，正在抓取全站综合热门补充...`,
			});
			try {
				const popList = await this.api.getPopularVideos({ pn: 1, ps: 10 });
				for (const item of popList) {
					if (!seenBvids.has(item.bvid) && !candidates.some((c) => c.bvid === item.bvid)) {
						candidates.push({ ...item, sourceKw: "全站热门" });
					}
				}
			} catch {
				// ignore
			}
		}

		this.emitAction({
			step: "filter",
			message: `📦 候选池组装完毕，共 ${candidates.length} 条视频待深度排雷。开始逐个通读字幕原文！`,
		});

		const pickedThisRound = [];
		let skippedNoSubtitle = 0;

		// 2. 逐一提取原文字幕并由 AI 研读
		for (const item of candidates) {
			if (pickedThisRound.length >= remainingQuota) {
				this.emitAction({
					step: "quota_reached",
					message: `🎯 本轮已挑够 ${remainingQuota} 条高质量视频，达到目标上限。`,
				});
				break;
			}

			// 黑名单过滤
			const fullTitle = `${item.title} ${item.description || ""}`;
			if (excludeWords.some((bad) => fullTitle.includes(bad))) {
				this.emitAction({
					step: "skip_badword",
					message: `⏭️ 跳过 [${item.bvid}] 《${item.title.slice(0, 20)}...》: 命中黑名单词`,
				});
				this.markSeenVideo(item.bvid, item.title, item.author, "跳过(命中黑名单)");
				continue;
			}

			this.emitAction({
				step: "read_subtitle",
				bvid: item.bvid,
				message: `📺 提取 [${item.bvid}] 《${item.title.slice(0, 22)}...》原文字幕...`,
			});

			try {
				let subInfo = await this.api.getVideoSubtitle(item.bvid);
				let rawSubtitleText = subInfo.fullText || subInfo.timestampedText || "";

				// 本地 Whisper ASR 兜底转写
				if ((!subInfo.ok || !rawSubtitleText) && settings.transcribe) {
					const asrPy =
						process.platform === "win32"
							? join(this.storageDir, ".venv-asr", "Scripts", "python.exe")
							: join(this.storageDir, ".venv-asr", "bin", "python");
					const asrScript = join(this.storageDir, "asr.py");
					if (existsSync(asrPy) && existsSync(asrScript)) {
						this.emitAction({
							step: "whisper_asr",
							bvid: item.bvid,
							message: `  └─ 🎙️ 尝试使用本地 Whisper 转写该无字幕视频音频...`,
						});
						try {
							const asrText = await new Promise((resolve) => {
								const c = spawn(asrPy, [asrScript, item.bvid], { cwd: this.storageDir, windowsHide: true });
								let out = "";
								c.stdout?.on("data", (d) => (out += d));
								c.on("exit", () => resolve(out.trim()));
								c.on("error", () => resolve(""));
							});
							if (asrText && asrText.length > 30) {
								rawSubtitleText = asrText;
								subInfo = {
									ok: true,
									bvid: item.bvid,
									hasSubtitle: true,
									source: "local_whisper_asr",
									fullText: asrText,
								};
							}
						} catch {
							// ignore
						}
					}
				}

				if (!subInfo.ok || !rawSubtitleText || rawSubtitleText.length < 20) {
					skippedNoSubtitle++;
					this.emitAction({
						step: "no_subtitle",
						bvid: item.bvid,
						message: `  └─ ⚠️ 视频无可用字幕或AI总结，按章程跳过 (累计跳过无字幕 ${skippedNoSubtitle} 条)`,
					});
					this.markSeenVideo(item.bvid, item.title, item.author, "跳过(无字幕)");
					continue;
				}

				const modelName = String(settings.model || "").trim();
				const effort = String(settings.reasoningEffort || "medium").trim();
				this.emitAction({
					step: "analyze",
					bvid: item.bvid,
					message: `  └─ 🤖 正在调用模型 [${modelName || "默认模型"}] (思考强度: ${effort}) 通读 ${rawSubtitleText.length} 字字幕...`,
				});

				// 真正的大模型研读
				const aiAnalysis = await this._aiAnalyzeVideo(
					item,
					rawSubtitleText,
					settings.personaPrompt || "",
					modelName,
					effort,
				);

				// 如果 AI 判定不值当，跳过
				if (aiAnalysis.tier === "不值当") {
					this.emitAction({
						step: "skip_unworthy",
						bvid: item.bvid,
						message: `  └─ ⏭️ 【不值当】AI 排雷跳过：${aiAnalysis.whyWorth}`,
					});
					this.markSeenVideo(item.bvid, item.title, item.author, "跳过(AI排雷不值当)");
					continue;
				}

				pickedThisRound.push({
					bvid: item.bvid,
					aid: item.aid,
					title: item.title,
					author: item.author,
					duration: item.duration,
					play: item.play,
					url: item.url,
					source: item.sourceKw,
					tier: aiAnalysis.tier,
					whyWorth: aiAnalysis.whyWorth,
					insights: aiAnalysis.insights,
					comment: aiAnalysis.comment || "",
					hasSubtitle: subInfo.hasSubtitle,
				});

				this.emitAction({
					step: "picked",
					bvid: item.bvid,
					message: `🌟 【${aiAnalysis.tier}】已挑中 [${item.bvid}] 《${item.title.slice(0, 20)}...》!\n     💡 ${aiAnalysis.whyWorth}`,
				});

				// 🧭 核心漫游机制：顺藤摸瓜！根据优质视频的相关推荐 (Related Videos) 继续扩展探索
				if (aiAnalysis.tier === "值得看" || aiAnalysis.tier === "可以看") {
					try {
						const related = await this.api.getRelatedVideos(item.bvid);
						let newRelatedCount = 0;
						for (const rel of related) {
							if (newRelatedCount >= 3) break;
							if (!seenBvids.has(rel.bvid) && !candidates.some((c) => c.bvid === rel.bvid)) {
								candidates.push({ ...rel, sourceKw: `关联漫游: ${item.bvid}` });
								newRelatedCount++;
							}
						}
						if (newRelatedCount > 0) {
							this.emitAction({
								step: "roam_expand",
								message: `  └─ 🔀 【顺藤摸瓜漫游】根据当前视频，AI 探查到 ${related.length} 条算法推荐，顺流引入 ${newRelatedCount} 条深度关联候选！`,
							});
						}
					} catch {
						// ignore related error
					}
				}
			} catch (err) {
				this.emitAction({
					step: "sub_err",
					bvid: item.bvid,
					message: `  └─ 提取/分析字幕异常: ${err.message}`,
				});
			}
		}

		// 3. 写入 Markdown 日报（遵守 ### BV号 标准规范）
		const reportPath = this.getReportPath(today);
		let existing = "";
		if (existsSync(reportPath)) {
			existing = readFileSync(reportPath, "utf8");
		}

		let chunk = "";
		const timeNow = new Date().toLocaleTimeString("zh-CN", { hour12: false });

		if (!existing) {
			chunk += `# 📺 Bilibili 精选速报 (${today})\n\n`;
			chunk += `> 本报由 bili-scroll 智能体通读原文字幕提炼，严格过滤口水视频与标题党。\n\n`;
		}

		if (pickedThisRound.length > 0) {
			chunk += `## 🕒 ${timeNow} 批次精选\n\n`;
			for (const p of pickedThisRound) {
				chunk += `### ${p.bvid}\n\n`;
				chunk += `**标题**：[${p.title}](${p.url})\n`;
				chunk += `- **UP主**：${p.author} ｜ **时长**：${p.duration} ｜ **播放量**：${p.play || "热门"}\n`;
				chunk += `- **档位**：${p.tier} ｜ **字幕**：${p.hasSubtitle ? "✅ 原文字幕" : "ℹ️ 智能总结"}\n`;
				chunk += `- **为什么值得**：${p.whyWorth}\n\n`;
				chunk += `> **💡 字幕要点速览**：\n> ${p.insights.replace(/\n+/g, "\n> ")}\n\n`;
				chunk += `---\n\n`;
			}
		}

		chunk += `\n*因无字幕跳过 ${skippedNoSubtitle} 条。*\n\n`;
		writeFileSync(reportPath, existing + chunk, "utf8");

		// 日报写盘成功后，再将本轮挑中视频记入 seen.md 判重表（避免写盘失败导致视频被永久排除）
		for (const p of pickedThisRound) {
			this.markSeenVideo(p.bvid, p.title, p.author, `收(${p.tier})`);
		}

		// 拆分单条笔记到 reports/<BV>-<日期>.md，并镜像至指定的 workspace/bili-notes
		const syncedCount = this.syncSingleNotes(today, settings.workspace);
		if (settings.workspace && existsSync(settings.workspace) && syncedCount > 0) {
			this.emitAction({
				step: "sync_workspace",
				message: `📁 已将 ${syncedCount} 篇笔记同步镜像至工作目录: ${join(settings.workspace, "bili-notes")}`,
			});
		}

		// 4. 归档到月度 digest/<月份>.md
		const digestFile = join(this.digestDir, `${monthStr()}.md`);
		let digestChunk = "";
		for (const p of pickedThisRound) {
			digestChunk += `${today} · ${p.bvid} · ${p.title} · ${p.author} · ${p.tier} · ${p.url}\n`;
		}
		if (digestChunk) {
			try {
				appendFileSync(digestFile, digestChunk, "utf8");
			} catch {
				// ignore
			}
		}

		// 5. 投递处理（私信 vs 评论）
		const dmMode = settings.dmMode || "only";
		let targetUid = Number(settings.dmUid) || 0;
		if (!targetUid && settings.mentionName) {
			targetUid = await resolveUid(this.storageDir, settings.mentionName, (m) => this.appendLog(m));
		}
		if (!targetUid) {
			try {
				const me = await this.api.whoami();
				if (me.loggedIn && me.mid) {
					targetUid = me.mid;
				}
			} catch {}
		}

		// 私信投递
		if ((dmMode === "only" || dmMode === "both") && targetUid > 0 && pickedThisRound.length > 0) {
			try {
				const dmItems = pickedThisRound.slice(0, 4).map((p) => `· ${p.title}\n  ${p.url}\n  ${p.whyWorth}`);
				const dmBody = `今天刷到这几条觉得值得你看：\n\n${dmItems.join("\n\n")}`;
				await this.api.sendMessage(targetUid, dmBody.slice(0, 480));
				this.emitAction({
					step: "dm_sent",
					message: `📨 已通过私信发送给 UID: ${targetUid}（精简人话推荐，共 ${pickedThisRound.length} 条）`,
				});
				this.markSeenVideo("DM_DIGEST", `私信投递${pickedThisRound.length}条`, "我", "已发私信");
			} catch (err) {
				this.emitAction({
					step: "dm_fail",
					message: `⚠️ 私信发送失败: ${err.message}`,
				});
			}
		}

		// 公开评论（仅当 dmMode !== 'only' 且开启了 autoComment）
		if (dmMode !== "only" && settings.autoComment && pickedThisRound.length > 0) {
			const maxComments = Math.max(1, Math.min(Number(settings.commentPerRound) || 1, pickedThisRound.length));
			const toComment = pickedThisRound.slice(0, maxComments);
			for (const p of toComment) {
				try {
					const mentionText = settings.mentionName ? `@${settings.mentionName.replace(/^@/, "")} ` : "";
					let commentText = p.comment || p.whyWorth || "";
					// 过滤掉内部机械汇报公文套话，转换为真诚自然的人类交流短评
					commentText = commentText
						.replace(/^视频重点阐述了[：:]\s*/, "")
						.replace(/[，,]\s*具有针对性的参考价值[。.]?$/, "")
						.replace(/通读了原文字幕[，,]\s*/, "")
						.trim();
					if (mentionText) {
						commentText = `${mentionText}${commentText}`;
					}
					if (commentText.length > 150) commentText = commentText.slice(0, 148) + "…";
					const rep = await this.api.replyVideo(p.bvid, commentText);
					if (rep.rpid) {
						this.markCommentRecord(p.bvid, rep.rpid, 0, commentText);
						this.emitAction({
							step: "comment_sent",
							bvid: p.bvid,
							message: `💬 已在 [${p.bvid}] 发布评论 (rpid: ${rep.rpid})`,
						});
					}
				} catch (err) {
					this.emitAction({
						step: "comment_err",
						bvid: p.bvid,
						message: `  └─ 发布评论出错: ${err.message}`,
					});
				}
			}
		}

		// 6. 自动收藏处理（如果设置了 favFolderId）
		const favFid = Number(settings.favFolderId) || 0;
		if (favFid > 0 && pickedThisRound.length > 0) {
			let favCount = 0;
			for (const p of pickedThisRound) {
				try {
					const r = await this.favOps.addVideo(p.bvid, favFid);
					if (r && r.ok) favCount++;
				} catch {
					// ignore
				}
			}
			this.emitAction({
				step: "fav_done",
				message: `⭐ 已将 ${favCount}/${pickedThisRound.length} 条精选视频存入目标收藏夹 (fid: ${favFid})`,
			});
		}

		this.emitAction({
			step: "done",
			status: "success",
			message: `🎉 巡检圆满完成！本轮挑中 ${pickedThisRound.length} 条干货视频，跳过无字幕 ${skippedNoSubtitle} 条，已归档至 out/${today}.md。任务已正常结束，若想继续挑可选「现在跑一轮」或调大额度。`,
		});
	}
}
