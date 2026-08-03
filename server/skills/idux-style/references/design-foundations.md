# IDux design foundations

Source baseline:

- Repository: `https://github.com/IDuxFE/idux`
- Website: `https://idux.site/`
- IDux version: `2.11.0`
- Source commit: `7047b9c1d6b640b79252c1aaca6ac4c656873aa2`
- Theme guide: `packages/site/src/docs/CustomizeTheme.zh.md`
- Getting started: `packages/site/src/docs/GettingStarted.zh.md`

## Theme model

IDux theme tokens form three levels:

1. Basic tokens define inputs such as primary color, base font size, base height, radius, and spacing.
2. Derived tokens calculate palettes, size scales, shadows, and state variants.
3. Extended tokens assign semantic values to concrete UI situations.

Use the most semantic available token. Avoid hard-coded colors and dimensions when an IDux token expresses the same intent.

Relevant default foundations:

- Base color: `--ix-color-primary`
- Page text: `--ix-color-text`
- Page background: `--ix-color-bg`
- Secondary surface: `--ix-color-info-container-bg`
- Container surface: `--ix-color-container-bg`
- Secondary border: `--ix-color-border-secondary`
- Base font size: 14px; normal body copy commonly uses the small derived size
- Base control height: 32px
- Base radius: 4px
- Base spacing: 8px
- Breakpoints: sm 600, md 960, lg 1280, xl 1720

The controlled generated project uses pre-generated static variables. Import structure CSS and one complete official theme:

```ts
import '@idux/components/index.full.css'
import '@idux/components/default.full.css'
```

For a reliably identified dark reference page, replace `default.full.css` with `dark.full.css`; never load both themes together.

## Page hierarchy

Use a restrained management-page hierarchy:

1. Breadcrumb or context label.
2. Page title, description, and one primary action.
3. Optional overview cards only when they summarize decisions.
4. Filter and search tools adjacent to the content they affect.
5. Primary data surface.
6. Live status or action feedback.

Prefer contrast and spacing over ornamental gradients. Use shadows only to indicate a low elevation or hover state.

## Viewport profiles

The generated page has two required logical viewports:

- Large: 1920×1080. Use the xl breakpoint to provide comfortable margins and a content width around 1600–1664px.
- Small: 1366×768. This remains a desktop management page. Reduce padding, gaps, card height, and nonessential description space while preserving task content.

Never stack the page into a phone layout at 1366px. Keep table identity, status, key fields, and operations legible.

## Accessibility and feedback

- Maintain at least 4.5:1 contrast for ordinary text.
- Provide an accessible name for search and icon-only controls.
- Keep default and primary controls at least 32px high.
- Announce action feedback through a visible `role="status"` region.
- Do not rely on color alone for state; include a readable label.
