---
description: "Local per-session Codex Fast controls, durable preferences, and subscription-usage limits."
kind: "package-bundle"
---

# Session Fast switch

English | [中文](README.zh.md)

This local bundle adds a Codex-only Fast row below the reasoning control and a non-interactive status badge beside the selected model outside the menu. The badge shows Fast when enabled and is hidden when disabled. A loading indicator or an unknown-state marker distinguishes unconfirmed settings; confirmed switch changes update the badge through the same session resource. Other providers show no badge. Each session stores its own preference in the `codex_session_fast` domain. Disabling Fast sends `service_tier: default` even when the provider profile requests Fast; enabling it sends `priority`. The selected model and reasoning strength are unchanged. A dispatched request retains its resolved tier while credential resolution and streaming finish; changes apply to subsequent requests. The initial value follows the installed Codex provider preference.

`/fast status`, `/fast on`, `/fast off`, and the UI switch share the same durable preferences. These are user-only subscription-usage controls: this bundle registers no model tools, and only the `openai-codex` route reads the session preference. Other providers keep their own request settings and tool schemas. New sessions and forks have independent preferences and initially use the provider default. The preference survives refresh and process restart. Opening the menu and changing its switch use the authenticated owner-only `/api/session-fast` preference endpoint, not commands; neither operation appends chat or Session command events. Only manually submitted `/fast` commands use the existing command audit events. This bundle adds no unknown Session event type and never removes existing audit history. Storage writes must succeed before the UI confirms a change.

This bundle targets DSH 0.2.2-alpha.2 and pi-ai 1.3.0; its manifest refuses other DSH versions. Install the accompanying `session-model-picker` bundle to provide the model-menu extension slot. Keep both local directories in place while installed. This bundle preserves the provider routes and sign-in from the earlier Codex Fast adapter and disables that adapter row without deleting its settings. Disabling this bundle restores the earlier adapter; its global Fast setting then applies again.

Fast consumes more subscription quota; account eligibility and actual priority allocation are controlled by OpenAI. This switch requests a tier, not a guaranteed response speed.

<a id="isolated-candidate-builds"></a>
## Isolated candidate builds

The source manifests and ignored runtime artifacts remain installed Desktop DSH 0.2.2-alpha.2 inputs. Both preparation entry points require `--candidate-root`; omitted arguments, source directories, existing outputs, and symlinked output ancestors are rejected. A candidate build reads current `llm-pi-ai/lib/index.js` and `ui-model-selection/lib/client.js`, bundles the Session Fast host and browser source, and copies runtime files, locales, icons, bilingual READMEs, and profile patches into three candidate packages. Generated manifests use the exact root DSH version and matching current vendor and installed third-party peers. Metadata checks alone do not establish runtime compatibility.

After the repository owner completes the current artifact build, use a new output directory from the repository root; do not run preparation against stale `lib` files:

```sh
node local-plugins/session-fast/prepare.mjs --candidate-root .artifacts/local-plugin-candidates-20261108
```

The Codex Fast preparation entry point accepts the same arguments and produces the same three packages. By default, preparation reads the existing Codex Fast patch without modifying it. Add `--profile-patch <original-profile-patch>` only to snapshot a different original `llm-pi-ai` override; that input must contain exactly one Codex route and no existing `serviceTier`. Candidate patches contain provider settings; keep them private. A failure leaves an incomplete output without `candidate-build.json`; choose a new output directory after fixing the failure. No preparation command changes plugin installation, profiles, or the running GUI.

Synthetic fixture tests require no current artifact build:

```sh
node --test local-plugins/session-fast/tests/prepare-candidates.test.mjs
```

The artifact metadata tests require a completed candidate root. In PowerShell, set the environment variable to that root before invoking the focused test; missing candidates fail rather than substituting legacy source manifests:

```powershell
$env:DSH_LOCAL_PLUGIN_CANDIDATE_ROOT = '.artifacts/local-plugin-candidates-20261108'
pnpm exec vitest run --config local-plugins/session-fast/vitest.config.ts local-plugins/session-fast/tests/runtime-compatibility.spec.ts
```

The same test retains separate assertions that all three original manifests admit alpha.2 and reject the current root runtime. Built runtime and browser verification remain the repository owner's responsibility before any separate installation decision.
