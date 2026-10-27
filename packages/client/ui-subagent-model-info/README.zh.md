---
description: "在 Web 客户端的工具卡片与页头谱系中展示子智能体的模型名称与思考强度。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent-model-info

[English](README.md) | 中文

## 概述

本包在 Web 客户端中展示 subagent 的模型名称与推理强度。它为 `subagent` 与 `subagent_fork` 工具调用卡片补充这些信息，并为页头 subagent 谱系目录中的每一项添加模型徽标。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本插件向 `tool.call.toolview` 插槽注册 `subagent` 与 `subagent_fork` 的专属视图，向面包屑目录的 `subagent.lineage.item.meta` 及根目录的 `conversation.session.header.actions.subagent.item.meta` 插槽注入模型信息。本插件或所属插槽声明卸载时，相关贡献均会移除。

可在配置中通过 profile patch 禁用本插件以恢复默认展示：

```yaml
- id: ui-subagent-model-info
  disabled: true
```

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节 — 点击展开</summary>

浏览器端入口通过 `ctx.slots.inject()` 注册，工具卡片优先级为 `-10`。它根据当前父会话的 `subagentCatalog` 投影，把持久化 activation receipt 的 `name` 关联到 child 的 Session ID；名称绝不作为 Session ID。没有元数据的历史 ID receipt 必须匹配本地子会话目录成员，或列表中父会话相同的子代理。后台任务 ID 绝不作为 child Session ID，元数据损坏时不会退回解析 receipt 文本。请求的模型与思考强度来自惰性工具入参视图；省略的值通过 `useSessions` 使用 child 的 `modelSelection` 或初始 `subagent` descriptor。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器展示

#### 模型看到什么

`subagent`、`subagent_fork` 卡片与谱系徽标仅在浏览器中展示；本包不添加提示词文本、工具 schema 或 Session 事件。

#### Token 影响

展示模型与 `reasoning_effort` 标签不会增加模型输入或输出 token。

#### KV Cache 影响

本包不改变模型请求内容或缓存前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 工具卡片装饰仅覆盖 `subagent` 和 `subagent_fork` 名称；其他委派别名保留原有展示。

<a id="dev-note"></a>
### 开发备注

无。
