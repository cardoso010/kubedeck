# kubedeck

Kubernetes desktop client (Lens-like). Tauri 2 app: Rust backend in `src-tauri/` (kube-rs), React + TypeScript UI in `src/`. README.md is the user-facing doc (Portuguese); this file is for working on the code.

## Safety first

- The developer's default kube context is a **production EKS cluster**. Never run tests, scripts or ad-hoc `kubectl` against `~/.kube/config`. Use the disposable kind cluster: `e2e/setup.sh`, then `KUBECONFIG=$PWD/.kind-kubeconfig`.
- The e2e tests refuse contexts containing `prd`/`prod`/`production`; keep that guard.
- In the UI, destructive actions (save YAML, delete, Helm rollback/uninstall) on production contexts must keep the type-the-name confirmation (`ConfirmDialog` with `typeToConfirm`).
- Never commit `.kind-kubeconfig`, `src-tauri/binaries/`, or anything from `~/.tauri/` (updater signing key; its password is in the macOS Keychain, service `kubedeck-updater-key-password`).

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
- `cluster.rs` — kubeconfig contexts, `connect` (also loads CRDs), namespaces.
- `kinds.rs` — built-in kinds + CRD-derived kinds; `summarize` turns any object into a table `Row`; `json_path` evaluates CRD printer columns.
- `resources.rs` — generic watch/get/replace/delete over `DynamicObject`.
- `streams.rs` (logs, exec), `portforward.rs`, `helm.rs` (releases; shells out to the bundled `helm`), `helm_charts.rs` (repos, search, install/upgrade), `metrics.rs` (metrics-server), `updater.rs` (self-update from private GitHub releases), `windows.rs` (new windows).
- `e2e_test.rs` — end-to-end tests that call the real commands through `tauri::test::mock_builder`; `Session::of(&app, "main")` gives a window's session, and `Sessions::with_helm_env` isolates helm's repository config.

UI (`src/`): `api.ts` holds a typed wrapper for every command; components in `src/components/`; `useStream.ts` owns stream lifecycles; `dev-mock.ts` mirrors the commands for browser-only work.

Layout: `Rail` (sections from `sections.ts`, pinned clusters from `pins.ts`, theme and update popovers) · `TopBar` (cluster / namespaces / view breadcrumb, ⌘K trigger) · `KindTabs` · `.workspace` (table + right-hand `.details` drawer) · `CommandPalette` (commands are built in `App.tsx`).

## Conventions

- **Commands** take `state: Session` (never `State<AppState>`, which would share one cluster across windows) and return `CmdResult<T>` (`Result<T, String>`); map errors with `state::err`. The UI shows these strings as-is, so make them readable.
- **Namespaces**: commands that list across namespaces take `namespaces: Vec<String>` (empty = all); the UI passes the picker selection. `watch_resources` runs one watch per namespace and merges them.
- **Streaming** (watch, logs, exec): the command spawns a task, sends events over a `tauri::ipc::Channel`, registers it with `AppState::track` (or the exec/forward maps) and returns an id. The UI must stop it with `stop_stream(id)`; use `useStream` rather than hand-rolled effects. `connect` stops everything.
- **Serde**: structs sent to the UI use `#[serde(rename_all = "camelCase")]`; tagged enums use `#[serde(tag = "type")]` (or `"status"`). Keep `api.ts` types in sync.
- **New command checklist**: Rust fn + register in `lib.rs` + wrapper in `api.ts` + case in `dev-mock.ts` + e2e coverage in `e2e_test.rs`.
- Anything that shells out to helm goes through `helm::helm` (cluster commands, adds `--kube-context`) or `helm::helm_local` (repos/search), so the session's helm environment applies.
- Secret values never go into table rows (`summarize` counts keys only).
- **Styling**: use only the theme tokens from the top of `App.css` (`--bg*`, `--line*`, `--text*`, `--accent*`, `--ok/--warn/--bad`, `--font-ui/--font-mono`, `--radius*`); never hard-code colors, or a theme will break. A new theme is one `[data-theme]` block plus an entry in `theme.ts` (with Monaco and xterm colors). Icons come from `@tabler/icons-react`; fonts are bundled (`@fontsource-variable/*`), never loaded from a CDN.
- After visible UI changes, regenerate the README images with `npm run screenshots` (scenes are in `scripts/screenshots.mjs`; keep `dev-mock.ts` realistic enough to photograph).
- New global actions belong in the command palette (`commands` in `App.tsx`) as well as wherever they have a button.
- Comments explain *why* (constraints, API quirks), not what the code does. Match the surrounding density.
- Rust edition 2024; prefer let-chains where clippy suggests them.

## Releases and updates

- `npm run release -- x.y.z --push` bumps package.json, tauri.conf.json, Cargo.toml and Cargo.lock, tags `vx.y.z` and pushes; `.github/workflows/release.yml` builds macOS (arm64, x64), Linux (AppImage, deb) and Windows (NSIS) into a draft, adds `latest.json`, then publishes. A manual run (workflow_dispatch) only builds, as artifacts — use it to check packaging changes.
- Asset names follow `kubedeck_<version>_<suffix>`; `scripts/latest-json.mjs` maps updater targets to those suffixes, so keep both in sync.
- The repo is private: the app authenticates with `GITHUB_TOKEN`/`GH_TOKEN` or `gh auth token`, and `latest.json` points at GitHub **API** asset URLs (`scripts/latest-json.mjs`). Don't switch to `browser_download_url`; it does not work for private repos.
- Changing the updater `pubkey` in tauri.conf.json strands every installed copy. Only rotate it together with a manual reinstall plan.
- Builds are ad-hoc signed (no Developer ID yet); `scripts/install.sh` (macOS, Linux) and `scripts/install.ps1` (Windows) install via `gh`.
- Platform code: the login-shell PATH import is `cfg(unix)`; keep Windows paths in mind for sidecars (`helm.exe`).
- Helm is pinned in `scripts/fetch-helm.mjs` with per-platform SHA-256 sums from the official release notes; update version and sums together.
