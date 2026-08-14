import assert from 'node:assert/strict'
import test from 'node:test'

import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { nativeCompactCheckpointSource } from '../src/checkpoint.js'
import {
  installManualCompactCommand,
  installNativeCheckpointGuard,
  installNativeCompactProbe,
  resolveNativeCompactConfig,
} from '../src/native-compact.js'

function context() {
  const logs = []
  let command
  return {
    logs,
    get command() {
      return command
    },
    commands: {
      register(definition) {
        command = definition
        return () => {}
      },
    },
    effect(factory) {
      const iterator = factory()
      iterator.next()
      iterator.next()
      iterator.next()
    },
    logger: {
      info(message) {
        logs.push(message)
      },
    },
  }
}

test('native compact supports probe, manual, and automatic modes', () => {
  assert.deepEqual(resolveNativeCompactConfig(), { mode: 'probe' })
  assert.deepEqual(resolveNativeCompactConfig({ nativeCompactMode: 'probe' }), { mode: 'probe' })
  assert.deepEqual(resolveNativeCompactConfig({ nativeCompactMode: 'manual' }), { mode: 'manual' })
  assert.deepEqual(resolveNativeCompactConfig({ nativeCompactMode: 'automatic' }), { mode: 'automatic' })
  assert.throws(
    () => resolveNativeCompactConfig({ nativeCompactMode: 'active' }),
    /nativeCompactMode must be "probe", "manual", or "automatic"/,
  )
})

test('single OAuth plugin installs explicit opaque replay probe', async () => {
  let probeCalls = 0
  const transport = {
    describe() {
      return { provider: 'codex-oauth', remoteCompaction: 'v2', defaultModel: 'gpt-5.4' }
    },
    async probe({ model }) {
      probeCalls += 1
      assert.equal(model, 'gpt-5.4')
      return {
        protocol: 'responses.compaction-trigger.v2',
        model,
        itemCount: 2,
        persistenceRoundTripVerified: true,
        replayVerified: true,
      }
    },
  }
  const ctx = context()
  installNativeCompactProbe(ctx, transport)

  assert.equal(ctx.command.name, 'native-compact-probe')
  assert.equal(ctx.command.recordInput, false)
  assert.equal(probeCalls, 0)
  const result = await ctx.command.handler({
    rawInput: '',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /opaque-only replay both passed/)
  assert.equal(probeCalls, 1)
  assert.match(ctx.logs[0], /native compact v2 transport ready in probe mode/)
})

test('global guard rejects native checkpoint on a foreign provider before next', async () => {
  let listener
  let options
  const ctx = {
    on(event, callback, registration) {
      assert.equal(event, 'llm/stream')
      listener = callback
      options = registration
      return () => {}
    },
  }
  installNativeCheckpointGuard(ctx, 'codex-oauth')
  assert.deepEqual(options, { global: true, prepend: true })
  const checkpoint = createUserMessage({
    content: [{ type: 'text', text: 'marker' }],
    source: nativeCompactCheckpointSource('compact-1', undefined, {
      provider: 'codex-oauth',
      model: 'gpt-5.4',
      transportIdentity: '0123456789abcdef01234567',
      protocol: 'responses.compaction-trigger.v2',
      items: [{ type: 'compaction', encrypted_content: 'opaque' }],
    }),
  })
  let nextCalls = 0
  const stream = listener({ provider: 'other-provider', messages: [checkpoint] }, () => {
    nextCalls += 1
    return (async function* () {})()
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of stream) {}
    },
    (error) => error.code === 'NATIVE_COMPACT_REPLAY_INCOMPATIBLE',
  )
  assert.equal(nextCalls, 0)
})

test('standalone manual compact command reports engine result', async () => {
  const ctx = context()
  ctx.compaction = {
    async compactNow(_agent, _signal, commandId) {
      assert.equal(commandId, 'command-1')
      return { shadowedSeqs: [1, 2], shadowedTokenCount: 900, summarySeq: 7 }
    },
  }
  installManualCompactCommand(ctx)
  assert.equal(ctx.command.name, 'compact')
  const result = await ctx.command.handler({
    rawInput: '',
    agent: {},
    commandId: 'command-1',
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, {
    kind: 'success',
    text: 'Native-compacted 2 history items (~900 tokens).',
    sourceEventSeq: 7,
  })
})

test('manual command explains a safe non-reducing checkpoint rejection', async () => {
  const ctx = context()
  const cause = Object.assign(new Error('not useful'), {
    code: 'NATIVE_COMPACT_NOT_USEFUL',
    replayTokens: 1094,
    shadowedTokens: 158,
  })
  ctx.compaction = {
    async compactNow() {
      throw new ManualCompactionError('summary', 'provider-native compaction failed', { cause })
    },
  }
  installManualCompactCommand(ctx)
  const result = await ctx.command.handler({
    rawInput: '',
    agent: {},
    commandId: 'command-2',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /checkpoint \(~1094 tokens\).*selected history \(~158 tokens\)/)
  assert.match(result.text, /continue the conversation and retry later/)
})
