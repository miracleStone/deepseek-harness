---
kind: upgrade-guide
description: "Older Harness versions cannot resume Sessions that record multiple workspace folders."
---

# Multi-folder Sessions require a compatible Harness

English | [中文](guide.zh.md)

## Change

A Workspace can retain additional folders while its original directory remains the default working directory. New conversations record these approved directories as required `sandbox/workspace-roots` Session events. Older Harness versions refuse these Sessions instead of silently applying different directory permissions. Existing single-folder Sessions remain unchanged; the [persistence acknowledgement](../../../persistence-changes/2026-10-17-workspace-folders.md) records reader compatibility.

## Migration

1. Upgrade every Harness installation that opens the same Session storage before starting multi-folder conversations. Do not remove the required event to make an older reader accept a Session.
2. Open a Workspace's **Manage folders** action and add its additional directories. Start a new conversation to use the updated folder list; existing conversations and their permissions remain unchanged.
3. Confirm that the new conversation's runtime context lists its workspace folders. Removing a folder from the Workspace affects subsequent conversations only and never deletes files.
