export type McpMarketCategory = "official" | "marketplace" | "community" | "directory";

export interface McpMarketItem {
	id: string;
	name: string;
	nameZh: string;
	description: string;
	descriptionZh: string;
	url: string;
	category: McpMarketCategory;
	region?: "cn" | "global";
	tags?: string[];
	author?: string;
	badge?: string;
	badgeZh?: string;
}

export const MCP_MARKETS: McpMarketItem[] = [
	{
		id: "awesome-mcp-zh",
		name: "Awesome MCP ZH (中文精选合集)",
		nameZh: "Awesome MCP 中文精选市场与资源列表",
		description:
			"The most popular Chinese curated list of Model Context Protocol servers, client integrations, and practical tutorials.",
		descriptionZh:
			"7,700+ 星标的中文最全 MCP 精选合集：涵盖高德、飞书、微信、音视频、知识库等各类国内 MCP 插件列表与配置教程。",
		url: "https://github.com/yzfly/Awesome-MCP-ZH",
		category: "community",
		region: "cn",
		author: "yzfly",
		badge: "7.7k★",
		badgeZh: "7700星推荐",
		tags: ["中文精选", "国内生态", "7700+星", "教程指南"],
	},
	{
		id: "awesome-china-mcp",
		name: "Awesome China MCP (国内常用应用市场)",
		nameZh: "国内常用应用 MCP 专区列表",
		description:
			"Curated index of MCP servers for Chinese apps: connect AI agents to AMap, 12306, Xiaohongshu, Feishu, Yuque, A-shares and more.",
		descriptionZh:
			"专为国内生态打造的 MCP 列表专区：收录高德地图、12306 查票、小红书、飞书、语雀文档、A股量化等常用国内服务。",
		url: "https://github.com/zackchewa/awesome-china-mcp",
		category: "community",
		region: "cn",
		author: "zackchewa",
		badge: "China Apps",
		badgeZh: "国内应用专区",
		tags: ["国内常用", "高德地图", "12306", "飞书", "小红书"],
	},
	{
		id: "awesome-mcp-wong2",
		name: "Awesome MCP Servers (wong2)",
		nameZh: "wong2 精选 MCP 服务与客户端合集",
		description:
			"High-quality curated collection of MCP servers, clients, multi-language libraries, and developer tutorials.",
		descriptionZh: "4,300+ 星标的经典精选合集，系统化整理了全球与中文优秀 MCP 服务实现、适配客户端与开发库。",
		url: "https://github.com/wong2/awesome-mcp-servers",
		category: "community",
		region: "cn",
		author: "wong2",
		badge: "4.3k★",
		badgeZh: "4300星精选",
		tags: ["中文精选", "多语言库", "客户端", "开发指南"],
	},

	{
		id: "smithery-ai",
		name: "Smithery.ai MCP Registry",
		nameZh: "Smithery 3,000+ 在线插件市场",
		description:
			"The premier registry for discovering, deploying, and connecting 3,000+ Model Context Protocol servers with live search and CLI commands.",
		descriptionZh: "主流的 MCP 服务器发现与注册市场，收录 3,000+ 个可在线检索与一键配置的 MCP 服务及连接命令。",
		url: "https://smithery.ai/",
		category: "marketplace",
		region: "global",
		author: "Smithery",
		badge: "3000+ Servers",
		badgeZh: "3000+插件",
		tags: ["Marketplace", "Registry", "3000+ Servers", "One-Click"],
	},
	{
		id: "mcpservers-org",
		name: "mcpservers.org (9,800+ Servers)",
		nameZh: "mcpservers.org 综合插件市场",
		description:
			"Extensive directory and live search engine showcasing 9,800+ Model Context Protocol servers across categories.",
		descriptionZh: "汇聚 9,800+ 款开源 MCP 服务器的大型在线市场，支持按分类检索、星标排行与一键复制配置命令。",
		url: "https://mcpservers.org/",
		category: "marketplace",
		region: "global",
		author: "mcpservers.org",
		badge: "9800+ Servers",
		badgeZh: "9800+插件",
		tags: ["Directory", "9800+ Servers", "Search", "Verified"],
	},
	{
		id: "glama-mcp",
		name: "Glama MCP Marketplace",
		nameZh: "Glama 开发者 MCP 市场",
		description:
			"Explore hundreds of verified community MCP servers with live server status, developer reviews, configuration snippets, and security insights.",
		descriptionZh: "发现经过检验的社区 MCP 服务器，支持在线服务状态监测、开发者评分、配置代码与安全合规提示。",
		url: "https://glama.ai/mcp/servers",
		category: "marketplace",
		region: "global",
		author: "Glama",
		badge: "Market",
		badgeZh: "开发者市场",
		tags: ["Marketplace", "Verified", "Inspect", "Reviews"],
	},
	{
		id: "pulsemcp",
		name: "PulseMCP Ecosystem Hub",
		nameZh: "PulseMCP 实时生态与趋势雷达",
		description:
			"Weekly updated directory of trending MCP servers, tools, news, clients, and active developer projects in the ecosystem.",
		descriptionZh: "每周动态更新的 MCP 趋势雷达与目录，汇集每周热门服务器、实用开发工具、适配客户端与生态快讯。",
		url: "https://www.pulsemcp.com/",
		category: "directory",
		region: "global",
		author: "PulseMCP",
		badge: "Trending",
		badgeZh: "实时趋势",
		tags: ["Directory", "Trending", "Weekly Top", "Ecosystem"],
	},
	{
		id: "mcp-so",
		name: "MCP.so Directory",
		nameZh: "MCP.so 综合分类导航目录",
		description:
			"Comprehensive index of Model Context Protocol servers, searchable by category, tags, hosting requirements, and platform integrations.",
		descriptionZh: "全面的 MCP 服务器目录索引，支持按业务分类、协议类型、部署依赖与集成目标精准筛选检索。",
		url: "https://mcp.so/",
		category: "directory",
		region: "global",
		author: "MCP.so",
		badge: "Directory",
		badgeZh: "分类导航",
		tags: ["Directory", "Search", "Index", "Categorized"],
	},
	{
		id: "mcp-get",
		name: "mcp-get Registry",
		nameZh: "mcp-get 发现与包管理平台",
		description:
			"Package discovery and CLI registry for community MCP servers, making it easy to find and run verified servers across environments.",
		descriptionZh: "面向开发者打造的 MCP 服务发现与命令行管理平台，便于快速定位并执行跨环境 MCP 服务。",
		url: "https://mcp-get.com/",
		category: "marketplace",
		region: "global",
		author: "mcp-get",
		badge: "Registry",
		badgeZh: "包检索",
		tags: ["Registry", "Package Manager", "CLI"],
	},
	{
		id: "awesome-mcp-punkpeye",
		name: "Awesome MCP Servers (Punkpeye)",
		nameZh: "Punkpeye 1.6万星全球开源合集",
		description:
			"A highly-rated curated list of Model Context Protocol servers, frameworks, and tools categorized by capability.",
		descriptionZh: "GitHub 上 16,000+ 星标的最权威开源 MCP 清单，按开发、数据库、文件、搜索等数十个能力分类列出。",
		url: "https://github.com/punkpeye/awesome-mcp-servers",
		category: "community",
		region: "global",
		author: "Punkpeye & Contributors",
		badge: "16k★",
		badgeZh: "1.6万星合集",
		tags: ["Awesome", "GitHub", "Curated", "Global Top"],
	},
	{
		id: "mcp-official-servers",
		name: "Anthropic MCP Reference Servers",
		nameZh: "Anthropic 官方核心参考服务集目录",
		description:
			"Anthropic's official open-source collection of reference MCP servers: filesystem, fetch, memory, sqlite, git, github, postgres, and more.",
		descriptionZh:
			"Anthropic 官方开源的核心参考服务仓库目录：文件系统、网页抓取、持久记忆图谱、SQLite、Git、GitHub 等官方服务清单。",
		url: "https://github.com/modelcontextprotocol/servers",
		category: "official",
		region: "global",
		author: "Anthropic",
		badge: "Official",
		badgeZh: "官方参考",
		tags: ["Official", "Reference", "GitHub", "Core"],
	},
	{
		id: "github-topic-mcp",
		name: "GitHub: #model-context-protocol",
		nameZh: "GitHub 全球开源 MCP 仓库实时列表",
		description:
			"Live directory of open-source repositories tagged with #model-context-protocol on GitHub, sorted by stars and recent activity.",
		descriptionZh: "GitHub 官方标签直达，全球开源智能体 MCP 仓库实时列表，可按 Star 数和最新活跃度在线浏览。",
		url: "https://github.com/topics/model-context-protocol",
		category: "directory",
		region: "global",
		author: "GitHub Community",
		badge: "GitHub Topic",
		badgeZh: "全球开源",
		tags: ["GitHub", "Topic", "Open Source", "Real-Time"],
	},
	{
		id: "github-topic-mcp-server",
		name: "GitHub: #mcp-server",
		nameZh: "GitHub #mcp-server 实时开源服务列表",
		description:
			"Live directory of thousands of open-source MCP server implementations on GitHub, filtered by #mcp-server topic.",
		descriptionZh: "GitHub 官方 #mcp-server 标签实时聚合，直达全球开发者开源的具体 MCP Server 代码仓库列表。",
		url: "https://github.com/topics/mcp-server",
		category: "directory",
		region: "global",
		author: "GitHub Community",
		badge: "GitHub Topic",
		badgeZh: "服务实现",
		tags: ["GitHub", "Topic", "mcp-server", "Real-Time"],
	},
];

