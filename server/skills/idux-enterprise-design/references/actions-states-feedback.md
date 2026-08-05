# Actions, states, and feedback

## Place actions by scope

- Global action: applies to the page, collection, current selection, or multiple objects. Place it in the page or collection header.
- Contextual action: applies to one object. Place it in the row, card, detail header, or relevant section.
- Bulk action: requires explicit selection and must state the number and scope of affected objects.
- Primary action: the dominant next step for the current view. Keep one visually dominant action per view or contained dashboard item.

Offer all important operations through a stable global location; duplicate only frequent single-object actions contextually. Disable unavailable actions with a reason or hide them only when disclosure would be unsafe.

## Match confirmation friction to impact

- Low-risk, instantly reversible action may execute directly with specific feedback.
- Non-trivial or hard-to-recreate change uses an IDux confirmation modal naming the object and consequence.
- Irreversible, cascading, high-cost, or bulk destructive action requires additional typed confirmation or an explicit prerequisite/recovery explanation.

Never insert a confirmation card into normal page content. Never confirm a generic “operation”; name the action, target, affected scope, and recovery consequence.

## Model all states

For every data surface, plan the applicable states:

- initial loading and background refresh;
- populated and partially populated;
- empty with explanation and a relevant next action;
- filtered no-results with a clear-filter recovery;
- data error with retry or escalation;
- permission denied with scope and resolution path;
- stale, pending, partial-success, or conflict when the workflow supports them.

Do not replace these states with placeholder text or a success toast.

## Give outcome-specific feedback

Feedback states what changed, which object was affected, and what the user can do next. Keep inline field errors near inputs; use alerts for page/data failures; use transient messages only for outcomes that do not need durable context. Long-running work exposes progress, cancellation rules, and the final result.
