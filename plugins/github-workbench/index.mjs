import { spawn } from "node:child_process";

const PAGE_SIZE = 50;
const MAX_OUTPUT = 4 * 1024 * 1024;
const FILTERS = {
	"review-requested": "is:open is:pr review-requested:@me",
	assigned: "is:open assignee:@me",
	authored: "is:open author:@me",
	mentioned: "is:open mentions:@me",
	repository: "is:open",
	custom: "",
};

function invalid(message) {
	return Object.assign(new Error(message), { status: 400 });
}

export function validateRepo(value) {
	if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(value) || value.length > 200) {
		throw invalid("仓库格式应为 owner/repo。");
	}
	if (value.split("/")[1] === "." || value.split("/")[1] === "..") throw invalid("仓库名称无效。");
	return value;
}

function validateNumber(value) {
	const number = String(value ?? "");
	if (!/^[1-9]\d{0,9}$/.test(number)) throw invalid("PR / Issue 编号无效。");
	return number;
}

function text(value, max = 16000) {
	const raw = String(value ?? "");
	return raw.length > max ? `${raw.slice(0, max)}\n[内容已截断，请在 GitHub 查看全文]` : raw;
}

function redact(value) {
	return String(value).replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]");
}

export function createGhRunner({ spawnImpl = spawn, timeoutMs = 25000 } = {}) {
	const children = new Set();
	let disposed = false;
	return {
		run(args, { cwd, input } = {}) {
			if (disposed) return Promise.reject(new Error("插件已卸载。"));
			return new Promise((resolve, reject) => {
				let child;
				let timer;
				let settled = false;
				let stdout = "";
				let stderr = "";
				let bytes = 0;
				const finish = (error, result) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					children.delete(child);
					if (error && child) child.kill();
					error ? reject(error) : resolve(result);
				};
				try {
					child = spawnImpl("gh", args, {
						cwd,
						shell: false,
						windowsHide: true,
						stdio: ["pipe", "pipe", "pipe"],
						env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" },
					});
				} catch (error) {
					finish(error);
					return;
				}
				const abort = (message) => {
					finish(new Error(message));
					child.kill();
				};
				children.add(child);
				timer = setTimeout(() => abort("GitHub 请求超时，请检查网络后重试。"), timeoutMs);
				const collect = (stream) => (chunk) => {
					bytes += Buffer.byteLength(chunk);
					if (bytes > MAX_OUTPUT) return abort("GitHub 返回内容过大，请缩小搜索范围。");
					if (stream === "out") stdout += chunk;
					else stderr += chunk;
				};
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", collect("out"));
				child.stderr.on("data", collect("err"));
				child.on("error", (error) =>
					finish(
						new Error(
							error.code === "ENOENT"
								? "未找到 GitHub CLI。请安装 gh，并在服务所在机器运行 gh auth login。"
								: redact(error.message),
						),
					),
				);
				child.on("close", (code) => {
					if (code !== 0) return finish(new Error(redact(text(stderr || `gh 退出码 ${code}`, 1500))));
					try {
						finish(null, JSON.parse(stdout));
					} catch {
						finish(new Error("GitHub 返回了无效的 JSON。"));
					}
				});
				child.stdin.on("error", (error) => finish(new Error(redact(error.message))));
				child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
			});
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const child of children) child.kill();
			children.clear();
		},
	};
}

function normalizeItem(item, repo) {
	const repository = repo || String(item.repository_url ?? "").split("/repos/")[1];
	return {
		repo: repository,
		number: item.number,
		kind: item.pull_request ? "pr" : "issue",
		title: text(item.title, 1000),
		state: item.state,
		url: `https://github.com/${repository}/${item.pull_request ? "pull" : "issues"}/${item.number}`,
		author: item.user?.login ?? "ghost",
		updatedAt: item.updated_at,
		labels: (item.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)).slice(0, 20),
		commentCount: item.comments ?? 0,
	};
}

