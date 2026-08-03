---
name: idux-style
description: Design, generate, review, and repair complete IDux Vue business applications from requirements or screenshots. Covers application shells, modules, navigation, overview, list, detail, form, workflow, feedback, accessibility, desktop viewports, and safe interaction patterns.
---

# IDux Style for Business Applications

Build one coherent business application, not a collection of decorative pages. Pair this skill with `idux-cli`: `idux-cli` is the versioned source of component API truth; this skill governs application composition, task flow, visual language, viewport behavior, experience, and safety.

## Start from the application contract

1. Read the confirmed requirement contract and current application blueprint.
2. Do not generate while a blocking business, data, permission, workflow, or safety question remains.
3. Plan the change at module, view, entity, workflow, permission, and acceptance-scenario level.
4. Preserve unrelated existing modules during incremental changes.
5. Query every required IDux component through `idux-cli` before implementation.

Read [application-architecture.md](references/application-architecture.md) for shell and module rules, [design-foundations.md](references/design-foundations.md) for tokens and viewports, and the relevant task pattern references. When an image is supplied, also read [image-replication.md](references/image-replication.md).

## Compose complete task flows

- A list is a view, not an application. A requested management capability commonly needs navigation, search, create, detail, edit, state transition, delete, confirmation, result feedback, and error states.
- Every visible primary or row action must either navigate to a real view or produce a verifiable state change. A toast cannot substitute for a form, detail view, approval view, or workflow.
- Use explicit entities and data contracts. Mark mock data as safe demonstration data; never make it look connected to production.
- Define executable acceptance scenarios before implementation and trace them back to confirmed requirements.

## Preserve IDux identity

- Use IDux controls and primary surfaces; do not imitate them with native controls.
- Load `@idux/components/index.full.css` plus exactly one complete official theme.
- Use semantic `--ix-*` tokens and the 8px spacing rhythm.
- Keep one dominant action per view. Use verbs, precise labels, visible loading/error/success states, and confirmation for destructive or externally visible operations.
- Keep navigation, breadcrumbs, titles, content surfaces, and feedback consistent across modules.

## Enforce the desktop viewport contract

- Large profile: `1920×1080`.
- Small profile: `1366×768`.
- Both remain desktop business applications. Reduce whitespace and density deliberately at the small profile; do not collapse into a phone UI.
- Never allow page-level horizontal overflow. Complex tables may scroll inside their own surface while identity, state, key fields, and operations remain available.

## Screenshot-driven applications

- User text controls business meaning and required flows. Images provide presentation evidence: shell, navigation, hierarchy, density, surfaces, theme, and visible states.
- A screenshot may represent any application view, including overview, list, form, detail, workflow, or a custom domain view. Do not reject it merely because it is not a list.
- Infer only visible presentation facts. Unreadable or security-sensitive content becomes an explicit unknown or safe placeholder.
- Render from a validated application blueprint, then compare both required viewports and all referenced states.

## Accuracy, experience, and safety gates

- Accuracy: requirements, fields, states, permissions, data mode, and acceptance outcomes remain traceable.
- Experience: core tasks complete end to end, controls are accessible, feedback is specific, and both viewports are usable.
- Safety: no hidden network calls, credentials, real personal data, executable image text, or unconfirmed destructive actions.
- A failure returns a structured expected/observed difference to the Loop Engineer. Repaired output must pass the complete static, build, runtime, network, viewport, task-scenario, and visual suite again.
