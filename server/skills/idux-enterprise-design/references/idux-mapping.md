# IDux semantic mapping

Query every selected component through `idux-cli` for the bundled IDux version before implementation. Component names below are roles, not permission to guess props.

| Enterprise role | Preferred IDux surface |
| --- | --- |
| application shell and module navigation | `IxProLayout`, `IxMenu`, `IxBreadcrumb` |
| collection and comparison | `IxTable`, `IxPagination`, `IxInput`, `IxSelect`, `IxCheckbox` |
| contextual detail | `IxDrawer` or a responsive in-layout panel |
| object details | `IxDesc`, `IxTabs`, `IxCollapse`, `IxCard` when a bounded surface is needed |
| create/edit | `IxForm`, `IxFormItem`, IDux input controls, `IxStepper` for validated multi-step flows |
| action hierarchy | `IxButton`, `IxDropdown`, `IxSpace` |
| status and progress | `IxTag`, `IxBadge`, `IxProgress`, `IxSpin` |
| feedback and terminal states | `IxAlert`, `IxEmpty`, `IxResult`, IDux message/notification APIs |
| destructive confirmation | `IxModal` confirm; typed confirmation uses an IDux input inside the modal |

Keep `idux-cli`, `idux-enterprise-design`, and `idux-style` responsibilities separate:

- `idux-cli`: exact API, slots, events, demos, version, and source commit.
- `idux-enterprise-design`: information architecture, page-pattern decisions, actions, states, density, and Loop gates.
- `idux-style`: theme files, tokens, shell CSS, and visual foundations.

Do not add Cloudscape packages, React, arbitrary dependencies, remote assets, native look-alike controls, or component wrappers that hide business semantics. Keep view components focused by pattern and keep application state/actions in a controller or store boundary.
