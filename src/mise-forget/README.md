# mise-forget

`mise-forget` removes entries from mise's tracked-configs list.

mise remembers every config file it has ever seen, in every directory you have
been in. Entries for archived or deleted projects therefore stick around and
keep showing up in `mise ls --all-sources`. `mise trust` / `mise untrust` do not
help here — they manage a different list (`trusted-configs`), and mise ships no
command for removing single tracked entries. This tool deletes the entries.

Works on Windows, Linux and macOS. On Windows mise stores each entry as a file
holding the path, elsewhere as a symlink to the config; both are handled, and
only the entry is removed, never the config it points to.

## Requirements

- [mise](https://mise.jdx.dev) on `PATH`
- Node.js 24 or newer, see the [installation](../../README.md#installation)

## Usage

```sh
# interactive list: mark entries, then review and confirm
mise-forget

# direct, still lists the entries and asks to confirm
mise-forget ~/old-project/mise.toml

# several paths and wildcards (quote them so the shell does not expand them)
mise-forget 'D:\Archive\*' 'C:\old\mise.toml'

# everything whose config file no longer exists (optionally narrowed by paths)
mise-forget --missing

# skip the confirmation (-y), or just preview with --dry-run (-n)
mise-forget --missing -y
mise-forget --missing -n

# delete for good instead of using the trash
mise-forget --missing --permanent
```

`mise-forget --help` lists all options.

## The interactive list

Entries that no longer exist are red. The list is the shared picker in
[`../lib/picker`](../lib/picker/index.ts).

| Key                    | Action                                                                        |
| ---------------------- | ----------------------------------------------------------------------------- |
| `↑` `↓` `PgUp` `PgDn`  | move                                                                          |
| `Space`                | mark / unmark                                                                 |
| `a` / `n`              | mark all matching the filter (all without one) / unmark all                   |
| `g`                    | switch between flat list and folder tree                                      |
| `←` `→`                | tree: collapse / expand a folder (`Space` on a folder marks everything below) |
| `d`                    | mark all missing entries                                                      |
| `p`                    | preview on / off (modified date and first lines of the config)                |
| `f` / `/`              | live filter (`Enter` or `Esc` leaves it)                                      |
| `Enter`                | done, then review and confirm                                                 |
| `Esc` / `q` / `Ctrl+C` | cancel                                                                        |

## Removing

Removed entries go to the trash (recycle bin on Windows) by default, so
restoring one brings the entry back. The confirmation offers trash (Enter),
permanent or no; `--yes` uses the trash, `--permanent` deletes for good.
Matching is case-insensitive on Windows and macOS, case-sensitive on Linux.

Note that mise re-adds the entry as soon as you `cd` into that project, so this
is only useful for projects you are done with.
