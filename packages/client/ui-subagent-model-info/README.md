---
description: "Show model name and reasoning effort for subagents in tool cards and header lineage."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent-model-info

English | [中文](README.zh.md)

## Summary

This package displays the model name and reasoning effort for subagents in the Web client. It decorates `subagent` and `subagent_fork` tool call cards and adds a model badge to each entry in the header subagent lineage catalog.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The plugin contributes to `tool.call.toolview` for `subagent` and `subagent_fork` tool calls, to `subagent.lineage.item.meta` in breadcrumb catalogs, and to `conversation.session.header.actions.subagent.item.meta` in the root catalog. Each contribution is removed when this plugin or its owning slot declaration unloads.

Disable this row through a profile patch to restore default unadorned subagent rows:

```yaml
- id: ui-subagent-model-info
  disabled: true
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser entry contributes through `ctx.slots.inject()`, with priority `-10` for tool cards. It resolves the persisted activation receipt's `name` through the current parent's `subagentCatalog` projection to the child's Session ID; names are never Session IDs. Historical ID receipts without metadata require matching local-child catalog membership or a listed subagent with the same parent. Background job IDs are never child Session IDs, and malformed metadata does not fall back to receipt text. Requested models and reasoning efforts come from the lazy tool-argument view; omitted values use the child's `modelSelection` or initial `subagent` descriptor through `useSessions`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Browser presentation

#### What the model sees

The `subagent` and `subagent_fork` cards and lineage badges are browser-only; this package adds no prompt text, tool schemas, or Session events.

#### Token effect

Displaying model and `reasoning_effort` labels does not add model-input or output tokens.

#### KV Cache effect

The package does not change model request content or cached prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Tool-card decoration is limited to the `subagent` and `subagent_fork` names; other delegation aliases retain their existing presentation.

<a id="dev-note"></a>
### Dev Note

None.
