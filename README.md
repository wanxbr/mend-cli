# mend

[![make.fun badge][makefun-badge]][makefun-url]
[![License: MIT][mit-badge]][mit-url]
[![Dev entry][dev-badge]][dev-url]

One command-line tool that applies the edits AI models write, in four formats, to a tree of files. Built for the [make.fun "Build mend, one patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

```bash
node main.ts [options] [PATCH]
```

Apply edits to your file tree in any of four formats: unified diff, SEARCH/REPLACE blocks, V4A patches, or JSON edits. The tool detects the format automatically or accepts it via `--format`.

### Options

- `--format=NAME`: Specify format: `unified`, `search-replace`, `v4a`, `json`, or `auto` (default)
- `--check`: Validate without writing changes
- `--strict`: Match lines exactly (tier 0 only)
- `PATCH`: Path to patch file, or `-` to read from stdin

## The files

- `main.ts`: The CLI entry point
- `runner.ts`: Test harness for running checks in isolated environments
- `check.ts`: Practice test runner for local validation
- `SPEC.md`: Complete specification of all four formats and expected behavior
- `README.md`: This file
- `LICENSE`: MIT license

## Running practice tests

```bash
node check.ts practice.json
node check.ts practice.json u-exact s-basic
```

Runs practice checks locally, displaying failures and scoring.

## What makes a good entry

The spec defines four formats and handles edge cases carefully: wrong line numbers, drifted whitespace, blank context lines, prose and code fences around patches, CRLF files, files without final line breaks, and ambiguous matches. Read SPEC.md sentence by sentence.

[makefun-url]: https://make.fun/bounty/hidden-spec-cli-01-run-20261122
[makefun-badge]: https://img.shields.io/badge/make.fun-hidden--spec--cli--01-brightgreen
[mit-badge]: https://img.shields.io/badge/License-MIT-blue
[dev-badge]: https://img.shields.io/badge/status-dev--entry-lightgrey
[dev-url]: https://make.fun/
