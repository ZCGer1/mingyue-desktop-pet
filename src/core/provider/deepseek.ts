import type {
  ModelEvent,
  ModelFacts,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelStreamObserver,
  ProviderErrorCategory,
  ProviderErrorDiagnostics,
  ProviderTransportPhase,
  Usage
} from '../types'
import { ProviderError } from '../types'
import {
  collectErrorDiagnostics,
  formatTransportMessage,
  isStableTransportFailure,
  redactedOrigin,
  sanitizeErrorText
} from './diagnostics'

export interface DeepSeekOptions {
  apiKey: string
  baseUrl?: string
  model: string
  contextWindow?: number
  maxOutputTokens?: number
  fetchImpl?: typeof fetch
  /** 等待响应头的上限；默认 45 秒。 */
  requestTimeoutMs?: number
  /** 流式响应两次数据之间的最长空闲；默认 120 秒。 */
  streamIdleTimeoutMs?: number
}

interface DeepSeekDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
}

interface DeepSeekChunk {
  choices?: Array<{
    delta?: DeepSeekDelta
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  } | null
}

/**
 * DeepSeek 官方 API（OpenAI 兼容 Chat Completions，流式 SSE）。
 * Core 不泄漏 DeepSeek 特有字段；只有这个文件知道请求体长什么样。
 */
export class DeepSeekProvider implements ModelProvider {
  readonly id = 'deepseek' as const
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly model: string
  private readonly contextWindow?: number
  private readonly maxOutputTokens?: number
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly streamIdleTimeoutMs: number

  constructor(options: DeepSeekOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
    this.model = options.model
    this.contextWindow = options.contextWindow
    this.maxOutputTokens = options.maxOutputTokens
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requestTimeoutMs = positiveMs(options.requestTimeoutMs, 45_000)
    this.streamIdleTimeoutMs = positiveMs(options.streamIdleTimeoutMs, 120_000)
  }

  /** 只暴露 origin；路径、查询串、用户名和密码都不进入日志。 */
  endpointOrigin(): string {
    return redactedOrigin(this.baseUrl)
  }

