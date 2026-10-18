---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-17-workspace-folders

[English](2026-10-17-workspace-folders.md) | 中文

## 概述

通过必需的 sandbox/workspace-roots Session 事件记录其他已批准的工作区目录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-workspace-folders
baseline: false
changes:
  - root: "event:sandbox/workspace-roots"
    previous: null
    after: "2ed1e856ba397443003fb95c647d12074f9f0255a2892779f87877dba860440e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 Session 不包含此事件，仍只以主 cwd 作为项目可写根目录。新读取器折叠最后一份完整的 additionalWorkspaceRoots 列表，不改变 cwd 或沙箱模式。旧读取器不认识此判别符，会在 Session 执行前拒绝未知的必需事件；遗漏会改变权限，因此不得把事件标记为可忽略。新判别符能够安全拒绝而不是不安全解释，所以写入版本保持不变。多文件夹工作区注册仍是可选的存储字段，不改变 Session header。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/sandbox/sandbox-policy/tests packages/api/session-controller/tests/session-presets.host.spec.ts packages/subagent/subagent/tests/continuation-inheritance.spec.ts：74 个通过，1 个平台相关跳过；覆盖事件缺席、回放、逐 Session 隔离、拒绝相对目录、必需模型上下文、新对话快照、已有权限不变、委派捕获及冷恢复。

<a id="dev-note"></a>
## 开发备注

无。
