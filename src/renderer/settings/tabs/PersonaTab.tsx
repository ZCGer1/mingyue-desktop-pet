import { DSH_PET_DEFAULT_SIZE } from '../../../shared/config'
import { useSettings } from '../context'
import { Button, Field, Section, Toggle } from '../ui'

/**
 * 人格与自主节奏。
 *
 * 自主 tick 只决定「模型什么时候有机会醒来」；是否说话、是否行动、
 * 是否保持沉默都由模型判断，不再有本地台词或默认发言。
 */
export function PersonaTab(): React.JSX.Element {
  const s = useSettings()
  const persona = s.config.persona
  const autonomy = s.config.autonomy
  const pet = s.config.worlds.pet
  const movement = pet.movement

  const minutes = (ms: number): number => Math.round(ms / 60_000)
  const seconds = (ms: number): number => Math.round(ms / 1000)

  return (
    <div className="stack">
      <Section title="身份">
        <div className="grid-2">
          <Field label="名字">
            <input
              className="input"
              maxLength={24}
              value={persona.name}
              onChange={(event) => s.update(['persona', 'name'], event.target.value)}
            />
          </Field>
          <Field label="语言">
            <select
              className="input"
              value={persona.language}
              onChange={(event) => s.update(['persona', 'language'], event.target.value)}
            >
              <option value="zh-CN">简体中文</option>
              <option value="zh-TW">繁體中文</option>
              <option value="en-US">English</option>
              <option value="ja-JP">日本語</option>
            </select>
          </Field>
        </div>
        <Field label="语气">
          <select
            className="input"
            value={persona.tone}
            onChange={(event) => s.update(['persona', 'tone'], event.target.value)}
          >
            <option value="gentle">温柔、轻一点</option>
            <option value="lively">活泼、话多一点</option>
            <option value="calm">安静、克制</option>
            <option value="sharp">直接、干脆</option>
          </select>
        </Field>
      </Section>

      <Section title="人格提示词">
        <Field label="自定义人格">
          <textarea
            className="input textarea"
            rows={6}
            maxLength={4000}
            spellCheck={false}
            placeholder="例如：她最近迷上了看云；遇到报错时先陪用户吐槽一句再分析。"
            value={persona.customPrompt}
            onChange={(event) => s.update(['persona', 'customPrompt'], event.target.value)}
          />
        </Field>
        <div className="row-gap">
          <span className="muted small">{persona.customPrompt.length} / 4000</span>
          <Button
            variant="subtle"
            disabled={persona.customPrompt === ''}
            onClick={() => s.update(['persona', 'customPrompt'], '')}
          >
            清空
          </Button>
        </div>
      </Section>

      <Section title="聊天节奏">
        <div className="grid-2">
          <Field label="最短间隔（分钟，1–60）">
            <input
              className="input input-num"
              type="number"
              min={1}
              max={60}
              disabled={!autonomy.enabled}
              value={minutes(autonomy.tickMinMs)}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'tickMinMs'],
                  Math.min(60, Math.max(1, Number(event.target.value))) * 60_000
                )
              }
            />
          </Field>
          <Field label="最长间隔（分钟，5–360）">
            <input
              className="input input-num"
              type="number"
              min={5}
              max={360}
              disabled={!autonomy.enabled}
              value={minutes(autonomy.tickMaxMs)}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'tickMaxMs'],
                  Math.min(360, Math.max(5, Number(event.target.value))) * 60_000
                )
              }
            />
          </Field>
          <Field label="沉默退避系数（1–4）">
            <input
              className="input input-num"
              type="number"
              min={1}
              max={4}
              step={0.5}
              disabled={!autonomy.enabled}
              value={autonomy.backoffFactor}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'backoffFactor'],
                  Math.min(4, Math.max(1, Number(event.target.value)))
                )
              }
            />
          </Field>
          <Field label="唤醒最小间隔（秒，10–300）">
            <input
              className="input input-num"
              type="number"
              min={10}
              max={300}
              value={seconds(autonomy.wakeGapMs)}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'wakeGapMs'],
                  Math.min(300, Math.max(10, Number(event.target.value))) * 1000
                )
              }
            />
          </Field>
          <Field label="你发言后的冷却（秒，0–600）">
            <input
              className="input input-num"
              type="number"
              min={0}
              max={600}
              value={seconds(autonomy.postUserCooldownMs)}
              onChange={(event) =>
                s.update(
                  ['autonomy', 'postUserCooldownMs'],
                  Math.min(600, Math.max(0, Number(event.target.value))) * 1000
                )
              }
            />
          </Field>
        </div>
        <Toggle
          label="安静时段内不主动说话"
          checked={autonomy.respectQuietHours}
          onChange={(checked) => s.update(['autonomy', 'respectQuietHours'], checked)}
        />
        <Toggle
          label="你离开电脑时减少主动说话"
          checked={autonomy.idlePauseTicks}
          onChange={(checked) => s.update(['autonomy', 'idlePauseTicks'], checked)}
        />
        <Toggle
          label="在 tick 中附带环境快照"
          checked={autonomy.ambientContext}
          onChange={(checked) => s.update(['autonomy', 'ambientContext'], checked)}
        />
      </Section>

      <Section title="桌宠表现">
        <Toggle
          label="启用桌宠世界"
          checked={pet.enabled}
          onChange={(checked) => s.update(['worlds', 'pet', 'enabled'], checked)}
        />
        <Field label={`角色大小（像素，默认 ${DSH_PET_DEFAULT_SIZE}）`}>
          <div className="row-gap">
            <input
              className="input"
              type="range"
              min={160}
              max={900}
              step={1}
              value={pet.appearance.size}
              disabled={!pet.enabled}
              aria-label="角色大小"
              onChange={(event) =>
                s.update(
                  ['worlds', 'pet', 'appearance', 'size'],
                  Math.min(900, Math.max(160, Number(event.target.value)))
                )
              }
            />
            <span className="muted small">{pet.appearance.size}px</span>
          </div>
        </Field>
        <Toggle
          label="减少动态效果"
          checked={pet.appearance.reducedMotion}
          onChange={(checked) =>
            s.update(['worlds', 'pet', 'appearance', 'reducedMotion'], checked)
          }
        />
        <Toggle
          label="随机小动作（2–5 分钟）"
          checked={pet.animation.randomIdle.enabled}
          disabled={!pet.enabled || pet.appearance.reducedMotion}
          onChange={(checked) =>
            s.update(['worlds', 'pet', 'animation', 'randomIdle', 'enabled'], checked)
          }
        />
        <Toggle
          label="按聊天与行为配动作"
          checked={pet.animation.semantic.enabled}
          disabled={!pet.enabled || pet.appearance.reducedMotion}
          onChange={(checked) =>
            s.update(['worlds', 'pet', 'animation', 'semantic', 'enabled'], checked)
          }
        />
        <Toggle
          label="允许桌宠走动"
          checked={movement.enabled}
          onChange={(checked) => s.update(['worlds', 'pet', 'movement', 'enabled'], checked)}
        />
        <Toggle
          label="偶尔随机走动"
          checked={movement.randomRoam.enabled}
          disabled={!movement.enabled || pet.appearance.reducedMotion}
          onChange={(checked) =>
            s.update(['worlds', 'pet', 'movement', 'randomRoam', 'enabled'], checked)
          }
        />
        <div className="grid-2">
          <Field label="模型自主移动前静止（秒）">
            <input
              className="input"
              type="number"
              min={5}
              max={1800}
              value={seconds(movement.minIdleMs)}
              disabled={!movement.enabled || pet.appearance.reducedMotion}
              onChange={(event) =>
                s.update(
                  ['worlds', 'pet', 'movement', 'minIdleMs'],
                  Math.max(5, Math.round(Number(event.target.value) || 5)) * 1000
                )
              }
            />
          </Field>
          <Field label="模型自主走动最短间隔（分钟）">
            <input
              className="input"
              type="number"
              min={1}
              max={720}
              value={minutes(movement.autonomousMinIntervalMs)}
              disabled={!movement.enabled || pet.appearance.reducedMotion}
              onChange={(event) =>
                s.update(
                  ['worlds', 'pet', 'movement', 'autonomousMinIntervalMs'],
                  Math.max(1, Math.round(Number(event.target.value) || 1)) * 60_000
                )
              }
            />
          </Field>
        </div>
        <Toggle
          label="打开面板时停止移动"
          checked={movement.pauseWithPanel}
          onChange={(checked) =>
            s.update(['worlds', 'pet', 'movement', 'pauseWithPanel'], checked)
          }
        />
        <Toggle
          label="只留在当前显示器"
          checked={pet.confineToScreen}
          onChange={(checked) => s.update(['worlds', 'pet', 'confineToScreen'], checked)}
        />
        <div className="row-gap">
          <Button onClick={() => void s.petCommand('reset')}>桌宠归位</Button>
          <Button onClick={() => void s.petCommand('settings')}>打开桌宠参数面板</Button>
        </div>
      </Section>

      <Section title="安静时段">
        <div className="row-gap">
          <Field label="从" inline>
            <input
              className="input"
              type="time"
              value={s.config.worlds.activity.quietHours[0]}
              onChange={(event) =>
                s.update(
                  ['worlds', 'activity', 'quietHours'],
                  [event.target.value, s.config.worlds.activity.quietHours[1]]
                )
              }
            />
          </Field>
          <Field label="到" inline>
            <input
              className="input"
              type="time"
              value={s.config.worlds.activity.quietHours[1]}
              onChange={(event) =>
                s.update(
                  ['worlds', 'activity', 'quietHours'],
                  [s.config.worlds.activity.quietHours[0], event.target.value]
                )
              }
            />
          </Field>
        </div>
      </Section>
    </div>
  )
}
