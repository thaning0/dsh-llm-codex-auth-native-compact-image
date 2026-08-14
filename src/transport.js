import { createHash } from 'node:crypto'
import { arch, platform, release } from 'node:os'
import {
  convertResponsesMessages,
  convertResponsesTools,
} from '@earendil-works/pi-ai/api/openai-responses-shared'

const PROVIDER = 'codex-oauth'
const PROVIDER_ID = 'openai-codex'
const PRODUCTION_BASE_URL = 'https://chatgpt.com/backend-api'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const DEFAULT_TIMEOUT_MS = 1_200_000
const CODEX_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode'])
// Codex V2 retains recent client-authored context beside the opaque item.
const RETAINED_INPUT_TOKEN_BUDGET = 64_000

export class CodexOAuthTransportError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CodexOAuthTransportError'
    this.code = code
  }
}

function fail(code, message, cause) {
  return new CodexOAuthTransportError(code, message, cause === undefined ? undefined : { cause })
}

function assertRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw fail('NATIVE_COMPACT_REQUEST', 'native compact request must be an object')
  }
  if (typeof request.model !== 'string' || request.model.length === 0) {
    throw fail('NATIVE_COMPACT_REQUEST', 'native compact model must be a non-empty string')
  }
  if (!Array.isArray(request.input) || request.input.length === 0) {
    throw fail('NATIVE_COMPACT_REQUEST', 'native compact input must be a non-empty array')
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    throw fail('NATIVE_COMPACT_REQUEST', 'native compact signal must be an AbortSignal')
  }
  if (request.instructions !== undefined && typeof request.instructions !== 'string') {
    throw fail('NATIVE_COMPACT_REQUEST', 'native compact instructions must be a string')
  }
  if (request.tools !== undefined && !Array.isArray(request.tools)) {
    throw fail('NATIVE_COMPACT_REQUEST', 'native compact tools must be an array')
  }
  if (request.expectedTransportIdentity !== undefined
    && (typeof request.expectedTransportIdentity !== 'string' || request.expectedTransportIdentity.length === 0)) {
    throw fail('NATIVE_COMPACT_REQUEST', 'expected transport identity must be a non-empty string')
  }
}

function decodeAccountId(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('invalid JWT')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    if (typeof accountId !== 'string' || accountId.length === 0) throw new Error('missing account id')
    return accountId
  } catch (error) {
    throw fail('NATIVE_COMPACT_AUTH', 'Codex OAuth token has no usable ChatGPT account identity', error)
  }
}

function fingerprint(accountId) {
  return createHash('sha256')
    .update('dsh-codex-oauth-transport-v1\0')
    .update(accountId)
    .digest('hex')
    .slice(0, 24)
}

function normalizeBaseUrl(raw, testBaseUrl) {
  const selected = testBaseUrl ?? raw
  let url
  try {
    url = new URL(selected)
  } catch (error) {
    throw fail('NATIVE_COMPACT_ENDPOINT', 'Codex OAuth backend URL is invalid', error)
  }

  if (testBaseUrl === undefined) {
    const normalized = url.toString().replace(/\/$/, '')
    if (normalized !== PRODUCTION_BASE_URL) {
      throw fail(
        'NATIVE_COMPACT_ENDPOINT',
        `refusing Codex OAuth credential outside ${PRODUCTION_BASE_URL}`,
      )
    }
  } else if (url.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) {
    throw fail('NATIVE_COMPACT_ENDPOINT', 'test Codex backend must be an explicit loopback HTTP URL')
  }

  return url.toString().replace(/\/$/, '')
}

function endpoint(baseUrl, operation) {
  return `${baseUrl}/codex/${operation}`
}

function baseHeaders(token, accountId) {
  return {
    authorization: `Bearer ${token}`,
    'chatgpt-account-id': accountId,
    originator: 'dsh',
    'user-agent': `dsh-codex-oauth (${platform()} ${release()}; ${arch()})`,
  }
}

function parseSse(text) {
  const events = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      events.push(JSON.parse(payload))
    } catch (error) {
      throw fail('NATIVE_COMPACT_PROTOCOL', 'Codex replay returned invalid SSE JSON', error)
    }
  }
  return events
}

function responsesBody(model, input, instructions, tools = []) {
  return {
    model,
    instructions,
    input,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: 'low', summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  }
}

