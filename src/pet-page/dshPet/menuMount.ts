import type {
  MenuBranch,
  MenuLeaf,
  MenuNode
} from '../../shared/dshPet/menu'

/**
 * DOM 侧右键菜单挂载（级联子菜单）。
 *
 * 菜单结构与文案在 `shared/dshPet/menu.ts`（纯数据，主进程也可安全引用）；
 * 这里只负责把树渲染到 document.body，并使用视口坐标定位。放在 pet-page
 * 目录下，避免 Node 侧的类型检查把 DOM 全局带进主进程。
 */

export interface ContextMenuMount {
  /** 已挂载的根元素（document.body 下） */
  el: HTMLElement
  /** 关闭并清理（幂等） */
  close: () => void
}

function isBranchNode(node: MenuNode): node is MenuBranch {
  return 'children' in node && Array.isArray((node as MenuBranch).children)
}

/**
 * 挂载系统风格右键菜单（级联子菜单）到 document.body。
 * 位置为视口坐标；级联面板平级挂载，指针整体离开菜单树 200ms 后关闭。
 */
export function mountContextMenu(opts: {
  tree: MenuNode[]
  x: number
  y: number
  onAction: (leaf: MenuLeaf) => void
  onClose?: () => void
  /** 菜单允许占用的矩形（视口局部坐标）；缺省 = 整个视口。 */
  clamp?: { x: number; y: number; w: number; h: number }
}): ContextMenuMount {
  const { tree, x, y, onAction, onClose, clamp } = opts
  const c =
    clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h)
      ? clamp
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
  const root = document.createElement('div')
  root.className = 'dsh-pet-menu'
  root.style.left = '0px'
  root.style.top = '0px'
  root.addEventListener('contextmenu', (event) => event.preventDefault())

  let closed = false
  const openChild = new Map<HTMLElement, HTMLElement>()
  let leaveTimer: number | null = null

  const hideChain = (panel: HTMLElement): void => {
    panel.style.display = 'none'
    const child = openChild.get(panel)
    if (child) {
      openChild.delete(panel)
      hideChain(child)
    }
  }

  const showPanel = (panel: HTMLElement, item: HTMLElement): void => {
    const rect = item.getBoundingClientRect()
    panel.style.left = ''
    panel.style.top = ''
    panel.style.display = 'block'
    let left = rect.right + 4
    if (left + panel.offsetWidth > c.x + c.w - 4) left = rect.left - panel.offsetWidth - 4
    left = Math.max(c.x + 4, left)
    let top = rect.top
    if (top + panel.offsetHeight > c.y + c.h - 4) {
      top = Math.max(c.y + 4, c.y + c.h - 4 - panel.offsetHeight)
    }
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
  }

  const buildPanel = (nodes: MenuNode[]): HTMLElement => {
    const panel = document.createElement('div')
    panel.className = 'dsh-pet-menu-column'
    panel.style.display = 'none'
    if (clamp) panel.style.maxHeight = `${Math.min(460, Math.max(120, c.h - 16))}px`
    root.appendChild(panel)
    for (const node of nodes) {
      const item = document.createElement('div')
      item.className = 'dsh-pet-menu-item'
      if (isBranchNode(node)) {
        const label = document.createElement('span')
        label.textContent = node.label
        const arrow = document.createElement('span')
        arrow.className = 'dsh-pet-menu-arrow'
        arrow.textContent = '▸'
        item.appendChild(label)
        item.appendChild(arrow)
        const childPanel = buildPanel(node.children)
        item.addEventListener('mouseenter', () => {
          const prev = openChild.get(panel)
          if (prev && prev !== childPanel) hideChain(prev)
          openChild.set(panel, childPanel)
          showPanel(childPanel, item)
        })
      } else {
        const label = document.createElement('span')
        label.textContent = node.label
        item.appendChild(label)
        if (node.hint) {
          const hint = document.createElement('span')
          hint.className = 'dsh-pet-menu-hint'
          hint.textContent = node.hint
          item.appendChild(hint)
        }
        item.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          close()
          onAction(node)
        })
      }
      panel.appendChild(item)
    }
    return panel
  }

  const rootPanel = buildPanel(tree)
  rootPanel.style.display = 'block'
  document.body.appendChild(root)

  const rw = rootPanel.offsetWidth
  const rh = rootPanel.offsetHeight
  rootPanel.style.left = `${Math.max(c.x + 4, Math.min(x, c.x + c.w - rw - 4))}px`
  rootPanel.style.top = `${Math.max(c.y + 4, Math.min(y, c.y + c.h - rh - 4))}px`

  root.addEventListener('mouseleave', () => {
    if (leaveTimer !== null) window.clearTimeout(leaveTimer)
    leaveTimer = window.setTimeout(() => {
      leaveTimer = null
      close()
    }, 200)
  })
  root.addEventListener('mouseover', () => {
    if (leaveTimer !== null) {
      window.clearTimeout(leaveTimer)
      leaveTimer = null
    }
  })

  const onDocPointerDown = (event: MouseEvent): void => {
    if (closed) return
    if (root.contains(event.target as Node)) return
    close()
  }
  const onDocKeyDown = (event: KeyboardEvent): void => {
    if (closed) return
    if (event.key === 'Escape') close()
  }
  document.addEventListener('mousedown', onDocPointerDown, true)
  document.addEventListener('keydown', onDocKeyDown, true)

  const close = (): void => {
    if (closed) return
    closed = true
    if (leaveTimer !== null) window.clearTimeout(leaveTimer)
    leaveTimer = null
    document.removeEventListener('mousedown', onDocPointerDown, true)
    document.removeEventListener('keydown', onDocKeyDown, true)
    root.remove()
    onClose?.()
  }

  return { el: root, close }
}
