# IDux list and table page pattern

Source baseline:

- Table design: `packages/components/table/docs/Design.zh.md`
- Card design: `packages/components/card/docs/Design.zh.md`
- Button design: `packages/components/button/docs/Design.zh.md`
- Pagination design: `packages/components/pagination/docs/Design.zh.md`
- Source commit: `7047b9c1d6b640b79252c1aaca6ac4c656873aa2`

## Information order

Order columns as:

1. Object identity or selection.
2. Status.
3. Core attributes required for comparison.
4. Time.
5. Operations.

Give identity and status stable widths. Keep critical IP addresses complete. Put shared units in column headings. Format precise time as `yyyy-mm-dd hh:mm:ss`.

## Table behavior

- Keep the header and primary body content visible at 1366×768.
- Use internal horizontal scrolling for wide tables; never page-level horizontal scrolling.
- Freeze identity or operation columns only when horizontal scrolling would otherwise hide the task context.
- Use pagination when the dataset is genuinely larger than one page. Align it to the bottom right.
- Limit visible row operations to four; collapse additional operations into “更多”.
- Keep destructive actions visually and behaviorally distinct and require confirmation.

## Cards and summaries

Use overview cards only for values that help users decide what to inspect or act on. Emphasize the value, keep labels concise, and avoid duplicating the same total in several places.

## Search and filtering

- Place search in the table toolbar.
- Use a domain-specific placeholder.
- Filter identity and high-value comparison fields.
- Keep the result count close to the table title.
- Preserve a visible empty state instead of showing a blank table.

## Density by viewport

At 1920×1080:

- Page horizontal padding: 48–56px.
- Content width: about 1600–1664px.
- Section gaps: 24px.

At 1366×768:

- Page horizontal padding: 24–32px.
- Section gaps: 16px.
- Reduce overview-card padding and toolbar gaps.
- Keep control height at 32px and table header at least 40px.
