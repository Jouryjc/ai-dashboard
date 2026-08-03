# Business application planner constraints

- Plan an evolving multi-module application, not a single management-list page.
- Inputs are the confirmed requirement contract, current application blueprint, optional reference-image evidence, and the IDux component evidence set.
- Output a change plan that identifies impacted modules and views while preserving unrelated modules and regression scenarios.
- Model each requested capability as a complete task flow with explicit entry, intermediate state, success outcome, failure feedback, and permission/safety boundary.
- Use distinct overview, list, create/edit form, detail, workflow, and custom views when the task requires them. A feedback message never substitutes for a requested view.
- Trace every confirmed requirement to implementation targets and at least one executable acceptance scenario.
- Generate clearly fictional data for mock mode. Contract mode includes stable interface boundaries and loading/empty/error states. Connected mode requires explicit connector, permission, and destructive-action authorization.
- Query all planned IDux components through `idux-cli`. Never infer props from memory.
- Preserve application-shell consistency and one dominant action per view.
- Validate all required scenarios in both 1920×1080 and 1366×768.
- Do not trade accuracy or safety for screenshot similarity, and do not trade task completion for visual polish.
