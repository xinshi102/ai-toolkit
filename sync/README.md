# 按需同步：已有脚本与其他设备

其他设备上的AI先读 [根README](../README.md)，识别系统、宿主和需求，再选择Skill、插件或MCP。`capabilities.json`是能力目录，`targets.json`是本机Skill目标清单。

## 当前脚本覆盖范围

`targets.json`目前登记原Mac的 `xinshiimprove` 与 `knowledge-vault`，不覆盖全部组件。`scripts/sync-skills.sh` 只同步已登记Skill内容/习惯文件，不拉取GitHub，不安装依赖，不注册MCP，不部署DSH插件，不启动AI，不向其他设备推送。

需要Bash、Python 3及diff/cmp/cp等命令。Windows先确认合适的Bash环境；没有时使用本机工具完成同样的比较、备份、更新。

## 其他设备的使用流程

1. 克隆仓库，或检查本机改动后 `git pull --ff-only`；记录提交号。
2. 确认所选Skill的本机安装目录。首次安装需按宿主规则创建并部署。
3. 在本机仓库副本修改 `sync/targets.json`，只登记本次组件/目标。填写真实绝对路径，不照搬Mac路径或未展开的 `~`。
4. 先 `--check`，审阅差异和本机定制；需要更新时才 `--apply`。
5. 验证真实宿主发现/加载，记录备份和提交号；设备目标清单不要自动推送上游。

脚本固定读取 `sync/targets.json`，没有 `--manifest` 参数。目标不存在只报告缺失，不完成首次安装。

```sh
bash scripts/sync-skills.sh --check --component xinshiimprove
bash scripts/sync-skills.sh --apply --component xinshiimprove
```

不指定组件会处理清单中全部目标，运行前必须核对清单。

## 更新和恢复

- `full-copy`：备份现有目录到 `.sync-backups/` 后替换整个Skill目录；本机修改先合并。
- `pointer`：只检查宿主的 `SKILL.md` 是否仍是指向正本的指针；不复制正文、不覆盖。`xinshiimprove` 2.0.0 起已无 `share/`，原先的 `shared-rules` 目标改为此类型。
- `habits`的 `format: copy`：备份后替换指定文件，先确认文件属于更新范围。
- `habits`的 `format: append`：只报告需要审阅，不自动编辑。
- 来源/目标缺失或类型不支持时报告问题，不按已同步记录。

失败后按输出的备份路径恢复此次改变的目标，复查宿主加载。备份和同步记录留在本机。插件与MCP必须按组件说明和本机宿主机制更新，不能用Skill复制脚本替代安装验证。
