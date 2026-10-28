---
description: "Local bundle for Codex subscription search, image generation, and image editing."
kind: "package-bundle"
---

# Codex subscription capabilities

English | [中文](README.zh.md)

## Summary

Use your existing ChatGPT subscription sign-in to search the web, generate images, and edit selected images in a conversation. This optional local bundle leaves the conversation model, reasoning settings, and Fast adapter unchanged. Requests use subscription-specific ChatGPT endpoints rather than a paid OpenAI API key. OpenAI controls availability and quota; private endpoints can change without notice.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install this directory as a local bundle in Plugin Manager, then activate it in the intended profile. Keep the directory in place for a linked installation. The bundle selects `codex-subscription` for `web_search`, keeps `web_fetch` on the standard `http` provider, and adds `codex_image_generate`. If your profile overrides the `web` row, its higher-priority configuration must select the new provider explicitly; preserve any custom fetch provider you need. Removing the bundle removes its contributions and restores lower-layer selections. The desktop profile is managed exclusively by Electron and rejects ordinary CLI installation; use its Plugin Manager.

Sign in to `openai-codex` through the existing model settings. No browser cookies, copied tokens, additional sign-in flow, or OpenAI API key are needed. Any conversation model can call the installed capabilities; every such call uses the signed-in Codex account's allowance.

Ask for an image to generate a new one. For an edit, attach the intended image or use `read_image` on its local file; the tool accepts only complete attachment IDs already in the current session. Missing or invalid references fail without generating a replacement image. The result shows a standard image preview and an original PNG host path when the attachment backend exposes one. Copy that file with a `.png` extension to export it; never move or overwrite the attachment-store object.

<a id="configuration"></a>
## Configuration

The inserted `codex-capabilities` row owns validated settings. The defaults are `searchModel: gpt-5.6-luna`, `searchMode: live`, `imageModel: gpt-image-2.5-flare`, and `imageQuality: auto`. Search mode also accepts `cached` or `disabled`; `imagesEnabled: false` removes the image tool. These settings apply when the plugin loads and require a remount after edits.

`baseURL` defaults to `https://chatgpt.com/backend-api/codex/` and must end in `/`. An override receives your subscription credential: use only an endpoint you trust. HTTPS is mandatory except for loopback HTTP test servers. Search defaults to a 30-second timeout, 2 MiB response limit, and 4096 output tokens. Images default to a 5-minute timeout, 32 MiB decoded limit, and 1 MiB JSON-envelope allowance; the attachment backend's stricter image limits also apply.

The image tool accepts `size: auto` or exact dimensions: multiples of 16, at most 3840 pixels per side, at most 3:1 aspect ratio, and 655360–8294400 total pixels. Background accepts `auto`, `transparent`, or `opaque`. The supported engines are `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`; both accept auto/low/medium/high/xhigh/max quality. Subscription access is account-dependent. No failure silently switches engines.

Engine selection follows [OpenAI's model-selection guide](https://developers.openai.com/api/docs/guides/image-prompting.md#choose-a-model) and [Sunburst's precise-editing guidance](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst.md). The tool tells the assistant to honor an explicit user choice, prefer Flare for fast everyday generation, drafts, and concept exploration, and prefer Sunburst for quality-critical or complex generation and precision-sensitive edits where subject or product preservation matters more than speed. Both engines generate and edit images; artistic style or the presence of references alone does not determine the choice. The runtime default remains Flare when `model` is omitted. API guidance does not establish a fixed latency gain, subscription allowance difference, or perfect detail preservation on the private subscription endpoint.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Host implementation</summary>

[Authentication](auth.js) reads and refreshes the existing `llm-pi-ai/openai-codex` grant through pi-ai and the credential service's atomic update. Token and account ID must match the same stored snapshot. Readiness checks do not contact OpenAI. Credential values never enter tool output or browser state.

[Search](search.js) posts to `alpha/search` with native search commands. [Images](images.js) posts to `images/generations` or `images/edits`; edit references are encoded as JSON data URLs. These operations consume bounded JSON, not Responses SSE. The [transport](http.js) rejects redirects, propagates cancellation, bounds complete response bytes, and sanitizes error reports. It performs no automatic retries.

Images are fully validated before storage. The attachment service saves the original bytes separately from its normalized preview. A storage failure returns no success, although already committed content-addressed objects can remain unreachable. A cancellation or transport failure after dispatch does not establish whether OpenAI completed the operation or consumed quota; inspect the result before deciding to retry. HTTP 401 requests renewed sign-in; HTTP 403 requires checking access, plan/workspace, region, or network; HTTP 429 requires waiting for quota availability.

This implementation adapts protocols from [WSL043/dsh-codex-subscription](https://github.com/WSL043/dsh-codex-subscription), version 3.1.8. [Third-party notices](THIRD_PARTY_NOTICES.md) retain its MIT terms. Its account vault, custom composer/viewer, voice, remote control, and model-routing modifications are not included.

</details>

<a id="model-experience"></a>
## Model Experience

The bundle adds the image tool's schema to enabled conversations and routes the existing search tool to subscription-backed sources. Image results persist text, an attachment preview, and original-file metadata in ordinary tool results, so replay does not require a custom client plugin. Preview images can increase later model-request image/token usage; original bytes are stored separately and are not sent to the chat model automatically.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

The endpoints are private and account-dependent. Offline protocol, OAuth refresh, redirect rejection, Loader registration/disposal, and image-storage tests do not establish current OpenAI access. Live search and image generation require an eligible signed-in account; no successful live call is claimed here. Only the first returned PNG is used; image streaming, masks, custom image UI, and subscription-backed page fetching are not provided. The attachment provider must support verbatim file storage as well as PNG previews. The standard HTTP fetch provider remains independent of subscription search.

<a id="dev-note"></a>
## Dev Note

Run the focused keyless suite from the repository root with `pnpm exec vitest run --config local-plugins/codex-capabilities/vitest.config.ts`. Tests resolve peers from this checkout; installation resolves them from the target profile. No token or account data belongs in test fixtures.
