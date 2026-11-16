**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# sftp — project-level SFTP sync

Transfer between the local workspace and a remote server: **config lives in the project's own `.pi/`**, differences
are computed before anything is sent, deletions go to the trash first, and credentials are stored only as references,
never as plaintext. The panel uploads/downloads a single file or a whole directory tree by hand; on the AI side there
is **one** action-style `sftp` tool, so the model can configure connections, inspect diffs, upload and download, and
edit remote files on its own.

To keep it out of the UI and out of the way: no plugin installed = it does not exist. Once installed the UI gains
**exactly one entry point** — the 「SFTP 同步」(SFTP Sync) view tab in the top bar (it takes no bottom-bar slot) — plus
two more file context-menu items, 「上传到远端 / 上传此目录」(Upload to remote / Upload this directory) (clicking one
opens the panel and shows progress inline). Sync status: in-flight state is folded into the button label (scan phase is
`SFTP 扫描 1234`, transfer phase is `SFTP 3/10`), hover for details, and completion/failure/stop each send a
notification.

---

## SSH host trust

On first connection the panel shows the host, port, key type, SHA256 fingerprint and where `known_hosts` is stored.
Verify the fingerprint independently through the server console or an administrator, tick the confirmation, then click
「信任并重新连接」(Trust and reconnect). The plugin saves the record on **the machine running the pi-web-ui service**
(default `~/.ssh/known_hosts`, override with `PI_WEB_SSH_KNOWN_HOSTS`), then re-reads the remote directory; uploads,
deletions and other operations that failed earlier must be started again.

If the key changes, the panel warns explicitly and requires you to confirm that a server reinstall or key rotation has
been verified before it replaces the old record. Revoked keys cannot be re-trusted through the panel; wildcard or
certificate-authority rules cannot be replaced in the panel either and must be maintained by an administrator. A
confirmation request is valid for five minutes and is bound to the workspace that opened the connection; reconnect
once it expires. A failed save shows an error and never turns off host verification or auto-accepts a new key. AI tools
cannot confirm host trust — do it in the plugin panel.

Authentication follows the current selection: password/secret login never reads a leftover private-key path, and key or
agent login is never overridden by a global password. Changing credentials or switching connections re-establishes the
connection; while a host fingerprint awaits confirmation, the log mentions it only once per minute.

## Config: `.pi/sftp.json` + `.pi/sftp.local.json`

```
<project>/.pi/
├── sftp.json         connection and sync policy — committable, shareable (credentials as references only)
├── sftp.local.json   local overrides (port / private-key path / plaintext password…) — the plugin adds it to .gitignore
└── sftp-trash/       local trash (deletion protection, one directory per batch)
```

Two layers **deep-merged** (local overrides base, arrays replaced wholesale): the team shares one base, each machine
writes only its own deltas. Reads always merge, **writes split by file** — the tool writes whichever field it changed to
whichever file owns it, and never pours local overrides back into base.

```jsonc
// .pi/sftp.json
{
	"version": 1,
	"active": "prod",
	"defaults": {
		"ignore": ["dist", "*.map"], // appended after the plugin's default excludes
		"delete": "none", // none | remote-only | both
		"concurrency": 4, // 1..16, transfer concurrency
	},
	"connections": {
		"dev": {
			"host": "10.0.0.5",
			"port": 22,
			"username": "deploy",
			"remotePath": "/srv/app", // must be an absolute path
			"auth": {
				"method": "key", // password | key | agent (default: inferred from the contents)
				"privateKeyPath": "~/.ssh/id_ed25519",
				"passphrase": "${secret:dev-key-pass}",
			},
		},
		"prod": {
			"host": "203.0.113.10",
			"username": "root",
			"remotePath": "/project/app",
			"auth": { "method": "password", "password": "${secret:prod-password}" },
			// sync only the mapped subtrees (independent trees, no overlap); without mappings it is "workspace root ↔ remotePath"
			"mappings": [{ "local": "web/dist", "remote": "/var/www/app" }],
			"sync": { "direction": "up", "delete": "remote-only", "compare": "mtime+size", "conflict": "newer" },
		},
	},
}
```

**Built-in default excludes** (cannot be pulled back in by negative rules): `.git`, `node_modules`, `.pi`,
`.sftp-trash`, `*.log`, `*.tmp`, plus the internal guardrails `.sftp-trash/` (trash) and `.sftp-tmp-*` (in-flight
transfers) — these are never synced back to either side, otherwise "delete → trash → sent back next run" would loop
forever.

### Credential references (plaintext never enters config)

