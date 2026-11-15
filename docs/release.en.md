**English** · [简体中文](./release.md) · [繁體中文](./release.zh-TW.md)

# Release process

> The npm publisher account is `xingshuyin` (verified with `npm whoami`). `dist/server/` and `web/dist/` are gitignored and not in git, but the `files` allowlist in `package.json` packs them into the npm package; local test files and desktop artifacts in the root of `dist/` do not enter the npm package. `prepublishOnly` compiles the P2P helper, checks the Windows desktop codec component plus its sources and relink material, then runs `npm run build`; the server build first cleans `dist/server/` so stale output from deleted sources does not remain in the release package. Before releasing, the Windows build artifacts described below must be prepared first.

## Steps

```bash
# 1) bump the version (patch/minor depending on the change; a version already on npm is rejected with 404)
#    change both places and keep them in sync:
#      "version" in package.json and "version" in package-lock.json (line 3 + packages[""])

# 2) write the CHANGELOG (a fixed step of every release, never skipped)
#    add a new version section at the top of CHANGELOG.md: Added / Fixed / Changed / i18n,
#    filed by "the commits actually merged into this release" (git log last version bump commit..HEAD),
#    with the date set to the npm publish time (UTC+8 calendar day); add one entry to the version link definitions at the bottom.
#    If the Unreleased section has content, fold it into the new version and clear it; if not, create only an empty placeholder section.
#    The i18n section is not written by hand: run it once after changing copy and it is recorded into ## [Unreleased] automatically (idempotent, safe to re-run):
#    npm run changelog:i18n

# 3) self-check + build
npm run typecheck
npm run build

# 4) commit (Conventional Commits: feat/fix/perf/chore(scope): description, explain why)
git add -A
git commit -m "feat(files): <一句话描述>"

# 5) push to GitHub (public repository: xing-shuyin/pi-web-ui, branch main)
git push origin main

# 5.5) CI green guard: find main's CI for this commit SHA and wait for everything to pass.
#      On failure run gh run view <run-id> --log-failed, locate the root cause, re-verify locally, commit and push,
#      then wait for CI of the new SHA; a green result on an old commit does not stand in for this commit.
#      Once all green, show the version and the final Release Notes, get the user's release confirmation, and only then proceed to tag / npm.
gh run list --branch main --workflow CI --commit "$(git rev-parse HEAD)"
gh run watch <run-id> --exit-status

# 6) tag and push (tags carry a v prefix, matching the npm version one-to-one; the tag missing before issue #103 has been backfilled)
#    A missed tag leaves GitHub's "latest" behind npm, so always tag.
git tag vX.Y.Z
git push origin vX.Y.Z

# 7) GitHub Release (published automatically, nothing to write by hand)
#    Pushing the tag runs the Action (.github/workflows/release-notes.yml) automatically:
#    install the locked parse dependencies (without running install scripts), take the CHANGELOG section + generate ### i18n against the previous tag,
#    and create the Release (updating notes if it already exists). Preview locally first:
node scripts/release-notes.mjs X.Y.Z --base v<上个版本>   # preview (prints to stdout)
#    After an automatic job fails and the workflow is fixed, reprocess the published tag from the workflow on main; it validates and checks out that tag,
#    then installs that tag's locked dependencies, generates and updates the notes:
# gh workflow run release-notes.yml --ref main -f tag=vX.Y.Z
#    If the workflow is still unusable, post manually once local dependencies are complete:
# node scripts/release-notes.mjs X.Y.Z --base v<上个版本> --out /tmp/notes.md --create

# 8) publish to npm (runs the prepublishOnly build automatically)
#    The account has 2FA: running npm publish directly with a "2FA-bypassing granular token" gets the version downgraded by the registry into a
#    staged publish (the version only lands minutes later, and retries meanwhile only return 409 Cannot publish over previously
#    staged version; unpublish / dist-tag changes even return 403 outright). Use the OTP wrapper:
NPM_OTP=123456 npm run release:npm     # pre-checks dirty worktree/account/tag + publishes with OTP + heals staged
#    Equivalent manual command: npm publish --otp=123456
#    To only see what would be packed: npm run release:npm -- --dry-run

# 8.5) desktop installers (automatic, three platforms in parallel, nothing to write by hand)
#    The same tag also triggers .github/workflows/desktop-release.yml, running three jobs at once
#    (all npm run build + build:desktop + electron-builder):
#      windows-latest  --win            → *.exe (+ .blockmap) + latest.yml
#      macos-latest    --mac            → *.dmg + *.zip + latest-mac.yml
#      ubuntu-latest   --linux AppImage → *.AppImage + latest-linux.yml
#    All three attach their artifacts to that tag's Release (--clobber, so re-pushing the tag reruns the whole batch and overwrites assets;
#    workflow_dispatch only produces workflow artifacts and does not touch Release assets).
#    Two things to note:
#      - runners produce the host architecture by default: x64 on Windows/Linux, arm64 on macos-latest
#        (Intel Mac needs --mac --x64 on top, a one-liner, not done yet);
#      - none of the three platforms is signed (Windows shows a SmartScreen prompt on first launch, macOS needs right-click→open the first time,
#        and macOS certificates are outside SignPath's scope too); if first launch/terminal is a concern, run the
#        dmg/AppImage on a real machine before announcing.
#    Signing (SignPath Foundation) gets added to this workflow later — SignPath signs CI artifacts only,
#    a local npm run desktop:dist can never be signed (local packaging only verifies Windows).

# 8.6) mobile APK + desktop installers (one local command, recommended)
#    One command produces everything: desktop (current platform) + mobile arm64 (with the engine runtime), and attaches them to that tag's Release:
npm run release:local -- vX.Y.Z                # everything: desktop + mobile (the mobile step is a 15–25 minute qemu build)
npm run release:local -- vX.Y.Z --skip-mobile  # desktop only
npm run release:local -- vX.Y.Z --skip-desktop # mobile only
npm run release:local -- vX.Y.Z --skip-desktop --reuse-runtime  # mobile only without rebuilding the runtime (preferred when the engine is unchanged, a few minutes)
npm run release:local -- vX.Y.Z --no-upload    # package only, leave the Release alone
npm run release:local -- vX.Y.Z --portable     # additionally produce a portable build (bundled Git/Node, slower)
#    Note: the mobile package does not come out automatically with the tag. The tag only triggers desktop-release / release-notes / extensions;
#    mobile-release is a manual workflow (CI generates a new debug keystore every time, so a new build cannot install over the old one and even wipes engine data),
#    so the APK for every version needs one local run of the command above.
#    --reuse-runtime only holds when "server code is unchanged and only the shell/plugins moved": the runtime contains the server package
#    from this repository's npm pack, and the script stops outright on a piWebUi version mismatch (add --allow-stale-engine if you are sure nothing changed).
#    The script first validates that the tag matches the package.json version, then: npm run build → desktop packaging → (optional) build the
#    arm64 runtime and APK → generate SHA256SUMS.txt → gh release upload --clobber.
#    Why local first: a mobile APK carries a 280 MB engine runtime, CI's qemu is slow and swaps the debug signature every time
#    (a new build cannot install over the old one and wipes the engine data on the phone too); a Windows desktop installer takes minutes locally.
#    Two known limits:
#      - the Windows NSIS installer cannot be produced locally (after packaging, electron-builder must execute the freshly produced setup.exe
#        to generate the uninstaller, and the local machine blocks it: ERR_ELECTRON_BUILDER_CANNOT_EXECUTE / exit code null),
#        so local output is a portable zip (release/pi-web-ui-desktop-<version>-win-x64-portable.zip);
#        use CI's desktop-release windows job when a real installer is needed.
#      - macOS / Linux installers can only be built on the matching system and still come from .github/workflows/desktop-release.yml.
#    .github/workflows/mobile-release.yml is kept but switched to manual triggering (click in Actions) as a cloud fallback;
#    it needs optional secrets such as MOBILE_KEYSTORE_BASE64 to ship an upgradable package.

# 9) verify
npm run release:check -- vX.Y.Z  # whether Release assets are complete: desktop 3 platforms + extensions + mobile APK + SHA256SUMS
npm view pi-web-ui version        # should show the new version (registry cache delay is normal)
curl -s https://registry.npmjs.org/pi-web-ui/latest | jq .version
git ls-remote --tags origin       # vX.Y.Z should be visible
```

