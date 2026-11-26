# 普通 Agent 怎样接续任务与长对话

一次模型回复结束，不一定等于一项工作已经交付。DeepWriter 分开保存两件事：这次任务的步骤，以及下次模型调用还需要的对话原文。

| 源码参考 | 对 DeepWriter 的具体影响 |
| --- | --- |
| [ZCode：会话待办的读取与更新](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/tool/handlers/todo.ts) | 在工具执行处写进度，而不从聊天文字猜测。DeepWriter 按任务隔离，避免同一会话中的另一个任务改写它。 |
| [DeepSeek Harness：todo 快照](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/todo/tool-todo/src/index.ts)；[Pi：todo 扩展示例](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/coding-agent/examples/extensions/todo.ts) | 采用完整快照替换和工具回执回放。失败更新不影响上一份有效清单；桌面、终端和进程重启后都从同一组回执读取。 |
| [DeepSeek Harness：上下文压缩](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/compaction/compaction-basic/src/summarizer.ts)；[Pi：上下文压缩](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/coding-agent/src/core/compaction/compaction.ts) | 使用可恢复的记忆检查点，并保留近期完整对话。这里抽取带来源与顺序的原话，不再发一次费用不透明的总结请求。 |
| [Pi：同批工具调度](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/agent/src/agent-loop.ts#L592-L659) | 将执行与结果顺序分开，只对独立、无需交互的本地文本读取开放并发；写入和命令是串行分界。 |
| [DeepSeek Harness：精确编辑](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/fs/fs-local/src/fsio.ts#L849-L868)；[Pi：编辑匹配](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/coding-agent/src/core/tools/edit-diff.ts#L244-L293) | 对文学稿件，近似匹配只用来找回原句。重试时仍以准确原文写入，以免更改作者有意保留的标点或字形。 |

### 哪些内容会留到下一轮？

单个会话检查点最多保存 192 段原话，每段最多 640 个 UTF-16 代码单元。最终记忆最多使用剩余输入预算的 40%，上限 4,096 估算 token。没有选中的摘录仍在本地会话原文中，可由已有检索找回。打开一项旧运行使用的是它启动时冻结的历史位置。

工具调用和结果成对保留。独立的成功清单更新被下一份替换时，较早的纯记账往返不再重复发送；持久化记录不删。清单不能充当写盘、核对或取得授权的证明。
