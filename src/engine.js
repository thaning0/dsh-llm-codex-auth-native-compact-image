import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { codexContext } from './adapter.js'
import {
  externalizeNativeCheckpointImages,
  nativeCompactCheckpointSource,
  readNativeCompactCheckpoint,
} from './checkpoint.js'

const CHECKPOINT_TEXT = 'Provider-native Codex compaction checkpoint. The adapter replays its opaque state; this marker is never sent to the model.'
const DEFAULT_THRESHOLD_RATIO = 0.8
const DEFAULT_RETAIN_RATIO = 0.16
// Codex's fixed model-visible estimate for one resized `detail:auto` image.
const RESIZED_IMAGE_VISIBLE_BYTES = 7373
const RESIZED_IMAGE_TOKENS = Math.ceil(RESIZED_IMAGE_VISIBLE_BYTES / 4)

class SurfaceChangedError extends Error {}
class NoUsefulNativeCompactionError extends Error {
  code = 'NATIVE_COMPACT_NOT_USEFUL'

  constructor(replayTokens, shadowedTokens) {
    super(`provider-native checkpoint would not reduce context (${replayTokens} estimated replay tokens versus ${shadowedTokens} shadowed replay tokens)`)
    this.replayTokens = replayTokens
    this.shadowedTokens = shadowedTokens
  }
}
class TargetPressureConfigError extends Error {
  constructor(targetKey, message) {
    super(message)
    this.targetKey = targetKey
  }
}

function ratio(name, value, fallback) {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved <= 0 || resolved > 1) {
    throw new TypeError(`${name} must be a number in (0, 1]`)
  }
  return resolved
}

function nonNegativeInteger(name, value, fallback) {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 0) throw new TypeError(`${name} must be a non-negative integer`)
  return resolved
}

export function resolveNativeCompactionPolicy(config = {}) {
  const thresholdRatio = ratio('thresholdRatio', config.thresholdRatio, DEFAULT_THRESHOLD_RATIO)
  const retainRatio = ratio('retainRatio', config.retainRatio, DEFAULT_RETAIN_RATIO)
  if (retainRatio >= thresholdRatio) throw new TypeError('retainRatio must be less than thresholdRatio')
  return Object.freeze({
    auto: config.auto === true,
    thresholdRatio,
    retainRatio,
    compactionRetries: nonNegativeInteger('compactionRetries', config.compactionRetries, 1),
    maxOverflowRetries: nonNegativeInteger('maxOverflowRetries', config.maxOverflowRetries, 1),
  })
}

function routedTarget(agent, provider, { strict = true } = {}) {
  const config = agent.session.requestHeader()?.config
  const target = config !== undefined && config.provider.length > 0 && config.model.length > 0
    ? { provider: config.provider, model: config.model }
    : agent.options.provider && agent.options.model
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined
  if (target === undefined) {
    if (!strict) return undefined
    throw new Error('native compaction requires a previously routed provider/model')
  }
  if (target.provider !== provider) {
    if (!strict) return undefined
    const error = new Error(`native compaction requires provider ${provider}; current route is ${target.provider}`)
    error.code = 'NATIVE_COMPACT_REPLAY_INCOMPATIBLE'
    throw error
  }
  return target
}

function entryState(events) {
  let openTurn = null
  let openTurnKnown = false
  let unmatchedStart
  let compactionKnown = false
  let latestEndSeedSeq
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq
    if (!compactionKnown) {
      if (event.type === 'compaction/start') {
        unmatchedStart = event
        compactionKnown = true
      } else if (event.type === 'compaction/end') {
        compactionKnown = true
      }
    }
    if (!openTurnKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnKnown = true
      } else if (event.type === 'turn/end') {
        openTurnKnown = true
      }
    }
    if (openTurnKnown && compactionKnown && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedStart, latestEndSeedSeq }
}

function assertInactive(state, stage) {
  if (state.unmatchedStart !== undefined && !(state.latestEndSeedSeq !== undefined && state.latestEndSeedSeq > state.unmatchedStart.seq)) {
    throw new ManualCompactionError('busy', `${stage}: native compaction lock is already active`)
  }
}

