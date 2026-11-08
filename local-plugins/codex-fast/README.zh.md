---
description: "本地 Codex Fast 适配器组合包：提供方设置保留、处理档位行为与准备限制。"
kind: "package-bundle"
---

# Codex Fast 桌面适配器

[English](README.md) | 中文

这是本 checkout 中源码适配器的本地部署，面向 DSH 0.2.2-alpha.2 和 pi-ai 1.3.0；manifest 拒绝其他 DSH 版本。此组合包禁用原有 `llm-pi-ai` 条目但不删除其设置，并使用全部现有提供方路由的快照挂载重新构建的适配器。只有 Codex 路由增加 `serviceTier: fast`；凭据以及默认模型和推理强度选择保持不变。

生成的适配器和 profile 专用 patch 被 Git 忽略。组合包安装期间，请保留此目录。激活期间所做的模型／提供方编辑属于 `codex-fast-adapter`，不属于已禁用的原条目。移除或禁用此组合包会恢复原适配器及其安装前设置；之后对替代适配器的编辑不会自动迁回。

通过 Plugin Manager 安装此目录。原作闪电 PNG 图标按 MIT 许可证随附。这是仅替换 Host 的组合包，不添加自定义浏览器组件。

`providers.openai-codex.serviceTier` 接受 `fast` 或 `default`。Fast 发送 `service_tier: priority`；标准档位发送 `default`。账号资格与计费由 OpenAI 控制。Fast 消耗更多订阅额度；本地速度或成本估算不能证明实际已获得优先处理。提供方失败不会触发档位切换。

## 构建后准备

源目录仍是已安装 DSH 0.2.2-alpha.2 的 link 目标。[候选准备流程](../session-fast/README.zh.md#isolated-candidate-builds) 必须显式选择仓库 `.artifacts` 下的新输出目录，并为当前根版本生成全部三个组合包。它从不改写源 manifest、adapter、patch 或带版本的运行文件。可选的 `--profile-patch` 读取原始 `llm-pi-ai` override，并拒绝已有档位；不提供时，准备流程读取已保留的 Codex Fast patch。准备流程从不安装或激活插件。
