---
description: "Local Codex Fast adapter bundle: preserved provider settings, tier behavior, and preparation limits."
kind: "package-bundle"
---

# Codex Fast desktop adapter

English | [中文](README.zh.md)

Local deployment of the source adapter in this checkout, targeting DSH 0.2.2-alpha.2 and pi-ai 1.3.0; other DSH versions are refused by its manifest. This bundle disables the original `llm-pi-ai` row without deleting its settings and mounts the rebuilt adapter with a snapshot of all existing provider routes. Only the Codex route gains `serviceTier: fast`; credentials and the default model/reasoning selection remain unchanged.

The generated adapter and profile-specific patch are ignored by Git. Keep this directory in place while the bundle is installed. Model/provider edits made while it is active belong to `codex-fast-adapter`, not the disabled original row. Removing or disabling this bundle restores the original adapter and its pre-install settings; later edits to the replacement do not migrate back automatically.

Use Plugin Manager to install this directory. The original PNG lightning icon is included under the MIT license. This is a Host-only replacement and adds no custom browser component.

`providers.openai-codex.serviceTier` accepts `fast` or `default`. Fast sends `service_tier: priority`; Standard sends `default`. Account eligibility and billing are controlled by OpenAI. Fast uses more subscription allowance; no local speed or cost estimate establishes actual priority allocation. Provider failures do not switch tiers.

## Prepare after building

The source directory remains the installed DSH 0.2.2-alpha.2 link target. [Candidate preparation](../session-fast/README.md#isolated-candidate-builds) requires an explicit, new output directory below repository `.artifacts` and generates all three bundles for the current root version. It never rewrites source manifests, adapters, patches, or versioned runtime files. An optional `--profile-patch` reads the original `llm-pi-ai` override and refuses an existing tier; without it, preparation reads the preserved Codex Fast patch. Preparation never installs or activates plugins.