function compactionOwner(session, manual) {
  const state = entryState(session.events)
  assertInactive(state, manual ? 'manual compaction' : 'automatic compaction')
  if (manual) {
    if (state.openTurn !== null) throw new ManualCompactionError('busy', 'manual native compaction requires an idle session')
    return null
  }
  if (state.openTurn === null) throw new Error('automatic native compaction requires an open turn')
  return state.openTurn
}

function imagePayloadAdjustment(value) {
  let payloadBytes = 0
  let replacementBytes = 0
  const visit = (current) => {
    if (current === null || typeof current !== 'object') return
    if (!Array.isArray(current) && current.type === 'input_image') {
      if (typeof current.image_url === 'string' && current.image_url.startsWith('data:image/')) {
        const comma = current.image_url.indexOf(',')
        if (comma >= 0) {
          payloadBytes += current.image_url.length - comma - 1
          replacementBytes += RESIZED_IMAGE_VISIBLE_BYTES
        }
      } else if (current.image_url?.kind === 'dsh-attachment-image') {
        replacementBytes += RESIZED_IMAGE_VISIBLE_BYTES
      }
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item)
    } else {
      for (const item of Object.values(current)) visit(item)
    }
  }
  visit(value)
  return { payloadBytes, replacementBytes }
}

function messageImageCount(blocks) {
  let count = 0
  for (const block of blocks) {
    if (block.type === 'image') count += 1
    else if (block.type === 'tool-result') count += messageImageCount(block.content)
  }
  return count
}

// Match Codex's model-visible estimator for remote-compaction replay. Ordinary
// retained messages use the standard 4-bytes/token JSON proxy, but embedded
// image base64 is replaced with Codex's fixed resized-image estimate. A
// compaction item's ciphertext uses decoded payload length minus fixed framing.
export function estimateOpaqueReplayTokens(items) {
  const tokens = items.reduce((sum, item) => {
    if (item !== null
      && typeof item === 'object'
      && !Array.isArray(item)
      && item.type === 'compaction'
      && typeof item.encrypted_content === 'string') {
      const visibleBytes = Math.max(Math.floor(item.encrypted_content.length * 3 / 4) - 650, 0)
      return sum + Math.ceil(visibleBytes / 4)
    }
    const rawBytes = JSON.stringify(item).length
    const { payloadBytes, replacementBytes } = imagePayloadAdjustment(item)
    return sum + Math.ceil(Math.max(rawBytes - payloadBytes + replacementBytes, 0) / 4)
  }, 0)
  return tokens + 16
}

function effectiveMeasurement(session, meter) {
  const measurement = meter.measure(session)
  const nodes = measurement.nodes.map((node) => {
    const message = session.deriveEventMessage(session.events[node.seq])
    const checkpoint = message === null ? undefined : readNativeCompactCheckpoint(message.source)
    const imageTokens = message === null ? 0 : messageImageCount(message.content) * RESIZED_IMAGE_TOKENS
    const effectiveTokens = checkpoint === undefined
      ? node.tokens + imageTokens
      : Math.max(node.tokens, estimateOpaqueReplayTokens(checkpoint.items))
    return { ...node, effectiveTokens }
  })
  const extraTokens = nodes.reduce((sum, node, index) => sum + node.effectiveTokens - measurement.nodes[index].tokens, 0)
  return {
    ...measurement,
    nodes,
    effectiveTotalTokens: measurement.totalTokens + extraTokens,
  }
}

function selectRange(session, measurement, retainTokens) {
  const priced = measurement.nodes
  const nodes = session.surface.nodes
  if (priced.length !== nodes.length || nodes.some((seq, index) => priced[index]?.seq !== seq)) {
    throw new Error('native compaction token-meter surface does not match the session surface')
  }
  if (nodes.length < 2) return null
  let accumulated = 0
  let keepFrom = nodes.length
  for (let index = priced.length - 1; index >= 0; index -= 1) {
    accumulated += priced[index].effectiveTokens
    keepFrom = index
    if (accumulated >= retainTokens) break
  }
  if (keepFrom === 0) return null
  while (keepFrom > 0 && !toolPairingBalancedBefore(session, nodes[keepFrom])) keepFrom -= 1
  if (keepFrom === 0) return null
  const start = nodes[0]
  const end = nodes[keepFrom - 1]
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) return null
  return {
    start,
    end,
    startIndex: 0,
    endIndex: keepFrom - 1,
    shadowedSeqs: nodes.slice(0, keepFrom),
  }
}

