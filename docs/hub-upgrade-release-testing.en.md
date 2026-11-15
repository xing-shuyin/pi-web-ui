**English** · [简体中文](./hub-upgrade-release-testing.md) · [繁體中文](./hub-upgrade-release-testing.zh-TW.md)

# Hub release-package upgrade acceptance

Pre-release testing should install the `.tgz` npm is about to deliver, upgrade from an already released Hub to that package, and use real system services and a browser. Starting the service from the source directory or simulating `/health` in a unit test cannot prove that packaged contents, install paths, npm dependencies, and service restarts are correct.

## Running locally

```bash
node scripts/prepare-hub-release.mjs
node tests/hub-upgrade-release-test.mjs --candidate /absolute/path/pi-web-ui-VERSION.tgz --baseline pi-web-ui@0.117.0 --output /absolute/path/results
```

The first command copies the current source into a separate temp directory, runs the full release build, then `npm pack --ignore-scripts`, without overwriting the `dist/` in use in the workspace. The build uses the dependencies already installed in the current workspace; CI builds the same candidate package from a clean `npm ci`. `PI_HUB_TEST_TMP` overrides the temp directory (`E:/tmp` is recommended on Windows dev machines).

The second command installs the candidate package and the specified public npm version, runs the old version through the real service manager, then upgrades it to the candidate package. It uses a unique `pi-device-hub-smoke-<随机值>` name, a separate service configuration and data directory, uninstalls the test service when done, and leaves the default Hub untouched. The first-round baseline start uses the candidate CLI to generate the isolated service definition, while the service entry point and runtime code come from the actual public package; the definition format matches what older versions install. It needs npm registry network access, a usable user service session, service management permissions, and Chromium/Chrome. An existing Chrome is detected automatically; otherwise run `npx playwright-core install chromium --with-deps`.

Pass `--background` to run it in the background and inspect `acceptance.log`, `commands.log`, and `result.json` in the output directory. A pass requires the script to return or `result.json` to end in terminal state `passed`. On failure the install directory and diagnostics are kept; failing to clean up the service also fails acceptance.

## Behaviors actually verified

1. Install the exact candidate tarball and public-version dependencies, and check the real package contents plus isolated Hub startup.
2. Start the public version through the real OS service, create an account, pair a device, sync the Bot, and create a group.
3. Upgrade the old service to the candidate package with the candidate CLI, and check that the instance ID, login cookie, devices, and groups still exist. Compatible with older versions' health endpoints that lack a version/start identifier.
4. Use real Chromium to click the page's「一键升级」(One-click upgrade), bound to the new task ID returned by this POST, going through a real npm install, a separate update task, service stop, and restart; only this task's and the UI's expected terminal state, target version, and new start identifier are accepted. Unexpected failures are reported immediately, and an old task's result cannot stand in for this one.
5. Simulate an install failure with a nonexistent package, asserting that the page shows failure and the old Hub's start identifier is unchanged.
6. Create a candidate package that imports normally but whose start function throws, let the real service actually try to start it; confirm automatic recovery to the old service, the UI reporting failure, and group data being preserved. Even when the expected failure returns HTTP 503, confirm that what is recorded on disk is this newly created failed task; a network error or an old task must not count as a pass.
7. Uninstall the isolated test service and clean up the managed install directories.

The output includes report JSON/Markdown, candidate tarball SHA-256, baseline and candidate versions, Node and OS, plus browser success/failure/rollback screenshots. On failure it also collects, before uninstalling the service, this task's allowed fields, size-limited redacted logs, and service manager state; macOS checks the gui/user domains separately, Windows saves task state, start events, and the TCP state and owning PID of the failed port; no remote addresses or other processes' command lines are recorded. Upgrade and rollback both complete a bounded TCP resource-release check after stopping the task before starting the corresponding version; version, instance, and new start identifier are then checked. Diagnostics do not copy full configuration, data directories, environment blocks, or credentials.

## Release gate

`.github/workflows/hub-upgrade.yml` builds the candidate tarball once, then hands the same file to six real-service acceptance runs across Windows, Linux, macOS × Node 22/24. The baseline defaults to npm's current `latest` and can be pinned to a specific version on manual trigger. Linux prepares a systemd user session. Reports and screenshots are uploaded as workflow artifacts.

Release should wait for the relevant unit tests, type checks, and the six acceptance runs to pass, verify the tarball SHA-256 in `result.json`, then publish **the same tested file**:

```bash
npm publish /absolute/path/to/the-tested-candidate.tgz
```

Never rebuild after testing or publish straight from the source directory, otherwise the verified file and what users receive may differ. The workflow itself does not publish to npm; branch protection and release permissions should make this check a gate.

## Scope of the results

A pass on this machine proves the candidate package completed these upgrade scenarios under this machine's OS, Node, account permissions, and service configuration. A pass across the matrix adds evidence for the corresponding clean system environments. Neither guarantees the same network, proxy, disk, permissions, system version, and custom deployment on every user machine; production data compatibility also needs historical-data fixtures added alongside schema changes.

The stronger delivery constraint is: widen the supported environment matrix, use real historical data samples from the previous public version, publish the same verified package, and keep explicit failure states, diagnostic logs, and the old running version. Platforms that have not been run should be marked unverified; passing source-level unit tests is not a substitute.