| Form             | Source                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `${secret:name}` | host-encrypted secret (AES-256-GCM in `<dataDir>`, unreadable if copied to another machine). Written by `sftp_secret` |
| `${env:VAR}`     | process environment variable (injected in CI)                                                                         |
| `${file:~/path}` | read from a file (leading/trailing blank lines trimmed, so `echo xxx > pass` works)                                   |
| any other string | **plaintext**. It works, but `plaintextWarn` raises a warning in the UI and in tool acknowledgements                  |

A malformed reference such as `${env}` **fails loudly** and never silently falls back to an empty password — otherwise
one typo in a variable name degrades into an "authentication failed" symptom that is hard to diagnose.

### Migration

If `.vscode/sftp.json` exists on first activation and the project has not been configured yet, the panel offers an
「导入 .vscode/sftp.json」(Import .vscode/sftp.json) button (equivalent to the AI calling `sftp_secret` before
`sftp_save`). During import plaintext passwords are moved into encrypted secrets and the config file keeps only
`${secret:…}` references.

---

## Sync semantics

**Two-phase: plan → apply.** `sftp_plan` (the 「预览差异」(Preview diff) panel button) only scans and reports; the
manifest has six classes: `add` / `update` / `same` / `local-only` / `remote-only` / `conflict`. `sftp_sync` defaults to
`dryRun`, **moving not a single byte**; only after confirmation does it run with `dryRun: false`.