function explicitRange(session, measurement, start, end) {
  const nodes = session.surface.nodes
  const startIndex = nodes.indexOf(start)
  const endIndex = nodes.indexOf(end)
  if (startIndex < 0 || endIndex < startIndex) throw new Error('native compact explicit range is not present in surface order')
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) {
    throw new Error('native compact explicit range would split a tool-call/result pair')
  }
  if (measurement.nodes.length !== nodes.length || nodes.some((seq, index) => measurement.nodes[index]?.seq !== seq)) {
    throw new Error('native compaction token-meter surface does not match the session surface')
  }
  return {
    start,
    end,
    startIndex,
    endIndex,
    shadowedSeqs: nodes.slice(startIndex, endIndex + 1),
  }
}

function validateSelectedStable(session, meter, prepared) {
  const nodes = session.surface.nodes
  const startIndex = nodes.indexOf(prepared.start)
  const endIndex = nodes.indexOf(prepared.end)
  if (startIndex < 0 || endIndex < startIndex) throw new SurfaceChangedError('selected native compact range disappeared')
  const currentSeqs = nodes.slice(startIndex, endIndex + 1)
  if (!isDeepStrictEqual(currentSeqs, prepared.shadowedSeqs)) throw new SurfaceChangedError('selected native compact range changed')
  if (!toolPairingBalancedBefore(session, prepared.start) || !toolPairingBalancedAfter(session, prepared.end)) {
    throw new SurfaceChangedError('selected native compact range is no longer tool-pairing balanced')
  }
  const measured = meter.measure(session).nodes.slice(startIndex, endIndex + 1)
  if (!isDeepStrictEqual(measured, prepared.selectedNodes)) throw new SurfaceChangedError('selected native compact range was rewritten')
}

function validateWholeStable(session, meter, prepared) {
  if (!isDeepStrictEqual(session.surface.nodes, prepared.measurement.nodes.map((node) => node.seq))) {
    throw new SurfaceChangedError('native compact surface changed during the provider request')
  }
  if (!isDeepStrictEqual(meter.measure(session).nodes, prepared.measurement.nodes)) {
    throw new SurfaceChangedError('native compact token measurement changed during the provider request')
  }
  validateSelectedStable(session, meter, prepared)
}

function tokenUsage(usage) {
  if (usage === undefined || usage === null || typeof usage !== 'object') return undefined
  const inputTokens = usage.input_tokens ?? usage.inputTokens
  const outputTokens = usage.output_tokens ?? usage.outputTokens
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined
  return {
    inputTokens,
    outputTokens,
    ...(Number.isFinite(usage.input_tokens_details?.cached_tokens)
      ? { cacheReadTokens: usage.input_tokens_details.cached_tokens }
      : {}),
  }
}

function manualFailure(failure) {
  if (failure.stage === 'commit') {
    return new ManualCompactionError('commit', 'manual native compaction did not commit cleanly', { cause: failure.error })
  }
  if (failure.error instanceof SurfaceChangedError) {
    return new ManualCompactionError('changed', 'native compact history changed during the provider request', { cause: failure.error })
  }
  return new ManualCompactionError('summary', 'provider-native compaction failed', { cause: failure.error })
}

export class NativeCompactionEngine extends CompactionEngine {
  transport
  provider
  config
  resolveAttachments
  warnedPressureConfigTargets = new Set()
  overflowRetries = new WeakMap()
  overflowAgents = new WeakMap()

