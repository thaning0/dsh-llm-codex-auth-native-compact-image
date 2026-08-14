# Codex OAuth native compact design contract

## Status

This fork remains one npm package. Its Host entry owns the `codex-oauth` route,
OAuth lifecycle, authenticated transport, replay guard, and probe. Its
`./compaction` entry mounts inside the `codex-native` agent preset's isolated
compaction realm, where it replaces `compaction-basic` and owns `/compact`,
automatic step-pressure compaction, and context-overflow recovery.

Manual mode and automatic mode share the same provider-native transaction.
Manual success additionally flushes under Scheme A. Automatic pressure starts
at 80% of the routed model context window, retains at least 16% verbatim, and
allows one additional convergence attempt; provider-confirmed overflow forces
one balanced native reduction and one request retry. Non-`codex-oauth` routes
are ignored without a text-summary fallback.

## Verified protocol

A real-account smoke established:

- legacy V1 `responses/compact` returned HTTP 404 on the current ChatGPT backend;
- current V2 succeeded through normal Codex Responses with one trailing
  `{ "type": "compaction_trigger" }` item;
- the returned opaque compaction item survived JSON encode/decode;
- a continuation recovered a nonce whose plaintext source item was not replayed.

V2 is therefore the production path for this fork. V1 may remain a tested,
fail-closed compatibility path but is not an automatic fallback.

## Image input contract

For a routed model whose catalog declares `image` input, the Host adapter reads
only DSH durable attachment references through the optional `attachments`
service and emits pi-ai image blocks. The Responses converter lowers these to
`input_image` items with canonical `data:image/...;base64,...` URLs and
`detail: "auto"`. This covers user uploads, deferred `read_image` context, and
images nested in tool results. Attachment reads are deduplicated within one
request and receive its abort signal. Missing storage, unreadable bytes,
in-history system images, and models without image capability fail before
provider traffic.

The agent-scoped engine uses the same converter before manual, pressure, and
overflow compaction. Before persistence, every V2-retained `input_image` data URL
is externalized back to its verified durable attachment ref; inline image bytes
are forbidden in checkpoint JSON. Replay re-reads that ref and reconstructs the
exact provider data URL, while the opaque compaction item remains untouched.
Retention budgets charge client text while preserving images attached to
retained messages. Replay reduction and pressure use Codex's fixed model-visible
resized-image estimate rather than base64 wire length.

Only PNG, JPEG, WebP, and GIF bytes admitted by the DSH attachment service are
supported. The plugin does not fetch remote image URLs and does not use an OAuth
Files API or `file_id`. Base64 payloads are request/checkpoint data and must
never enter logs or diagnostics.

## Package architecture

```text
one npm package: dsh-llm-codex-auth-native-compact-image
├─ Host entry: provider, OAuth, transport, adapter, replay guard, probe
└─ Agent entry: isolated ctx.compaction, /compact, pressure/overflow listeners

DshCredentialStore
  └─ owns OPENAI_CODEX_OAUTH persistence and serialized refresh

CodexOAuthTransport
  ├─ resolves auth through pi-ai Models
  ├─ derives ChatGPT account id internally
  ├─ attaches bearer/account headers
  ├─ restricts production traffic to chatgpt.com/backend-api
  ├─ sends normal model Responses requests
  └─ sends native V2 compaction_trigger requests

CodexAdapter
  ├─ validates native checkpoint provider/model/account identity
  ├─ injects opaque items before generic pi-ai conversion
  └─ handles normal DSH ↔ pi-ai message conversion

Native compaction module
  ├─ manual + automatic CompactionEngine and standalone /compact
  ├─ agent/pre-step pressure and agent/request-error overflow recovery
  ├─ native-aware opaque replay-token pressure correction
  ├─ global foreign-provider replay guard
  └─ explicit /native-compact-probe diagnostic
```

OAuth tokens, refresh tokens, raw account ids, authorization headers, and
cookies MUST stay inside the OAuth store/transport. The compaction engine and
checkpoint receive only provider output plus non-secret metadata.

## Transport contract

```ts
interface CodexOAuthTransport {
  describe(): {
    provider: 'codex-oauth'
    remoteCompaction: 'v2' | 'v1' | 'unsupported'
    defaultModel?: string
  }

  compact(request: {
    model: string
    input: JsonValue[]
    instructions?: string
    signal: AbortSignal
  }): Promise<{
    protocol: 'responses.compaction-trigger.v2' | 'responses.compact.v1'
    model: string
    transportIdentity: string
    items: JsonValue[]
    usage?: JsonValue
  }>
}
```

