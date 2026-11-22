# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Bedos24/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Bedos24/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** is one command-line tool that applies AI-written edits in four formats to a tree of text files: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. It finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-insensitive), writes every change or none at all, and prints what it changed or why it failed. Node 22, standard library only — no install, no build step.

- Four readers: unified diff sections (create, delete, rename, change, multi-hunk with nearest-occurrence matching and `\ No newline at end of file`), SEARCH/REPLACE blocks (path from the line above the block, code fences ignored), V4A (`*** Begin Patch` … `*** End Patch`, anchors, cursors, end-of-file chunks, moves), and JSON edits (`create`, `str_replace`, `insert`, array or JSON Lines).
- Matching: tier 0 exact, tier 1 trailing whitespace ignored, tier 2 indentation ignored with re-indentation of the replacement; `--strict` pins tier 0.
- Atomic: a failed edit changes nothing, later edits still run, every failure is reported; `--check` previews without writing.
- CRLF files keep their line breaks; files without a final line break keep it that way unless the patch says otherwise; unsafe paths (`..`, absolute, backslashes) are refused.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or nothing) to read it from standard input. Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`, detected from the patch), `--check` (preview, write nothing), `--strict` (exact matching only). Examples:

```sh
node main.ts fix.patch
node main.ts --check < fix.patch
cat fix.patch | node main.ts --format=v4a -
```

Exit codes: `0` applied (prints `M`/`A`/`D`/`R` lines and `ok: <n> files`), `1` some edits failed (prints `error: <code> <path>` per failed edit and `failed: <k> of <n> edits`, nothing written), `2` usage, unreadable patch, unknown format, or parse error (`error: parse <N>`).

## Practice checks

The kit's practice set (100 checks with expected outcomes) passes 100/100 — unified 30/30, SEARCH/REPLACE 20/20, V4A 20/20, JSON 15/15, CLI 15/15:

```sh
node check.ts ../program/generator/practice.json
```

`SPEC.md` is the full contract the tool implements; `runner.ts` is the kit's trial runner, kept as shipped.

---

<sub>Entered on [make.fun](https://make.fun/?ref=daring-marten-90&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
