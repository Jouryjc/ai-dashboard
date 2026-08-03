---
name: idux-style
description: Design and validate IDux Vue business pages from text requirements or reference screenshots using the official IDux design system, theme tokens, component composition rules, and the repository's 1920×1080 / 1366×768 page profiles. Use when generating, screenshot-replicating, restyling, reviewing, or repairing IDux pages, especially list, table, card, filter, form, and management interfaces.
---

# IDux Style

Create IDux business pages that look and behave like one coherent product. Pair this skill with `idux-cli`: use `idux-cli` for versioned component APIs and this skill for page composition, density, tokens, and viewport behavior.

## Apply the workflow

1. Identify the user's primary task and business object before choosing a page pattern.
2. Query every IDux component API used in the page through `idux-cli`; do not infer props from memory.
3. Read [design-foundations.md](references/design-foundations.md) for theme, token, viewport, and accessibility rules.
4. For list or table management pages, also read [list-page-pattern.md](references/list-page-pattern.md).
   When a reference screenshot is present, read [image-replication.md](references/image-replication.md).
   The generation planner consumes the concise [planner-guidance.md](references/planner-guidance.md) constraints.
5. Reuse [list-page.vue.tpl](assets/list-page.vue.tpl) and [page-shell.css](assets/page-shell.css) when the requested page matches that pattern.
6. Validate at both `1920×1080` and `1366×768`. Treat either viewport as a required delivery target.

## Replicate screenshots through a blueprint

- Analyze the reference image before planning code. Extract only visible page structure, text hierarchy, component roles, density, and surface organization.
- Treat user text as the business requirement and the image as the presentation reference.
- Convert the analysis to a validated IDux page specification; never paste image-derived text directly into executable code.
- Compare both rendered viewports with the reference image during visual review.
- If the image is unsupported or the vision model is unavailable, stop explicitly. Do not silently generate a generic page.

## Preserve IDux identity

- Use IDux components for controls and primary surfaces. Do not imitate them with native elements.
- For the controlled static-theme build, load the component structure file and one complete official theme:

```ts
import '@idux/components/index.full.css'
import '@idux/components/default.full.css'
```

- Use `dark.full.css` instead of `default.full.css` only when a reference image is reliably classified as a dark IDux page.
- Use semantic `--ix-*` tokens for page layout. Prefer global or component tokens over internal selector overrides.
- Base spacing on IDux's 8px scale. Keep control heights, typography, borders, shadows, and status colors consistent with the default preset.
- Make one primary page action visually dominant. Express actions as verbs and provide visible feedback.
- Keep table columns in task order: identity, status, core attributes, time, operations.

## Enforce the viewport contract

- Large page: `1920×1080`.
- Small page: `1366×768`.
- Scale the fixed logical page for preview; do not reinterpret the small profile as a phone layout.
- At 1366×768, reduce surrounding spacing before hiding content. Keep the title, primary action, table header, identity/status columns, key attributes, and row operations available.
- Allow table-internal horizontal scrolling only when the domain genuinely needs more columns. Never introduce page-level horizontal overflow.

## Protect accuracy and safety

- Keep formats consistent by column. Include units in headings when all values share a unit.
- Show IP addresses completely when they are task-critical. Use `yyyy-mm-dd hh:mm:ss` for precise timestamps.
- Use clearly fictional demonstration data. Never place real credentials, private network endpoints, or personal data in generated files.
- Keep network access disabled in generated previews. Require explicit confirmation for destructive or externally visible actions.
- Do not mark a page complete based on class names alone; verify computed IDux theme variables, component structure, contrast, layout, and interaction.

## Repair conservatively

Use [quality-overrides.css](assets/quality-overrides.css) only for known layout failures. For other failures, return a structured expected/observed difference to the Loop Engineer. A model repair may replace only approved `src` files and must pass the same static, build, runtime, network, viewport, and task-scenario gates before it is accepted.
