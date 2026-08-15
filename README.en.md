# dsh-llm-codex-auth-native-compact-image

English | [中文](README.md)

> This project was built by DeepSeek-V4-Pro in DeepSeek Harness in under ~3 hours. It has NOT undergone a full code review — only a manual check that the basic functionality works. Understand the security risks and use it at your own discretion before deploying.

Use your **ChatGPT / Codex subscription** (Plus / Pro / Business / Edu) inside dsh (DeepSeek Harness). The plugin signs in to your ChatGPT account through the OpenAI Codex OAuth flow and exposes your subscription quota as the `codex-oauth` model provider.

This plugin also integrates provider-native compaction. One npm package exposes a Host authentication/transport entry and an agent-scoped compaction entry. The `codex-native` preset replaces `compaction-basic`, so `/compact`, 80% context pressure, and overflow recovery all use opaque native checkpoints. See [`docs/native-compact-design.md`](docs/native-compact-design.md). Do not load the upstream OAuth package and this plugin together because both own the same provider route.

> ⚠️ **Risk notice**: this plugin calls the ChatGPT web backend (`chatgpt.com/backend-api`), an undocumented, officially unsupported interface. Using it carries a real risk of violating OpenAI's terms of service and may lead to account restrictions. Evaluate it yourself before use.

## Table of contents

