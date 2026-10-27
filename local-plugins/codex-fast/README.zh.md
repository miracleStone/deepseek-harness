---
description: "本地 Codex Fast 适配器组合包：提供方设置保留、处理档位行为与准备限制。"
kind: "package-bundle"
---

# Codex Fast 桌面适配器

[English](README.md) | 中文

这是本 checkout 中源码适配器的本地部署，兼容 DSH 0.2.1-rc.2 和 pi-ai 1.1.0。此组合包禁用原有 `llm-pi-ai` 条目但不删除其设置，并使用全部现有提供方路由的快照挂载重新构建的适配器。只有 Codex 路由增加 `serviceTier: fast`；凭据以及默认模型和推理强度选择保持不变。

生成的适配器和 profile 专用 patch 被 Git 忽略。组合包安装期间，请保留此目录。激活期间所做的模型／提供方编辑属于 `codex-fast-adapter`，不属于已禁用的原条目。移除或禁用此组合包会恢复原适配器及其安装前设置；之后对替代适配器的编辑不会自动迁回。

通过 Plugin Manager 安装此目录。原作闪电 PNG 图标按 MIT 许可证随附。这是仅替换 Host 的组合包，不添加自定义浏览器组件。

`providers.openai-codex.serviceTier` 接受 `fast` 或 `default`。Fast 发送 `service_tier: priority`；标准档位发送 `default`。账号资格与计费由 OpenAI 控制。Fast 消耗更多订阅额度；本地速度或成本估算不能证明实际已获得优先处理。提供方失败不会触发档位切换。

## 构建后准备

使用当前桌面 profile patch 路径运行 `prepare.mjs`，将已构建适配器及提供方设置复制到组合包中。准备过程读取但不修改源 profile。若已有档位设置，则拒绝准备，避免静默覆盖另一偏好。安装和激活是分开的 Plugin Manager 操作。
