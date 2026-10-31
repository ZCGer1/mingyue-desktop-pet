import { useEffect } from 'react'
import { BilibiliSettings } from '../../components/BilibiliSettings'
import { useSettings } from '../../context'

/** B 站子页：状态轮询只在本子页挂载期间运行。 */
export function BilibiliSection(): React.JSX.Element {
  const s = useSettings()
  const load = s.loadDiscovery
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load])

  return <BilibiliSettings discovery={s.discovery} onRefresh={load} />
}
