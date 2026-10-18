---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-17-workspace-folders

English | [中文](2026-10-17-workspace-folders.zh.md)

## Summary

Records additional approved workspace directories as a required sandbox/workspace-roots Session event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing Sessions contain no such event and retain the primary cwd as their only project write root. New readers fold the last complete additionalWorkspaceRoots list without changing cwd or sandbox mode. Older readers do not recognize this discriminator and refuse required unknown events before Session execution; the event must not be marked ignorable because omission would change permissions. The writer version stays unchanged because the new discriminator gives safe refusal rather than unsafe interpretation. Multi-folder Workspace registration remains an optional storage field and is not a Session header change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/sandbox/sandbox-policy/tests packages/api/session-controller/tests/session-presets.host.spec.ts packages/subagent/subagent/tests/continuation-inheritance.spec.ts: 74 passed, 1 platform-specific skip; covers absent event, replay, per-Session isolation, invalid relative roots, required model context, new-conversation snapshots, unchanged existing grants, delegation capture, and cold resume.

<a id="dev-note"></a>
## Dev Note

None.
