import type { AppConfig } from './shared/config'
import { DeepSeekProvider } from './core/provider/deepseek'
import { redactedOrigin } from './core/provider/diagnostics'
import {
  ProviderError,
  type ModelEvent,
  type ModelFacts,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamObserver
} from './core/types'

/**
 * 按当前配置与密钥惰性构造 Provider。
 *
 * 配置或密钥变化时整体替换底层 Provider；旧实例不会继续接收新请求。
 * 这里只做装配，不保存密钥、不解释模型能力。
 */
export class ConfigurableDeepSeekProvider implements ModelProvider {
  readonly id = 'deepseek' as const
  private readonly getApiKey: () => string | null
  private readonly getConfig: () => AppConfig
  private readonly fetchImpl: typeof fetch | undefined
  private provider: DeepSeekProvider | null = null
  private signature = ''

  constructor(opts: {
    getApiKey: () => string | null
    getConfig: () => AppConfig
    fetchImpl?: typeof fetch
  }) {
    this.getApiKey = opts.getApiKey
    this.getConfig = opts.getConfig
    this.fetchImpl = opts.fetchImpl
  }

  private current(): DeepSeekProvider {
    const key = (this.getApiKey() ?? '').trim()
    if (key === '') {
      throw new ProviderError('还没有配置 DeepSeek API Key。到设置 → 模型里填一个 Key 就能聊天了。', {
        retryable: false,
        code: 'NO_API_KEY',
        category: 'config'
      })
    }
    const config = this.getConfig().provider
    const signature = [
      key,
      config.baseUrl ?? '',
      config.model,
      String(config.contextWindow),
      String(config.maxOutputTokens),
      String(config.requestTimeoutMs),
      String(config.streamIdleTimeoutMs)
    ].join('\u0000')
    if (this.provider === null || signature !== this.signature) {
      this.provider = new DeepSeekProvider({
        apiKey: key,
        model: config.model,
        contextWindow: config.contextWindow,
        maxOutputTokens: config.maxOutputTokens,
        requestTimeoutMs: config.requestTimeoutMs,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl })
      })
      this.signature = signature
    }
    return this.provider
  }

  modelFacts(): ModelFacts {
    const config = this.getConfig().provider
    return {
      model: config.model,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.current().listModels()
  }

  async *stream(
    req: ModelRequest,
    signal: AbortSignal,
    observer?: ModelStreamObserver
  ): AsyncIterable<ModelEvent> {
    yield* this.current().stream(req, signal, observer)
  }

  endpointOrigin(): string {
    return redactedOrigin(this.getConfig().provider.baseUrl)
  }

  get fetchKind(): 'global-fetch' | 'injected-fetch' {
    return this.fetchImpl === undefined ? 'global-fetch' : 'injected-fetch'
  }

  hasApiKey(): boolean {
    return (this.getApiKey() ?? '').trim() !== ''
  }
}
