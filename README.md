# dsh-llm-codex-auth-native-compact-image

[English](README.en.md) | 中文

> 本项目由 DeepSeek-V4-Pro 在 DeepSeek Harness 用时约 3h 不到完成，未进行完整 Code Review，仅人工审查确保基础功能可用，使用前需了解安全风险并自行为此负责。

在 dsh（DeepSeek Harness）里使用你的 **ChatGPT / Codex 订阅**（Plus / Pro / Business / Edu）。插件通过 OpenAI Codex 的 OAuth 流程登录 ChatGPT 账号，把订阅额度暴露成 dsh 的 `codex-oauth` 模型提供方。

本插件同时集成 provider-native compaction。同一个 npm 包分别提供 Host 认证/transport 入口和 agent-scoped compaction 入口；`codex-native` preset 用后者替换 `compaction-basic`，使 `/compact`、80% 上下文压力触发和 overflow 恢复都使用 opaque native checkpoint。`/native-compact-probe [model]` 保留为显式诊断。完整契约见 [`docs/native-compact-design.md`](docs/native-compact-design.md)。原版 OAuth 插件与本插件不得同时加载，否则会重复注册同一 provider。

> ⚠️ **风险提示**：本插件调用 ChatGPT 网页版后端（`chatgpt.com/backend-api`），这是一个未公开、官方不支持的接口，违反 OpenAI 服务条款的风险真实存在，可能导致账号受限。请自行评估后使用。

## 目录

