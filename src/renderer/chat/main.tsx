import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('root element missing')

if (window.mingyue === undefined) {
  const message = document.createElement('div')
  message.className = 'boot-error'
  message.textContent = '聊天窗初始化失败：预加载桥不可用。请重启应用。'
  container.appendChild(message)
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
