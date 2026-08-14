import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

import * as compactionPlugin from '../src/compaction-plugin.js'
import { readNativeCompactCheckpoint } from '../src/checkpoint.js'

function user(text, image) {
  return createUserMessage({
    content: [{ type: 'text', text }, ...(image === undefined ? [] : [{ type: 'image', attachment: image }])],
    source: { kind: 'user' },
  })
}

test('agent-scoped entry replaces the seam and pressure event runs native compact', async () => {
  const root = new Context()
  let command
  let compactCalls = 0
  let sawImage = false
  const image = {
    attachmentId: 'scoped-image',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  root.provide('commands', {
    register(definition) {
      command = definition
      return () => {}
    },
  })
  root.provide('tokenMeter', {
    measure(session) {
      return {
        totalTokens: session.surface.nodes.length * 100,
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 100 })),
      }
    },
  })
  root.provide('sessions', { async flush() {} })
  root.provide('attachments', {
    async readImage(ref) {
      assert.deepEqual(ref, image)
      return { ref: image, data: Uint8Array.from([1, 2, 3, 4]) }
    },
  })
  root.provide('llm', {
    async resolveModelInfo() {
      return { context: { contextWindow: 500 } }
    },
  })
  root.provide('codexOAuthTransport', {
    supportsImageInput() {
      return true
    },
    async identity() {
      return '0123456789abcdef01234567'
    },
    async compactContext({ model, context }) {
      compactCalls += 1
      sawImage = context.messages.some((message) => Array.isArray(message.content)
        && message.content.some((block) => block.type === 'image'))
      return {
        protocol: 'responses.compaction-trigger.v2',
        model,
        transportIdentity: '0123456789abcdef01234567',
        items: [{ type: 'compaction', encrypted_content: 'opaque-scoped-state' }],
      }
    },
  })

  const scoped = root.isolate('compaction').isolate('toolResultPruner')
  try {
    await scoped.plugin(compactionPlugin, {
      provider: 'codex-oauth',
      nativeCompactMode: 'automatic',
      thresholdRatio: 0.8,
      retainRatio: 0.16,
    })
    const engine = scoped.get('compaction')
    assert.ok(engine)
    assert.equal(engine.config.auto, true)
    assert.equal(command.name, 'compact')

    const session = Session.create(SessionId('scoped-native-auto'))
    session.append('request/header', {
      header: { config: { provider: 'codex-oauth', model: 'gpt-5.4' } },
      reason: 'initial',
    })
    for (let index = 0; index < 5; index += 1) {
      session.append('user/message', user(`history-${index}`, index === 0 ? image : undefined), { surfaceOp: 'append' })
    }
    session.append('turn/start', { turn: 1 })
    const agent = { session, options: {} }
    const decision = await scoped.waterfall(
      'agent/pre-step',
      { agent, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' }),
    )
    assert.deepEqual(decision, { kind: 'enter' })
    assert.equal(compactCalls, 1)
    assert.equal(sawImage, true)
    assert.equal(readNativeCompactCheckpoint(session.deriveMessages()[0].source).kind, 'openai-codex-native-compaction')
  } finally {
    await root.fiber.dispose()
  }
})