## Notes

- The version **must** be higher than what is already on the npm registry (check the current value with `npm view pi-web-ui version`).
- Version format: npm without a `v` prefix (`0.70.0`), git tag / GitHub Release with a `v` prefix (`v0.70.0`).
- Commit messages must not carry `Co-authored-by` (P1 rule, the repository hook blocks it).
- `.pi/commands.json` holds **per-project** personal commands (under `.pi/` of the current cwd), is gitignored and never enters the public repository; switching cwd refreshes the command list to that project's commands.
- In CI green guard mode, CI verification of the final commit must complete before showing the version and Release Notes to request release confirmation; that one confirmation covers the tag push and `npm publish` for this version.
- **Restart after upgrading**: `npm i -g` only updates files on disk, a running process still holds the old code in memory — the frontend reads from disk on every request (so it turns new first), but WS message handling is old in-process logic, and mixed old/new shows up as "the UI is new, some feature keeps loading forever". "Update now" in the UI (the update dropdown in the top bar) now runs `npm i -g pi-web-ui@latest` in a visible terminal tab (reusing the same tab mode as SCM/plugin uninstall), and after it finishes the service must be restarted manually: `pi-web-ui server restart` (launchd/systemd brings it back up via the service manager; Docker needs `docker compose restart`). The server keeps a `PI_WEB_RESTART_CHILD` port to wait for the handshake (restart-handoff-test regression), for an externally orchestrated replacement subprocess.
- **Dry-run the desktop packaging workflow before re-pushing the tag**: run `gh workflow run desktop-release.yml --ref main` to verify all three platform jobs are green, then re-push the tag — re-pushing the tag rebuilds and `--clobber`s the Release assets and is the only path for a real package.
- **Check example files for leaks before releasing**: files shipped in the npm package (`deploy/`, `README` etc.; the `files` allowlist includes `deploy/`) and distributed via GitHub **must never contain real IPs / domains / keys** — use placeholders (e.g. `<LAN_IP>`, `<PUBLIC_IP>:<PUBLIC_PORT>`, `your-host`). Change real environment configuration locally only, never in the repository.

