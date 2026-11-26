# v1.2.2 叙事状态与发布门说明

## 能力边界

长文运行现在把叙事状态绑定到可迁移的 `story_id / project_id / branch_id` scope。`run_id` 只作为本次执行和证据的 provenance；同一 session 的新 run 可以显式选择上一条已提交 story revision 作为 parent。提交后 scope head 的 revision 与 high-watermark 会写入 scene manifest，编辑旧 revision 必须创建显式 branch，无法安全判断 parent 或 head 时 fail-closed。

这不是“自然语言六类状态抽取已经可靠”的承诺。产品能力是结构化事实注册、状态 delta、scene/manifest 绑定、版本化 provenance 和可审计证据；只有带明确 beat/JSON 或已注册事实引用的输入才会进入相应结构化路径。普通自由文本的角色、知识、物品、关系、时间线、伏笔识别仍是保守的部分能力，证据不足会进入 pending review/waiting_user，不会伪造完整状态。

## Ledger 迁移与并发语义

- schema v23 新增 `story_ledger_heads`、`story_ledger_runs`、`story_ledger_revisions`。迁移会把旧 `narrative_commits` 按提交顺序导入确定性的 scope；旧 run 的 `run_id` 保留在 revision provenance，不作为跨 run 主键。
- branch 首次提交记录 parent branch/revision，并继承 parent revision 可见的 ledger；同 branch 只接受当前 head，陈旧 parent 或游标不匹配会拒绝提交。
- revision 保存 delta、scene manifest、各自 hash 与 revision hash。提交和 head/cursor 更新在同一事务内；重启通过持久表读回，不从内存或当前设置猜测。

## 发布门与回归

`release:candidate:fast` 已包含下列首方检查：

- `p1-provider-tool-stream`
- `p1-3-scene-contract-semantics`
- `p1-c-scope-scene-manifest`
- `p1-4-story-ledger`
- `p2-completion-combo`
- `r60`

其中 `p1-4-story-ledger` 覆盖同 session 三 run “交钥匙 → 询问持有人 → 归还”、显式分支、陈旧 parent、并发 head 冲突和重启读回。`p2-completion-combo` 覆盖精确事故组合：accepted 已达到目标、required beat 仍 unresolved、Provider 分别返回空串或元话术；最多两次有界场景修复后必须进入 `waiting_user`，污染不能进入正式正文。

可复现命令：

```text
npm run typecheck
npm run p1-4-story-ledger
npm run p2-completion-combo
npm run release:candidate:fast
```
