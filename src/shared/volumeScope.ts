/**
 * 主进程卷清单的只读视图（可安全进入设置页与诊断）。
 *
 * 这里只描述卷身份、挂载路径、可用性和排除原因，不包含文件内容。
 * 服务本身在 `src/worlds/files/volumes.ts`；渲染进程只使用这些类型。
 */

export type VolumeKind = 'fixed' | 'removable' | 'optical' | 'network' | 'unknown'

export type VolumeExclusionReason =
  /** 卷当前未挂载、介质缺失或主机断开。 */
  | 'offline'
  /** 卷已挂载，但当前账户读不了（Windows 拒绝访问或 ACL 限制）。 */
  | 'no-permission'
  /** 卷存在但没有可用的挂载路径。 */
  | 'no-mount'
  /** 枚举本身失败；不能回退成系统盘。 */
  | 'enumeration-failed'

/**
 * 这个卷为什么出现在范围描述里。授权来源与可用性分开：
 * 一个卷可以“已授权但因为离线暂不可读”，设置页仍要能说清原因。
 */
export type VolumeAuthorizationSource =
  /** 用户选择「全部已挂载磁盘」，该卷（包括系统盘）由卷清单自动纳入。 */
  | 'all-volumes'
  /** 用户选择「全部非系统盘」，该卷由卷清单自动纳入。 */
  | 'non-system-volume'
  /** 工作区、笔记、信任目录、files 目录或自由探索显式读取目录落在该卷。 */
  | 'explicit-read-root'
  /** 她的作品/下载目录落在该卷（与笔记目录一起是显式例外）。 */
  | 'artifact-root'

export interface VolumeEntryView {
  /** 稳定卷身份：卷 GUID、网络共享的 UNC 路径；盘符只是挂载路径。 */
  id: string
  kind: VolumeKind
  label: string
  fileSystem: string
  /** 可能包含多个挂载点（盘符与目录挂载）。 */
  mounts: string[]
  /** 网络卷的远端共享路径（`\\server\share`）；其他卷为 null。 */
  remote: string | null
  /** 该卷包含实际 Windows 系统目录；只是身份，不再自动等于“排除”。 */
  system: boolean
  available: boolean
  /** 当前账户实际可读；与是否被某个范围模式授权无关。 */
  readable: boolean
  /** 多个挂载点中只有一部分可读；仅用于状态展示。 */
  partialReadable?: boolean
  /** 为空表示卷本身可用；模式授权另看 authorizationSource。 */
  exclusion: VolumeExclusionReason | null
  /** 授权来源与普通读取范围同源；为空表示当前没有任何范围包含它。 */
  authorizationSource: VolumeAuthorizationSource | null
}

export interface VolumeScopeView {
  platform: string
  systemRoot: string
  status: 'pending' | 'ok' | 'failed' | 'unsupported'
  enumeratedAt: number
  /** 每次真实刷新递增；执行时用它判断范围描述是否过期。 */
  version: number
  error: string | null
  entries: VolumeEntryView[]
  summary: {
    total: number
    /** 当前可读卷数（含系统卷，与授权模式无关）。 */
    readable: number
    /** 包含 Windows 系统目录的卷数。 */
    system: number
    /** 离线、无权限或无挂载点的卷数。 */
    unavailable: number
  }
}
