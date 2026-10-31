import '../renderer/chat/styles.css'
import './app.css'
import { boot, showFatal } from './boot'

void boot().catch((error: unknown) => showFatal(error))