export function createGitHubService(run, getCwd) {
	const api = (endpoint, method = "GET", input) =>
		run(
			[
				"api",
				"--hostname",
				"github.com",
				"--method",
				method,
				"-H",
				"Accept: application/vnd.github+json",
				endpoint,
				...(input === undefined ? [] : ["--input", "-"]),
			],
			{ input },
		);
	return {
		async status() {
			const cwd = getCwd();
			const user = await api("user");
			let repo = "";
			try {
				repo = validateRepo((await run(["repo", "view", "--json", "nameWithOwner"], { cwd })).nameWithOwner);
			} catch {}
			return { login: user.login, repo };
		},
		async items(query) {
			const filter = query.filter ?? "repository";
			if (!Object.hasOwn(FILTERS, filter)) throw invalid("未知的待办分类。");
			const repo = query.repo ? validateRepo(query.repo) : "";
			if (filter === "repository" && !repo) throw invalid("请填写仓库 owner/repo，或选择个人待办分类。");
			const page = Number(query.page ?? 1);
			if (!Number.isInteger(page) || page < 1 || page > 20)
				throw invalid("页码范围为 1–20（GitHub 搜索最多 1000 条）。");
			if (typeof query.q !== "undefined" && (typeof query.q !== "string" || query.q.length > 1000))
				throw invalid("搜索条件最多 1000 字。");
			let q = [FILTERS[filter], repo ? `repo:${repo}` : "", query.q?.trim()].filter(Boolean).join(" ");
			if (q.includes(":@me")) {
				const user = await api("user");
				q = q.replace(/:(@me)(?=\s|$)/g, `:${user.login}`);
			}
			if (!q) throw invalid("请输入 GitHub 搜索条件，例如 is:open is:issue label:bug。");
			const result = await api(
				`search/issues?${new URLSearchParams({ q, sort: "updated", order: "desc", per_page: String(PAGE_SIZE), page: String(page) })}`,
			);
			return {
				items: (result.items ?? []).map((item) => normalizeItem(item)),
				page,
				total: Math.min(result.total_count ?? 0, 1000),
				hasMore: page < 20 && page * PAGE_SIZE < Math.min(result.total_count ?? 0, 1000),
				incomplete: Boolean(result.incomplete_results),
			};
		},
		async detail(query) {
			const repo = validateRepo(query.repo);
			const number = validateNumber(query.number);
			const root = `repos/${repo}/issues/${number}`;
			const issue = await api(root);
			const count = issue.comments ?? 0;
			const comments = count ? await api(`${root}/comments?per_page=30&page=${Math.ceil(count / 30)}`) : [];
			const item = {
				...normalizeItem(issue, repo),
				body: text(issue.body),
				assignees: (issue.assignees ?? []).map((user) => user.login),
				comments: comments.map((comment) => ({
					author: comment.user?.login ?? "ghost",
					body: text(comment.body, 4000),
					createdAt: comment.created_at,
				})),
				commentsTruncated: count > comments.length,
			};
			if (issue.pull_request) {
				const pr = await api(`repos/${repo}/pulls/${number}`);
				item.pr = {
					draft: pr.draft,
					merged: pr.merged,
					mergeable: pr.mergeable,
					mergeableState: pr.mergeable_state,
					base: pr.base?.ref,
					head: pr.head?.ref,
					additions: pr.additions,
					deletions: pr.deletions,
					changedFiles: pr.changed_files,
					reviewers: (pr.requested_reviewers ?? []).map((user) => user.login),
				};
			}
			return { item };
		},
		async comment(body) {
			const repo = validateRepo(body.repo);
			const number = validateNumber(body.number);
			if (typeof body.body !== "string" || !body.body.trim() || body.body.length > 60000)
				throw invalid("评论不能为空，且最多 60000 字。");
			await api(`repos/${repo}/issues/${number}/comments`, "POST", { body: body.body });
			return {};
		},
		async state(body) {
			const repo = validateRepo(body.repo);
			const number = validateNumber(body.number);
			if (body.state !== "open" && body.state !== "closed") throw invalid("状态只能是 open 或 closed。");
			await api(`repos/${repo}/issues/${number}`, "PATCH", { state: body.state });
			return {};
		},
	};
}

export function registerRoutes(host, service) {
	const off = [];
	for (const [method, path, action] of [
		["GET", "/status", () => service.status()],
		["GET", "/items", (req) => service.items(req.query ?? {})],
		["GET", "/detail", (req) => service.detail(req.query ?? {})],
		["POST", "/comment", (req) => service.comment(req.body ?? {})],
		["POST", "/state", (req) => service.state(req.body ?? {})],
	]) {
		off.push(
			host.route(method, path, (req, res) => {
				void Promise.resolve()
					.then(() => action(req))
					.then((result) => res.json({ ok: true, ...result }))
					.catch((error) =>
						res.status(error.status === 400 ? 400 : 502).json({ ok: false, error: redact(text(error.message, 1600)) }),
					);
			}),
		);
	}
	return () => off.forEach((unregister) => unregister());
}

export default {
	activate(host) {
		const runner = createGhRunner();
		const unregister = registerRoutes(
			host,
			createGitHubService(runner.run, () => host.cwd),
		);
		return () => {
			unregister();
			runner.dispose();
		};
	},
};
