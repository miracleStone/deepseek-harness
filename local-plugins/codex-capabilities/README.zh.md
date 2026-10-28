---
description: "通过 Codex 订阅搜索、生成图片和编辑图片的本地组合包。"
kind: "package-bundle"
---

# Codex 订阅能力

[English](README.md) | 中文

## 概述

使用现有 ChatGPT 订阅登录来搜索网页、生成图片，以及编辑会话中选定的图片。这个可选本地组合包不改变会话模型、推理设置或 Fast 适配器。请求使用 ChatGPT 的订阅专用端点，而不是付费 OpenAI API 密钥。可用性和额度由 OpenAI 控制；私有端点可能随时变化。

## 目录

- [使用此包](#use-this-package)
- [配置](#configuration)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在插件管理器中将此目录安装为本地组合包，再在目标配置档中启用。链接安装时请保留该目录。组合包将 `web_search` 的提供方设为 `codex-subscription`，保持 `web_fetch` 使用标准 `http` 提供方，并添加 `codex_image_generate`。如果配置档覆盖了 `web` 行，须在其更高优先级配置中显式选择新提供方；请保留所需的自定义抓取提供方。移除组合包会移除其贡献，并恢复下层选择。桌面配置档由 Electron 独占管理，会拒绝普通 CLI 安装；请使用其插件管理器。

通过现有模型设置登录 `openai-codex`。无需浏览器 Cookie、复制令牌、额外登录流程或 OpenAI API 密钥。任何会话模型都可以调用安装后的能力；所有这类调用都使用已登录 Codex 账户的额度。

请求图片即可生成新图。编辑图片时，请先附上目标图片，或用 `read_image` 读取其本地文件；工具仅接受当前会话中已有的完整附件 ID。缺少或无效的引用会导致失败，不会改为生成替代图片。结果显示标准图片预览；附件后端可提供主机路径时，还会返回原始 PNG 路径。导出时将该文件复制为带 `.png` 扩展名的文件，切勿移动或覆盖附件存储对象。

<a id="configuration"></a>
## 配置

插入的 `codex-capabilities` 行拥有经过校验的设置。默认值为 `searchModel: gpt-5.6-luna`、`searchMode: live`、`imageModel: gpt-image-2.5-flare` 和 `imageQuality: auto`。搜索模式还支持 `cached` 或 `disabled`；`imagesEnabled: false` 会移除图片工具。这些设置在插件加载时生效，修改后需重新挂载。

`baseURL` 默认为 `https://chatgpt.com/backend-api/codex/`，且必须以 `/` 结尾。覆盖后的端点会收到订阅凭据：只可使用你信任的端点。除回环 HTTP 测试服务器外必须使用 HTTPS。搜索默认超时 30 秒、响应上限 2 MiB、输出令牌上限 4096。图片默认超时 5 分钟、解码后上限 32 MiB、JSON 外层预留 1 MiB；同时遵守附件后端更严格的图片限制。

图片工具接受 `size: auto` 或精确尺寸：边长为 16 的倍数、单边不超过 3840 像素、长宽比不超过 3:1、总像素在 655360–8294400 之间。背景支持 `auto`、`transparent` 或 `opaque`。支持的引擎为 `gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst`，两者均接受 auto/low/medium/high/xhigh/max 质量。订阅访问权限取决于账户。任何失败都不会静默切换引擎。

引擎选择依据 [OpenAI 模型选择指南](https://developers.openai.com/api/docs/guides/image-prompting.md#choose-a-model)和 [Sunburst 精确编辑说明](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst.md)。工具要求助手尊重用户显式选择，在快速日常生图、草稿和概念探索时优先选择 Flare；在质量优先或复杂生图，以及主体或产品保真比速度更重要的精确编辑时优先选择 Sunburst。两者都支持生成和编辑图片，不能仅凭美术风格或有无参考图来决定。省略 `model` 时的运行时默认值仍为 Flare。API 指南不能证明私有订阅端点具有固定的延迟提升、订阅额度差异或完美的细节保持能力。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>主机端实现</summary>

[认证](auth.js) 通过 pi-ai 和凭据服务的原子更新读取、刷新现有 `llm-pi-ai/openai-codex` 授权。令牌与账户 ID 必须匹配同一份已存储快照。就绪检查不会联系 OpenAI。凭据值不会进入工具输出或浏览器状态。

[搜索](search.js) 向 `alpha/search` 发送原生搜索命令。[图片](images.js) 向 `images/generations` 或 `images/edits` 发送请求；编辑引用编码为 JSON 数据 URL。这些操作读取有大小限制的 JSON，而非 Responses SSE。[传输](http.js) 拒绝重定向、传递取消信号、限制完整响应字节数，并清理错误报告中的敏感信息。它不会自动重试。

图片在存储前经过完整校验。附件服务将原始字节与规范化预览分别保存。存储失败不会返回成功，但已提交的内容寻址对象可能成为无引用对象。派发后的取消或传输失败无法证明 OpenAI 是否已完成操作或扣除额度；决定重试前请先检查结果。HTTP 401 提示重新登录；HTTP 403 需要检查访问权限、套餐/工作区、地区或网络；HTTP 429 需要等待额度恢复。

本实现参考 [WSL043/dsh-codex-subscription](https://github.com/WSL043/dsh-codex-subscription) 3.1.8 版的协议。[第三方声明](THIRD_PARTY_NOTICES.md) 保留其 MIT 条款。不包含原项目的账户保险库、自定义输入框/查看器、语音、远程控制或模型路由修改。

</details>

<a id="model-experience"></a>
## 模型体验

组合包将图片工具的声明添加到启用的会话，并让现有搜索工具返回订阅搜索来源。图片结果通过普通工具结果持久化文本、附件预览和原始文件元数据，回放无需自定义客户端插件。预览图片可能增加后续模型请求的图片/令牌用量；原始字节单独存储，不会自动发送给聊天模型。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办工作

这些端点是私有端点，且依赖账户权限。离线协议、OAuth 刷新、重定向拒绝、Loader 注册/卸载及图片存储测试无法证明当前 OpenAI 访问权限。在线搜索和生图需要符合资格的已登录账户；此处不声称已成功在线调用。只使用首张返回的 PNG；不提供图片流式输出、蒙版、自定义图片界面或订阅网页抓取。附件提供方必须同时支持原样文件存储和 PNG 预览。标准 HTTP 抓取提供方与订阅搜索相互独立。

<a id="dev-note"></a>
## 开发备注

在仓库根目录运行专用无密钥测试：`pnpm exec vitest run --config local-plugins/codex-capabilities/vitest.config.ts`。测试从此检出目录解析对等依赖；安装时从目标配置档解析。测试夹具中不得包含令牌或账户数据。
