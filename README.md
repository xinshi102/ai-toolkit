# AI Toolkit：个人 AI 工具的统一来源

仓库：<https://github.com/xinshi102/ai-toolkit>

这里集中维护 Xinshi 的 Skill、DSH 插件、MCP 和管理工具。其他设备上的 AI 根据当前任务和本机环境，选择需要的组件，再完成安装、适配、更新与验证。

**给接手同步的 AI：先读本页，再读 [能力清单](CAPABILITIES.md) 或 [机器可读目录](capabilities.json)，最后只读选中组件的说明。不要默认安装全部内容。**

## 1. 识别本机与任务

确认用户需要解决的问题、已有能力，以及本机的系统（macOS / Windows / Linux）、AI宿主及版本（Codex / DSH / Hermes / OpenCode / 网页聊天）、文件与安装权限、实际Skill目录、插件/MCP接口和Node.js/Python等依赖。

先检查已有同名组件和本机定制。路径、命令和接口以本机配置、宿主帮助和组件说明为准。仓库中的 `/Users/xinshi/...` 是原Mac示例，不是其他设备的安装位置；不要照搬端口、代理、知识库或应用路径。

仅有网页聊天或无法访问本机时，报告限制并提供适配方案，不声称已安装。登录同一账号不代表另一台设备自动拥有本地工具。

## 2. 根据需求选择组件

| 需求 | 优先查看 | 本机条件 |
|---|---|---|
| 通用协作、项目接手 | [xinshi（信使）](skills/xinshi/SKILL.md) | 保留宿主入口和项目规则 |
| 小说规划、写作、审阅 | [novel-writing](skills/novel-writing/SKILL.md) | 有相应创作材料 |
| 知识库与个人笔记 | [knowledge-vault](skills/knowledge-vault/SKILL.md)、[obsidian-knowledge-base](skills/obsidian-knowledge-base/SKILL.md)、[personal-note-capture](skills/personal-note-capture/SKILL.md) | 本机解析知识库位置，不从GitHub取得私人笔记 |
| 日常报告、网页、表格 | [daily-office-work](skills/daily-office-work/SKILL.md) | 结合宿主已有文档/表格工具 |
| 视觉设计、图片、宠物素材 | [visual-director](skills/visual-director/SKILL.md)、[generate-images-with-comfyui](skills/generate-images-with-comfyui/SKILL.md)、[hatch-pet](skills/hatch-pet/SKILL.md) | 另行确认ComfyUI、模型、Hermes脚本、Pillow及图像宿主能力 |
| 监督Hermes执行 | [supervise-hermes](skills/supervise-hermes/SKILL.md) | 需本机隔离Worker，复制Skill不等于可调度 |
| 持久计划与导图 | [Plan Map](plan-map/README.md) | DSH用插件版，Codex用Skill/MCP版；其他宿主先确认MCP与UI支持 |
| DSH搜索、上下文、通知、管理 | [DSH插件清单](CAPABILITIES.md)与 `plugins/dsh/<组件>/` | 对应DSH版本和插件接口，密钥本机单独配置 |
| 多AI桥接 | [codex-bridge](plugins/dsh/codex-bridge/README.md)、[opencode-bridge MCP](mcp/opencode-bridge/README.md) | 可运行的本机桥服务与明确授权的会话 |
| 工作区与产物治理 | [ai-workspace-manager](skills/ai-workspace-manager/SKILL.md)、[管理工具](tools/workspace-manager/README.md) | 为目标设备建立自己的目录与状态 |

为选中组件说明为什么需要、装到哪里、依赖是什么、怎样验证。同一需求有多个实现时，优先使用本机已有、兼容且改动最少的方案，不必全部安装。

## 3. 获取或更新源码

首次在用户选定的源码位置执行：

```sh
git clone https://github.com/xinshi102/ai-toolkit.git
cd ai-toolkit
git rev-parse HEAD
```

已有仓库时，先检查 `git status --short` 与 `git remote -v`。确认来源正确、无未处理的本机改动后，使用 `git pull --ff-only`，再记录 `git rev-parse HEAD` 的提交号。有修改或分支分歧时先保留并判断如何合并，不强制重置或盲目覆盖。

**更新源码和更新已经安装的组件是两个步骤。** 默认按本次需求更新，不建立定时拉取或自动推送。

## 4. 按类型部署

### Skill

阅读所选 `SKILL.md` 与必要引用。按当前宿主支持的目录安装整个组件，包括 `references/`、`scripts/`、`agents/`、`assets/` 等配套内容，不只复制正文。已有同名版本先备份和比较，保留用户修改、本机路径与宿主专用入口。

