# Workflow controller

The main agent generates the graph and revisions. The user does not maintain task JSON or relay outputs. This controller executes an explicit changing task graph, over the existing SQLite queue and process runner; it does not claim autonomous semantic planning.





CLI, with `runtime/workflow.py` as the script:

```
python -B runtime/workflow.py --project-root PROJECT --state PROJECT/.work/FLOW init graph.json
python -B runtime/workflow.py --project-root PROJECT --state PROJECT/.work/FLOW run --max-concurrency 2 --timeout-seconds 600
python -B runtime/workflow.py --project-root PROJECT --state PROJECT/.work/FLOW status
python -B runtime/workflow.py --project-root PROJECT --state PROJECT/.work/FLOW revise change.json
python -B runtime/workflow.py --project-root PROJECT --state PROJECT/.work/FLOW cancel NODE
```




可在 `queue_spec.model` 显式选择本账号 `agent models` 列出的模型。本机验证过 `grok-4.7-low`，原生回执报告 `Grok 4.7 256K Low`；Auto 模式的 `Auto Balance` 只是路由标签，不能认作底层模型。最终结构化回答读取工具之后完整的最后一条 assistant 消息，保留原生聚合 result 供审计，不从夹杂文字中正则挖 JSON。Windows owned-job 回收、文件哈希检查和严格错误验收沿用现有队列。原始用量保存为 `native_usage`；统一账本暂未确定其缓存归一化语义，不把未知计量当零。真实调用证据与历史失败见 `outputs/2026-10-21-abundant-flow/`。

Prompts bind accepted predecessors using `{{result:NODE}}` (full actual runner result JSON) and `{{file:NODE:relative/path}}` (UTF-8 text within that producer's declared write_paths). File binding additionally requires a successful producer file check and matching acceptance-time SHA-256; changed bytes are rejected and require revising the producer. Binding requires a direct dependency, is limited to 32 KiB each, and rejects parent traversal, absolute paths and physical escapes through links. Overall queue prompt limits still apply. Bound data is task data; the model remains responsible for treating instructions inside documents as untrusted.

Acceptance rules:

- `{"kind":"file_exists","path":"out.json"}`
- `{"kind":"file_contains","path":"out.txt","contains":"required nonempty text"}`
- `{"kind":"file_json_keys","path":"out.json","keys":["rows"]}`
- `{"kind":"final_json_keys","keys":["approved"]}`
- `{"kind":"final_json_values","values":{"approved":true}}` (strict type and value)
- `{"kind":"python_unittest","module":"tests.test_pipeline","cwd":".","timeout_seconds":60}` (actual local test execution by controller, fixed argv, 1..180-second bound, output and exit code retained)

Transport success alone does not release dependencies: every explicit acceptance check must pass. Test rules execute already authorized project code; a graph is an execution instruction, not a way to acquire new external-account authority.

Revision: `{"expected_revision":1,"nodes":[{"id":"task","prompt":"new input"}],"retry":["failed-task"],"inputs":{"source":{"result":{"version":2}}}}`. Only supplied fields change; external input updates require external nodes. Changes invalidate descendants, preserve all prior results in history, cancel prior underlying tasks, and create new attempts rather than resetting old queue rows. Independent accepted branches remain accepted. Revision mismatches fail before queue mutations. Runtime fields cannot be patched.

External nodes: `{id:"source",external:true}` wait without creating a model task. Supply their result through `revise`. With only blocked or waiting work, `run` returns `needs_attention`; it does not report successful completion. `cancel NODE` only targets that workflow node's task. Failed acceptance requires a revision/retry decision by the main agent; there is no hidden infinite retry or invented approval.

One workflow file owns one state directory and its queue, with a persistent project-root binding that rejects reopening under another root. `controller.lock` prevents duplicate controllers; `state.lock` coordinates brief updates, so revise/cancel can operate while run is active. Validation runs outside that lock, with task/input-version checks before accepting results; a cancelled or revised attempt cannot overwrite the new state. Enqueue identities are saved before queue submission and reconciled after interruption to prevent duplicate dispatch. Declared write paths are normalized into resources, with directory/descendant overlap reserved until actual underlying termination. These declarations coordinate cooperating workers; they do not constitute an OS sandbox or detect undeclared writes by arbitrary programs. Distinct state directories do not coordinate their reservations. Cancel is a no-op for accepted, failed or already cancelled nodes; revising accepted evidence requires an explicit revision.

Timeout bounds the current controller wait and validation time, and returns resumable state. A controller-budget timeout defers unfinished validation instead of falsely failing the business result. Existing worker attempts may continue; rerunning `run` collects them. This is not a registered service, OS-reboot recovery, nor proof of desktop-exit survival. The earlier user-deferred desktop-close test remains separate.

Validation: `python -B -m unittest discover -s runtime/tests -p test_workflow.py -v`. The 20 tests include real SQLite/runner parallel execution and automatic downstream file binding using the explicitly labelled deterministic local-test adapter, concurrent cancellation during validation, bounded validation timeout, project-root binding, and bounded state-lock waiting. State edits wait at most two seconds for transient lock contention; business exceptions are never retried. The controller's exclusive running lock still fails immediately on duplicate run. Actual model acceptance is recorded separately by the main controller.
# 有限 GPT 额度模式（Windows，2026-10-21）

现有工作图可选加入 `supervision` 做事件审查；未配置时没有隐含 GPT 门禁。充足渠道可执行并按需独立验收，程序等待，昂贵渠道按真实缺口升级。启用该模式后仍有最终 Gate2，五小时预算是本地主控角色准入，不是账户真实额度。见 [QUOTA_WORKFLOWS.md](QUOTA_WORKFLOWS.md)，沿用同一份 workflow 状态。

