# mend

Apply model edits to text files using unified diffs, SEARCH/REPLACE blocks, V4A patches, or JSON edits. All edits succeed together, or no files change.

Run with Node 22 and no dependencies:

```sh
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

Leave out `PATCH`, or use `-`, to read standard input. Use `--check` to preview changes without writing files. Use `--strict` to require exact line matches.

Check the practice score:

```sh
/usr/bin/node check.ts .kit/practice.json
```

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AARenor/mend-patch-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AARenor/mend-patch-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
<sub>Entered on [make.fun](https://make.fun/?ref=33j7v2e3&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
