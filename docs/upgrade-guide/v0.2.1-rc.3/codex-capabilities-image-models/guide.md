---
kind: upgrade-guide
description: "The local Codex capabilities bundle accepts only the two GPT Image 2.5 identifiers and defaults to Flare."
---

# Codex image tools use GPT Image 2.5

English | [中文](guide.zh.md)

## Change

Version 1.0.1 of the optional local `@local/dsh-codex-capabilities` bundle removes `gpt-image-2` from the image tool's accepted `model` values and from the plugin's `imageModel` configuration. The default is `gpt-image-2.5-flare`; `gpt-image-2.5-sunburst` remains available. Search and stored image attachments are unchanged.

## Migration

1. In any profile patch or overlay configuring the `codex-capabilities` row, replace `imageModel: gpt-image-2` with `imageModel: gpt-image-2.5-flare` or remove `imageModel` to use the default.
2. Update tool callers that explicitly send `model: gpt-image-2` to use one of the two GPT Image 2.5 identifiers, or omit `model`.
3. Install and activate bundle version 1.0.1. Confirm that `codex_image_generate` lists only `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`. Old explicit model values fail before any network request; they do not silently switch engines.