## Code and docs must not leak any public IP

## P2P npm candidate package

The complete candidate package is produced by `npm run pack:p2p` and requires Node.js and Go ≥1.24. Publishers first run `npm run build:desktop-codec` on a Windows x64 build machine; when packaging on macOS/Linux, copy that machine's `bin/desktop-codec/win32-x64/` and `bin/ffmpeg/win32-x64/nvenc-compat/` into the release workspace first. The command cross-compiles the five-platform helpers, prepares the default Windows FFmpeg, validates native components and material, builds Web/server and packs. Before releasing you can also run `npm run verify:desktop-codec` separately. When required artifacts are missing or tampered with, `pack:p2p` and the npm pre-publish checks fail; do not bypass the checks with `npm pack --ignore-scripts`.

The `bin/device-p2p/` helpers plus the Windows codec and relink material are generated artifacts, not committed to Git, and collected through npm's `bin/` file allowlist. The Windows desktop installer release workflow builds these components from source. Sources, licenses and relink material ship with the package, and the maintainer checks the applicable license requirements of third-party dependencies before an official release.

Before releasing, run `node --import tsx tests/device-p2p-test.mjs` and the related device permission/access unit tests; install from the produced tarball and check the five helpers and the manifest, verifying the connection helpers inside the package rather than in the workspace. Go cross-compilation passing does not equal passing on real macOS/Linux machines, and the release notes must distinguish the two.
