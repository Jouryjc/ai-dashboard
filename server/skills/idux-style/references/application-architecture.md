# IDux business application architecture

## Application shell

The shell owns brand context, module navigation, current-module state, breadcrumbs, data-mode disclosure, and global feedback. Implement it with the version-pinned `IxProLayout`; side/mixin navigation is the default for several modules, while header navigation is appropriate for a small, shallow application. Navigation must always lead to a real module default view.

`App.vue` is only the composition root and provider boundary. Generate the shell, view heading, overview/list/form/detail renderers, destructive-action modal, and runtime state controller as separate files. A valid blueprint is not permission to collapse the implementation into one SFC.

## Modules and views

A module groups one cohesive business responsibility. Each module declares its entities, workflows, permissions, default view, views, and requirement IDs. Views represent user tasks rather than visual containers:

- overview: decisions, risk, workload, and entry points;
- list: search, filters, comparison, selection, and row operations;
- form: create or edit with validation, cancel, submit, and result state;
- detail: complete selected-object context and permitted next actions;
- custom: domain-specific tasks such as topology, scheduling, allocation, or approval.

## Actions and workflows

Actions must map to navigation, mutation, or a workflow transition. Destructive actions have high risk and explicit confirmation through an `IxModal` confirm dialog with object identity, impact text, cancel, and a danger-styled confirm action. Inline cards or banners do not satisfy this boundary. State transitions declare valid source states, target state, permission, confirmation behavior, and an acceptance outcome.

## Data modes

- mock: isolated fictional records; no network access;
- contract: front-end behavior plus explicit interface contract, including loading/empty/error behavior;
- connected: an authorized connector and permission boundary are mandatory, with secrets kept outside generated source.

## Acceptance

Each must-have capability needs a scenario that runs through visible controls and asserts the resulting view, record, state, or feedback. Run scenarios independently at 1920×1080 and 1366×768 so state leakage cannot hide defects.
