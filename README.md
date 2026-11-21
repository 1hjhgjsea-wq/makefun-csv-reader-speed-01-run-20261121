# makefun-csv-reader-speed-01-run-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/1hjhgjsea-wq/makefun-csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/1hjhgjsea-wq/makefun-csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0. `solve.js` answers
exactly as csv-reader does on every input — same `{columns, rows, errors}`,
including its broken-row policy (BOM, CRLF/LF, stray CRs, quoted fields,
`quote_junk`, `unterminated_quote`, short/long row padding and cutting, and
the `{code, line, row}` error order) — while reading roughly 4× faster than
the reference on the practice set (about 4.3× on pure-parse CPU time with
the house driver's `--no-incremental-marking` flag).

How it gets there: a line with no quote and no stray CR is split on its
commas with `indexOf` and `slice`; a line with a quote but no stray CR is
read field by field within the line, so neither needs a terminator search
or line counting; only lines with a stray CR, and fields spanning lines,
go through the general reader, which finds each terminator with `indexOf`
and slices spans instead of walking characters. No per-field objects are
allocated; the only arrays built are the output's own.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or
`$MAKEFUN_INPUT_DIR/cases.json` outside a container), answers each with
`run` from `solve.js`, and writes `/output/answers.json` (or
`$MAKEFUN_OUTPUT_DIR/answers.json`). Node 22, no dependencies, no install
step.

To check it against the reference on the practice set, from the unpacked kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver docker
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=qg9vrma2&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
