# Information architecture

## Model the product

Use this hierarchy:

```text
application -> navigation group -> module -> task view -> object/state/action
```

- Application: one product identity, global context, data-mode disclosure, and cross-module feedback.
- Navigation group: a stable user mental model, not a list of generated pages.
- Module: an independently evolving business capability with its own objects, tasks, permissions, and regression scenarios.
- Task view: one dominant user goal. A view is not automatically a route, table, or card.
- Object/state/action: the business contract that makes a view executable and testable.

## Choose navigation

- Prefer side navigation for broad multi-module products, frequent switching, nested groups, and long-lived operational work.
- Prefer top navigation only for a small number of peer modules with shallow hierarchy and short labels.
- Keep module navigation stable while task views change. Use breadcrumbs to expose current hierarchy and return paths.
- Put product-wide controls in the header. Put module controls in the module or view header. Do not mix them into the data surface.
- Make the default module the most common entry task or a meaningful overview; do not add an overview only to fill space.

## Define the view inventory

Derive views from tasks and state transitions. Consider:

- overview for monitoring, investigation entry points, or onboarding;
- collection for finding, comparing, selecting, and acting on objects;
- detail for understanding one object and navigating its related tasks;
- create/edit for changing validated business data;
- workflow for review, approval, triage, or multi-party state transitions;
- settings for product or module configuration;
- custom task views when none of the standard patterns fits.

Do not force every module to contain every view. Do not treat four KPI cards plus a table as a complete product.

## Keep hierarchy visible

Each task view must expose the current module, view title, concise purpose, dominant action, task surface, and relevant state. Repeated page-level wrappers, nested cards, oversized hero areas, or decorative metrics must not compete with the task.
