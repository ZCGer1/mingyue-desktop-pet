import { useSettings } from '../context'
import { Button, Field, Pill, Toggle } from '../ui'

/**
 * 模型连接与上下文。模型页与配置流程的 API 步骤共用同一份表单。
 *
 * API Key 是即时动作（主进程加密保存），不进入配置草稿。
 */
export function ModelFields(): React.JSX.Element {
  const s = useSettings()
  const provider = s.config.provider
  const key = s.boot.keyStatus

  return (
    <div className="stack section-stack">
      <section className="section" aria-labelledby="model-key">
        <header className="section-head">
          <h2 id="model-key">DeepSeek API Key</h2>
          <div className="section-actions">
            <Pill tone={key.configured ? 'ok' : 'bad'}>
              {key.configured ? '已配置' : '未配置'}
            </Pill>
            {key.storageAvailable ? null : <Pill tone="bad">DPAPI 不可用</Pill>}
          </div>
        </header>
        <div className="section-body">
          <div className="row-gap">
            <input
              className="input grow"
              type="password"
              aria-label="DeepSeek API Key"
              autoComplete="off"
              spellCheck={false}
              placeholder={key.configured ? '输入新 Key 以替换' : 'sk-…'}
              value={s.keyInput}
              onChange={(event) => s.setKeyInput(event.target.value)}
            />
            <Button variant="primary" onClick={() => void s.saveKey()} disabled={s.keyBusy}>
              保存
            </Button>
            <Button onClick={() => void s.verifyKey()} disabled={s.keyBusy}>
              验证
            </Button>
            <Button onClick={() => void s.listModels()} disabled={s.keyBusy}>
              模型列表
            </Button>
            {key.configured && (
              <Button variant="danger" onClick={() => void s.clearKey()} disabled={s.keyBusy}>
                删除
              </Button>
            )}
          </div>
          {s.models.length > 0 && (
            <div className="model-chips">
              {s.models.map((model) => (
                <button
                  type="button"
                  key={model}
                  className={`chip ${provider.model === model ? 'is-active' : ''}`}
                  onClick={() => s.update(['provider', 'model'], model)}
                >
                  {model}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="section" aria-labelledby="model-config">
        <header className="section-head">
          <h2 id="model-config">模型</h2>
        </header>
        <div className="section-body">
          <div className="grid-2">
            <Field label="主模型">
              <input
                className="input"
                value={provider.model}
                maxLength={100}
                onChange={(event) => s.update(['provider', 'model'], event.target.value.trim())}
              />
            </Field>
            <Field label="工具模型">
              <input
                className="input"
                value={provider.utilityModel}
                maxLength={100}
                onChange={(event) =>
                  s.update(['provider', 'utilityModel'], event.target.value.trim())
                }
              />
            </Field>
            <Field label="上下文窗口（tokens）">
              <input
                className="input input-num"
                type="number"
                min={8000}
                max={1000000}
                value={provider.contextWindow}
                onChange={(event) =>
                  s.update(['provider', 'contextWindow'], Number(event.target.value))
                }
              />
            </Field>
            <Field label="最大输出（tokens）">
              <input
                className="input input-num"
                type="number"
                min={256}
                max={65536}
                value={provider.maxOutputTokens}
                onChange={(event) =>
                  s.update(['provider', 'maxOutputTokens'], Number(event.target.value))
                }
              />
            </Field>
            <Field label="上下文预算（tokens）">
              <input
                className="input input-num"
                type="number"
                min={1000}
                max={provider.contextWindow}
                value={s.config.context.maxTokens}
                onChange={(event) =>
                  s.update(['context', 'maxTokens'], Number(event.target.value))
                }
              />
            </Field>
          </div>
          <Toggle
            label="启用 thinking"
            checked={provider.thinking}
            onChange={(checked) => s.update(['provider', 'thinking'], checked)}
          />
          <Toggle
            label="允许图片输入"
            hint="截图、整屏共享与电脑操作都依赖它"
            checked={provider.visionInput}
            onChange={(checked) => s.update(['provider', 'visionInput'], checked)}
          />
        </div>
      </section>

      <details className="advanced-block">
        <summary>高级</summary>
        <div className="section-body">
          <div className="grid-2">
            <Field label="接口地址">
              <input
                className="input"
                value={provider.baseUrl ?? ''}
                placeholder="https://api.deepseek.com"
                onChange={(event) =>
                  s.update(
                    ['provider', 'baseUrl'],
                    event.target.value.trim() === '' ? undefined : event.target.value.trim()
                  )
                }
              />
            </Field>
            <Field label="等待响应头（毫秒）">
              <input
                className="input input-num"
                type="number"
                min={1000}
                max={300000}
                value={provider.requestTimeoutMs}
                onChange={(event) =>
                  s.update(['provider', 'requestTimeoutMs'], Number(event.target.value))
                }
              />
            </Field>
            <Field label="流空闲上限（毫秒）">
              <input
                className="input input-num"
                type="number"
                min={1000}
                max={600000}
                value={provider.streamIdleTimeoutMs}
                onChange={(event) =>
                  s.update(['provider', 'streamIdleTimeoutMs'], Number(event.target.value))
                }
              />
            </Field>
            <Field label="软阈值比例">
              <input
                className="input input-num"
                type="number"
                step={0.01}
                min={0.5}
                max={0.98}
                value={s.config.context.softRatio}
                onChange={(event) =>
                  s.update(['context', 'softRatio'], Number(event.target.value))
                }
              />
            </Field>
            <Field label="保留比例">
              <input
                className="input input-num"
                type="number"
                step={0.01}
                min={0.05}
                max={0.8}
                value={s.config.context.keepRatio}
                onChange={(event) =>
                  s.update(['context', 'keepRatio'], Number(event.target.value))
                }
              />
            </Field>
          </div>
          <div className="grid-2">
            <Field label="合批安静间隔（毫秒）">
              <input
                className="input input-num"
                type="number"
                value={s.config.batching.quietGapMs}
                onChange={(event) =>
                  s.update(['batching', 'quietGapMs'], Number(event.target.value))
                }
              />
            </Field>
            <Field label="合批最短等待（毫秒）">
              <input
                className="input input-num"
                type="number"
                value={s.config.batching.minBatchAgeMs}
                onChange={(event) =>
                  s.update(['batching', 'minBatchAgeMs'], Number(event.target.value))
                }
              />
            </Field>
            <Field label="合批最长等待（毫秒）">
              <input
                className="input input-num"
                type="number"
                value={s.config.batching.maxBatchAgeMs}
                onChange={(event) =>
                  s.update(['batching', 'maxBatchAgeMs'], Number(event.target.value))
                }
              />
            </Field>
            <Field label="最多合并条数">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={64}
                value={s.config.batching.maxBatchSize}
                onChange={(event) =>
                  s.update(['batching', 'maxBatchSize'], Number(event.target.value))
                }
              />
            </Field>
          </div>
        </div>
      </details>
    </div>
  )
}
