# DSH Web GUI 增强包（皮肤 / 插件开关 / 插件市场）

让 DeepSeek Harness 网页版更像桌面软件，并加装三个实用性插件。
**全部通过右下角「插件坞」交互**：🎨 切换皮肤 ｜ 🧩 插件开关 ｜ 🛍️ 插件市场。

## 已安装组件

| 组件 | 说明 | 状态 |
|---|---|---|
| `@local/dsh-ui-skins` | 皮肤系统：macOS桌面 / 默认 / 暗夜玻璃 / 极简 / 自定义CSS | ✅ 已激活 |
| `@local/dsh-ui-toggles` | 插件开关：按钮式热插拔（关=卸载，开=热重载即开即用） | ✅ 已激活 |
| `@local/dsh-ui-market` | 插件市场：游戏开发/小说写作/视频创作分类目录 | ✅ 已激活 |
| 技能包 ×3 | `game-dev` / `novel-writing` / `video-creation`（~/.dsh/skills/） | ✅ 已激活 |

## 皮肤（🎨）

- **macOS 桌面**（默认）：毛玻璃标题栏 + 红绿灯窗口按钮 + SF Pro 字体栈
- **默认**：官方外观
- **暗夜玻璃**：毛玻璃卡片 + 渐变霓虹，深色主题下最佳
- **极简**：去装饰，内容优先
- **自定义**：粘贴自己的 CSS（localStorage 持久化）
- 选择即时生效、持久化；独立窗口（PWA/`--app`）下自动适配系统标题栏

## 插件开关（🧩）

- 列出所有客户端插件，按钮式开/关
- **热插拔**：关闭=拆卸组件+移除样式；开启=热重载重新挂载（即开即用）
- 每个插件另有「⟳」独立热重载按钮
- 关闭状态存 localStorage（`dsh-plugin-disabled`），刷新后自动恢复
- 核心组件带 ⚠️ 标记，关闭前需确认

## 插件市场（🛍️）

- 按领域浏览：游戏开发 / 小说写作 / 视频创作 / 效率工具
- 每张卡片：功能说明 + 状态徽章（已内置/需安装/技能包）+ 复制安装命令
- 已安装状态实时读取插件清单

## 文件位置

- 插件源码：`~/.dsh/profiles/web/plugins/dsh-ui-{skins,toggles,market}/`
- 链接：`~/.dsh/profiles/web/node_modules/@local/`（symlink）
- 配置行：`~/.dsh/profiles/web/cordis.patch.yml`（`ui-skins`/`ui-toggles`/`ui-market`）
- 构建脚本：本目录 `build-deploy.js`（改源码后重跑即可重新部署）
- 皮肤源码：本目录 `dsh-ui-skins.js`；插件体：`plugins/{toggles,market}/plugin-body.js`

## 部署机制（双层）

1. **前端 dist 引导**（立即生效）：`dsh-web-frontend/dist/index.html` 注入
   `<script src="/assets/dsh-ui-skins.js?v=1">`，manifest 为 `standalone`。
   浏览器刷新即生效；dsh 升级后需重新应用（用 `apply-dist.sh` 或手动）。
2. **正式客户端插件**（官方机制，重启后生效）：三个 `@local/*` 包进入启动图，
   由 client-modules 扫描 `dsh.client` 声明后从 `/plugins/<id>/client.js` 提供。

两套皮肤机制幂等互斥（`window.dshSkins` 守卫），不会重复应用。

## 如何撤销 / 临时关闭

- **临时关皮肤**：控制台 `localStorage.setItem('dsh-skins','off')` 后刷新
- **移除插件**：删除 `cordis.patch.yml` 中对应 `insert` 行 + `plugins/` 目录 + `web/node_modules/@local` 链接
- **还原官方外观**：删除 dist `index.html` 中的脚本行（`dsh-ui-skins`）

## 版本更新记录

- 2026-08-21：dsh 0.1.0-rc.6 → **0.1.1-rc.2**（npm 全局 + profile 符号链接农场重建 + dist 重新应用）