  constructor(ctx, transport, { provider = 'codex-oauth', resolveAttachments, ...config } = {}) {
    super(ctx)
    this.transport = transport
    this.provider = provider
    this.resolveAttachments = resolveAttachments
    this.config = resolveNativeCompactionPolicy(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  _registerAutomaticCompaction() {
    const { ctx } = this
    const logResult = (result, trigger) => {
      ctx.logger.info(`native compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} heuristic tokens)`)
    }
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`native step compaction failed: ${message}; continuing the turn without a text-summary fallback`)
        }
      }
      return next()
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      if (routedTarget(agent, this.provider, { strict: false }) === undefined) return next()
      this.overflowAgents.set(agent.session, agent)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= this.config.maxOverflowRetries) return next()
      const generation = agent.session.surface.replaceGeneration
      let result
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(`native context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`)
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(`native context-overflow compaction failed: ${message}; preserving the original request error`)
        return next()
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  async compactIfNeeded(agent, trigger, signal) {
    const target = routedTarget(agent, this.provider, { strict: false })
    if (target === undefined) return null
    if (trigger !== 'pressure' && trigger !== 'context-overflow') throw new TypeError(`unknown native compaction trigger ${String(trigger)}`)
    const meter = this.ctx.tokenMeter
    let measurement = effectiveMeasurement(agent.session, meter)
    const prune = this.ctx.get('toolResultPruner')
    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = effectiveMeasurement(agent.session, meter)
      }
      const selection = selectRange(agent.session, measurement, 0)
      if (selection === null) return null
      return this._compactSelected(agent, selection, measurement, signal, { manual: false })
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    const contextWindow = info.context?.contextWindow
    const targetKey = `${target.provider}/${target.model}`
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      throw new TargetPressureConfigError(targetKey, `native compaction: no positive context capacity for ${targetKey}`)
    }
    const thresholdTokens = Math.floor(contextWindow * this.config.thresholdRatio)
    const retainTokens = Math.floor(contextWindow * this.config.retainRatio)
    if (measurement.effectiveTotalTokens < thresholdTokens) return null
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = effectiveMeasurement(agent.session, meter)
    }
    if (measurement.effectiveTotalTokens < thresholdTokens) return null

    let result = null
    for (let attempt = 0; attempt <= this.config.compactionRetries; attempt += 1) {
      const selection = selectRange(agent.session, measurement, retainTokens)
      if (selection === null) {
        if (result === null) return null
        break
      }
      result = await this._compactSelected(agent, selection, measurement, signal, { manual: false })
      measurement = effectiveMeasurement(agent.session, meter)
      if (measurement.effectiveTotalTokens < thresholdTokens) return result
    }
    throw new Error(`native compaction still above threshold after ${this.config.compactionRetries + 1} attempts (${measurement.effectiveTotalTokens} estimated replay tokens >= threshold ${thresholdTokens})`)
  }

  compactRegion(start, end, agent, signal = new AbortController().signal) {
    signal.throwIfAborted()
    const measurement = effectiveMeasurement(agent.session, this.ctx.tokenMeter)
    const selection = explicitRange(agent.session, measurement, start, end)
    return this._compactSelected(agent, selection, measurement, signal, { manual: false })
  }

  compactNow(agent, signal, sourceCommandId) {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const measurement = effectiveMeasurement(agent.session, this.ctx.tokenMeter)
          const selection = selectRange(agent.session, measurement, 0)
          if (selection === null) return null
          return await this._compactSelected(agent, selection, measurement, operationSignal, {
            manual: true,
            sourceCommandId,
          })
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual native compaction was cancelled', { cause: error })
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error) {
      throw new ManualCompactionError('busy', 'manual native compaction requires an idle agent with no queued work', { cause: error })
    }
  }

  async _compactSelected(agent, selection, measurement, signal, { manual, sourceCommandId }) {
    const session = agent.session
    const meter = this.ctx.tokenMeter
    const target = routedTarget(agent, this.provider)
    const selectedNodes = measurement.nodes
      .slice(selection.startIndex, selection.endIndex + 1)
      .map(({ effectiveTokens: _effectiveTokens, ...node }) => node)
    const shadowedTokenCount = selectedNodes.reduce((sum, node) => sum + node.tokens, 0)
    const shadowedReplayTokenCount = measurement.nodes
      .slice(selection.startIndex, selection.endIndex + 1)
      .reduce((sum, node) => sum + node.effectiveTokens, 0)
    const prepared = {
      ...selection,
      selectedNodes,
      measurement: {
        ...measurement,
        nodes: measurement.nodes.map(({ effectiveTokens: _effectiveTokens, ...node }) => node),
      },
      shadowedTokenCount,
      shadowedReplayTokenCount,
    }
    const owner = compactionOwner(session, manual)
    const compactionId = CompactionId(randomUUID())
    const lifecycle = {
      compactionId,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      turn: owner,
    }
    const startEvent = session.append('compaction/start', lifecycle)
    let failure
    let flushFailure
    let result
    let closing = false
    let closed = false
    let stage = 'summary'

    try {
      const header = session.requestHeader()
      const messages = selection.shadowedSeqs
        .map((seq) => session.deriveEventMessage(session.events[seq]))
        .filter((message) => message !== null)
      const transportIdentity = await this.transport.identity(target.model)
      const imageReferences = new Map()
      const context = await codexContext({
        model: target.model,
        messages,
        signal,
        ...(header?.system === undefined ? {} : { system: header.system }),
        ...(header?.tools === undefined ? {} : { tools: [...header.tools] }),
      }, 'openai-codex', {
        provider: this.provider,
        model: target.model,
        transportIdentity,
      }, {
        attachments: this.resolveAttachments?.(),
        imageInputSupported: this.transport.supportsImageInput?.(target.model) !== false,
        imageReferences,
      })
      const compacted = await this.transport.compactContext({
        model: target.model,
        context,
        expectedTransportIdentity: transportIdentity,
        signal,
      })
      signal.throwIfAborted()
      const checkpointItems = externalizeNativeCheckpointImages(compacted.items, imageReferences)
      const replayTokenEstimate = estimateOpaqueReplayTokens(checkpointItems)
      if (replayTokenEstimate >= shadowedReplayTokenCount) {
        throw new NoUsefulNativeCompactionError(replayTokenEstimate, shadowedReplayTokenCount)
      }
      if (manual) validateSelectedStable(session, meter, prepared)
      else validateWholeStable(session, meter, prepared)

      const checkpoint = {
        provider: this.provider,
        model: compacted.model,
        transportIdentity: compacted.transportIdentity,
        protocol: compacted.protocol,
        items: checkpointItems,
      }
      const summary = [{ type: 'text', text: CHECKPOINT_TEXT }]
      const checkpointMessage = createUserMessage({
        content: summary,
        source: nativeCompactCheckpointSource(compactionId, sourceCommandId, checkpoint),
      })

      stage = 'commit'
      const summaryEvent = session.append('compaction/summary', {
        compactionId,
        ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        summary,
        shadowedRange: { start: selection.start, end: selection.end },
        shadowedSeqs: [...selection.shadowedSeqs],
        shadowedTokenCount,
        provider: this.provider,
        model: compacted.model,
        ...(tokenUsage(compacted.usage) === undefined ? {} : { usage: tokenUsage(compacted.usage) }),
      })
      session.append('user/message', checkpointMessage, {
        surfaceOp: { op: 'replace', start: selection.start, end: selection.end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selection.shadowedSeqs],
      })
      closing = true
      const endEvent = session.append('compaction/end', lifecycle)
      closed = true
      result = {
        compactionId,
        ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        startSeq: startEvent.seq,
        summarySeq: summaryEvent.seq,
        endSeq: endEvent.seq,
        summary,
        shadowedRange: { start: selection.start, end: selection.end },
        shadowedSeqs: [...selection.shadowedSeqs],
        shadowedTokenCount,
      }
    } catch (error) {
      failure = { error, stage: closing ? 'commit' : stage }
      if (!closing) {
        closing = true
        try {
          session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
          closed = true
        } catch (closeError) {
          failure = { error: closeError, stage: 'commit' }
        }
      }
    }

    if (manual && closed) {
      try {
        await this.ctx.sessions.flush(session)
      } catch (error) {
        flushFailure = error
      }
    }
    signal.throwIfAborted()
    if (failure !== undefined) {
      if (manual) throw manualFailure(failure)
      throw failure.error
    }
    if (flushFailure !== undefined) {
      throw new ManualCompactionError('persistence', 'manual native compaction durability checkpoint failed', { cause: flushFailure })
    }
    if (result === undefined) throw new ManualCompactionError('commit', 'native compaction committed without a result')
    return result
  }
}
