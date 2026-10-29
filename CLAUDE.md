# kubedeck

Kubernetes desktop client. Tauri 2 app: Rust backend in `src-tauri/` (kube-rs), React + TypeScript UI in `src/`. README.md is the user-facing doc; this file is for working on the code. Licensed Apache-2.0 (`LICENSE`, `NOTICE`, which credits the bundled Helm).

## Safety first

- Assume the default kube context is **production** (the maintainer's is a production EKS cluster). Never run tests, scripts or ad-hoc `kubectl` against `~/.kube/config`. Use the disposable kind cluster: `e2e/setup.sh`, then `KUBECONFIG=$PWD/.kind-kubeconfig`.
- The e2e tests refuse contexts containing `prd`/`prod`/`production`; keep that guard.
- In the UI, every action that changes a production cluster (save YAML, delete, create, restart, scale, pause, rollback, cordon, drain, expand a volume, Helm install/upgrade/rollback/uninstall) keeps the type-the-name confirmation: `ConfirmDialog`/`DiffDialog` with `typeToConfirm`, which render `TypeToConfirm` (the name shown as typed, copyable); `CreateDialog` uses `TypeToConfirm` directly.
- Never commit `.kind-kubeconfig`, `src-tauri/binaries/`, or the updater signing key (the maintainer keeps it in `~/.tauri/`, its password in the macOS Keychain as `kubedeck-updater-key-password`; CI reads it from repository secrets).

## Commands

```bash
npm install
npm run tauri dev                 # native app with hot reload (fetches the Helm sidecar first)
npm run dev                       # UI only in a browser, with sample data from src/dev-mock.ts
npm run screenshots               # with npm run dev running: regenerate docs/screenshots (README images)
npm run binaries                  # fetch the Helm sidecar; needed once before plain cargo commands
npx tsc --noEmit                  # typecheck UI
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test        # unit tests (e2e tests are #[ignore])

# e2e against kind (see README "Testing")
e2e/setup.sh
cd src-tauri && KUBECONFIG=$PWD/../.kind-kubeconfig KUBEDECK_E2E_CONTEXT=kind-kubedeck-test \
  KUBEDECK_HELM=$PWD/binaries/helm-$(rustc -vV | sed -n 's/host: //p') cargo test -- --include-ignored
```

CI (`.github/workflows/ci.yml`) runs all of the above on Linux, including e2e on kind. Run clippy, tsc and the e2e suite before saying a change works.

## Architecture

Rust (`src-tauri/src/`), one module per feature; every `#[tauri::command]` is registered in `lib.rs`:

- `state.rs` — `Sessions` holds one `AppState` per window (`Connection` with client, context and kinds; background tasks keyed by stream id). Commands take `state: Session`, a custom `CommandArg` that Tauri fills from the calling webview; the window's session is stopped when it closes.
- `cluster.rs` — kubeconfig contexts, `connect` (also loads CRDs), namespaces, `set_read_only`, `run_login` (the user's login command from the 401 banner).
- `kinds.rs` — built-in kinds + CRD-derived kinds; `summarize` turns any object into a table `Row`; `json_path` evaluates CRD printer columns.
- `resources.rs` — generic watch/get/replace/delete over `DynamicObject`, and `create_resources` (multi-document YAML, server-side dry run).
- `streams.rs` (logs, exec), `portforward.rs`, `helm.rs` (releases; shells out to the bundled `helm`), `helm_charts.rs` (repos, search, install/upgrade), `metrics.rs` (metrics-server, table columns), `pod_insights.rs` (pod drawer metrics: usage vs requests/limits, Prometheus detection and history through the API server service proxy), `updater.rs` (self-update from GitHub releases), `windows.rs` (new windows, saving files).
- `workloads.rs` (restart, scale, pause, rollout history and rollback, object events), `diagnostics.rs` (Problems scan and the Related graph), `nodes.rs` (node summary, cordon, drain via the eviction API), `rightsizing.rs` (requests vs Prometheus/metrics-server usage per workload container), `secrets.rs` (masking and per-key reveal), `storage.rs` (claim usage from Prometheus or the kubelet stats summary, history, expansion), `ai.rs` (Explain with Claude: key in the system keychain, redacted context, streamed SSE).
- `e2e_test.rs` — end-to-end tests that call the real commands through `tauri::test::mock_builder`; `Session::of(&app, "main")` gives a window's session, and `Sessions::with_helm_env` isolates helm's repository config.

UI (`src/`): `api.ts` holds a typed wrapper for every command; components in `src/components/`; `useStream.ts` owns stream lifecycles; `dev-mock.ts` mirrors the commands for browser-only work.

Layout: `Rail` (sections, with the Problems badge from `sections.ts`, pinned clusters from `pins.ts`, theme and update popovers) · `TopBar` (cluster / namespaces / view breadcrumb, ⌘K trigger) · `KindTabs` · `.workspace` (table + right-hand `.details` drawer) · `Dock` (bottom terminals/logs, `dock.ts` context) · `CommandPalette` (commands are built in `App.tsx`). Per-viewer preferences live in localStorage per cluster: `readOnly.ts` (lock default, login command), `favorites.ts` (starred port forwards, restarted on connect), `notify.ts` (crash notifications, fed by the Problems polling).

## Conventions

- **Commands** take `state: Session` (never `State<AppState>`, which would share one cluster across windows) and return `CmdResult<T>` (`Result<T, String>`); map errors with `state::err`. The UI shows these strings as-is, so make them readable.
- **Namespaces**: commands that list across namespaces take `namespaces: Vec<String>` (empty = all); the UI passes the picker selection. `watch_resources` runs one watch per namespace and merges them.
- **Streaming** (watch, logs, exec): the command spawns a task, sends events over a `tauri::ipc::Channel`, registers it with `AppState::track` (or the exec/forward maps) and returns an id. The UI must stop it with `stop_stream(id)`; use `useStream` rather than hand-rolled effects. `connect` stops everything.
- **Serde**: structs sent to the UI use `#[serde(rename_all = "camelCase")]`; tagged enums use `#[serde(tag = "type")]` (or `"status"`). Keep `api.ts` types in sync.
- **New command checklist**: Rust fn + register in `lib.rs` + wrapper in `api.ts` + case in `dev-mock.ts` + e2e coverage in `e2e_test.rs`.
- Prometheus is reached with `client.request_text` on `/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/...` (the user's own RBAC), never a port forward. Detection runs once per connection (`Connection::prometheus`); `KUBEDECK_PROMETHEUS=ns/svc:port` overrides it. Charts are `components/LineChart.tsx` (plain SVG, `--chart-*` tokens).
- Anything that shells out to helm goes through `helm::helm` (cluster commands, adds `--kube-context`) or `helm::helm_local` (repos/search), so the session's helm environment applies.
- **Errors from the API**: map `kube::Error` with `state::kube_err` (readable, and 401s say "(401)", which the UI's `isUnauthorized` matches) and flag 401s where the UI needs to react (`WatchMsg::Error.unauthorized`). A 401 means expired/revoked credentials: the UI shows the auth banner and reconnects quietly every 20s, re-running the kubeconfig exec plugin.
- Secret values never go into table rows (`summarize` counts keys only), `get_yaml` masks them unless `reveal`, and `ai.rs` refuses Secrets and redacts env values. Keep it that way.
- **Read-only mode**: every command that changes the cluster calls `state.writable()?` first (dry runs excepted). The UI locks production contexts by default (`readOnly.ts`), but the backend is what enforces it; new write commands must call it and get a line in the read-only e2e test.
- **Claude** is called with raw HTTP from `ai.rs` (no Rust SDK): model `claude-opus-5-5`, streamed, with server-side fallback (`content_block_start` of type `fallback` restarts the text). Only on an explicit click, never automatically.
- **Styling**: use only the theme tokens from the top of `App.css` (`--bg*`, `--line*`, `--text*`, `--accent*`, `--ok/--warn/--bad`, `--font-ui/--font-mono`, `--radius*`); never hard-code colors, or a theme will break. A new theme is one `[data-theme]` block plus an entry in `theme.ts` (with Monaco and xterm colors). Icons come from `@tabler/icons-react`; fonts are bundled (`@fontsource-variable/*`), never loaded from a CDN.
- After visible UI changes, regenerate the README images with `npm run screenshots` (scenes are in `scripts/screenshots.mjs`; keep `dev-mock.ts` realistic enough to photograph).
- New global actions belong in the command palette (`commands` in `App.tsx`) as well as wherever they have a button.
- Comments explain *why* (constraints, API quirks), not what the code does. Match the surrounding density.
- Rust edition 2024; prefer let-chains where clippy suggests them.

## Releases and updates

- `npm run release -- x.y.z --push` bumps package.json, tauri.conf.json, Cargo.toml and Cargo.lock, tags `vx.y.z` and pushes; `.github/workflows/release.yml` builds macOS (arm64, x64), Linux (AppImage, deb) and Windows (NSIS) into a draft, adds `latest.json`, then publishes. A manual run (workflow_dispatch) only builds, as artifacts — use it to check packaging changes.
- Asset names follow `kubedeck_<version>_<suffix>`; `scripts/latest-json.mjs` maps updater targets to those suffixes, so keep both in sync.
- The updater checks GitHub anonymously, or with `GITHUB_TOKEN`/`GH_TOKEN`/`gh auth token` when present (rate limit, private forks). `latest.json` points at GitHub **API** asset URLs (`scripts/latest-json.mjs`); keep them, since installed copies (including ones from the private era) download with `Accept: application/octet-stream`, and `browser_download_url` breaks private forks.
- Changing the updater `pubkey` in tauri.conf.json strands every installed copy. Only rotate it together with a manual reinstall plan.
- Builds are ad-hoc signed (no Developer ID yet); `scripts/install.sh` (macOS, Linux) and `scripts/install.ps1` (Windows) download with curl/PowerShell, or through `gh` when it is logged in.
- `identifier` in tauri.conf.json (`io.github.cardoso010.kubedeck`) is kept on purpose: changing it would reset every user's settings and could install a second copy on Windows.
- Platform code: the login-shell PATH import is `cfg(unix)`; keep Windows paths in mind for sidecars (`helm.exe`).
- Helm is pinned in `scripts/fetch-helm.mjs` with per-platform SHA-256 sums from the official release notes; update version and sums together.
