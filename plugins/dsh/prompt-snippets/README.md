# prompt-snippets · 提示词库

把常用提示词收进一个库：聊天里 `/snippet` 命令族，UI 里右侧边栏「提示词」面板。

## 用法

```bash
/snippet                          # 列出全部
/snippet save review 请审查这段代码的正确性与边界情况   # 新建/更新
/snippet review                   # 把「review」的正文作为消息送入当前会话
/snippet rm review                # 删除
```

UI（右侧边栏 → 提示词 Tab）：列表 + 预览，**插入 / 删除**按钮，底部表单直接新建。
所有 UI 动作都走主机命令执行，UI 本身无状态。

## 存储

`~/.dsh/snippets/snippets.json`（可在 patch 里改 `root`）：

```json
{
  "version": 1,
  "snippets": {
    "review": { "body": "请审查这段代码……", "updatedAt": 1726800000000 }
  }
}
```

- 原子写（tmp + rename）+ 进程内串行化，不会写坏；
- 名称限 `^[A-Za-z0-9_-]{1,32}$`，正文默认截断 4000 字符，默认最多 100 条；
- 纯 JSON，可手改、可进 git、可跨机器同步。

## 安装

```bash
dsh plugin --profile web add file:/Users/xinshi/Documents/deepseek/work/dshworkspace/plugins/prompt-snippets
```

## 配置

```yaml
- id: prompt-snippets
  config:
    root: '~/.dsh/snippets'
    maxSnippets: 100
    maxBodyChars: 4000
```

## 测试

```bash
cd plugins/prompt-snippets && node --test   # 7 项：解析/序列化/增删/上限/路径
```
