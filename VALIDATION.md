# 2026-10-12 发布验证

## 2026-11-10 面板作答/排队/项目输出 + 收尾

- 面板：目标决定可在面板选 A/B 并自动续跑（A 加预算重启新一轮，B 标记已停止）；忙碌时改排队；可填授权项目目录，完成后把产物复制过去；长任务显示里程碑进度。
- 运行组件 71 项测试；面板 31 项测试；门禁 PASS。
- 协作窗口修复：App 原来加载 `/codex-collab/window`（Windows 主控台页），改为 `/api/codex-bridge/window`（Mac 目标页）；应用标题改为「信使协作」，附 build.sh。
- 通知：`osascript display notification` 退出码 0；证据索引脚本 `scripts/evidence-index.py` 生成 `.work/xinshi/evidence-index.md`。
- 面板实测：发布到项目目录成功（liveD）；忙碌排队 E/F 成功；A/B 作答成功；草稿 required_keys/artifact 与 checks 对齐（提交 b6b646a）。

- 边界：聊天本身与 DSH/Codex/Hermes 的 token 未解析；Windows、Kimi、Claude 未验证；真断点续跑与 OS 级隔离未做；项目输出只复制最终产物，不做任意文件编辑。

## 2026-11-09 xinshi 3.1.4 mac.6 + v4 目标循环

- 协作运行器 63 项测试通过（goal loop / hybrid judge / OpenCode + DSH executor / quota / panel 契约）。
- 面板 31 项测试通过；`/codex-collab/control` 返回 goals；「目标」标签与决定展示已部署 desktop profile 并验证。
- 发布门禁 PASS；mac.6 推送 `d798f4e`；面板进 main `66443fd`；备份分支长期保留。
- 真实模型：OpenCode 免费模型两轮 reject→pass（18.452s / 10852 tok），未唤醒用户。
- 验收证据默认只存本机 `.work/`（acceptance/、journal/），报告与决定包带路径，不随分支发布。
- 边界：agent judge 未做大样本误判对比；DSH 执行器只做契约测试，未跑真实端到端；面板 UI 需重载后人工确认。

- 12组Node组件测试：270通过、0失败、4个宿主条件测试跳过；Plan Map真实MCP初始化、资源和本机HTTP保护测试通过。
- Workspace隔离验证：10项迁移/回滚/索引检查，28项任务/产物/适配检查通过。
- hatch-pet在临时Python环境安装Pillow后，28项单元测试通过；未使用付费图像调用。
- 84份JS/MJS语法检查、35份Python解析通过。
- UI旧builder在临时profile构建出5个包；没有部署到真实DSH。
- 发布文件检查未发现匹配的提供商/GitHub密钥或私钥，也未包含.env、聊天数据库/队列等运行状态；此模式检查不等于通用安全审计。

范围：源码、离线测试与隔离构建。不代表所有AI/目标设备已安装、真实GUI已重载或模型对话效果已验证。Master Plan草稿单独保留，不宣称可运行。

## 2026-10-15 Plan Map 0.6.0 / DSH 0.1.1

- Codex 适配器本机 `node --test "acceptance/*.test.js"` 23/23 通过：存储与并发写入、真实 MCP 初始化与工具发现、内嵌视图、视口适配、计划解析、历史与宿主待办桥接。
- DSH 插件 `node --test` 56/56 通过，含 `tool/ptc-dispatch` 事件折叠。
- 范围未变：测试通过不等于目标设备已重连宿主；v8 内嵌实显、真实 `update_plan` 事件与自动维护端到端仍未验收。

## 2026-10-19 xinshi 3.0.0-trial.2

- DSH 技能目录显示 `xinshi`；Codex CLI（`codex exec`）会话内技能列表包含 `xinshi`（22 项，含 plan-map、knowledge-vault）。
- CodeBuddy/WorkBuddy/Box/Kimi 的目录已改名并写入指针，但未做会话内加载确认。
- 安装脚本：Windows 临时目录试装通过；bash 脚本只做 `bash -n` 语法检查，未在 macOS 实跑。

## 2026-10-19 xinshi 3.0.0-trial.1

- 技能文件与入口指针改名完成；DSH 技能目录已热加载为 `xinshi`（旧名不再出现在目录里）。
- 本机检查范围：文件、JSON/脚本语法、入口指针指向正本；各宿主的「发现→加载→真实任务」仍按宿主单独验收，不因改名完成而宣称全部生效。
- 旧 `integrations/xinshiimprove` 与各宿主旧入口停用；旧名只保留在历史证据与备份路径。

## 2026-10-16 xinshiimprove 2.0.0-trial.3

- 仓库只做文件快照与入口一致性检查（SKILL.md 版本、references 齐全、宿主指针仍指向正本）。
- DSH 侧运行时采纳已单独验证；其他 harness 的运行时采纳、真实跨 harness 主控交接与关闭聊天后的持久调度均未验收。


## 2026-10-13 Plan Map 0.4.0

本机适配源与仓库快照均11/11通过：宽度适配、缩放上下限、纵向滚动高度、嵌入偏好恢复、状态更新保留滚动、手动展开不被接管、MCP初始化、v6资源与v3/v4/v5兼容读取、存储回归。已检查DSH提供的425px/360px截图；截图是该适配器页面的证据，不等于重连后的宿主实显验收。
