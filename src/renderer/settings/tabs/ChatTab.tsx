import { useState } from 'react'
import { useSettings } from '../context'
import { Field, Section, Toggle } from '../ui'

/** 聊天窗口、快捷输入与点击行为。 */
export function ChatTab(): React.JSX.Element {
  const s = useSettings()
  const chat = s.config.chatUi
  const [deniedText, setDeniedText] = useState(chat.quickInput.deniedTools.join('\n'))

  return (
    <div className="stack">
      <Section title="完整聊天窗口">
        <Toggle
          label="启用聊天"
          checked={s.config.worlds.chat.enabled}
          onChange={(checked) => s.update(['worlds', 'chat', 'enabled'], checked)}
        />
        <div className="grid-2">
          <Field label="默认宽度（像素）">
            <input
              className="input input-num"
              type="number"
              min={360}
              max={1200}
              value={chat.window.width}
              onChange={(event) =>
                s.update(
                  ['chatUi', 'window', 'width'],
                  Math.min(1200, Math.max(360, Number(event.target.value)))
                )
              }
            />
          </Field>
          <Field label="默认高度（像素）">
            <input
              className="input input-num"
              type="number"
              min={400}
              max={1400}
              value={chat.window.height}
              onChange={(event) =>
                s.update(
                  ['chatUi', 'window', 'height'],
                  Math.min(1400, Math.max(400, Number(event.target.value)))
                )
              }
            />
          </Field>
        </div>
        <Toggle
          label="允许模型打开完整聊天"
          checked={chat.allowModelOpen}
          onChange={(checked) => s.update(['chatUi', 'allowModelOpen'], checked)}
        />
      </Section>

      <Section title="快捷输入">
        <Toggle
          label="启用快捷输入"
          checked={chat.quickInput.enabled}
          onChange={(checked) => s.update(['chatUi', 'quickInput', 'enabled'], checked)}
        />
        <div className="grid-2">
          <Field label="面板宽度（像素）">
            <input
              className="input input-num"
              type="number"
              min={280}
              max={600}
              disabled={!chat.quickInput.enabled}
              value={chat.quickInput.width}
              onChange={(event) =>
                s.update(
                  ['chatUi', 'quickInput', 'width'],
                  Math.min(600, Math.max(280, Number(event.target.value)))
                )
              }
            />
          </Field>
          <Field label="单条回复上限（字符）">
            <input
              className="input input-num"
              type="number"
              min={100}
              max={2000}
              disabled={!chat.quickInput.enabled}
              value={chat.quickInput.maxReplyChars}
              onChange={(event) =>
                s.update(
                  ['chatUi', 'quickInput', 'maxReplyChars'],
                  Math.min(2000, Math.max(100, Number(event.target.value)))
                )
              }
            />
          </Field>
        </div>
        <Toggle
          label="Esc 关闭快捷输入"
          checked={chat.quickInput.closeOnEscape}
          disabled={!chat.quickInput.enabled}
          onChange={(checked) =>
            s.update(['chatUi', 'quickInput', 'closeOnEscape'], checked)
          }
        />
        <Toggle
          label="允许快捷聊天使用工具"
          checked={chat.quickInput.allowTools}
          disabled={!chat.quickInput.enabled}
          onChange={(checked) => s.update(['chatUi', 'quickInput', 'allowTools'], checked)}
        />
        <Field label="额外禁用的工具" hint="每行一个工具名。">
          <textarea
            className="input textarea"
            rows={3}
            disabled={!chat.quickInput.enabled || !chat.quickInput.allowTools}
            value={deniedText}
            placeholder={'term_run\ncua_key'}
            onChange={(event) => {
              const text = event.target.value
              setDeniedText(text)
              s.update(
                ['chatUi', 'quickInput', 'deniedTools'],
                text
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line !== '')
              )
            }}
          />
        </Field>
      </Section>

      <Section title="点击桌宠">
        <Field label="点击动作">
          <select
            className="input"
            value={chat.petClickAction}
            onChange={(event) => s.update(['chatUi', 'petClickAction'], event.target.value)}
          >
            <option value="quick-input">打开快捷输入</option>
            <option value="full-chat">打开完整聊天</option>
            <option value="none">什么都不做</option>
          </select>
        </Field>
        {!chat.quickInput.enabled && chat.petClickAction === 'quick-input' && (
          <p className="inline-warn">快捷输入已关闭，这个选项不会生效。</p>
        )}
      </Section>
    </div>
  )
}
