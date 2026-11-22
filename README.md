# mend-patch-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AARenor/mend-patch-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AARenor/mend-patch-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit an AI model wrote to a tree of text files: a unified diff with wrong line numbers, SEARCH/REPLACE blocks, a V4A patch, or text-editor JSON. It matches lines at three tiers, writes every change or none, and prints what it changed or why it failed. Node 22, standard library only.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The 100 public practice checks come with the bounty's kit (`program/generator/practice.json`); copy it to `.kit/practice.json` and run `node check.ts .kit/practice.json`.

## Code layout

`main.ts` handles arguments, input, format dispatch and the trial runner handover.
`lib/patch.ts` holds shared patch state and line helpers, and `lib/match.ts` separates position scanning from shared tier selection and indentation.
The unified, SEARCH/REPLACE, V4A and JSON readers live in separate `lib/` modules.
`lib/apply.ts` applies edits in memory, writes files only after every edit succeeds and builds the result lines. It removes deleted files before writing, so a new directory can replace a deleted file.

---

<sub>Entered on [make.fun](https://make.fun/?ref=33j7v2e3&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
