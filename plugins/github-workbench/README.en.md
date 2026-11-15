**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# GitHub workbench

Handles PRs and Issues in the「工作台」(Workbench) tab next to「文件列表」(File list) on the right, side by side with the conversation. Reuses the GitHub CLI login of the machine running the service; no separate token is needed.

## Usage

1. Install [GitHub CLI](https://cli.github.com/) on the machine running the pi-web-ui service and run `gh auth login --hostname github.com`.
2. Install「GitHub 工作台」(GitHub workbench) from the plugin marketplace. Local development install: `node bin/pi-web-ui.mjs install ./plugins/github-workbench --data-dir <实际数据目录>` (actual data directory). Refresh the plugin list after installing.
3. Click the **工作台** (Workbench) tab next to「文件列表」(File list) on the right. The project repository is detected automatically when the workbench opens; personal todos work even outside a Git repository.
4. Choose repository todos, waiting for my review, assigned to me, created by me, mentions me, or a custom search. Switch type with「全部 / PR / Issue」(All / PR / Issue) and click the search icon to expand search conditions. Personal categories are equally limited by the repository input; clearing the repository queries across repositories.
5. In a narrow sidebar, click an item to open details, then「返回列表」(Back to list) to keep browsing; once the sidebar is widened to 480px, list and details show side by side automatically. Switching between the file list and the workbench preserves filters, page, selected item, scroll position, and comment draft.

Search supports GitHub search syntax, e.g. `is:pr draft:false`, `is:issue label:bug`, `is:closed`. Default categories are already limited to open items; choose「自定义搜索」(Custom search) to query historical states. Search is sorted by update time descending, 50 per page, browsing at most the first 1000 items GitHub search allows. Searches that do not return everything prompt you to narrow the range.

## Operations

- **View details**: click an item to see the body, labels, and latest page of comments. PRs also show source/target branch, draft and merge state, changed-file stats, and requested reviewers. The body shows as plain text, keeping the Markdown source; full diffs, CI, and line-level review are viewed through GitHub links.
- **Quote into conversation / hand to the AI**: add a short quote attachment to the current conversation, e.g. `PR #749 · owner/repo`, along with the GitHub link, then switch back to the conversation. The user writes and sends the instruction; existing body and attachments are preserved, and clicking the same item again de-duplicates.
- **Post a comment**: type a Markdown-capable comment and click publish; it posts to the selected item as the current `gh` account. Failures keep the draft; after switching items or returning to the file list, each draft is still kept separately. Drafts live in page memory only and are cleared by a refresh or plugin reload. Switching tabs while publishing waits for the original operation, avoiding duplicate submissions. After a network interruption, confirm on GitHub whether it posted before retrying.
- **Close / reopen**: change the state of the selected PR/Issue. Merged PRs get no reopen button. The list updates the state, and a re-search filters by conditions.

## Implementation conventions

- The backend has only `GET /status`, `GET /items`, `GET /detail`, `POST /comment`, `POST /state`, all mounted under the host-authenticated `/plugins-api/github-workbench`. The client preserves the app root path from the bundle URL.
- `gh api --hostname github.com` runs as an async child process, with no shell and no interactive prompts; written content goes in as JSON stdin, and comments are never concatenated onto the command line. GitHub Enterprise is not supported yet.
- Repository, number, state, comment, search length, and pagination are all validated server-side. Requests time out at 25 seconds, output is capped at 4 MiB, and uninstall terminates the child process; detail bodies and comments have length caps with truncation marked explicitly.
- Uses the existing `compose` host bridge to add `mode: "quote"` attachments; a quote contains only type, number, repository, and link; the AI can read the latest details as the user asks. When the current conversation is unavailable it shows an error and never creates one on its own.
- Plugin version `0.1.4`, no npm dependencies added. Permissions are only `ui` and `http`. Registers the workbench tab with a GitHub SVG icon via `rightpanel.tabs`; the client's `styles.mjs` uses host theme variables and container queries, not browser window width.

Targeted verification: `npx vitest run tests/unit/github-workbench.test.ts tests/unit/github-workbench-client.test.ts`.
