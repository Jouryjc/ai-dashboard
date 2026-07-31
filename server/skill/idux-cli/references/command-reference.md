# IDux CLI command reference

## Contents

- [Choosing an executable](#choosing-an-executable)
- [Version selection](#version-selection)
- [Component discovery](#component-discovery)
- [API queries](#api-queries)
- [Demo queries](#demo-queries)
- [JSON interpretation](#json-interpretation)
- [Failure recovery](#failure-recovery)

## Choosing an executable

Prefer the first available form:

```bash
idux-cli <command>
idux <command>
node /path/to/idux-cli/bin/idux-cli.js <command>
```

Use the source entry point only while developing this repository. Do not invoke an unreviewed remote package through `npx` merely because the global command is absent.

`idux-cli --version` prints the CLI package version. It does not print the selected IDux catalog version.

## Version selection

Inspect available and selected catalogs:

```bash
idux-cli versions
```

Selection precedence:

1. `--idux-version <exact-version>`
2. `IDUX_VERSION`
3. exact `@idux/components` version installed in the current project or a parent workspace
4. active version selected by `use` or a latest sync
5. the catalog bundled with the CLI

Useful operations:

```bash
# Download and activate npm latest.
idux-cli sync

# Cache an exact version without activating it.
idux-cli sync 2.10.1

# Cache and activate an exact version.
idux-cli sync 2.10.1 --activate

# Select an already cached default.
idux-cli use 2.10.1

# Generate a catalog from an IDux checkout.
idux-cli sync 2.10.1 --source /path/to/idux
```

For version-pinned work, keep the flag on each read:

```bash
idux-cli info select props --idux-version 2.10.1 --json
```

`latest` means the active latest catalog already synced into the cache; it does not perform a network refresh. Run `sync` first when freshness is required.

## Component discovery

```bash
idux-cli list --json
idux-cli list select --json
idux-cli list --category components --json
idux-cli list --category pro --json
idux-cli list --category cdk --json
idux-cli list select --lang en --json
```

The `list` payload contains:

- `source`: upstream repository, ref, commit, and IDux version
- `total`: number of matches
- `components[]`: `id`, `category`, source name, localized title and description, `demoCount`, and `sourceUrl`

Use the returned `id` in later commands. IDs for standard components look like `button`; Pro and CDK IDs look like `pro-table` and `cdk-a11y`.

## API queries

`get` is an alias for `info`.

```bash
idux-cli info button --json
idux-cli get IxButton --json
idux-cli info select props --json
idux-cli info select slots --json
idux-cli info select events --json
idux-cli info select methods --json
idux-cli info button props --api IxButtonGroup --json
idux-cli info select SelectPanelProps --json
```

The optional section accepts:

- `all`
- `props`
- `slots`
- `events`
- `methods`
- an exact API section name, case-insensitively

`--api` filters the exported API owner or subcomponent by exact name, case-insensitively. If unsure which names exist, query a narrow section without `--api` and inspect `apis[].name`.

The `info` payload contains:

- `source`
- `component`
- requested `section`
- `apis[]`
  - `name`: exported component or API owner
  - `overview`
  - `sections[]`
    - `name`
    - `kind`
    - `overview`
    - `items[]` with `name`, `type`, `default`, `description`, and `remarks` when available

The `events` view derives entries whose prop names match `onXxx`. It intentionally keeps the original complete event declarations in the `props` view too.

## Demo queries

```bash
idux-cli demo button --list --json
idux-cli demo button Basic --json
idux-cli demo select Searchable --lang en --json
```

The demo payload contains:

- `source`
- `component`
- `total`
- `demos[]`
  - stable demo `name`
  - localized `title` and `description`
  - `order`
  - full Vue SFC `source`
  - commit-pinned `sourceUrl`

`--list` suppresses source only in human-readable output. Current JSON output still includes `source`, so filter the parsed payload when context size matters or use human-readable `--list` for discovery.

Demo lookup accepts the stable name or localized title. Prefer the stable name returned by the list.

## JSON interpretation

Always check `source.version` before using the result. `source.commit` and `sourceUrl` pin the evidence to the extracted upstream source.

Localized text follows `--lang zh|en`; when upstream English documentation is absent, the CLI can fall back to Chinese.

For events:

```text
onChange: (value, oldValue) => void
```

usually maps to:

```vue
<IxComponent @change="handleChange" />
```

For render functions or object props, use `{ onChange: handleChange }`.

## Failure recovery

- Component not found: inspect suggested IDs, then run `list <broader-keyword> --json`.
- Demo not found: run `demo <component> --list --json` and use the returned stable name.
- Catalog missing: run `sync <exact-version>` and repeat the query with `--idux-version`.
- npm/GitHub fetch blocked: use `sync <version> --source <local-checkout>`.
- Isolated CI or testing: set `IDUX_CLI_CACHE_DIR` or pass `--cache-dir`.
- WSL2 local checkout: use a WSL path such as `/mnt/d/code/idux`, not `D:\code\idux`.

Do not recover by querying a different IDux version unless the user explicitly accepts that substitution.
