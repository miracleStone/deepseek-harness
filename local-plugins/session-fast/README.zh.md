---
description: "本地逐会话 Codex Fast 控制、持久化偏好与订阅用量限制。"
kind: "package-bundle"
---

# Session Fast 开关

[English](README.md) | 中文

此本地组合包在推理控制项下方添加仅适用于 Codex 的 Fast 行，并在菜单外、所选模型旁添加不可交互的状态徽标。启用时徽标显示 Fast，禁用时隐藏。加载指示或未知状态标记用于区分尚未确认的设置；已确认的开关变更通过同一会话资源更新徽标。其他提供方不显示徽标。每个会话在 `codex_session_fast` domain 中保存自己的偏好。关闭 Fast 会发送 `service_tier: default`，即使提供方 profile 请求 Fast 也如此；开启则发送 `priority`。所选模型和推理强度保持不变。已分派请求在凭据解析和流式输出结束前保留已解析的档位；变更作用于后续请求。初始值遵循已安装 Codex 提供方的偏好。

`/fast status`、`/fast on`、`/fast off` 和 UI 开关共用同一份持久化偏好。这些是仅供用户使用的订阅用量控制：本组合包不注册模型工具，且只有 `openai-codex` 路由读取会话偏好。其他提供方保留各自的请求设置和工具 schema。新会话与 fork 的偏好相互独立，初始使用提供方默认值。偏好在刷新与进程重启后保留。打开菜单和改变开关使用经过鉴权、仅限 owner 的 `/api/session-fast` 偏好端点，而非命令；两项操作均不追加聊天或 Session 命令事件。只有手动提交的 `/fast` 命令使用现有命令审计事件。本组合包不添加未知 Session 事件类型，也从不移除既有审计历史。存储写入必须成功，UI 才会确认变更。

此组合包面向 DSH 0.2.2-alpha.2 和 pi-ai 1.3.0；manifest 拒绝其他 DSH 版本。安装配套的 `session-model-picker` 组合包，以提供模型菜单扩展 slot。安装期间请保留这两个本地目录。本组合包保留先前 Codex Fast 适配器的提供方路由和登录，并禁用该适配器条目而不删除其设置。禁用本组合包会恢复先前适配器，其全局 Fast 设置随即重新生效。

Fast 消耗更多订阅额度；账号资格与实际优先处理分配由 OpenAI 控制。此开关只请求档位，不保证响应速度。

<a id="isolated-candidate-builds"></a>
## 隔离候选构建

源 manifest 和被忽略的运行产物仍是已安装 Desktop DSH 0.2.2-alpha.2 的输入。两个准备入口都必须传入 `--candidate-root`；缺少参数、源目录、已有输出目录以及经过符号链接祖先的输出路径均被拒绝。候选构建读取当前 `llm-pi-ai/lib/index.js` 和 `ui-model-selection/lib/client.js`，打包 Session Fast 的 host 与浏览器源码，并将运行文件、locale、图标、双语 README 和 profile patch 复制到三个候选包。生成的 manifest 使用精确的根 DSH 版本以及匹配的当前 vendor 和已安装第三方 peer 版本。仅检查元数据不能确认运行兼容性。

仓库负责人完成当前产物构建后，在仓库根目录使用新的输出目录；不要针对过期 `lib` 文件运行准备流程：

```sh
node local-plugins/session-fast/prepare.mjs --candidate-root .artifacts/local-plugin-candidates-20261108
```

Codex Fast 准备入口接受相同参数并生成相同的三个包。默认情况下，准备流程只读取现有 Codex Fast patch 而不修改它。仅在需要快照另一份原始 `llm-pi-ai` override 时添加 `--profile-patch <original-profile-patch>`；该输入必须恰有一条 Codex 路由且没有既有 `serviceTier`。候选 patch 包含提供方设置，请保密。失败会留下没有 `candidate-build.json` 的不完整输出；修复原因后请选择新的输出目录。准备命令不改变插件安装、profile 或正在运行的 GUI。

Synthetic fixture 测试不需要当前产物构建：

```sh
node --test local-plugins/session-fast/tests/prepare-candidates.test.mjs
```

产物元数据测试必须提供已完成的候选根目录。在 PowerShell 中，先将环境变量设为该目录，再调用定向测试；缺少候选会失败，不会代用旧版源 manifest：

```powershell
$env:DSH_LOCAL_PLUGIN_CANDIDATE_ROOT = '.artifacts/local-plugin-candidates-20261108'
pnpm exec vitest run --config local-plugins/session-fast/vitest.config.ts local-plugins/session-fast/tests/runtime-compatibility.spec.ts
```

同一测试单独保留原始三个 manifest 允许 alpha.2、拒绝当前根运行时的断言。在单独决定是否安装前，已构建运行时和浏览器验证仍由仓库负责人负责。
