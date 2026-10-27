---
description: "Local per-session Codex Fast controls, durable preferences, and subscription-usage limits."
kind: "package-bundle"
---

# Session Fast switch

English | [中文](README.zh.md)

This local bundle adds a Codex-only Fast row below the reasoning control and a non-interactive status badge beside the selected model outside the menu. The badge shows Fast when enabled and is hidden when disabled. A loading indicator or an unknown-state marker distinguishes unconfirmed settings; confirmed switch changes update the badge through the same session resource. Other providers show no badge. Each session stores its own preference in the `codex_session_fast` domain. Disabling Fast sends `service_tier: default` even when the provider profile requests Fast; enabling it sends `priority`. The selected model and reasoning strength are unchanged. A dispatched request retains its resolved tier while credential resolution and streaming finish; changes apply to subsequent requests. The initial value follows the installed Codex provider preference.

`/fast status`, `/fast on`, `/fast off`, and the UI switch share the same durable preferences. These are user-only subscription-usage controls: this bundle registers no model tools, and only the `openai-codex` route reads the session preference. Other providers keep their own request settings and tool schemas. New sessions and forks have independent preferences and initially use the provider default. The preference survives refresh and process restart. Opening the menu and changing its switch use the authenticated owner-only `/api/session-fast` preference endpoint, not commands; neither operation appends chat or Session command events. Only manually submitted `/fast` commands use the existing command audit events. This bundle adds no unknown Session event type and never removes existing audit history. Storage writes must succeed before the UI confirms a change.

Install the accompanying `session-model-picker` bundle to provide the model-menu extension slot. Keep both local directories in place while installed. This bundle preserves the provider routes and sign-in from the earlier Codex Fast adapter and disables that adapter row without deleting its settings. Disabling this bundle restores the earlier adapter; its global Fast setting then applies again.

Fast consumes more subscription quota; account eligibility and actual priority allocation are controlled by OpenAI. This switch requests a tier, not a guaranteed response speed.