  modelFacts(): ModelFacts {
    return {
      model: this.model,
      ...(this.contextWindow === undefined ? {} : { contextWindow: this.contextWindow }),
      ...(this.maxOutputTokens === undefined ? {} : { maxOutputTokens: this.maxOutputTokens })
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const deadline = new AbortController()
    let timedOut = false
    let response: Response
    try {
      response = await withTimeout(
        this.fetchImpl(`${this.baseUrl}/models`, {
          headers: this.headers(),
          signal: deadline.signal
        }),
        this.requestTimeoutMs,
        () => {
          timedOut = true
          deadline.abort()
        }
      )
    } catch (error) {
      if (error instanceof ProviderError) throw error
      if (timedOut) {
        throw this.transportError('连接 DeepSeek 超时', timeoutCause(), 'request', 'timeout', 'TIMEOUT')
      }
      throw this.transportError('无法连接 DeepSeek', error, 'request')
    }
    if (!response.ok) throw this.httpError(response.status, await safeText(response))
    let payload: { data?: Array<{ id?: string; owned_by?: string }> }
    try {
      payload = (await response.json()) as { data?: Array<{ id?: string; owned_by?: string }> }
    } catch (error) {
      throw new ProviderError('DeepSeek 返回的模型列表无法解析', {
        code: 'RESPONSE_INVALID',
        category: 'response',
        retryable: true,
        diagnostics: responseDiagnostics('response-headers'),
        cause: error
      })
    }
    return (payload.data ?? [])
      .filter((item): item is { id: string; owned_by?: string } => typeof item.id === 'string')
      .map((item) => ({ id: item.id, ...(item.owned_by === undefined ? {} : { ownedBy: item.owned_by }) }))
  }

  async *stream(
    req: ModelRequest,
    signal: AbortSignal,
    observer?: ModelStreamObserver
  ): AsyncIterable<ModelEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true }
    }
    if (req.tools !== undefined && req.tools.length > 0) {
      body.tools = req.tools
      body.tool_choice = 'auto'
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.thinking !== undefined) body.thinking = { type: req.thinking ? 'enabled' : 'disabled' }

    // 外部 signal 负责用户取消；内部 deadline 只负责超时。两者分开记录，
    // 这样“用户停止”与“请求超时”不会混成同一个 NETWORK。
    const deadline = new AbortController()
    let timedOut = false
    const combined = AbortSignal.any([signal, deadline.signal])
    let response: Response
    try {
      response = await withTimeout(
        this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: combined
        }),
        this.requestTimeoutMs,
        () => {
          timedOut = true
          deadline.abort()
        }
      )
    } catch (error) {
      if (timedOut) {
        throw this.transportError('等待 DeepSeek 响应超时', timeoutCause(), 'request', 'timeout', 'TIMEOUT')
      }
      if (signal.aborted) throw this.cancelledError(error, 'request')
      throw this.transportError('网络中断', error, 'request')
    }
    // 响应头已经到达（即使状态码不是 2xx）；调用方据此区分请求阶段与流阶段。
    observer?.onResponseStarted?.()

    if (!response.ok) {
      const detail = await safeText(response)
      throw this.httpError(response.status, detail)
    }
    if (response.body === null) {
      throw new ProviderError('DeepSeek 返回了空响应', {
        code: 'EMPTY_RESPONSE',
        category: 'response',
        retryable: true,
        diagnostics: responseDiagnostics('response-headers')
      })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let dataLines: string[] = []
    let finished = false

    const dispatch = function* (data: string): Generator<ModelEvent> {
      if (data.trim() === '' || data.trim() === '[DONE]') return
      let chunk: DeepSeekChunk
      try {
        chunk = JSON.parse(data) as DeepSeekChunk
      } catch {
        return
      }
      if (chunk.usage !== undefined && chunk.usage !== null) {
        yield { type: 'usage', usage: normaliseUsage(chunk.usage) }
      }
      const choice = chunk.choices?.[0]
      if (choice === undefined) return
      const delta = choice.delta
      if (delta !== undefined) {
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          yield { type: 'reasoning', text: delta.reasoning_content }
        }
        if (typeof delta.content === 'string' && delta.content !== '') {
          yield { type: 'text', text: delta.content }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            yield {
              type: 'tool_call',
              index: typeof call.index === 'number' ? call.index : 0,
              ...(typeof call.id === 'string' && call.id !== '' ? { id: call.id } : {}),
              ...(typeof call.function?.name === 'string' && call.function.name !== ''
                ? { name: call.function.name }
                : {}),
              ...(typeof call.function?.arguments === 'string' && call.function.arguments !== ''
                ? { argumentsDelta: call.function.arguments }
                : {})
            }
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
        finished = true
        yield { type: 'finish', reason: choice.finish_reason }
      }
    }

    try {
      while (!finished) {
        let read: Awaited<ReturnType<typeof reader.read>>
        try {
          read = await withTimeout(reader.read(), this.streamIdleTimeoutMs, () => {
            timedOut = true
            deadline.abort()
          })
        } catch (error) {
          if (timedOut) {
            throw this.transportError(
              'DeepSeek 响应流空闲超时',
              timeoutCause(),
              'stream',
              'timeout',
              'TIMEOUT'
            )
          }
          if (signal.aborted) throw this.cancelledError(error, 'stream')
          throw this.transportError('DeepSeek 响应流中断', error, 'stream')
        }
        const { done, value } = read
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          let line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (line === '') {
            if (dataLines.length > 0) {
              for (const event of dispatch(dataLines.join('\n'))) yield event
              dataLines = []
            }
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
          newline = buffer.indexOf('\n')
        }
        if (finished) break
      }
      if (dataLines.length > 0) {
        for (const event of dispatch(dataLines.join('\n'))) yield event
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json'
    }
  }

  private httpError(status: number, detail: string): ProviderError {
    const clean = sanitizeErrorText(detail, 400)
    const map: Record<number, string> = {
      401: 'API Key 无效或已过期',
      402: 'DeepSeek 账户余额不足',
      429: 'DeepSeek 请求过于频繁，请稍后再试',
      500: 'DeepSeek 服务暂时不可用',
      502: 'DeepSeek 网关错误',
      503: 'DeepSeek 服务暂时不可用',
      504: 'DeepSeek 服务超时'
    }
    const message = map[status] ?? `DeepSeek 请求失败（HTTP ${status}）`
    return new ProviderError(`${message}${clean === '' ? '' : `：${clean}`}`, {
      status,
      category: 'http',
      diagnostics: responseDiagnostics('response-headers')
    })
  }

  /** 传输类失败：保留底层 code/类型；证书与非法地址不做自动重试。 */
  private transportError(
    prefix: string,
    error: unknown,
    phase: ProviderTransportPhase,
    category: ProviderErrorCategory = 'transport',
    code = 'NETWORK'
  ): ProviderError {
    const diagnostics = collectErrorDiagnostics(error, phase, category)
    return new ProviderError(formatTransportMessage(prefix, error, diagnostics), {
      code,
      category,
      retryable: category === 'timeout' ? true : !isStableTransportFailure(diagnostics),
      diagnostics,
      cause: error
    })
  }

  private cancelledError(error: unknown, phase: ProviderTransportPhase): ProviderError {
    return new ProviderError('请求已取消', {
      code: 'CANCELLED',
      category: 'cancelled',
      retryable: false,
      diagnostics: collectErrorDiagnostics(error, phase, 'cancelled'),
      cause: error
    })
  }
}

function normaliseUsage(usage: NonNullable<DeepSeekChunk['usage']>): Usage {
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    ...(usage.prompt_cache_hit_tokens === undefined
      ? {}
      : { cacheHitTokens: usage.prompt_cache_hit_tokens }),
    ...(usage.prompt_cache_miss_tokens === undefined
      ? {}
      : { cacheMissTokens: usage.prompt_cache_miss_tokens })
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function responseDiagnostics(phase: ProviderTransportPhase): ProviderErrorDiagnostics {
  return {
    category: 'response',
    transportPhase: phase,
    causeStatus: 'none'
  }
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

const TIMEOUT_MARKER = Symbol('provider-timeout')

/** 超时不是底层网络错误；给一条真实、可读的 message，不伪造 errno/code。 */
function timeoutCause(): Error {
  return new Error('请求超过了设定的等待时限')
}

/**
 * Promise.race 而不是只依赖 AbortSignal：真实 fetch 会响应 abort，
 * 注入的假 fetch/ReadableStream 不一定；测试与超时判定都需要确定性。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(TIMEOUT_MARKER)
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
    // 超时后原 Promise 仍可能迟到地失败；吞掉它，避免未处理的 rejection。
    void promise.catch(() => undefined)
  })
}
