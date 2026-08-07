# Page pattern decisions

These rules adapt Cloudscape patterns as semantic decisions. Implement them with IDux.

## Dashboard

Use a dashboard only when it supports at least one explicit objective:

- monitor health, trends, capacity, risk, or progress;
- investigate an issue and drill into evidence;
- inform users about required attention, changes, or onboarding.

Each dashboard item serves one goal and links to a complete task view. Use a static dashboard when order and prominence are product decisions. Use a configurable dashboard only when personalization is itself a requirement. Do not combine both models or place long operational tables and complex filtering directly on an overview.

## Collections

Choose the representation from data and comparison needs:

- Table: many objects share comparable metadata; users scan, sort, filter, select, or act in bulk.
- Cards: a small set has heterogeneous metadata or visual content and direct comparison is not dominant.
- Split collection: users repeatedly compare contextual details during monitoring, triage, or troubleshooting. Keep a dedicated detail view for complete information.
- Tree/grouped collection: hierarchy or grouping is part of the domain, not merely a visual preference.

A production collection includes the states and controls the task needs: title/count, search or property filters, sort, selection, global actions, contextual actions, pagination or progressive loading, preferences when justified, refresh/loading, empty, no-results, error, and permission states.

## Details

- Use a standard details page for a focused object summary and a few coherent sections.
- Use tabs when sections are peer information sets that users revisit independently.
- Use a hub when the object is an entry point to several related resources or workflows.
- Use a split panel only for fast contextual comparison; do not squeeze a full details page into it.

Put identity and status first, then the most frequent actions, then operational or historical details. Preserve a clear return path to the collection.

## Create and edit

- Modal create: one simple, reversible field and no dependent decisions.
- Single-page create: roughly 2–15 primary fields or up to five coherent groups with straightforward dependencies.
- Multi-step create: long or interdependent configuration, irreversible choices, or distinct concepts that need their own validation and review step.
- Full-page edit: several related properties, dependencies, or consequences need context.
- Inline/attribute edit: one or a few independent, low-risk values can be changed without losing context.

Place secondary configuration behind explicit sections with safe defaults. Validate near the field and provide a recoverable summary. Preserve unsaved-change awareness when leaving a form.

## Workflow and settings

Use workflow views for queues, approvals, assignments, audits, and state transitions. Expose actor, current state, allowed transition, reason, impact, and history. Use settings views for durable configuration, grouped by user goal; distinguish editable, read-only, inherited, and permission-restricted values.