- [dsh-llm-codex-auth-native-compact-image](#dsh-llm-codex-auth-native-compact-image)
  - [目录](#目录)
  - [功能特性](#功能特性)
  - [安装](#安装)
    - [免 pnpm 的一键安装（本地 / 开发用，跨平台）](#免-pnpm-的一键安装本地--开发用跨平台)
    - [手动命令行安装](#手动命令行安装)
    - [验证安装完成](#验证安装完成)
  - [使用](#使用)
  - [工作原理](#工作原理)
  - [开发](#开发)
  - [安全与合规](#安全与合规)
  - [License](#license)

## 功能特性

- **订阅模型接入**：把 pi-ai 内置的 `openai-codex` provider（`openai-codex-responses` 线上协议）注册为 dsh LLM seam 的 `codex-oauth` 提供方；模型目录随所装 pi-ai 维护（如 `gpt-5.3-codex-spark`、`gpt-5.4`、`gpt-5.5`、`gpt-5.6-*` 等）。
- **OAuth 设备码登录**：走 `auth.openai.com`（与 Codex CLI 同一 OAuth client），headless 友好，无需本地回调服务器。
- **凭据安全**：refresh / access token 只存在 dsh 凭据库 `$DSH_HOME/.credentials.yaml`（0600），**不进配置、不进会话日志、不进本仓库**；access token 过期时由 pi-ai 在串行化的写路径里自动用 refresh token 续期。
- **设置页登录**：在设置页提供「Codex 订阅 (ChatGPT)」区块，含登录 / 登出按钮与实时状态；对话侧仅保留只读的 `/codex-status`、`/codex-logout` 命令。
- **多轮对话**：完整保留 provider 原生回放元数据（签名等），支持跨轮次多轮请求。
- **多模态图片输入**：对声明 image capability 的 Codex 模型，将用户附件、`read_image` 延迟上下文及工具结果中的 PNG/JPEG/WebP/GIF durable attachment 转成请求期 Responses `input_image` base64 data URL；普通回放、手动/自动 native compact 与 checkpoint replay 使用同一路径，checkpoint 只落 attachment ref、不落图片 base64。
- **共享原生压缩 transport**：发布不暴露 token 的 `codexOAuthTransport` Cordis 服务；OAuth 刷新、ChatGPT 账号 Header、端点隔离、V2 `compaction_trigger` 与 opaque item 回放全部留在认证插件内部，调用方不会收到凭据材料。
- **手动与自动原生压缩**：`/compact`、80% 压力触发和 context-overflow 恢复都将旧历史替换为版本化 opaque checkpoint；落盘/重启后由 Codex adapter 在通用消息转换前原样回放。跨 provider、model 或账号 identity 会在联网前失败，绝不回退到文本摘要。

## 安装

### 免 pnpm 的一键安装（本地 / 开发用，跨平台）

不想装 pnpm、也不想手动找 profile 目录时，仓库脚本会替你复制插件并登记 bundle（Windows / macOS / Linux 通用，用 Node 即可，无需 bash）：

```sh
node scripts/install.mjs            # 默认装到 web profile
node scripts/install.mjs headless   # 指定其他 profile
```

脚本会自动定位 `$DSH_HOME`（默认 `~/.dsh`），把插件复制进 DSH 实际优先解析的 `node_modules` 并写入 bundle 列表，全程不碰 pnpm。Windows 上在 cmd / PowerShell 里直接运行同一命令即可，插件本身是纯 Node 实现，不依赖 bash / pwsh。

更新已有安装前先停止对应的 dsh 进程，然后重复运行同一命令。脚本会识别脚本管理的共享安装和 profile 内由 pnpm 管理的安装，在目标旁完成暂存与可回滚替换，并删除会遮蔽新版的重复副本。OAuth 凭据位于 `$DSH_HOME/.credentials.yaml`，刷新插件目录不会读取、移动或删除凭据。

对应的卸载脚本：

```sh
node scripts/uninstall.mjs            # 从 web profile 卸载
node scripts/uninstall.mjs headless   # 从其他 profile 卸载
```

（若当初是用 `dsh plugin add`（pnpm）安装的，优先用官方 `dsh plugin --profile <name> remove dsh-llm-codex-auth-native-compact-image`；卸载脚本也会顺带清掉 manifest 里的条目作为兜底。）

### 手动命令行安装

```sh
# 前置 1：需要 pnpm（dsh plugin 转发给它）。没有的话先：npm install -g pnpm
# 前置 2：需要 dsh CLI，二选一：
#   · 全局安装（推荐）：npm install -g @deepseek-ai/dsh
#   · 临时使用：把下面命令里的 dsh 换成 npx @deepseek-ai/dsh

# 已全局安装 dsh 时：
dsh plugin --profile web add file:/path/to/dsh-llm-codex-auth-native-compact-image

# 未全局安装、临时用 npx 时：
npx @deepseek-ai/dsh plugin --profile web add file:/path/to/dsh-llm-codex-auth-native-compact-image

# 重启 dsh web 使新 bundle 生效
```

> **必须用 `file:` 前缀**。直接传目录路径时 pnpm 会以 `link:`（软链到本仓库）安装，
> Node 按真实路径解析插件内部依赖时会找不到 `node_modules` 而加载失败；
> `file:` 会把包复制进 profile 的依赖树（已实测验证）。
> pnpm 11 的 minimum-release-age 门禁会自动放行本插件依赖的 rc 包，无需额外配置。
>
> **pnpm 11 的 ignored-builds 提示会让 `dsh plugin` 报 "pnpm failed"**（依赖其实已装好）。
> 修复：把 profile 目录 `pnpm-workspace.yaml` 里 pnpm 生成的 `allowBuilds:` 占位值改为 `false`
> （`@google/genai`、`protobufjs` 的构建脚本对本插件无关紧要），然后重跑同一命令完成 bundle 对账。

### 验证安装完成

安装后 `dsh --profile web --dump-config`（或 `npx @deepseek-ai/dsh --profile web --dump-config`）应能看到 `llm-codex-auth-native-compact-image` 行。

> **更新插件代码**：`file:` 安装是硬链接快照，编辑器替换式写入不会被 pnpm 感知，直接重跑
> `add` 可能不会刷新。推荐先停止 dsh，再从仓库运行一键脚本；它会刷新当前真正生效的安装位置，
> 不需要为本地迭代反复 bump version：
> ```sh
> node scripts/install.mjs
> ```
> 如果坚持只使用 pnpm，则必须完整 remove/add：
> ```sh
> dsh plugin --profile web remove dsh-llm-codex-auth-native-compact-image
> dsh plugin --profile web add file:/path/to/dsh-llm-codex-auth-native-compact-image
> # 未全局安装 dsh 时，把上面的 dsh 换成 npx @deepseek-ai/dsh
> ```

## 使用

1. 重启 dsh 后打开**设置页**，侧栏选择「Codex 订阅 (ChatGPT)」。
2. 点击「登录 ChatGPT 账号」，按提示打开验证网址、输入设备码并登录你的 ChatGPT 账号。
3. 新建会话时选择 `Codex Native` agent preset（本机配置可把它设为默认），并在 **Models 设置页**选择 `codex-oauth` 下的模型；已经用 `standard` 创建的旧会话不会热切换 compaction provider。
4. agent 空闲且至少有两条可压缩 surface 消息时可输入 `/compact`；opaque checkpoint 本身约有千 token 级固定成本，短会话可能因“checkpoint 不比历史更小”而安全拒绝且不替换。正常对话达到模型 context window 的 80% 时会在 step 前自动 native compact，provider 报 context overflow 时也会尝试一次 native compact 后重试。
5. 展开 GUI 的压缩条目，应看到 `Provider-native Codex compaction checkpoint`；折叠态“已压缩 N 条历史记录”是所有 backend 共用文案，不能单独证明 native。
6. 登出：回设置页点「登出」，或在对话里输入 `/codex-logout`；`/codex-status` 可随时查看状态。

## 工作原理

| 组件 | 说明 |
|---|---|
| `src/adapter.js` | `LlmAdapter` 实现：codex 流 → dsh `StreamChunk` 协议、签名与 native checkpoint 回放、错误分类、空闲看门狗 |
| `src/transport.js` | 认证隔离的 Responses/V2 compact transport；只返回 opaque provider output 和非秘密 identity |
| `src/checkpoint.js` | 版本化 checkpoint carrier、lossless JSON 与 provider/model/identity 兼容性验证 |
| `src/engine.js` | native-aware 压力计量、manual/pressure/overflow `ctx.compaction`、tool-pairing 边界、日志 bracket、replacement 与 Scheme A flush |
| `src/compaction-plugin.js` | agent-scoped preset 入口：发布隔离的 `ctx.compaction`、`/compact` 和自动触发监听器 |
| `src/native-compact.js` | `/compact`、`/native-compact-probe` 与跨 provider 的联网前 replay 守卫 |
| `src/store.js` | pi-ai `CredentialStore` ↔ dsh 凭据库的桥（串行化读写，token 不出宿主） |
| `src/login.js` | 设备码登录编排（pi-ai 官方流，自动持久化凭据） |
| `src/server.js` | 宿主 `webServer` 挂 `/codex-oauth` HTTP 路由（status / login / logout），供浏览器半调用 |
| `src/client.js` | 浏览器半：设置页 `settings.section` 区块，经 `build.mjs` 打包成 client-modules 工厂格式 |
| `src/commands.js` | 只读命令 `/codex-status`、`/codex-logout` |

## 开发

- 纯 ESM JavaScript；宿主半无构建步骤（命名导出 `apply` / `inject` / `name`）。
- 浏览器半用 esbuild 打包：`node build.mjs`（React 外部化为 `require("react")`，复用宿主实例）。
- `dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh plugin add` 安装后自动加入 profile 的 bundle 层。
- `npm test` 在临时 `DSH_HOME` 中验证重复安装、pnpm 内层快照刷新、凭据不变和 profile 路径校验，无需网络或真实凭据。
- 测试套件在 `test/`：`smoke.mjs`（provider 路由 / HTTP 端点 / 命令 / 凭据库）、`stream-test.mjs`（流翻译、回放、错误分类、选项装配，含多轮回放回归用例）、`login-smoke.mjs`（设备码流联网冒烟，不涉及账号）。它们通过 profile 依赖树解析依赖，放进已安装本插件的 profile 目录运行：
  ```sh
  cp test/*.mjs .testhome/profiles/codex-test2/ && cd .testhome/profiles/codex-test2
  node smoke.mjs && node stream-test.mjs && node login-smoke.mjs
  ```
- 已知限制：自动 native compaction 只处理 `codex-oauth`；其他 provider 不会回退到 `compaction-basic`，而已经含 native checkpoint 的会话也不能跨 provider/model/account 回放。GUI 的通用 token meter 不读取 opaque source，engine 会按 Codex 对 remote-compaction ciphertext 的 model-visible 估算规则修正自身压力判断。图片仅走 durable attachment → base64 data URL，不支持远程图片 URL 或 OAuth Files API `file_id`。

## 安全与合规

- 仓库内不包含任何秘密。推送到 GitHub（公开或私有）前请确认 `.gitignore` 生效，**永远不要**提交 `$DSH_HOME/.credentials.yaml` 或其中内容。
- 本插件使用未公开的 ChatGPT 后端接口，存在违反 OpenAI 条款、账号受限的风险，使用者自担风险。

## License

MIT
