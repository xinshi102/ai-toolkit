# session-guard — 会话日志写入守卫

> 一句话：**任何本地插件都别再想写坏会话日志**。写入前比对宿主自己的事件词表，
> 未知事件类型直接 fail-closed，日志永远可读、DSH 永远能重启。

## 它解决什么问题

DSH 的 `session.append(type, data)` **不做词汇校验**，但宿主**读回**会话日志时会走
`dsh-session-persistence` 的 `validateStoredEvents`：

```
session "<id>" contains event type "<type>" (seq N) unknown to this harness
and not marked ignorable; refusing to interpret the log
```

即：**未知事件类型 + 没有 `ignorable: true` ⇒ 整份日志拒读**。后果有两个：

1. 那个会话从此在历史里**打不开**（本次实际踩雷：`plan/node`、`chain/note`、`chain/nudge`）；
2. 如果它落在启动/列表要读的日志上，会**拖累 DSH 启动/重启**。

而插件的 `append(type, data, ...opts)` 的 opts 只承载 `surfaceOp` / `sourceEventSeqs`
—— **插件根本没有渠道**给事件信封加 `ignorable`（见 `dsh-session` 的 `append` 实现）。
所以"写自定义事件类型"对插件来说是无解的坏路，唯一的正确做法是别写。

## 它怎么防

1. **运行时 fail-closed（本插件）**：在 `session/created` 上给每个真实 `Session` 实例
   包一层 `append`；写入前把类型和**宿主自己的** `KNOWN_SESSION_EVENT_TYPES`
   （从应用内 `@deepseek-ai/dsh-session` 导入，与宿主同一份词表）比对。
   未知类型 ⇒ 抛错阻止写入，坏事件**根本进不了日志**。
   - 插件晚加载 / 热重载时，用 `ctx.sessions.store` 把**已经活着**的会话补挂上。
   - `/session-guard` 命令随时报告状态：已守卫几个会话、拦截几次、宿主词表多少个类型。
2. **静态审计（`scripts/verify.mjs` 第 ⑥ 步）**：扫描所有插件 `lib/` 下的
   `session.append(...)`，第一个参数不是宿主词表内的字符串字面量 ⇒ 自检失败。
   注释里的示例、非 session 接收者（如 `other.append(...)`）不会误报。

## 为什么它自己不会成为新的故障源

这道守卫如果在生产里崩了，后果比它要防的 bug 更严重，所以：

| 风险 | 处理 |
|---|---|
| `SessionStore.announce()` **不隔离** `session/created` 监听器异常（抛出会回滚会话 attach） | 监听器内部整体 try/catch，**永不抛**（有单测逐个喂 null/42/hostile getter/冻结对象） |
| 定位不到宿主词表（换机器、换应用路径） | 自动降级为「只告警」模式，**不阻断任何写入**，并写一条 warn |
| 守卫自身判定抛异常 | 判定处 try/catch，异常一律放行原调用 |
| 实例被冻结/密封，装不上包装 | 安全 no-op，返回空 disposer，不抛 |
| 重复安装（热重载） | `Symbol.for` 幂等标记，只包一层；disposer 可完整还原原型方法 |
| 异步 `apply` 被宿主拒绝 | cordis 会把插件 fiber 回收并记日志（不会崩应用）；既然不会 reject，正常场景不会走到 |
| **词表读错应用/读成旧版本**（2026-09-26 实际踩雷） | 候选路径**全部从 `process.resourcesPath` 派生**，只认正在运行的宿主；不再有写死的 `/Applications/...` 兜底。定位不到⇒只告警，宁可不守也不用别人的词表阻断 |

### 事故复盘：误伤宿主自己的 `developer/message`（2026-09-26）

- 现象：官方桌面版里每轮都弹 `session-guard 拒绝写入：事件类型 "developer/message" 不在宿主事件词表内`。
- 真因：宿主 0.1.7-rc.2 的 agent loop 在**工具集变化**时会 `session.append("developer/message", …)`
  （见 asar 内 bundle）——这是宿主自己的合法写入。而守卫当时把词表路径兜底成社区版
  `DSH Desktop.app`（0.1.5-rc.2，词表里没有这个类型），于是**用另一个安装的旧词表**把宿主拦了。
- 为什么没被自检拦住：`scripts/verify.mjs` 的词表加载同样写死了那个路径，读不到就
  **静默 skip**（"无法判定 append 类型，请在有 DSH Desktop 的机器上跑"），第 ⑦ 步的对拍等于没跑。
- 修法：候选路径锚定当前宿主 + `/session-guard` 报告词表来源文件 + 补 5 项回归断言
  （含"候选里不得出现写死的应用路径"、`developer/message` 必须放行）。

## 安装 / 配置

```bash
cd /Users/xinshi/Documents/deepseek/work/dshworkspace
node scripts/dump-profile.mjs desktop | grep session-guard   # 确认合成树里有这一行
```

`cordis.patch.yml` 默认配置：

```yaml
- insert:
    - id: session-guard
      name: '@local/dsh-session-guard'
      config:
        enforce: true      # false = 只告警不阻断（排查兼容性时用）
        # appDir: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'  # 显式指定宿主目录
```

宿主词表定位优先级：`config.appDir` → `config.candidates`（直接钉死模块路径）→
`DSH_DESKTOP_APP` → `process.resourcesPath` 下的三种布局（`app.asar/dsh` →
`app.asar` → `app`）。

**不设任何写死的 `/Applications/...` 兜底**（2026-09-26 的故障根因）：曾经兜底到社区版
`DSH Desktop.app` 的 app 目录，官方桌面版（宿主在 `app.asar` 内、`resourcesPath/app` 不存在）
于是静默用了**另一个安装**的旧词表（0.1.5-rc.2），把宿主 0.1.7-rc.2 自己合法写的
`developer/message` 当成未知类型拦住，每轮都报一次错。现在：词表只能来自当前宿主，
定位不到就降级为「只告警」，绝不用别的应用/别的版本的词表 fail-closed。
`/session-guard` 会一并报告词表来源文件，便于一眼看穿「读错了模块」。

**一键停用**（推荐，别删 bundle 行）：

```yaml
- id: session-guard
  disabled: true
```

## 自检

```bash
# ⚠️ Node 22 的 `--test <目录>` 会把目录当模块加载（MODULE_NOT_FOUND）：要显式给测试文件
node --test plugins/session-guard/test/*.test.js   # 31 项（纯 node 下 4 项真机用例自动 skip；在宿主运行时下则全跑）
node scripts/verify.mjs                            # 含第 ⑥ 步写入审计 + 第 ⑦ 步守卫安全性对拍
```

## 已修好的历史日志

`node scripts/repair-session-log.mjs --apply`（默认 dry-run）。它给已写坏的日志做**最小改写**
（未知事件补 `ignorable: true`、缺 id 的 `user/message` 补 uuid），不改 seq、不删事件、
不动 surface，并逐帧原地重压（宿主 `assertIndependentHeaderFrame` 要求第一帧恰好只含 header 行）。
写完用宿主两道读取闸门 + 物理布局自检，任一不过就回滚。
