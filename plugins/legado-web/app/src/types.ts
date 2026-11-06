export interface SearchRule {
	bookList?: string;
	name?: string;
	author?: string;
	kind?: string;
	wordCount?: string;
	lastChapter?: string;
	intro?: string;
	coverUrl?: string;
	bookUrl?: string;
}

export interface BookInfoRule {
	init?: string;
	name?: string;
	author?: string;
	kind?: string;
	wordCount?: string;
	lastChapter?: string;
	intro?: string;
	coverUrl?: string;
	tocUrl?: string;
}

export interface TocRule {
	chapterList?: string;
	chapterName?: string;
	chapterUrl?: string;
	isVolume?: string;
	updateTime?: string;
	nextTocUrl?: string;
}

export interface ContentRule {
	content?: string;
	nextContentUrl?: string;
	webJs?: string;
	sourceRegex?: string;
	replaceRegex?: string;
	imageStyle?: string;
}

export interface ExploreRule {
	bookList?: string;
	name?: string;
	author?: string;
	kind?: string;
	intro?: string;
	coverUrl?: string;
	bookUrl?: string;
}

export interface BookSource {
	bookSourceUrl: string;
	bookSourceName: string;
	bookSourceGroup?: string;
	bookSourceType?: number;
	bookUrlPattern?: string;
	enabled?: boolean;
	enabledExplore?: boolean;
	jsLib?: string;
	header?: string;
	loginUrl?: string;
	loginCheckJs?: string;
	exploreUrl?: string;
	searchUrl?: string;
	ruleExplore?: ExploreRule;
	ruleSearch?: SearchRule;
	ruleBookInfo?: BookInfoRule;
	ruleToc?: TocRule;
	ruleContent?: ContentRule;
	[k: string]: unknown;
}

export interface SearchBook {
	bookSourceUrl: string;
	bookSourceName: string;
	name: string;
	author: string;
	kind?: string;
	intro?: string;
	coverUrl?: string;
	bookUrl: string;
	wordCount?: string;
	lastChapter?: string;
}

export interface BookInfo {
	name?: string;
	author?: string;
	kind?: string;
	intro?: string;
	coverUrl?: string;
	tocUrl: string;
	lastChapter?: string;
	wordCount?: string;
}

export interface Chapter {
	name: string;
	url: string;
	isVolume?: boolean;
	updateTime?: string;
}

export interface FetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	charset?: string;
}