function textOfRetainedItem(item) {
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return ''
  return item.content
    .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

function safeTail(text, chars) {
  let start = Math.max(text.length - chars, 0)
  if (start > 0 && start < text.length) {
    const first = text.charCodeAt(start)
    if (first >= 0xdc00 && first <= 0xdfff) start += 1
  }
  return text.slice(start)
}

function truncateRetainedItem(item, tokenBudget) {
  let remainingChars = tokenBudget * 4
  if (typeof item.content === 'string') {
    return { ...item, content: safeTail(item.content, remainingChars) }
  }
  if (!Array.isArray(item.content)) return undefined
  const content = []
  for (let index = item.content.length - 1; index >= 0; index -= 1) {
    const part = item.content[index]
    if (part?.type === 'input_image' && typeof part.image_url === 'string') {
      content.unshift(part)
      continue
    }
    if (part?.type !== 'input_text' || typeof part.text !== 'string' || remainingChars === 0) continue
    const text = safeTail(part.text, remainingChars)
    if (text.length > 0) content.unshift({ ...part, text })
    remainingChars = Math.max(remainingChars - text.length, 0)
  }
  return content.length === 0 ? undefined : { ...item, content }
}

function retainedV2Input(input) {
  const retained = []
  let remaining = RETAINED_INPUT_TOKEN_BUDGET
  for (let index = input.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = input[index]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    if (item.role !== 'user' && item.role !== 'developer' && item.role !== 'system') continue
    const tokens = Math.max(Math.ceil(textOfRetainedItem(item).length / 4), 1)
    if (tokens <= remaining) {
      retained.unshift(item)
      remaining -= tokens
      continue
    }
    const truncated = truncateRetainedItem(item, remaining)
    if (truncated !== undefined) retained.unshift(truncated)
    remaining = 0
  }
  return retained
}

function compactV2Result(events) {
  const compacted = events
    .filter((event) => event?.type === 'response.output_item.done' && event.item?.type === 'compaction')
    .map((event) => event.item)
  if (compacted.length !== 1) {
    throw fail(
      'NATIVE_COMPACT_PROTOCOL',
      `Codex native compact expected exactly one compaction item, received ${compacted.length}`,
    )
  }
  const completed = events.find((event) => event?.type === 'response.completed')
  if (completed === undefined) {
    throw fail('NATIVE_COMPACT_PROTOCOL', 'Codex native compact ended without response.completed')
  }
  return {
    item: compacted[0],
    usage: completed.response?.usage,
  }
}

function replayText(events) {
  const deltas = events
    .filter((event) => event?.type === 'response.output_text.delta' && typeof event.delta === 'string')
    .map((event) => event.delta)
    .join('')
  if (deltas !== '') return deltas

  for (const event of events) {
    if (event?.type !== 'response.output_item.done' || event.item?.type !== 'message') continue
    const text = event.item.content
      ?.filter((item) => item?.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('')
    if (text) return text
  }
  return ''
}

/**
 * Shared authenticated Codex transport. OAuth material never leaves this object:
 * callers receive only provider output and a one-way account fingerprint.
 */
export class CodexOAuthTransport {
  #models
  #providerId
  #provider
  #fetch
  #testBaseUrl
  #timeoutMs

  constructor(models, options = {}) {
    this.#models = models
    this.#providerId = options.providerId ?? PROVIDER_ID
    this.#provider = options.provider ?? PROVIDER
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#testBaseUrl = options.testBaseUrl
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (typeof this.#fetch !== 'function') {
      throw fail('NATIVE_COMPACT_TRANSPORT', 'global fetch is unavailable')
    }
  }

  async #authorization(modelId) {
    const model = this.#models.getModel(this.#providerId, modelId)
    if (model === undefined) {
      throw fail('NATIVE_COMPACT_MODEL', `Codex model is unavailable: ${modelId}`)
    }

    let resolution
    try {
      resolution = await this.#models.getAuth(model)
    } catch (error) {
      throw fail('NATIVE_COMPACT_AUTH', 'failed to resolve Codex OAuth authentication', error)
    }
    const token = resolution?.auth?.apiKey
    if (typeof token !== 'string' || token.length === 0) {
      throw fail('NATIVE_COMPACT_AUTH', 'Codex OAuth is not configured')
    }

    const accountId = decodeAccountId(token)
    const rawBaseUrl = resolution?.auth?.baseUrl ?? model.baseUrl
    return {
      token,
      accountId,
      identity: fingerprint(accountId),
      baseUrl: normalizeBaseUrl(rawBaseUrl, this.#testBaseUrl),
    }
  }

  describe() {
    const available = this.#models.getModels(this.#providerId) ?? []
    const defaultModel = available.find((model) => model.id === 'gpt-5.4')?.id ?? available[0]?.id
    return Object.freeze({
      provider: this.#provider,
      remoteCompaction: 'v2',
      ...(defaultModel === undefined ? {} : { defaultModel }),
    })
  }

  supportsImageInput(model) {
    if (typeof model !== 'string' || model.length === 0) return false
    return this.#models.getModel(this.#providerId, model)?.input.includes('image') === true
  }

  async identity(model) {
    if (typeof model !== 'string' || model.length === 0) {
      throw fail('NATIVE_COMPACT_MODEL', 'Codex model must be a non-empty string')
    }
    return (await this.#authorization(model)).identity
  }

  async compactContext(request) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw fail('NATIVE_COMPACT_REQUEST', 'native compact context request must be an object')
    }
    const model = this.#models.getModel(this.#providerId, request.model)
    if (model === undefined) throw fail('NATIVE_COMPACT_MODEL', `Codex model is unavailable: ${String(request.model)}`)
    const context = request.context
    if (context === null || typeof context !== 'object' || !Array.isArray(context.messages)) {
      throw fail('NATIVE_COMPACT_REQUEST', 'native compact context must contain messages')
    }
    const input = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
      includeSystemPrompt: false,
      toolOptions: {
        strict: null,
        supportsStrictMode: model.compat?.supportsStrictMode ?? true,
        supportsOpenAIGrammarTools: false,
      },
    })
    const tools = Array.isArray(context.tools) && context.tools.length > 0
      ? convertResponsesTools(context.tools, {
          strict: null,
          supportsStrictMode: model.compat?.supportsStrictMode ?? true,
          supportsOpenAIGrammarTools: false,
        })
      : []
    return this.compact({
      model: request.model,
      input,
      instructions: context.systemPrompt ?? 'You are a helpful assistant.',
      tools,
      expectedTransportIdentity: request.expectedTransportIdentity,
      signal: request.signal,
    })
  }

  async #postSse(url, body, auth, signal, operation) {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          ...baseHeaders(auth.token, auth.accountId),
          accept: 'text/event-stream',
          'content-type': 'application/json',
          'openai-beta': 'responses=experimental',
        },
        body: JSON.stringify(body),
        signal: combined,
      })
    } catch (error) {
      if (signal?.aborted) throw fail('NATIVE_COMPACT_ABORTED', `${operation} was aborted`, error)
      throw fail('NATIVE_COMPACT_TRANSPORT', `${operation} transport failed`, error)
    }
    if (!response.ok) {
      throw fail('NATIVE_COMPACT_HTTP', `${operation} failed with HTTP ${response.status}`)
    }
    return parseSse(await response.text())
  }

  async compact(request) {
    assertRequest(request)
    const auth = await this.#authorization(request.model)
    if (request.expectedTransportIdentity !== undefined && auth.identity !== request.expectedTransportIdentity) {
      throw fail('NATIVE_COMPACT_IDENTITY', 'authenticated account/workspace identity changed before compact request')
    }
    const trigger = { type: 'compaction_trigger' }
    const events = await this.#postSse(
      endpoint(auth.baseUrl, 'responses'),
      responsesBody(
        request.model,
        [...request.input, trigger],
        typeof request.instructions === 'string' ? request.instructions : '',
        request.tools ?? [],
      ),
      auth,
      request.signal,
      'Codex native compact',
    )
    const compacted = compactV2Result(events)
    const items = [...retainedV2Input(request.input), compacted.item]
    return Object.freeze({
      protocol: 'responses.compaction-trigger.v2',
      model: request.model,
      transportIdentity: auth.identity,
      items,
      ...(compacted.usage === undefined ? {} : { usage: compacted.usage }),
    })
  }

  /** Explicit diagnostic: compact synthetic history, JSON-round-trip it, then replay it once. */
  async probe(request) {
    const nonce = `DSH_NATIVE_COMPACT_${Date.now().toString(36).toUpperCase()}`
    const input = [
      {
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Remember the exact probe code stated by the assistant in the next history item.',
        }],
      },
      {
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: `The exact probe code is ${nonce}.`,
        }],
      },
    ]
    const compacted = await this.compact({ model: request.model, input, signal: request.signal })
    const roundTripped = JSON.parse(JSON.stringify(compacted.items))
    if (JSON.stringify(roundTripped) !== JSON.stringify(compacted.items)) {
      throw fail('NATIVE_COMPACT_FIDELITY', 'native compact items failed a lossless JSON round trip')
    }

    const auth = await this.#authorization(request.model)
    const replayInput = [
      ...roundTripped,
      {
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'What exact probe code were you asked to remember? Reply with only that code.',
        }],
      },
    ]
    const events = await this.#postSse(
      endpoint(auth.baseUrl, 'responses'),
      responsesBody(request.model, replayInput, 'Follow the latest user instruction exactly.'),
      auth,
      request.signal,
      'Codex replay probe',
    )
    if (!events.some((event) => event?.type === 'response.completed')) {
      throw fail('NATIVE_COMPACT_PROTOCOL', 'Codex replay probe ended without response.completed')
    }
    const text = replayText(events).trim()
    if (!text.includes(nonce)) {
      throw fail('NATIVE_COMPACT_REPLAY', 'Codex replay did not recover the compacted probe code')
    }

    return Object.freeze({
      protocol: compacted.protocol,
      model: compacted.model,
      transportIdentity: compacted.transportIdentity,
      itemCount: compacted.items.length,
      persistenceRoundTripVerified: true,
      replayVerified: true,
    })
  }
}
