---
kind: upgrade-guide
description: "本地 Codex 能力组合包仅接受两个 GPT Image 2.5 标识符，并默认使用 Flare。"
---

# Codex 图片工具使用 GPT Image 2.5

[English](guide.md) | 中文

## 变更

可选本地组合包 `@local/dsh-codex-capabilities` 的 1.0.1 版从图片工具接受的 `model` 值和插件的 `imageModel` 配置中移除 `gpt-image-2`。默认值为 `gpt-image-2.5-flare`；仍可使用 `gpt-image-2.5-sunburst`。搜索和已存储的图片附件不变。

## 迁移

1. 在配置 `codex-capabilities` 行的配置档补丁或覆盖层中，将 `imageModel: gpt-image-2` 替换为 `imageModel: gpt-image-2.5-flare`，或移除 `imageModel` 以使用默认值。
2. 将显式发送 `model: gpt-image-2` 的工具调用方改为使用两个 GPT Image 2.5 标识符之一，或省略 `model`。
3. 安装并启用组合包 1.0.1 版。确认 `codex_image_generate` 仅列出 `gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst`。显式传入旧模型值会在任何网络请求前失败，不会静默切换引擎。
