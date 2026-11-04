# 安装和跨设备接入

## 同一技能，不同设备配置
把整个 knowledge-vault 文件夹安装到客户端官方支持或本机已验证的技能目录，保持 SKILL.md 和相对资源路径完整。客户端没有原生 skill 时，在其支持的用户/项目规则入口引用 SKILL.md；有相关问题时读取技能。不要改活动会话数据库。

安装 helper：`python scripts/install.py --target <客户端技能根目录>`。它只安装本技能；已有完全相同版本时不重复写入，有差异时拒绝覆盖并要求先核对。更新时审阅差异后使用客户端支持的更新方法。可安装副本是客户端加载包，不是知识库或项目源码副本。

每台设备用普通 JSON 配置 `~/.config/knowledge-vault/config.json`：
```json
{"vault_path": "/this-device/existing-vault"}
```
或设置 KNOWLEDGE_VAULT_PATH；特定设备可设置 KNOWLEDGE_VAULT_CONFIG 指向自己的配置。配置不放入公开技能仓库。路径使用该设备自己的目录；Windows 与 macOS/Linux 的路径不必一致。

定位检查：`python scripts/resolve_vault.py`。有多个库时返回候选，不自动任选；有配置但目录失效时报错。无库时可以 `python scripts/resolve_vault.py --create-temp --workspace <获准工作目录>`，生成最小临时库，不安装 Obsidian、不改已有库。

## 客户端接入
- 原生技能客户端：将安装位置核实后传给 installer；在新对话/技能列表验证 knowledge-vault 可用，实际执行一次只读查询。
- 无原生技能客户端：将“遇到工作问题或完成排查时读取 knowledge-vault/SKILL.md，按其规则查询和沉淀”加入支持的规则入口；路径为本机绝对路径或项目内相对路径。
- 网页/云端 AI：上传或引用技能包，提供允许访问的知识库文件或连接器；没有可用文件写入能力时只生成待入库内容。不能宣称已经改了本地库。
- 手机与其他设备：安装技能并配置本设备库路径；若 AI 不能访问 Obsidian 目录，使用可授权的连接器或导出相关 Markdown，不要求共享账号或凭据。

## 与笔记同步的区别
GitHub 工具仓库发布的是技能、模板和辅助脚本。知识库笔记同步沿用用户已选方案；没有选定方案时说明技能已安装而笔记未同步，不自动公开笔记、创建远程库或购买同步服务。

## 验收
安装文件存在 → 客户端能发现/读到 → 定位到正确库 → 查询命中条目 → 写入和索引维护通过，逐项记录。其他设备没有实际访问与测试时只报告“安装包可用，设备接入待验证”。

Obsidian 下载：https://obsidian.md/download
已有 Markdown 文件夹作为库打开：https://help.obsidian.md/Files+and+folders/Manage+vaults

## 日常使用（1.0.1）
直接说「帮我看看这个问题怎么解决」或「看知识库内有没有类似问题」即可，不需要输入技能名。明确查库时先查库；司内问题通常优先参考内部经验；SVN 等通用工具按正常方式排查，知识库作为可选补充。更新后在对应客户端新对话或刷新目录中核实生效。
