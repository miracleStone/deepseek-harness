---
kind: upgrade-guide
description: "旧版 Harness 无法恢复记录了多个工作区文件夹的 Session。"
---

# 多文件夹 Session 需要兼容的 Harness

[English](guide.md) | 中文

## 变更

工作区可以保留其他文件夹，原始目录仍是默认工作目录。新对话通过必需的 `sandbox/workspace-roots` Session 事件记录这些已批准的目录。旧版 Harness 会拒绝这些 Session，而不会静默使用不同的目录权限。已有的单文件夹 Session 保持不变；[持久化确认记录](../../../persistence-changes/2026-10-17-workspace-folders.zh.md)说明读取器兼容性。

## 迁移

1. 开始多文件夹对话前，升级所有访问同一 Session 存储的 Harness 安装。不要删除必需事件来让旧读取器接受 Session。
2. 打开工作区的**管理文件夹**操作，添加其他目录。新建对话后才使用更新的文件夹列表；已有对话及其权限保持不变。
3. 确认新对话的运行时上下文列出了工作区文件夹。从工作区移除文件夹只影响后续对话，不会删除文件。