`transportIdentity` is a one-way compatibility fingerprint. It MUST contain no
raw account id, email, or credential material.

Production requests accept no configurable absolute URL. Explicit test
construction may inject a loopback HTTP base. Platform API endpoints and API-key,
environment-key, browser-cookie, local-summary, or `compaction-basic` fallbacks
are forbidden.

## Durable checkpoint

```ts
interface OpenAiNativeCheckpointV1 {
  kind: 'openai-codex-native-compaction'
  version: 1
  provider: 'codex-oauth'
  model: string
  transportIdentity: string
  protocol: 'responses.compaction-trigger.v2' | 'responses.compact.v1'
  items: JsonValue[]
}
```

The carrier is embedded in the compact replacement message source so it is
available in normal adapter input without process-memory lookup. It must preserve
complete JSON structure, ordering, and unknown fields across JSONL persistence,
restart, fork, and export/import.

## Replay

Before generic DSH-to-pi-ai conversion, `CodexAdapter` must:

1. recognize and validate checkpoint kind/version;
2. require provider, model, and transport-identity compatibility;
3. replace the synthetic checkpoint carrier with native continuation items at
   the same logical position;
4. never send marker text;
5. fail before network with `NATIVE_COMPACT_REPLAY_INCOMPATIBLE` for every
   incompatible or unsupported checkpoint.

A global `llm/stream` guard must prevent another adapter from receiving native
checkpoint data.

## Manual and automatic engine

Every path acquires the durable compaction lock, selects a tool-pairing-balanced
region, builds exact provider-native input, calls the shared transport with the
live abort signal, validates lossless-JSON continuation items, rejects a
checkpoint whose Codex-compatible model-visible estimate would not reduce the
selected replay region, and appends the normal lifecycle bracket plus adjacent
replacement. Retained user/developer/system messages use the ordinary
4-bytes/token JSON proxy. Compaction ciphertext mirrors codex-rs
`estimate_reasoning_length`: decoded base64 bytes minus fixed framing, then the
same 4-byte conversion. Raw wire JSON must not be priced at 2 chars/token because
that over-counts opaque ciphertext by roughly 2.7x and rejects valid reductions. Manual `/compact` reserves idle maintenance admission and flushes
before reporting success.

Automatic pressure runs from `agent/pre-step` inside the open turn. It resolves
the adapter-owned context window, applies the configured 80%/16% policy, and
uses a native-aware measurement that adds back opaque replay cost hidden from
the generic marker-text token meter. `agent/request-error` handles only the
standard context-window-exceeded code, performs one forced native reduction,
and retries only after surface generation advances. Foreign routes call no
transport and receive no text-summary fallback.

The agent entry fails startup if another `ctx.compaction` provider is registered
inside the same isolated realm. The shipped `compaction-basic` and
`command-compact` rows are therefore removed from `codex-native`; this is also
why a Host-global command alone cannot work—agent-scoped command definitions
shadow global definitions.

## Persistence failure semantics — plugin-only Scheme A

This fork intentionally uses the existing DSH compaction seam without changing
DSH core:

- transport failure writes no replacement;
- after a replacement is appended, a persistence flush failure reports the
  stable `persistence` class;
- the current process surface may already contain the replacement;
- restart follows the actually persisted append-only log;
- the plugin performs no rollback because the public Session API has none.

This matches `dsh-compaction-basic`; strict staged atomic commit is outside this
plugin's contract.

## Activation gates

Manual and automatic modes are accepted only while these invariants continue to pass:

1. engine source/runtime receives no OAuth material;
2. endpoint isolation rejects every Platform API target before I/O;
3. refresh serialization, account header, cancellation, and error redaction
   match ordinary Codex requests;
4. unknown/nested opaque fixtures survive compact → JSONL → restart → replay;
5. transport failure leaves no replacement and every bracket/lock closes under
   the Scheme A persistence semantics above;
6. provider/model/identity/version incompatibility fails before network;
7. manual compact passes restart, fork, export/import, and repeated-compaction;
8. logs, events, checkpoints, errors, and snapshots contain no secrets/raw id;
9. failures never invoke Platform compact, text summary, or compaction-basic;
10. an explicit real-account test performs compact and post-restart continuation;
11. pressure compaction runs only inside an open turn and writes a native source;
12. overflow retries only after a successful surface replacement;
13. foreign providers perform no native transport call and never invoke a text-summary fallback;
14. repeated native checkpoints are measured using opaque replay cost rather than marker text alone.
