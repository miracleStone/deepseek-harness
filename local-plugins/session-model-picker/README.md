---
description: "Local model-selector bundle and its session-scoped extension slot for companion controls."
kind: "package-bundle"
---

# Session model options

English | [中文](README.zh.md)

This local bundle loads the rebuilt model selector with the session-scoped `conversation.input.model.options` list slot below the reasoning row. Existing model selection, reasoning levels, model labels, search, and menu positioning remain in their owning component. Extension menu buttons participate in its arrow-key, Tab, and Escape behavior.

This bundle targets DSH 0.2.2-alpha.2; its manifest refuses other DSH versions. The companion Session Fast bundle contributes the Fast switch. Disabling this picker restores the shipped selector. Keep this directory in place while installed; its generated browser artifact is copied by the companion preparation script after rebuilding the source selector. The lightning icon is original artwork shared with the local Codex Fast bundle under the MIT license.
