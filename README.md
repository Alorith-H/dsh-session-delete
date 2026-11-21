# dsh-session-delete

[![test](https://github.com/Alorith-H/dsh-session-delete/actions/workflows/test.yml/badge.svg)](https://github.com/Alorith-H/dsh-session-delete/actions/workflows/test.yml)

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 的会话菜单补一个真正可用的 **删除会话**。

DSH 原生只提供**归档**：会话日志会一直留在磁盘上（`<DSH_HOME>/sessions/<项目键>/<会话 ID>/session.v4.jsonl.zstd`），任何界面都没有删除入口，连 ACP 层的 `session/delete` 也没有接上（`dsh-acp` 明确声明不支持删除）。本插件补上这一步，并顺手把归档/置顶记录里的陈旧 ID 清掉。

> DSH ships **archive only** — a conversation's JSONL log accumulates on disk forever and no UI (nor the ACP layer) can remove it. This plugin adds a real delete row to a Session's `...` menu: the log directory is removed, the Session is detached from its Workspace, and stale archive/pin ids are cleaned up.

---

## 使用 / Usage

1. 左侧会话列表 → 把鼠标移到目标会话上 → 点行尾的 `…`。
2. 菜单最后多出一行红色的 **删除会话**（英文 *Delete session*）。
3. 点一下，这一行变成 **再次点击确认删除**，并提示「会话日志会从磁盘移除，无法恢复」。6 秒内再点一次才真正执行；点别处、超时或打开别的菜单都会自动解除。
4. 成功之后：磁盘日志目录被移除，侧栏那一行也消失。失败时原因显示在菜单行内，不弹原生对话框（桌面版 `dsh-app://` 页面上的模态对话框不可靠）。

各状态：

| 状态 | 这一行显示 | 说明 |
| --- | --- | --- |
| idle | `删除会话` | 红色，排在「复制 Session ID」之后 |
| confirm | `再次点击确认删除` + 提示行 | 6 秒窗口，再点一次才算确认 |
| busy | `正在删除…` | 期间禁用点击 |
| error | 红色错误行（`role="alert"`） | 例如「这个会话正在运行，请先停止当前回合再删除。」 |

> 失败行只在菜单还开着的时候可见（指针离开菜单，菜单就会卸载）。删除成功时菜单自行关闭，失败时保持打开并显示原因。

## 它到底删了什么

一次删除按固定顺序执行，任何一步被拒绝都不会留下半删状态：

1. **拒绝运行中的会话** —— 只有「还有没结束的回合」才拒绝。停在某个会话上「正在查看」**不**影响删除（这是最常见的情况，所以特意区分了这两种状态）。
2. **先让它离开内存** —— 侧栏的一行来自 Host 内存里的 live session，而不只是磁盘日志：`session.list` 会把「内存里有、磁盘上没日志」的会话当成待落盘的会话继续列出来。所以先把该会话从内存 store 里摘掉（`entry.detach()`，并让剔除前的 flush 先写完），再动文件；否则会出现「日志删了、行还在，而且永远删不掉」的僵尸行。
3. **删磁盘日志** —— 移除 `<会话根目录>/<项目键>/<会话 ID>/`。项目键与目录名复刻 `dsh-session-persistence-jsonl` 的 `~XXXX` 转义规则，删的一定是后端自己写的那一份。cwd 未知时回退到 `_no-cwd/`，再回退到受上限的项目目录扫描；目标路径永远被限制在根目录内，根目录本身永不删除。磁盘上已经没有这个会话时**不算失败**（第 2 步已经解决了那一行）。
4. **清投影缓存** —— 删掉 `storages/session_projcache/sessions/<会话 ID>.json`。这是 Host 为了少读日志写的派生记录（标题、token 统计），属于派生物，删不掉也不影响正确性。
5. **从工作区摘掉** —— 调用该工作区记录的 `detachSession(sessionId)` 把 ID 从 `sessionIds` 去掉，侧栏通过 Workspace 的 follow 流自动消行。
6. **清理归档 / 置顶** —— 若该 ID 还在 `archivedSessionIds` / `pinnedSessionIds` 里，一并清掉，不留指向已删文件的陈旧记录。

删除是**不可恢复**的：插件不做回收站、不做备份。想保留就先复制那个目录。

## 1.1.0：为什么曾经「点了没反应」

1.0.0 只删磁盘上的日志目录。可是 DSH 的侧栏同时列**内存里还活着的会话**（见上面第 2 步）：日志早已被删掉的会话仍然活在内核里，于是行一直在，而每次再点删除都「成功」返回（`removed: []`）——用户看到的就是「点了没反应，会话还在列表里」。1.1.0 修的就是这一步：现在会把 live session 先摘出内存 store，因此这种「日志已经没了」的僵尸行也能删掉。

## 安装 / Install

需要已安装 DSH（桌面版或带 Web 前端的版本）。本包是一个 Harness bundle：Host 半端注册一条受保护的 HTTP 路由，浏览器半端往会话菜单里注册一行。

```bash
git clone https://github.com/Alorith-H/dsh-session-delete.git
```

然后在 DSH 里用插件管理器安装该目录（绝对路径）：

```
plugin_manager install_bundle   target = C:\path\to\dsh-session-delete
```

或用「插件」页面从本地目录安装。装上之后：

- `client.js` 改动：**刷新页面**即生效；
- `index.js`（Host 半端）改动：在插件管理器里**关掉再打开**该插件即可热重载（插件是 `link:` 安装的，会重新导入磁盘上的文件），不必重启 DSH。旧版本也可以直接重启 DSH。

卸载：插件页面移除 `dsh-session-delete` 即可，已经删掉的会话不会回来。

## 实现 / How it works

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半端。`export function apply(ctx)` 注册一条 `POST /dsh-session-delete/delete` 路由；`deleteSession(ctx, sessionId)` 是唯一实现（校验 → 删文件 → 摘账 → 清理归档/置顶）。路由先过宿主自己的 `connection.requestRejection(request)`（Host/Origin 栅栏 + 浏览器登录态），只接受 `application/json`，请求体上限 16 KiB，会话 ID 必须先过 `/^[A-Za-z0-9._:-]{1,200}$/`。 |
| `client.js` | 浏览器半端。通过 `window.__ModuleLoader__.load()` 注册 `sidebar.workspaces.session.menu.item` 一行（id `delete-session`，order 500），自己实现两段式确认，`fetch POST` 到 Host 路由，失败就地显示。只依赖 `slots`、`locale` 两个 Client 服务，不 require 其它 Harness Client 包。 |
| `locale/{zh,en}.json` | 插件管理器里显示的名称与说明。 |
| `cordis.patch.yml` | 把本包插入宿主组合（`- insert:` / id / name / config）。 |
| `test/run.mjs` | Host 逻辑的离线测试：假会话根目录 + 假 ctx，不碰真实数据。 |

设计取舍：**删除操作只实现一次**（Host 的 `deleteSession`），UI 只是它的一个调用方；将来想加 Agent 工具或命令面板入口，复用的还是同一个函数。

## 测试 / Tests

```bash
npm test        # 或 node test/run.mjs
```

用临时目录伪造会话根，覆盖 37 项检查：cwd 路径删除、扫描回退、`_no-cwd` 回退、运行中/回合中拒绝且文件与账目不受伤、空闲但打开着的会话可删、live session 先 flush 再脱桩、**日志已丢的僵尸会话仍可删**、投影缓存文档被清、`detachEntered` 回退路径、归档与置顶清理、`../../etc/passwd` 被转义成单个段名、根目录删不掉、`projectKey` 分隔符折叠与 255 字符上限。

## 已知边界 / Known limits

- 删除**不**清理 `attachments/` 等会话之外的内容（DSH 的附件按全局目录存放）。
- subagent / fork 出来的子会话不会跟着父会话一起删，需要单独删。
- 该会话正被别的进程写入时返回「会话文件正被占用」，切换会话后重试。
- 侧栏行消失依赖 Workspace follow 流；宿主版本没推送时刷新页面即可。
- 插件依赖 DSH 的私有 Host 服务（`webServer`、`workspaceRegistry`、`sessionPersistence`、`sessions`、`agents`、`connection`）——DSH 升级后如果这些接口变了，插件需要同步更新。

## License

[MIT](LICENSE)
