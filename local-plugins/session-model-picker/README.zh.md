---
description: "本地模型选择器组合包及其供配套控制项使用的会话作用域扩展 slot。"
kind: "package-bundle"
---

# 会话模型选项

[English](README.md) | 中文

此本地组合包加载重新构建的模型选择器，在推理行下方提供会话作用域的 `conversation.input.model.options` 列表 slot。现有模型选择、推理等级、模型标签、搜索及菜单定位仍由其所属组件负责。扩展菜单按钮参与该组件的方向键、Tab 和 Escape 行为。

此组合包面向 DSH 0.2.2-alpha.2；manifest 拒绝其他 DSH 版本。配套的 Session Fast 组合包提供 Fast 开关。禁用此选择器会恢复随产品交付的选择器。安装期间请保留此目录；其中生成的浏览器产物是已安装的旧版产物。[候选准备流程](../session-fast/README.zh.md#isolated-candidate-builds) 将当前选择器构建复制到独立的 `.artifacts` 目录，从不覆盖此浏览器产物。闪电图标是与本地 Codex Fast 组合包共用的原作，采用 MIT 许可证。