- [dsh-llm-codex-auth-native-compact-image](#dsh-llm-codex-auth-native-compact-image)
  - [Table of contents](#table-of-contents)
  - [Features](#features)
  - [Installation](#installation)
    - [One-command install without pnpm (local / development, cross-platform)](#one-command-install-without-pnpm-local--development-cross-platform)
    - [Install Manually](#install-manually)
    - [Verification](#verification)
  - [Usage](#usage)
  - [How it works](#how-it-works)
  - [Development](#development)
  - [Security \& compliance](#security--compliance)
  - [License](#license)

## Features

- **Subscription models**: registers pi-ai's built-in `openai-codex` provider (`openai-codex-responses` wire protocol) as the `codex-oauth` provider on the dsh LLM seam. The model catalog is maintained by the installed pi-ai (e.g. `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.5`, `gpt-5.6-*`, …).
- **OAuth device-code login**: uses `auth.openai.com` (the same OAuth client as the Codex CLI), headless-friendly, no local callback server required.
- **Credential safety**: refresh / access tokens live only in the dsh credential store `$DSH_HOME/.credentials.yaml` (0600) — never in config, never in session logs, never in this repository. Expired access tokens are refreshed automatically by pi-ai inside a serialized write path.
- **Login and subscription usage**: the "Codex 订阅 (ChatGPT)" settings section provides login / logout, remaining percentages and reset times for the 5-hour and 7-day windows, plus manual refresh. Conversation helpers are `/codex-status`, `/codex-usage`, and `/codex-logout`.
- **Multimodal image input**: for Codex models declaring image capability, durable PNG/JPEG/WebP/GIF attachments from users, deferred `read_image` context, and tool results become request-local Responses `input_image` base64 data URLs. Ordinary replay, manual/automatic native compaction, and checkpoint replay share the same path; checkpoints persist attachment refs, never image base64.
- **Multi-turn**: preserves provider-native replay metadata (signatures, …) for reliable multi-turn requests.
- **Transient-error recovery**: maps Codex/pi-ai WebSocket, DNS, connection, premature-stream, throttling, service-unavailable, and provider retry-guidance failures into DSH's durable `TRANSPORT`, `RATE_LIMIT`, or `SERVER` backoff retries while retaining provider request IDs; directly thrown transport failures keep retryable codes too. Context-size overflow takes native-compaction recovery instead, while unknown `CODEX_ERROR` and deterministic model-not-found failures are not retried blindly.
- **Shared native-compaction transport**: publishes the token-free `codexOAuthTransport` Cordis service. It owns OAuth refresh, ChatGPT account headers, endpoint isolation, V2 `compaction_trigger`, and opaque-item replay; consumers never receive token material.
- **Manual and automatic provider-native compaction**: `/compact`, 80% pressure, and context-overflow recovery replace older history with a versioned opaque checkpoint. The Codex adapter replays it before generic conversion after persistence/restart; provider, model, or account-identity mismatches fail before network I/O, with no text-summary fallback.

## Installation

### One-command install without pnpm (local / development, cross-platform)

If you don't want to install pnpm or hunt for the profile directory, the repo script copies the plugin and registers the bundle for you (Windows / macOS / Linux — just Node, no bash required):

```sh
node scripts/install.mjs            # installs into the web profile by default
node scripts/install.mjs headless   # or another profile name
```

It auto-locates `$DSH_HOME` (default `~/.dsh`), copies the plugin into the `node_modules` location DSH will actually resolve first, and adds the bundle entry — no pnpm involved. On Windows, run the same command in cmd or PowerShell; the plugin itself is pure Node and does not depend on bash or pwsh.

Stop the target dsh process before updating an existing installation, then run the same command again. The script detects both script-managed shared installs and profile-local pnpm installs, stages a rollback-capable replacement beside the target, and removes a duplicate copy that could shadow the refreshed package. OAuth credentials live in `$DSH_HOME/.credentials.yaml`; refreshing the plugin directory does not read, move, or delete them.

The matching uninstall script:

```sh
node scripts/uninstall.mjs            # uninstall from the web profile
node scripts/uninstall.mjs headless   # uninstall from another profile
```

(If you installed via `dsh plugin add` (pnpm), prefer the official `dsh plugin --profile <name> remove dsh-llm-codex-auth-native-compact-image`; the uninstall script also clears the manifest entries as a fallback.)

### Install Manually

```sh
# Prereq 1: pnpm is required (dsh plugin forwards to it). Install first if missing: npm install -g pnpm
# Prereq 2: the dsh CLI is required — either:
#   · install it globally (recommended): npm install -g @deepseek-ai/dsh
#   · or use it ad hoc: replace `dsh` with `npx @deepseek-ai/dsh` below

# With dsh installed globally:
dsh plugin --profile web add file:/path/to/dsh-llm-codex-auth-native-compact-image

# Ad hoc, via npx:
npx @deepseek-ai/dsh plugin --profile web add file:/path/to/dsh-llm-codex-auth-native-compact-image

# restart dsh web so the new bundle takes effect
```

> **The `file:` prefix is required.** Passing a bare directory path makes pnpm install with `link:` (a symlink into this repo),
> and Node's realpath resolution can no longer find the plugin's own `node_modules`, so loading fails.
> `file:` copies the package into the profile's dependency tree (verified).
> pnpm 11's minimum-release-age gate automatically allows this plugin's rc dependencies; no extra configuration needed.
>
> **pnpm 11's ignored-builds notice makes `dsh plugin` report "pnpm failed"** (the packages are actually installed).
> Fix: in the profile's `pnpm-workspace.yaml`, change the `allowBuilds:` placeholders pnpm generated to `false`
> (the `@google/genai` and `protobufjs` build scripts are irrelevant to this plugin), then re-run the same command to finish bundle reconciliation.

### Verification

After installing, `dsh --profile web --dump-config` (or `npx @deepseek-ai/dsh --profile web --dump-config`) should show the `llm-codex-auth-native-compact-image` row.

> **Updating plugin code**: a `file:` install is a hard-link snapshot, so an editor's replace-style write is invisible to pnpm and a plain re-`add` may not refresh it. Prefer stopping dsh and running the repository installer; it refreshes the package location that is actually active and does not require repeated version bumps during local iteration:
> ```sh
> node scripts/install.mjs
> ```
> If you use pnpm exclusively, perform a complete remove/add instead:
> ```sh
> dsh plugin --profile web remove dsh-llm-codex-auth-native-compact-image
> dsh plugin --profile web add file:/path/to/dsh-llm-codex-auth-native-compact-image
> # without a global dsh install, replace `dsh` with `npx @deepseek-ai/dsh` above
> ```

## Usage

1. After restarting dsh, open the **settings page** and select "Codex 订阅 (ChatGPT)" in the sidebar.
2. Click "登录 ChatGPT 账号", follow the device-code prompt, and sign in. The section then shows the remaining percentages for the 5-hour and 7-day windows, refreshes once per minute, and also offers a manual refresh button.
3. Create the conversation with the `Codex Native` agent preset (it may be configured as the local default), then select a model under `codex-oauth`. Existing conversations created with `standard` do not hot-swap their compaction provider.
4. Run `/compact` while idle with at least two compactable surface messages. Opaque checkpoints carry roughly a thousand-token fixed cost, so a short conversation can be safely rejected when the checkpoint is not smaller than its history; no replacement is written. Normal turns automatically native-compact at 80% of the routed model context window; a provider-confirmed context overflow also gets one native-compaction recovery attempt.
5. Expand the GUI compaction row and look for `Provider-native Codex compaction checkpoint`. The collapsed “Compacted N history items” label is shared by every backend and does not prove native by itself.
6. `/codex-usage` force-refreshes and reports the remaining percentages in a conversation. Logout via the settings section or `/codex-logout`; `/codex-status` shows login status.

## How it works

| Component | Purpose |
|---|---|
| `src/adapter.js` | `LlmAdapter`: Codex stream → dsh `StreamChunk`, signature and native-checkpoint replay, error classification, idle watchdog |
| `src/transport.js` | Auth-isolated Responses/V2 compact transport; returns only opaque provider output and a non-secret identity |
| `src/checkpoint.js` | Versioned checkpoint carrier, lossless JSON, and provider/model/identity compatibility validation |
| `src/engine.js` | Native-aware pressure metering, manual/pressure/overflow `ctx.compaction`, tool-pairing boundaries, lifecycle bracket, replacement, and Scheme A flush |
| `src/compaction-plugin.js` | Agent-scoped preset entry that publishes isolated `ctx.compaction`, `/compact`, and automatic trigger listeners |
| `src/native-compact.js` | `/compact` and the pre-network foreign-provider replay guard |
| `src/store.js` | Bridge between pi-ai's `CredentialStore` and the dsh credential store (serialized read/write, tokens never leave the host) |
| `src/login.js` | Device-code login orchestration (pi-ai's own flow, persists the credential automatically) |
| `src/usage.js` | WHAM response allow-listing, remaining-percent calculation, 60-second host cache, and command formatting |
| `src/server.js` | Host `webServer` routes under `/codex-oauth` (status / usage / login / logout) for the browser half |
| `src/client.js` | Browser settings login and usage progress bars, bundled by `build.mjs` into the client-modules factory format |
| `src/commands.js` | Commands `/codex-status`, `/codex-usage`, `/codex-logout` |

## Development

- Plain ESM JavaScript; the host half needs no build step (named exports `apply` / `inject` / `name`).
- The browser half is bundled with esbuild: `node build.mjs` (React is externalized to `require("react")`, reusing the host's React instance).
- `dsh.bundle.patch` points at `cordis.patch.yml`; `dsh plugin add` adds the plugin to the profile's bundle layer automatically.
- `npm test` verifies repeated installs, profile-local pnpm snapshot refresh, unchanged credentials, and profile-path validation in temporary `DSH_HOME` trees; it needs no network or real credential.
- Tests live in `test/`: `smoke.mjs` (provider route / HTTP endpoints / commands / credential store), `stream-test.mjs` (stream translation, replay, error classification, option assembly, incl. multi-turn replay regressions), `login-smoke.mjs` (live device-flow smoke test, no account involved). They resolve dependencies through the profile's dependency tree; drop them into an installed profile directory and run:
  ```sh
  cp test/*.mjs .testhome/profiles/codex-test2/ && cd .testhome/profiles/codex-test2
  node smoke.mjs && node stream-test.mjs && node login-smoke.mjs
  ```
- Known limitations: automatic native compaction handles only `codex-oauth`; other providers do not fall back to `compaction-basic`, and a conversation containing a native checkpoint cannot replay across provider/model/account. The generic GUI token meter cannot inspect opaque source data, so the engine corrects pressure using Codex's model-visible estimator for remote-compaction ciphertext. Images use only durable attachment → base64 data URLs; remote image URLs and OAuth Files API `file_id` are not supported.

## Security & compliance

- This repository contains no secrets. Before pushing to GitHub (public or private), confirm `.gitignore` is effective and **never** commit `$DSH_HOME/.credentials.yaml` or its contents.
- This plugin uses an undocumented ChatGPT backend interface; there is a risk of violating OpenAI's terms and of account restriction. Use at your own risk.

## License

MIT
