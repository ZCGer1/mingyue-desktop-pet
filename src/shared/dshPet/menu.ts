/**
 * 右键动作菜单（移植自上游 `src/shared/menu.ts`，锁定 commit 2fa04a51）。
 *
 * 移植差异：
 *  - 去掉浏览器/DSH 宿主专属的「显示位置」「更多/第三方插件」菜单；
 *  - 一级菜单增加本应用真实存在的入口（对话、快捷输入、设置、回初始位置）；
 *  - 保留上游的「动作 → 分类 → 动画名」结构与同一套级联面板渲染/定位逻辑；
 *  - 类型收紧到本项目 Animations/ Category，不依赖上游 PetDisplay。
 *
 * 菜单数据单一事实来源 = 校验后的动画目录。
 */

import type { Animations, Category } from './types'

/** 本应用的菜单动作；不进入模型上下文。 */
export type PetMenuAction =
  | 'chat'
  | 'quick-input'
  | 'settings'
  | 'home'
  | 'refresh'
  | 'hide'
  | 'animation'

/** 叶子：可点击的菜单项 */
export interface MenuLeaf {
  label: string
  /** 点播的动画名；`action === 'animation'` 时必填。 */
  anim?: string
  action?: PetMenuAction
  /** 项目右侧的灰色小字（纯视觉提示）。 */
  hint?: string
}

/** 分支：带子菜单的项 */
export interface MenuBranch {
  label: string
  children: MenuNode[]
}

export type MenuNode = MenuLeaf | MenuBranch

/** 事件名 → 分类标签（无映射时用事件名本身） */
const EVENT_LABELS: Record<string, string> = {
  balance: '余额档位',
  whisper: '碎碎念',
  workStatus: '工作状态'
}

const leaf = (anim: string): MenuLeaf => ({
  label: anim,
  anim,
  action: 'animation'
})

/**
 * 由动画目录推导「动作」分支：分类（待机/转向/拖拽/点击回应/移动 + 随机分类 +
 * 事件档位）→ 具体动画名。空池/空分类自动省略。
 */
export function buildActionBranch(animations: Animations): MenuBranch | null {
  const groups: MenuNode[] = []
  const pools: Array<[string, string[]]> = [
    ['待机', animations.idle],
    ['转向', animations.turn],
    ['拖拽', animations.drag],
    ['点击回应', animations.clicks],
    ['移动', animations.moves.actions.map((move) => move.name)]
  ]
  for (const [label, pool] of pools) {
    if (pool.length) groups.push({ label, children: pool.map(leaf) })
  }
  for (const category of animations.categories ?? []) {
    if (category.actions.length) {
      groups.push({ label: category.id, children: category.actions.map(leaf) })
    }
  }
  const events = animations.events ?? {}
  for (const key of Object.keys(events)) {
    const names: string[] = []
    for (const slot of events[key] ?? []) {
      if (typeof slot === 'string') names.push(slot)
      else names.push(...slot)
    }
    if (names.length) {
      groups.push({ label: EVENT_LABELS[key] ?? key, children: names.map(leaf) })
    }
  }
  return groups.length ? { label: '动作', children: groups } : null
}

/**
 * 完整右键菜单：本应用工具项（真实可用才注入）+ 上游动作分类。
 * `quickInput` 为 false 时不显示快捷输入入口。
 */
export function buildPetMenu(
  animations: Animations,
  opts: { quickInput: boolean }
): MenuNode[] {
  const nodes: MenuNode[] = [
    { label: '对话', action: 'chat' },
    ...(opts.quickInput ? [{ label: '快捷输入', action: 'quick-input' } satisfies MenuLeaf] : []),
    { label: '回到初始位置', action: 'home' },
    { label: '设置', action: 'settings' },
    { label: '重新载入桌宠', action: 'refresh', hint: 'F5' }
  ]
  const actions = buildActionBranch(animations)
  if (actions !== null) nodes.push(actions)
  return nodes
}

/** 该动画是否属于 noMirror 分类（文字类）：朝右（镜像）时点播前强制朝左，避免文字镜像。 */
export function isNoMirrorAnimation(categories: Category[], anim: string): boolean {
  return (categories ?? []).some(
    (category) => category.noMirror === true && category.actions.includes(anim)
  )
}

/** 菜单样式（与上游桌面菜单一致；面板各自独立滚动，绝不嵌套）。 */
export const MENU_CSS = [
  '.dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2b2b;font-size:13px;line-height:1.5;',
  "font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
  '.dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}',
  '.dsh-pet-menu-column{position:absolute;min-width:150px;max-width:300px;padding:4px;',
  'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;',
  'box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto;',
  'scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}',
  '.dsh-pet-menu-column::-webkit-scrollbar{width:8px;height:8px}',
  '.dsh-pet-menu-column::-webkit-scrollbar-track{background:transparent}',
  '.dsh-pet-menu-column::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:4px;',
  'border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-column::-webkit-scrollbar-thumb:hover{background:rgba(43,99,255,.4);',
  'border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-column::-webkit-scrollbar-corner{background:transparent}',
  '.dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;',
  'gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}',
  '.dsh-pet-menu-item:hover{background:rgba(43,99,255,.14)}',
  '.dsh-pet-menu-item>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-pet-menu-hint{color:#9aa0a6;font-size:12px;flex:none;white-space:nowrap}',
  '.dsh-pet-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}'
].join('')
