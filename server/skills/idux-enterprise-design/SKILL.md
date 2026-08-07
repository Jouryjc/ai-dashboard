---
name: idux-enterprise-design
description: Plan, generate, review, and repair general-purpose B2B management platforms with Vue 3 and IDux. Use for business-app requirement contracts, application blueprints, information architecture, collection/detail/form/workflow patterns, action safety, responsive density, visual review, and Loop repair decisions. Adapts AWS Cloudscape task patterns to IDux without importing Cloudscape React components or assuming a cloud-computing domain.
---

# IDux Enterprise Design

Build a coherent B2B product that helps users finish domain tasks. Do not imitate a screenshot, a cloud-console theme, or a universal CRUD template.

## Execute the product loop

1. Convert the confirmed requirement contract into actors, objects, decisions, tasks, permissions, states, and verifiable outcomes.
2. Choose the application shell and navigation from product breadth and task switching frequency.
3. Choose a page pattern for every view from the user task and data shape. Never choose from visual habit.
4. Define global, contextual, bulk, risky, and recovery actions before choosing components.
5. Map the semantic pattern to IDux. Query exact component APIs and demos through `idux-cli`; never copy Cloudscape React implementation.
6. Keep `App.vue` as the composition root. Separate shell, task views, feedback, and state/action control.
7. Validate source, build, runtime, both desktop viewports, embedded scrolling, acceptance scenarios, network isolation, and visual hierarchy.
8. Return every failed gate to the Loop as an expected/observed contract. Repair the responsible layer and rerun the complete suite before committing a revision.

## Load references by decision

- Read [information-architecture.md](references/information-architecture.md) when defining the application shell, modules, navigation, and view hierarchy.
- Read [page-patterns.md](references/page-patterns.md) when choosing dashboard, collection, detail, create/edit, workflow, or settings patterns.
- Read [actions-states-feedback.md](references/actions-states-feedback.md) when defining toolbars, row actions, selection, destructive actions, feedback, or non-happy states.
- Read [responsive-density.md](references/responsive-density.md) when defining density, width, overflow, scrolling, or embedded-workbench behavior.
- Read [idux-mapping.md](references/idux-mapping.md) before selecting IDux components or generating source.
- Read [loop-quality-gates.md](references/loop-quality-gates.md) when reviewing, validating, diagnosing, or repairing a candidate.
- Read [sources-and-license.md](references/sources-and-license.md) when updating this skill or auditing provenance.

Runtime stages consume the compact guidance files directly: [requirements-guidance.md](references/requirements-guidance.md), [planner-guidance.md](references/planner-guidance.md), [review-guidance.md](references/review-guidance.md), and [repair-guidance.md](references/repair-guidance.md).

## Preserve non-negotiable boundaries

- Support arbitrary domains, modules, views, actions, workflows, permissions, and data contracts. Do not default to cloud resources, accounts, orders, or a fixed list structure.
- Treat a list as one view. A management capability may also need dashboard, detail, create/edit, approval, audit, settings, or investigation views.
- Use IDux for interactive controls and primary surfaces. Use `IxProLayout` for the application shell and `IxModal` for contextual confirmation.
- Put business meaning in the requirement contract and blueprint. Put component API truth in `idux-cli`. Put spacing and theme assets in `idux-style`.
- Do not ask users to decide reversible design-system details. Ask only when scope, workflow, data, permission, or safety outcomes are blocked.
- Do not accept decorative completeness. Every visible action must navigate, change verifiable state, or explain why it is unavailable.
- Do not promote a candidate until all required gates pass. A repaired candidate repeats the complete validation path.
