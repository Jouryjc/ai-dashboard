# Responsive density and scroll ownership

## Desktop profiles

- `1920×1080`: preserve application hierarchy and allow broad comparison surfaces.
- `1366×768`: reduce padding and optional metadata, but keep navigation, title, dominant action, task surface, and readable controls.
- `862×623` embedded workbench: preserve the desktop application model while allowing the ProLayout content region to scroll.

Do not scale the entire application down. Do not collapse a management platform into a phone layout at the required profiles.

## Scroll ownership

- `html`, `body`, `#app`, and the application shell remain bounded by the viewport.
- The ProLayout content region owns vertical page scrolling.
- Wide tables own horizontal scrolling inside the table surface. Keep identity, state, selection, and actions discoverable.
- Drawers, modals, menus, and long forms own their internal overflow when open.
- Never combine a clipped root frame with content that can grow but has no scroll owner.

## Density

Choose density from task frequency and information volume:

- compact for repetitive operational comparison and dense collections;
- comfortable for mixed workflows and most management pages;
- spacious only for low-density onboarding or decision-heavy forms.

Use semantic IDux tokens and an 8px rhythm. Reduce decorative padding before shrinking type or controls. Avoid nested cards for every section. Full-width collection pages may use the available content area; forms and reading-heavy detail sections should use a controlled line length.

## Responsive priority

Assign information priority in the blueprint. At smaller profiles:

1. preserve object identity, status, dominant action, and blocking warnings;
2. preserve fields needed to choose or complete the task;
3. move secondary metadata to details, expandable areas, or a contextual panel;
4. never silently remove permissions, risk explanations, or workflow outcomes.
