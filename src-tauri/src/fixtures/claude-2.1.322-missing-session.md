# Claude missing-session capture

Recorded on 2026-11-11 using Claude Code 2.1.322:

```sh
claude -p --resume 00000000-1111-4222-8333-444444444444 --output-format stream-json --input-format stream-json --verbose < /dev/null
```

The `.jsonl` and `.stderr.txt` files are the unedited stdout and stderr bytes
from the same process. Exit status: 1. The sole stdout event has `num_turns: 0`,
`total_cost_usd: 0`, and the missing-session text in `errors[]`, with no `result`
field. This probe makes no model call.
