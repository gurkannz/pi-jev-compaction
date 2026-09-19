# @gurkannz/pi-jev-compaction

Pi package that compacts context without summarising it: every tool call and
every tool result is scored in one fast request to TypeSafe's Jev model, the
stale ones are dropped or truncated, and everything that stays, stays verbatim.

## What and why

Compaction normally asks an LLM to summarise old turns. A summary is lossy: a
file path, an exact error, a constraint or a command can disappear even when it
matters later. This package never rewrites anything. It only deletes tool calls
and tool results that Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text is never touched.

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is not a
chat model: it returns typed decisions with calibrated probabilities instead of
text, two orders of magnitude faster and cheaper than a frontier model, which is
what makes it affordable to ask two questions about every tool call in the
session.

## The two places it prunes

`/jev` switches between them at any time, and the choice is remembered.

| Mode | What happens |
| --- | --- |
| `off` | Nothing. Pi compacts the way it always did. |
| `compact` | Only `session_before_compact`: when pi is about to summarise the old part of the session, the surviving messages are handed back as text, verbatim, and no summary is generated. This is the default. |
| `always` | The above, plus `context`: from `triggerPercent` of the context window on, stale tool output leaves the live message list before every LLM call, without waiting for a compaction. |

In `always` mode the scoring runs **in the background between turns**, so no
turn ever waits for Jev; the decisions it reaches are applied from the next call
onwards. A call that has been let go is never brought back.

## How it works

1. Every tool call is paired with its result. Calls in the first and in the
   newest `preserveRecentMessages` messages are pinned and never touched.
2. The **state** sent to Jev is the whole conversation, oldest first, with every
   tool result replaced by a short note (`ok, 4213 chars (omitted)`). Tool
   inputs and texts are included; nothing is summarised.
3. The state is fitted into `maxStateTokens` in stages, each applied only if the
   previous one was not enough: tool inputs truncated to 1000, then 200, then 60
   characters; long texts abridged to head and tail, oldest first; old messages
   collapsed to a `[… N chars omitted …]` note; old calls reduced to one line;
   old call-less messages left out; runs of old call-only messages folded
   together. If it still does not fit, the pass fails and pi compacts on its own.
4. For every candidate call Jev gets two questions: should the **call** stay
   (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split across as many requests as needed to stay under
   `maxRequestTokens`; the same full state goes with each, and they run
   concurrently.
6. Against `keepThreshold`: result kept → call and result stay; else call kept →
   the result is cut to its first `truncateHeadChars` characters plus a note;
   else the call disappears together with its result.
7. A message that loses all its content is removed, and no result is ever left
   without its call.

At compaction time the result is rendered back as the conversation itself, with
a header saying it is not a summary, and stored in pi's compaction entry. The
files the old messages read and changed are carried in `details`, the way pi's
own compaction does, so the next compaction still knows about them.

## Install

Requires a TypeSafe API key ([Jev is in early access](https://docs.typesafe.ai/concepts/system-one)):

```sh
export TYPESAFE_API_KEY=...        # or put "apiKey" in the settings file below
```

From npm, once published:

```sh
pi install npm:@gurkannz/pi-jev-compaction
```

From a checkout, to try it first:

```sh
pi install /path/to/pi-jev-compaction     # -l writes to the project instead
pi remove /path/to/pi-jev-compaction      # to undo
```

Then `/jev` shows the state, and `/jev always` or `/jev compact` changes it.

> **Only one compaction extension at a time.** Pi runs every
> `session_before_compact` handler and keeps the result of whichever ran last,
> so another compaction package (for example `pi-smart-compact`) will both cost
> a summarisation request and make the outcome depend on load order. Disable the
> other one in `pi config` before using this.

## Settings

`~/.pi/agent/jev-compaction.json`, with `<project>/.pi/jev-compaction.json`
layered over it:

```json
{ "mode": "compact", "keepThreshold": 0.5, "triggerPercent": 60 }
```

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `compact` | `off`, `compact` or `always`; `/jev` writes this back |
| `apiKey` | – | TypeSafe key; `TYPESAFE_API_KEY` wins over it |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | System One endpoint | Where to send the requests |
| `keepThreshold` | `0.5` | Minimum probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `triggerPercent` | `60` | Context percentage from which `always` mode prunes |
| `minReductionRatio` | `0.25` | Below this saving, pi's own summary is used |
| `maxSummaryTokens` | `24000` | A verbatim history larger than this falls back to pi's summary |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped result kept before its note |

`TYPESAFE_API_KEY` and `PI_JEV_MODE` override the files.

## When it steps aside

Pi's own compaction takes over, and says why, when Jev fails or answers
malformedly, the key is missing, the history does not fit the state budget, the
verbatim history would be larger than `maxSummaryTokens`, or it would save less
than `minReductionRatio`. In `always` mode a failed pass simply leaves the
context as it is; the turn is never blocked or lost.

## Limitations

- Only tool calls and results are candidates. Text is never removed or
  shortened, and images in a dropped result are not carried into the note.
- At compaction time pi accepts one string, not a message list, so the surviving
  history is stored as text: the content is verbatim, the message structure is
  not. In `always` mode the structure is kept, because there the real messages
  are pruned.
- Pruning the live context in `always` mode changes messages the provider has
  already cached, so a pass costs some prompt-cache reuse on the next call. It
  only runs from `triggerPercent` on, and only when the set of candidate calls
  has actually changed.
- Token sizes are estimated from character counts, not from a tokenizer.
- A probability is not a proof that a result is safe to delete. The assistant
  can always run the tool again.

## Development

```sh
npm install
npm run typecheck
npm test          # 27 tests, a fake Jev, no network
```

`src/core/` scores the calls and fits the state, `src/pi/` maps that onto pi's
messages, and `extensions/` is the pi extension itself.