`xinshi`（信使；2.0 时叫 `xinshiimprove`）正文即 `SKILL.md` + `references/`，不再有 `share/` 共享库；各宿主的 `SKILL.md` 可以是指向正本的指针文件，不要用Codex入口整份覆盖DSH、Hermes或OpenCode入口。发现外部依赖缺失时先补齐或标记待适配，不宣称复制文件即可运行。

### DSH 插件

阅读所选组件的README、`package.json` 和 `cordis.patch.yml`。核查DSH版本、主机/客户端注入接口、依赖与注册方式，在隔离位置安装依赖并测试，再备份本机配置、按宿主机制部署。不要同时在bundle和patch重复激活。

重载或重启遵循已有授权并注意正在运行的任务。macOS通知、Swift原生窗口、AppleScript在Windows/Linux需替代实现。`ui-enhancements/build-deploy.js` 是会写入指定profile的旧部署器，不是通用同步工具；确认目标与改动范围后才运行。

### MCP

MCP可位于 `mcp/`，也可与插件/Skill共处一个组件，例如 `plan-map/codex/`。先确认宿主支持的传输与接口，安装该组件声明的依赖。有对应npm锁文件时可用 `npm ci --ignore-scripts`；依赖确需安装脚本时，查明用途后再执行。

用本机可用运行时和实际绝对路径注册服务，不复制另一台设备的MCP配置。验证初始化、工具发现与安全的只读调用；UI显示、消息投递另行验证。工具可见不等于所有效果已验收。私密材料传输、付费调用和消息发送仍受具体用户授权约束。

### 平台适配与草稿

Workspace管理工具当前按Mac工作区布局实现；其他系统先检查文件锁、目录、应用启动等差异。[Master Plan草稿](experimental/dsh-master-plan/README.md)缺少完整安装与验证，不作为已完成插件部署。

组件不兼容时记录原因，继续处理其他兼容组件；不要为凑齐数量重建整台设备的工具环境。仓库的Mac验证结果不替代目标设备验证。

## 5. 已有同步脚本的适用范围

[`sync/targets.json`](sync/targets.json)目前只登记原Mac的 `xinshi` 和 `knowledge-vault` 安装位置，不是全部28个组件的跨设备安装器。

[`scripts/sync-skills.sh`](scripts/sync-skills.sh)需要Bash、Python与相关命令，固定读取本机仓库副本的 `sync/targets.json`。运行前改为本机实际绝对路径，只登记准备管理的组件；脚本不展开 `~`，目标必须已存在。首次安装、依赖安装、插件部署与MCP注册需要分别完成。

```sh
bash scripts/sync-skills.sh --check --component xinshi
# 核对差异、目标和备份方案后，再执行更新：
bash scripts/sync-skills.sh --apply --component xinshi
```

`full-copy` 会备份后替换整个目标目录，有本机改动先合并；`pointer` 只核对宿主 `SKILL.md` 是否仍指向正本，不改正文。Windows没有合适Bash环境时，用本机工具执行同样的比较、备份、复制流程。详情见 [同步说明](sync/README.md)。

## 6. 验证、留档与回滚

按用户已经授权的范围执行同步，不为每个普通文件重复确认；超出范围、覆盖无法合并的定制或缺少关键权限时才停止说明。

验证所选组件的文件、引用、依赖与相关测试，并在真实宿主确认Skill发现、插件加载或MCP工具调用。不能完成的检查标记未验证，不把文件存在当成安装成功。

在本机记录日期、系统/宿主版本、源提交号、所选组件、目标路径、本机适配、备份位置、验证结果与未完成项，不记录密钥。更新失败时停用此次新增注册或恢复备份，复查原功能；不要删除聊天、知识库和其他工具数据。再次同步先比较提交与本机差异，避免重复安装或丢失适配。

## 7. 数据与上游边界

同步方向默认是GitHub源码到本机。不上传本机私人资料，不自动推送到上游。聊天、笔记、Registry、桥接队列、凭据、模型和应用二进制由本机配置和保管，不在此仓库中。

不要为同步读取、打印或复制凭据值；只检查必要变量是否存在，必要时仅由运行进程使用。保留第三方许可证和来源说明。本仓库是Xinshi的个人上游，未经明确授权不从其他设备提交/推送；其他人的改造使用自己的fork。

完整目录见 [CAPABILITIES.md](CAPABILITIES.md)，发布验证范围见 [VALIDATION.md](VALIDATION.md)。
