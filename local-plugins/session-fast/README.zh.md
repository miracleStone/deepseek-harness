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