| Direction | Meaning                                                                                                                                                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up`      | local → remote (deploying code). Whether extra remote files are cleaned up is decided by the delete policy                                                                                                                                                                                                     |
| `down`    | remote → local (pulling back what is on the server). Whether extra local files are cleaned up is decided by the delete policy                                                                                                                                                                                  |
| `both`    | bidirectional. A file present on only one side counts as an "addition" and is copied to the other side (**never deleted**, so "just deleted" is not misread as "new on the other side"); present on both but different → per `sync.conflict` (`newer` compares mtime by default / `local` / `remote` / `skip`) |

| Delete policy    | Allowed action                                                                      |
| ---------------- | ----------------------------------------------------------------------------------- |
| `none` (default) | never delete; extra files are only marked "not cleaned up" in the plan, with reason |
| `remote-only`    | may clean up extra remote files (`up` scenario)                                     |
| `both`           | both directions may clean up                                                        |

**Deletion is never a real delete**: remote files move into `<remotePath>/.sftp-trash/<batch>/`, local files into
`.pi/sftp-trash/<batch>/`, and expired batches are purged per `trashDays`. The `sftp_rm` tool also goes through the trash.

Other safeguards:

- **Cancelable**: the panel's 「停止」(Stop) button (tool side: `action=cancel`) stops **both the scan phase and the
  transfer phase** — a single server-side `AbortController` governs the whole run: once a stop request arrives no new
  files are claimed, in-flight streams are cut, partials are cleaned up; already transferred files are kept and trash
  batches can be rolled back. Cancelling **is not a failure** (it is not written to `failed`), and the `job` is released
  the moment the stop completes, so you can start over immediately (older versions had only a `running` flag and no
  cancel channel: pressing the button did nothing and you had to restart the service);
- **Level-parallel scanning**: local directories at the same level are `readdir`-ed together and files at the same level
  are `stat`-ed together; remote directories at the same level are `readdir`-ed together (one readdir per round trip —
  500 serial directories take hundreds of seconds on a high-latency link). Concurrency comes from the settings page's
  `scanConcurrency` (default 8, 1..32); while scanning the UI shows 「已扫 N 个文件 / M 个目录」(N files / M
  directories scanned) instead of a single 「扫描中…」(Scanning…);
- **Remote fast scan (requires "allow running commands on the remote")**: with exec on, the remote scan first fetches
  the whole tree with **one `find`** (`-printf '%y\t%s\t%T@\t%P\0'`, ignore rules that are bare directory names are
  translated into `-prune`, which also prunes whole `node_modules` trees) — a tree with 399 directories at 10 ms RTT:
  per-directory readdir 1.6 s → one find 12 ms. If the server has no `find`, does not understand `-printf`, returns
  truncated output or mismatched fields, the **whole batch is abandoned** and the scan falls back to per-directory
  readdir (slower but always correct), with the reason written to the plugin log;
- **Small-file batch transfer (requires "allow running commands on the remote")**: a batch of ≥5 small files is sent as
  one tar stream, turning 5~8 round trips per file into a few per batch. **Both ends are streams**: upstream reads and
  sends on the fly (AsyncGenerator → SSH channel, with backpressure), downstream `tar -czf -` unpacks and lands files as
  they arrive — no "whole-package Buffer" ever appears in between. Measured on a 20 MB small-file set: streaming RSS
  +4 MB, the old approach (buffer the whole package first) RSS +40 MB.
  - **Upstream**: local `tarStream()` produces ustar on the fly (it writes the headers itself, no dependency on the host
    tar) → fed into the exec stdin with backpressure → the remote unpacks into a `.sftp-tmp-stage-*` staging directory
    inside the sync root → another `find` verifies the batch size → each file `mv`-ed into place;
  - **Downstream**: one remote `tar -czf - <these files>` → `createGunzip()` + a streaming ustar parser → locally only
    the **rels this batch asked for** are extracted (other members are read and dropped, never written to disk) → each
    file `rename`-ed into place; the local staging area also lives under `.pi/` (same disk, hence atomic);
  - Both directions: sizes verified file by file, the staging area deleted as soon as it is done (internal guardrails
    keep it from being synced back next run), and if any step goes wrong (no tar, gzip/tar cannot unpack, checksum
    mismatch, size mismatch, mv/rename failure) the **whole batch is abandoned and it falls back to per-file transfer**,
    with the reason in the plugin log (`batchTransfer` can be turned off separately);
- **Plan reuse**: `/plan` returns a `planToken`; when the parameters are unchanged the apply call can pass it back and
  reuse that plan, skipping the second full scan (on large trees this is the longest part of "preview → apply"); it
  expires after 5 minutes, is invalidated as soon as parameters/connection change, and is discarded the moment the run
  finishes — rescanning is preferable to transferring the wrong thing;
- **Concurrent streaming**: 4 streams by default, `createReadStream`/`createWriteStream` transfer in chunks and do not
  eat memory (the old approach read whole files into memory and OOM-ed on large ones);
- **Atomic landing**: write `.sftp-tmp-*` first, then `rename` into place (when the remote target already exists it is
  deleted before the rename, to accommodate Windows OpenSSH `mv`, which does not overwrite); an interruption leaves only
  identifiable, cleanable partials;
- **Size verification**: byte counts are compared after transfer, turning silent truncation into an explicit failure;
- **mtime tolerance of 2 seconds**: second-level precision jitter on FAT/NTFS/sshd does not trigger a full re-transfer;
  when the remote does not return mtime it degrades to "same size means identical" and warns in the plan;
- **Boundary protection**: local write paths must pass `safeRel` and must land inside the sync root; remote names
  returned by `readdir` that contain a separator / `..` are rejected outright (otherwise a malicious server could write
  through the workspace); symlinks are always skipped; when `remotePath` is `/` and deletion is on, it is forcibly
  downgraded to `delete: none` (a real delete needs an explicit `allowRootRemote: true`).

---

## AI tool: one action-style `sftp`

**Only one tool** (not a dozen): these actions share the same config, the same connection and the same guardrails;
splitting them would only bloat the context, and the model would still miss some of them. The price is a description
that has to be complete — one action table spells out which action needs which parameters.

| action                                                     | Purpose                                                                                                      | Key parameters                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `status`                                                   | read config status (profile list, whether credentials exist, dependency state) — **never returns plaintext** | —                                                                                                                  |
| `save`                                                     | create/update a connection (absent fields keep their old values, `null` clears a credential)                 | `name` `host` `port` `username` `remotePath` `ignore` `direction` `deletePolicy` `target` `activate` + credentials |
| `secret`                                                   | write a password/passphrase into encrypted storage, return a `${secret:name}` reference                      | `name` `value`                                                                                                     |
| `test`                                                     | connection + remote root reachable + write-permission probe                                                  | `profile`                                                                                                          |
| `plan`                                                     | diff plan (transfers no files)                                                                               | `profile` `direction` `scope` `path` `deletePolicy`                                                                |
| `sync`                                                     | run the sync (`dryRun` defaults to true; files only move on an explicit `false`)                             | as above + `dryRun`                                                                                                |
| `cancel`                                                   | stop the running sync (including the scan phase); idempotent when there is no job                            | —                                                                                                                  |
| `ls` / `read` / `write` / `mkdir` / `mv` / `rm` / `search` | remote file CRUD and search (deletion goes through the trash)                                                | `path` (remote absolute path) / `from` `to` / `text` / `query` `maxResults` `maxDepth`                             |
| `exec`                                                     | run a shell command on the remote                                                                            | `cmd` `timeoutMs`                                                                                                  |

The meaning of `path` depends on the action: a **local relative path** for `plan`/`sync`, a **remote absolute path**
for file actions.

**`exec` is not in the enum by default** — after enabling 「设置 → 插件 → SFTP 同步 → 允许在远端执行命令」(Settings →
Plugins → SFTP Sync → Allow running commands on the remote), the plugin unregisters and re-registers the tool, and only
then does `exec` appear in the action table (a capability the model cannot see is truly disabled). The same switch also
turns on the two fast paths above (one-`find` scan + tar batching), while 「小文件批量打包传输」(Small-file batch
transfer) can turn batching off on its own. The settings page also controls: default delete policy, transfer
concurrency, scan concurrency, whether to maintain `.gitignore` automatically, whether to warn about plaintext
credentials, and trash retention days. A project file's `defaults` take precedence over the settings page (project
conventions should not be changed by a machine-level switch); the settings page applies only when the file leaves it
unset.

---

## Manual upload / download (panel)

When you do not want to look at a plan first and just want to push the one thing in hand, the panel has direct routes:

- the `⬇` at the end of each **remote file tree** row: download that entry (a directory downloads the whole subtree);
- 「上传本地对应目录」(Upload the corresponding local directory) in the **remote file tree toolbar**: push the local
  directory that corresponds to the current remote directory (the server reverse-resolves mappings / the remote root,
  which is why the path given is a remote absolute path);
- the **local file tree context menu**: 「上传到远端」(Upload to remote) / 「上传此目录」(Upload this directory)
  (provided by the manifest's `contextmenu.file`).

They go through `POST /transfer` and differ from `POST /sync` in exactly two ways: **no plan wait, execute directly**;
and **a fixed `deletePolicy: none`** — pushing a directory by hand should not wipe extra files on the remote. Manual
transfers also join `job` progress and notifications, and refresh the diff panel when done.

---

## Tests

`tests/sftp-plugin-test.mjs` (zero tokens, self-contained, already wired into `tests/run-smoke.mjs`):

```bash
npm run build:server
node tests/sftp-plugin-test.mjs 8999
```

Covers: config parsing and credential redaction, connectivity, diff plan and ignore, dry-run touching no files, real
execution landing files, deletion going to the trash and the trash not being sent back, `${secret:}`/`${env:}`
references and errors on bad references, remote CRUD, path escape and invalid-config rejection, `.vscode/sftp.json`
migration (plaintext never stored), registration of the single action-style tool and the `exec` action switch, manual
`POST /transfer` (single-file up/down / reverse-resolving a remote directory to a local directory / never touching the
delete policy), remote paths with `scope=tree`, down overwriting and both complementing, mappings subtree mapping, plan
token reuse (a `reuse` hit skips the rescan, a wrong token rescans), **`POST /cancel` mid-scan** (this one temporarily
adds 40 ms of latency to the mock READDIR to create a real time window: it asserts that `/state` shows progress during
the scan, that the request returns `cancelled` after the stop, that the running slot is released and that the plugin can
still produce a plan afterwards), and **the two exec fast paths** (13 small files upstream in one tar batch, downstream
pulled back in one `tar -czf -`; contents and nested relative paths all correct, staging directory cleaned up; then the
remote tar switch is turned off and the run repeated: `batched` honestly drops to zero, the per-file fallback still
transfers every file; and the `find` fast scan and per-directory readdir must produce exactly the same plan on the same
command chain).

The engine layer has its own pure unit tests: `tests/unit/sftp-engine-cancel.test.ts` (`runPool` claims no further tasks
after an abort, `scanLocal` scans level by level and throws on abort, a cancelled `applyPlan` is not a failure) and
`tests/unit/sftp-fastscan-batch.test.ts` (self-written ustar headers checked for checksum and unpacking against an
independent reader; upstream uses `tarStream` to produce and consume on the fly (asserting the largest chunk is far
smaller than the whole package), downstream feeds the tar to `readTarStream` in **100-byte fragments** (forcing it to
stitch headers and bodies across chunks); every old case from the `parseTarBuffer` era moved to streaming semantics:
flip one checksum byte, truncate the body, drop unwanted members while later ones still align, error out above
`maxBytes`; plus `parseFindOutput` in both NUL and newline flavours, the `-prune` command shape and fallback conditions
of `scanRemoteViaFind`, and `pruneDirNames` accepting only bare directory names). The remote side is provided by the
in-memory SFTP service in `tests/lib/mock-ssh.mjs` (user `tester` / password `secret123`, root `/home/test`, optional
`latencyMs` adds latency to every readdir; the exec side understands the `find -printf`, `tar -x -f -`, `mkdir -p`,
`mv -f` and `rm -rf` the plugin sends).

---

## Dependencies

`ssh2` is not shipped with the repository: on first use `host.ensureDeps(["ssh2"])` installs it into the plugin
directory automatically (the host single-flights concurrent calls); if installation fails, the panel and tool
acknowledgements point to 「在插件目录手动 `npm install ssh2`」(run `npm install ssh2` manually in the plugin directory).
