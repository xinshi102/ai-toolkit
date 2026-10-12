# DeepSeek 任务通知（macOS）

订阅宿主 `session/event`，在确实执行过步骤的一轮任务完成、报错、阻塞或达到 token 限制时发送通知。默认显示桌面右下角的浮动卡片，切换软件后也可见，12 秒后自动消失；卡片有关闭和查看 DeepSeek 按钮。主动停止、空轮次不会提醒；通知仅包含通用状态，不包含对话内容或文件路径。

## 使用

- `/notify status`：查看插件开关与系统权限。
- `/notify on`、`/notify off`：开启或关闭任务提醒，保存到 `~/.dsh/notifications/settings.json`。
- `/notify permission`：请求系统通知权限；被系统拒绝后需在系统设置里开启。
- `/notify settings`：打开系统通知设置，找到“DeepSeek 通知”。
- `/notify test`：发送一条测试通知。

安装版本 0.2.0 另支持 `/notify desktop|system|both` 切换桌面卡片、系统通知或两者。当前正在运行的旧插件无需重启：原生组件兼容旧调用，会按保存的 desktop 选择显示新卡片；新增的方式切换命令在宿主下一次自然加载新版代码后可用。当前 on/off/status/test 已实际运行验证，默认 desktop 已保存。

系统列表中的“DeepSeek 通知”是独立原生组件；不会修改官方 DeepSeek Harness 应用。桌面卡片不依赖系统通知授权；系统通知方式仍受专注模式与系统横幅设置影响。浮动卡片位于主显示器可用区域的右下角，不抢夺输入焦点。

## 本机安装

原生组件：`/Users/xinshi/Applications/DeepSeek Notifications.app`，bundle ID 为 `com.xinshi.deepseek-notifications`。Swift 源码位于 `native/Notify.swift`；使用 AppKit 与 UserNotifications 编译，组件需要带同一 bundle ID 的 Info.plist 并签名注册。安装文件保留在本机，其他电脑需要各自安装、各自授权。当前组件仅支持 macOS。

桌面 profile 已安装本目录的包，并通过 `cordis.patch.yml` 中的 `insert` 激活，不写入由官方插件管理器维护的 bundles。可用 `helper` 指定组件可执行文件位置，`stateFile` 指定开关文件。

卸载时先移除 desktop profile 中 id 为 `task-notifications` 的 insert 行，再移除该依赖。仅关闭提醒使用 `/notify off` 即可。修改前的 profile 备份位于工作区 `backups/task-notifications-20261010/`。

## 验证

`node --test test/notifications.test.js` 检查终止状态、关闭开关、去重、通知隐私与组件失败隔离。原生 `--status` 检查授权；`--delivered` 检查系统已送达记录。`queued: true` 仅表示系统接受请求，不独立证明横幅已显示。
