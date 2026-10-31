import { useSettings } from '../context'
import { Button, Field, Section, Toggle } from '../ui'

/** 终端、自启动与桌宠维护。 */
export function SystemSettingsTab(): React.JSX.Element {
  const s = useSettings()

  return (
    <div className="stack">
      <Section id="terminal" title="终端">
        <Toggle
          label="启用终端"
          checked={s.config.worlds.terminal.enabled}
          onChange={(checked) => s.update(['worlds', 'terminal', 'enabled'], checked)}
        />
        <Field label="Shell">
          <select
            className="input"
            value={s.config.worlds.terminal.shell}
            onChange={(event) => s.update(['worlds', 'terminal', 'shell'], event.target.value)}
          >
            <option value="cmd.exe">cmd.exe</option>
            <option value="powershell.exe">powershell.exe</option>
          </select>
        </Field>
        <Field label="允许的终端命令前缀" hint="每行一个；空列表表示一律需要人工确认。">
          <textarea
            className="input textarea"
            rows={4}
            placeholder={'git status\nnpm test'}
            value={s.config.autonomy.terminalAllowlist.join('\n')}
            onChange={(event) =>
              s.update(
                ['autonomy', 'terminalAllowlist'],
                event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line !== '')
              )
            }
          />
        </Field>
      </Section>

      <Section title="启动与暂停">
        <Toggle
          label="开机自动启动"
          checked={s.boot.autoLaunch}
          onChange={(checked) => void s.setAutoLaunch(checked)}
        />
        <Toggle
          label="暂停对话总线"
          checked={s.boot.agentPaused}
          onChange={(checked) => void s.setAgentPaused(checked)}
        />
      </Section>

      <Section title="桌宠页面维护">
        <div className="row-gap">
          <Button onClick={() => void s.petCommand('reset')}>归位</Button>
          <Button onClick={() => void s.petCommand('refresh')}>刷新页面</Button>
          <Button onClick={() => void s.petCommand('settings')}>打开桌宠参数</Button>
          <Button variant="danger" onClick={() => void s.resetPetSettings()}>
            重置桌宠设置
          </Button>
        </div>
      </Section>
    </div>
  )
}
