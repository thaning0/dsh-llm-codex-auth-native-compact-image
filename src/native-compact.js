import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  NATIVE_COMPACT_REPLAY_CODE,
  containsNativeCompactCheckpoint,
} from './checkpoint.js'

const DEFAULT_MODE = 'probe'

export function resolveNativeCompactConfig(config = {}) {
  const mode = config.nativeCompactMode ?? DEFAULT_MODE
  if (mode !== 'probe' && mode !== 'manual' && mode !== 'automatic') {
    throw new TypeError('nativeCompactMode must be "probe", "manual", or "automatic"')
  }
  return Object.freeze({ mode })
}

async function* failedReplay(error) {
  const message = error instanceof Error ? error.message : String(error)
  throw new LlmError(message, NATIVE_COMPACT_REPLAY_CODE, { cause: error })
}

/** Prevent every foreign adapter from seeing a provider-native checkpoint. */
export function installNativeCheckpointGuard(ctx, provider) {
  ctx.on('llm/stream', (options, next) => {
    if (options.provider === provider) return next()
    try {
      if (!containsNativeCompactCheckpoint(options.messages)) return next()
      return failedReplay(new Error(`native compact checkpoint can only replay through provider ${provider}`))
    } catch (error) {
      return failedReplay(error)
    }
  }, { global: true, prepend: true })
}

function manualResult(error) {
  switch (error.code) {
    case 'busy': return 'Compaction is unavailable because this process has active compaction or the agent is not idle.'
    case 'cancelled': return 'Compaction cancelled.'
    case 'changed': return 'Selected history changed before native checkpoint replacement; no replacement was written.'
    case 'summary': {
      const cause = error.cause
      if (cause?.code === 'NATIVE_COMPACT_NOT_USEFUL') {
        return `Native compaction was not useful: the checkpoint (~${cause.replayTokens} tokens) was not smaller than the selected history (~${cause.shadowedTokens} tokens). No replacement was written; continue the conversation and retry later.`
      }
      return 'Provider-native compaction failed; no replacement was written.'
    }
    case 'commit': return 'Native compaction did not commit cleanly; inspect the current session before retrying.'
    case 'persistence': return 'Native compaction finished, but the session could not be saved.'
    default: return undefined
  }
}

/** Register the standalone /compact command against this package's engine/error identity. */
export function installManualCompactCommand(ctx) {
  const active = new Set()
  ctx.effect(function* () {
    yield async () => {
      await Promise.allSettled(active)
    }
    yield ctx.commands.register({
      name: 'compact',
      description: 'Compact older conversation history with Codex native compaction',
      handler(invocation) {
        if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: 'Usage: /compact (no arguments)' }
        const operation = ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
          .then((result) => result === null
            ? { kind: 'success', text: 'No compactable history yet.' }
            : {
                kind: 'success',
                text: `Native-compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
                sourceEventSeq: result.summarySeq,
              })
          .catch((error) => {
            if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
            if (error instanceof ManualCompactionError) {
              const text = manualResult(error)
              if (text !== undefined) return { kind: 'error', text }
            }
            throw error
          })
        active.add(operation)
        operation.then(() => active.delete(operation), () => active.delete(operation))
        return operation
      },
    })
  }, 'native compact manual command lifecycle')
}

/**
 * Install the explicit native-compaction diagnostic inside the OAuth-owning
 * plugin. It never replaces the model-visible surface or registers
 * `ctx.compaction`; normal command lifecycle events remain log-only.
 */
export function installNativeCompactProbe(ctx, transport, config = {}) {
  const resolved = resolveNativeCompactConfig(config)
  const capability = transport.describe()
  const active = new Set()

  ctx.effect(function* () {
    yield async () => {
      await Promise.allSettled(active)
    }
    yield ctx.commands.register({
      name: 'native-compact-probe',
      description: '验证 Codex OAuth 原生压缩及 opaque checkpoint 回放（不替换对话历史）',
      input: { hint: '可选：Codex 模型名；留空使用 transport 默认模型' },
      recordInput: false,
      handler(invocation) {
        const model = invocation.rawInput.trim() || capability.defaultModel
        if (model === undefined) {
          return {
            kind: 'error',
            text: '没有可用的 Codex 模型；请使用 /native-compact-probe <model>。',
          }
        }
        const operation = transport.probe({ model, signal: invocation.signal })
          .then((result) => ({
            kind: 'success',
            text: `Native compact MVP verified: ${result.protocol}; model ${result.model}; ${result.itemCount} continuation item(s); JSON persistence round-trip and opaque-only replay both passed.`,
          }))
          .catch((error) => ({
            kind: 'error',
            text: `Native compact probe failed: ${error instanceof Error ? error.message : String(error)}`,
          }))
        active.add(operation)
        operation.then(() => active.delete(operation), () => active.delete(operation))
        return operation
      },
    })
  }, 'codex native compact probe command lifecycle')

  ctx.logger.info(
    `dsh-llm-codex-native-compact: native compact ${capability.remoteCompaction} transport ready in ${resolved.mode} mode; use /native-compact-probe for the explicit network test`,
  )
}
