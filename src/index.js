/**
 * Host entry: OAuth credentials, Codex adapter/transport, settings routes,
 * native checkpoint replay guard, and explicit diagnostic probe.
 *
 * The same npm package exports `./compaction` for an isolated agent preset;
 * keeping the entry points separate preserves the Host/agent Cordis planes.
 *
 * @module dsh-llm-codex-native-compact
 */
import { createModels } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { DshCredentialStore } from './store.js'
import { CodexAdapter } from './adapter.js'
import { LoginManager } from './login.js'
import { installCommands } from './commands.js'
import { installServerRoutes } from './server.js'
import { CodexOAuthTransport } from './transport.js'
import {
  installNativeCheckpointGuard,
  installNativeCompactProbe,
} from './native-compact.js'

export const name = 'dsh-llm-codex-native-compact'
export const inject = ['llm', 'credentials', 'commands']

const DEFAULTS = {
  provider: 'codex-oauth',
  providerId: 'openai-codex',
  credentialRef: 'OPENAI_CODEX_OAUTH',
  streamIdleTimeoutMs: 300000,
}

export function apply(ctx, config) {
  const provider = config?.provider ?? DEFAULTS.provider
  const providerId = config?.providerId ?? DEFAULTS.providerId
  const credentialRef = config?.credentialRef ?? DEFAULTS.credentialRef
  const streamIdleTimeoutMs = config?.streamIdleTimeoutMs ?? DEFAULTS.streamIdleTimeoutMs
  const catalogProvider = builtinProviders().find((entry) => entry.id === providerId)
  if (catalogProvider === undefined) {
    throw new Error(`dsh-llm-codex-native-compact: the installed pi-ai ships no provider "${providerId}"`)
  }

  const store = new DshCredentialStore(ctx, credentialRef, providerId)
  const models = createModels({ credentials: store })
  models.setProvider(catalogProvider)
  const transport = new CodexOAuthTransport(models, {
    providerId,
    provider,
    timeoutMs: streamIdleTimeoutMs * 4,
  })
  ctx.provide('codexOAuthTransport', transport)
  ctx.llm.registerAdapter([provider], new CodexAdapter(models, providerId, provider, {
    streamIdleTimeoutMs,
    transport,
    resolveAttachments: () => ctx.get('attachments'),
  }))

  const login = new LoginManager(ctx, models, providerId)
  installServerRoutes(ctx, login, store, providerId)
  installCommands(ctx, login, store, providerId)
  installNativeCheckpointGuard(ctx, provider)
  installNativeCompactProbe(ctx, transport, { ...config, nativeCompactMode: 'probe' })
  ctx.logger.info(`dsh-llm-codex-native-compact: provider "${provider}" ready (pi-ai ${providerId}; credential ${credentialRef})`)
}
