# LLM deciders: OpenAI Decisions, Gemini and consensus

The mission planner builds every candidate action itself: the harness-built candidate set, from the truth-free belief. A cloud model may only **choose one candidate id** from that set. It never actuates, approves, rejects or declares an outcome. The chosen id resolves to the application's own immutable proposal, which the harness validates like any other. Glass, water and payload actions still wait for the commander's individual approval. Whatever goes wrong with a cloud call, the deterministic local planner's choice is used.

## Modes

Pick a mode with **Mission planner** in run setup (`RunConfig.decider`):

| Mode | `decider` | Who chooses |
| --- | --- | --- |
| Local planner | `local` | The local planner only. No network call. |
| OpenAI Decisions | `decisions` | OpenAI Decisions (`gpt-6-luna`), with the local planner as fallback. |
| Gemini | `gemini` | Gemini (`gemini-3.6-flash`, low thinking), with the local planner as fallback. |
| Consensus | `consensus` | OpenAI Decisions and Gemini, asked in parallel over the same request. Their choice is used only when they agree. |

Batch evaluation always uses `local`.

## Request path

The mission worker sends one request at a time to `POST /api/decisions`, adding `?provider=gemini` or `?provider=consensus` for those modes. The route (`src/app/api/decisions/route.ts`, logic in `src/lib/navigation/planner/gateway.ts`) admits only local callers, rejecting a foreign Host or Origin with 403 before any upstream call. It validates the body strictly, takes a rate-limit token (one per-process bucket per provider, burst 5, 30 per minute; consensus needs a token from both buckets), and calls each provider with a 2 s deadline and no automatic retry. The worker also stops waiting after 2 s.

Both providers get the same fixed instructions. Report text, caller text and candidate descriptions travel only as data: an `input_json` part for OpenAI and the user-turn JSON for Gemini. None of it is ever placed in the instructions. Gemini's JSON response schema allows only `rationale` and `choice`, and `choice` is an enum of exactly the offered ids. The rationale is parsed for type and dropped, because it may repeat untrusted report text.

Each provider's outcome maps to one status. `ok` is an offered id. `refused` is a refusal, or for Gemini a blocked prompt or safety-type finish. `invalid` is an answer that names an id that was not offered or does not fit the schema. `timeout` is no answer within the deadline. `unconfigured` means the provider's key is missing, and no call is made. `error` covers HTTP or network failures and malformed replies. Every reply names the `decider` that was asked and lists each provider's own `proposals`.

The Gemini call (`gemini-gateway.ts`) uses REST over `fetch`, with no SDK: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `responseMimeType: application/json`, `responseJsonSchema` and `thinkingConfig.thinkingLevel`. To switch models, change `GEMINI_MODEL` and `GEMINI_THINKING_LEVEL`. The header comment records the docs and the date they were verified.

## Consensus semantics

- The worker's broker works out agreement from the two per-provider proposals itself. It never uses the reply's top-level choice.
- **Agreed** means exactly one OpenAI Decisions and one Gemini proposal, both `ok`, both naming the same offered id. That choice is used and labelled **"Consensus: OpenAI Decisions + Gemini"**, and its proposal is attributed to `consensus_planner`. If both chose `defer`, the local planner decides.
- **Disagreed** (both chose different offered ids) and **incomplete** (either was refused, invalid, timed out, unconfigured or errored, or the reply carried no proposals) both use the local planner's choice. The status then reads, for example, `Local planner (consensus not reached: the models disagreed: OpenAI Decisions chose "…", Gemini chose "…")` or `Local planner (consensus not reached: OpenAI Decisions chose "…", Gemini timed out)`. One model's lone choice is never used in consensus mode.
- If either provider is unconfigured, the rest of the run stays local, because consensus cannot be reached without both keys. A reset restores cloud planning.
- Each `decision.selected` event and decision record keeps `cloudDecider`, both `proposals` (`{provider, choice, status}`) and `agreement` (`agreed`, `disagreed` or `incomplete`). That serves the commander's timeline and the decisions collection.

## Honesty labels

The command label (`DeciderView.label`), the action card's "Proposed by" and the event reason name a model only when that model's choice was used:

| Label | When |
| --- | --- |
| `OpenAI Decisions` | Its offered choice was used (proposer `decisions_planner`). |
| `Gemini` | Its offered choice was used (proposer `gemini_planner`). |
| `Consensus: OpenAI Decisions + Gemini` | Both chose that same offered id (proposer `consensus_planner`). |
| `Local planner` | Every other case, including every fallback. The status says why. |

A reply from a different decider than the one asked for is discarded as `mismatched_reply`, and the local planner decides. So a Gemini run cannot credit an OpenAI answer, and a consensus run cannot credit a single-provider answer.

## Keys

Put the keys in `.env.local`, which is ignored by git. `.env.example` lists them.

```
OPENAI_API_KEY=...   # OpenAI Decisions
GEMINI_API_KEY=...   # Gemini (Google AI Studio key)
```

Only the Next server reads them, in `/api/decisions`. A key goes upstream only in its auth header: `Authorization: Bearer` for OpenAI, `x-goog-api-key` for Gemini. Keys are never returned in a reply, never logged and never sent to the browser. Restart `npm run dev` after changing `.env.local`. Without a key the app still runs: that provider reports `unconfigured` and the local planner decides.