export interface PublicMcpServer {
	id: string;
	name: string;
	nameZh: string;
	description: string;
	descriptionZh: string;
	category: "core" | "dev" | "db" | "search" | "automation" | "tools" | "productivity" | "social";
	transport: "stdio" | "http";
	command?: string;
	args?: string[];
	env?: Array<{ key: string; value: string; placeholder?: string; required?: boolean }>;
	url?: string;
	package: string;
	official: boolean;
	requiresKey: boolean;
	homepage: string;
	region: "cn" | "global";
	tags?: string[];
	badge?: string;
	badgeZh?: string;
}

export const PUBLIC_MCP_SERVERS: PublicMcpServer[] = [
	{
		id: "amap",
		name: "AMap (高德地图)",
		nameZh: "高德地图位置服务",
		description: "Official AMap location services: geocoding, POI search, transit route planning, and weather queries.",
		descriptionZh: "高德地图官方开放平台位置服务，提供地址解析编码、周边 POI 检索、驾车与公交路线规划及实时天气。",
		category: "tools",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@amap/amap-maps-mcp-server"],
		package: "@amap/amap-maps-mcp-server",
		env: [
			{
				key: "AMAP_MAPS_KEY",
				value: "",
				placeholder: "高德开放平台 Web 服务 Key",
				required: true,
			},
		],
		official: true,
		requiresKey: true,
		homepage: "https://lbs.amap.com",
		region: "cn",
		tags: ["高德地图", "地理位置", "路线规划", "国内生态"],
		badge: "Official",
		badgeZh: "高德官方",
	},
	{
		id: "feishu",
		name: "Feishu / Lark (飞书)",
		nameZh: "飞书办公协同与多维表格",
		description:
			"Official Feishu/Lark OpenAPI MCP: read/write Bitable, send bot messages, access cloud docs and calendars.",
		descriptionZh:
			"飞书官方开放平台 OpenAPI 集成：支持多维表格增删改查、发送机器人卡片消息、读取飞书云文档与日程管理。",
		category: "productivity",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@larksuiteoapi/lark-mcp"],
		package: "@larksuiteoapi/lark-mcp",
		env: [
			{
				key: "FEISHU_APP_ID",
				value: "",
				placeholder: "cli_axxxxxxxxxxxxxxx",
				required: true,
			},
			{
				key: "FEISHU_APP_SECRET",
				value: "",
				placeholder: "飞书自建应用 Secret",
				required: true,
			},
		],
		official: true,
		requiresKey: true,
		homepage: "https://github.com/larksuite/lark-openapi-mcp",
		region: "cn",
		tags: ["飞书", "多维表格", "协同办公", "国内生态"],
		badge: "Official",
		badgeZh: "飞书官方",
	},
	{
		id: "filesystem",
		name: "Filesystem",
		nameZh: "本地安全文件系统",
		description:
			"Secure file operations allowing reading, writing, and directory traversal with configurable allowed paths.",
		descriptionZh: "Anthropic 官方核心文件系统工具，支持受限目录下的安全文件读写、创建与遍历。",
		category: "core",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
		package: "@modelcontextprotocol/server-filesystem",
		official: true,
		requiresKey: false,
		homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
		region: "global",
		tags: ["Official", "Filesystem", "Core", "Anthropic"],
		badge: "Official",
		badgeZh: "官方核心",
	},
	{
		id: "fetch",
		name: "Web Fetch",
		nameZh: "网页抓取与 Markdown 提取",
		description: "Fetches and converts web pages to clean Markdown for model consumption, analysis, and research.",
		descriptionZh: "Anthropic 官方网页抓取工具，抓取指定 URL 页面并提取为结构化净室 Markdown。",
		category: "search",
		transport: "stdio",
		command: "uvx",
		args: ["mcp-server-fetch"],
		package: "mcp-server-fetch",
		official: true,
		requiresKey: false,
		homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
		region: "global",
		tags: ["Official", "Web Scraping", "Markdown", "Anthropic"],
		badge: "Official",
		badgeZh: "官方工具",
	},
	{
		id: "memory",
		name: "Knowledge Graph Memory",
		nameZh: "持久化知识记忆图谱",
		description:
			"Knowledge-graph based persistent memory system storing entities and relations locally across chat sessions.",
		descriptionZh: "Anthropic 官方知识图谱记忆服务，将实体与关联关系持久化于本地，赋予 AI 跨会话长期记忆。",
		category: "core",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-memory"],
		package: "@modelcontextprotocol/server-memory",
		official: true,
		requiresKey: false,
		homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
		region: "global",
		tags: ["Official", "Memory", "Knowledge Graph", "Anthropic"],
		badge: "Official",
		badgeZh: "长期记忆",
	},
	{
		id: "github",
		name: "GitHub",
		nameZh: "GitHub 仓库协作与代码管理",
		description: "Interact with GitHub repositories, search code, inspect issues, and review pull requests.",
		descriptionZh: "Anthropic 官方 GitHub 工具，支持检索代码、列出与修改 Issue、检查 PR 变更与提交评审意见。",
		category: "dev",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-github"],
		package: "@modelcontextprotocol/server-github",
		env: [
			{
				key: "GITHUB_PERSONAL_ACCESS_TOKEN",
				value: "",
				placeholder: "ghp_xxxxxxxxxxxxxxxxxxxx",
				required: true,
			},
		],
		official: true,
		requiresKey: true,
		homepage: "https://github.com/modelcontextprotocol/servers",
		region: "global",
		tags: ["Official", "GitHub", "DevOps", "Code Review"],
		badge: "Official",
		badgeZh: "研发协同",
	},
	{
		id: "sqlite",
		name: "SQLite Database",
		nameZh: "SQLite 数据库查询与分析",
		description: "Query and inspect local SQLite databases with automatic schema discovery and safety checks.",
		descriptionZh: "连接并查询本地 SQLite 数据库文件，支持执行 SQL 语句、表结构探查与业务数据分析。",
		category: "db",
		transport: "stdio",
		command: "uvx",
		args: ["mcp-server-sqlite", "--db-path", "./app.db"],
		package: "mcp-server-sqlite",
		official: true,
		requiresKey: false,
		homepage: "https://github.com/modelcontextprotocol/servers",
		region: "global",
		tags: ["Official", "SQLite", "SQL", "Database"],
		badge: "Official",
		badgeZh: "数据库",
	},
	{
		id: "postgres",
		name: "PostgreSQL Database",
		nameZh: "PostgreSQL 数据库管理",
		description: "Read-only and read-write operations on PostgreSQL databases with schema inspection.",
		descriptionZh: "连接 PostgreSQL 数据库，支持执行安全参数化查询、表与索引分析及数据检索。",
		category: "db",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:password@localhost:5432/dbname"],
		package: "@modelcontextprotocol/server-postgres",
		official: true,
		requiresKey: false,
		homepage: "https://github.com/modelcontextprotocol/servers",
		region: "global",
		tags: ["Official", "PostgreSQL", "Database", "Backend"],
		badge: "Official",
		badgeZh: "关系型数据库",
	},
	{
		id: "tavily",
		name: "Tavily AI Search",
		nameZh: "Tavily 智能体深度搜索引擎",
		description: "Search engine built specifically for AI agents, providing synthesized real-time web results.",
		descriptionZh: "专为 AI 智能体设计的搜索引擎，提供实时、高相关度、结构化且包含引文出处的互联网检索结果。",
		category: "search",
		transport: "stdio",
		command: "npx",
		args: ["-y", "tavily-mcp"],
		package: "tavily-mcp",
		env: [
			{
				key: "TAVILY_API_KEY",
				value: "",
				placeholder: "tvly-xxxxxxxxxxxxxxxxxxxx",
				required: true,
			},
		],
		official: false,
		requiresKey: true,
		homepage: "https://github.com/tavily-ai/tavily-mcp",
		region: "global",
		tags: ["Tavily", "AI Search", "Agent Engine", "Deep Research"],
		badge: "AI Native",
		badgeZh: "智能体搜索",
	},
	{
		id: "playwright",
		name: "Playwright Browser",
		nameZh: "Playwright 浏览器自动化 (微软)",
		description:
			"Official Microsoft Playwright MCP tools: full-fidelity browser automation, screenshots, clicks and form inputs.",
		descriptionZh: "微软官方维护的 Playwright 自动化工具：驱动无头/有头浏览器交互、全页截长图与复杂动态页面操作。",
		category: "automation",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@playwright/mcp"],
		package: "@playwright/mcp",
		official: true,
		requiresKey: false,
		homepage: "https://github.com/microsoft/playwright-mcp",
		region: "global",
		tags: ["Microsoft", "Playwright", "Browser", "Automation"],
		badge: "Official",
		badgeZh: "微软官方",
	},
];
