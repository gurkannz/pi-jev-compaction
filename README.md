<h1 align="center">pi-jev-compaction</h1>

<p align="center">
  <b>Context compaction for the pi coding agent that never rewrites a word.</b><br>
  Every tool call and result is scored by Jev; the stale ones go, the rest stay verbatim.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@gurkannz/pi-jev-compaction"><img alt="npm" src="https://img.shields.io/npm/v/%40gurkannz%2Fpi-jev-compaction?logo=npm&logoColor=white&label=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2f6feb">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A5%2022.19-5fa04e?logo=nodedotjs&logoColor=white">
  <img alt="tests" src="https://img.shields.io/badge/tests-27%20passing-2ea043">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-none-8957e5">
</p>

---

## The problem

Compaction normally asks an LLM to **summarise** old turns. A summary is lossy: a
file path, an exact error, a constraint or a command can disappear exactly when
it turns out to matter.

This package never rewrites anything. It only **deletes** tool calls and tool
results that are genuinely spent, and it decides that by showing the whole
conversation to [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
and asking about each one. Whatever survives is the original text, byte for byte.

```
 [user]   fix the failing parser test, don't touch legacy/   kept, verbatim
 [call]   read legacy/parser.ts                              dropped  ← spent
 [output] ████████████████ 12 KB                             dropped
 [asst]   the legacy one is unrelated                        kept, verbatim
 [call]   read src/parser.ts                                 kept
 [output] ████████████████ 18 KB                             cut to 300 chars
 [call]   npm test                                           kept
 [output] PASS                                               kept, verbatim
 [user]   now add a changelog entry                          kept, verbatim
```

Jev is not a chat model: it returns typed decisions with calibrated
probabilities instead of text, two orders of magnitude faster and cheaper than a
frontier model. That is what makes it affordable to ask two questions about
every tool call in the session, on every pass.

## Two places it prunes

`/jev` switches between them at any time, and the choice is remembered.

| Mode | What happens |
| :--- | :--- |
| `off` | Nothing. Pi compacts the way it always did. |
| **`compact`** | Only at compaction time. When pi is about to summarise the old part of the session, the surviving messages are handed back as text, verbatim, and no summary is generated. **Default.** |
| `always` | The above, plus every LLM call: from `triggerPercent` of the context window on, spent tool output leaves the live message list without waiting for a compaction. |

In `always` mode the scoring runs **in the background between turns**, so no turn
ever waits for Jev; its decisions apply from the next call onwards. A call that
has been let go is never brought back.

## Install

```sh
pi install npm:@gurkannz/pi-jev-compaction
```

Then set a TypeSafe API key — [Jev is in early access](https://docs.typesafe.ai/concepts/system-one):

```sh
export TYPESAFE_API_KEY=...        # or "apiKey" in the settings file below
```

`/jev` shows the state, `/jev always` and `/jev compact` change it.

> [!IMPORTANT]
> **Only one compaction extension at a time.** Pi runs every
> `session_before_compact` handler and keeps the result of whichever ran last, so
> a second compaction package costs an extra summarisation request and makes the
> outcome depend on load order. Disable the other one in `pi config`.

## How it works

1. Every tool call is paired with its result. Calls in the first and in the
   newest `preserveRecentMessages` messages are pinned and never touched.
2. The **state** sent to Jev is the whole conversation, oldest first, with every
   tool result replaced by a short note (`ok, 4213 chars (omitted)`). Tool inputs
   and texts are included; nothing is summarised.
3. The state is fitted into `maxStateTokens` in stages, each applied only if the
   previous one was not enough: tool inputs truncated to 1000, then 200, then 60
   characters; long texts abridged to head and tail, oldest first; old messages
   collapsed to a `[… N chars omitted …]` note; old calls reduced to one line;
   old call-less messages left out; runs of old call-only messages folded
   together. If it still does not fit, the pass gives up and pi compacts instead.
4. For every candidate call Jev gets two questions: should the **call** stay
   (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split across as many requests as needed to stay under
   `maxRequestTokens`; the same full state goes with each, and they run
   concurrently.
6. Against `keepThreshold`:

   | Decision | Outcome |
   | :--- | :--- |
   | result kept | call and result stay, untouched |
   | call kept, result not | result cut to `truncateHeadChars` plus a one-line note |
   | neither | the call disappears together with its result |

7. A message that loses all its content is removed, and no result is ever left
   without its call.

At compaction time the survivors are rendered back as the conversation itself,
under a header saying it is not a summary, and stored in pi's compaction entry.
The files the old messages read and changed travel in `details`, the way pi's own
compaction does, so the next compaction still knows about them.

## Settings

`~/.pi/agent/jev-compaction.json`, with `<project>/.pi/jev-compaction.json`
layered over it:

```json
{ "mode": "compact", "keepThreshold": 0.5, "triggerPercent": 60 }
```

| Option | Default | Description |
| :--- | :--- | :--- |
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

Pi's own compaction takes over — and says why — when Jev fails or answers
malformedly, the key is missing, the history does not fit the state budget, the
verbatim history would exceed `maxSummaryTokens`, or it would save less than
`minReductionRatio`. In `always` mode a failed pass simply leaves the context as
it is; the turn is never blocked or lost.

## Limitations

- Only tool calls and results are candidates. Text is never removed or shortened,
  and images in a dropped result are not carried into the note.
- At compaction time pi accepts one string, not a message list, so the surviving
  history is stored as text: the content is verbatim, the message structure is
  not. In `always` mode the structure survives, because there the real messages
  are pruned.
- Pruning the live context in `always` mode changes messages the provider has
  already cached, so a pass costs some prompt-cache reuse on the next call. It
  only runs from `triggerPercent` on, and only when the set of candidate calls
  has actually changed.
- Token sizes are estimated from character counts, not from a tokenizer.
- A probability is not a proof that a result is safe to delete. The assistant can
  always run the tool again.

## Development

```sh
npm install
npm run typecheck
npm test          # 27 tests, a fake Jev, no network
```

`src/core/` scores the calls and fits the state, `src/pi/` maps that onto pi's
messages, and `extensions/` is the pi extension itself.

<p align="center"><sub>MIT</sub></p>
