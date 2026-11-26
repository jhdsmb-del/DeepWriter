# DeepWriter 3.3.1

查阅多个来源时，Agent 不再因为累计到第 16 次 Provider 调用就停下来。搜索、读网页和后续模型回复仍逐次计入本次任务的用量。

不需要在新任务中填写一个很大的数字来放开次数。若你主动设置了次数、金额或 token 预算，Agent 仍按设置执行；也可以随时停止任务。

旧任务已在 16 次处暂停？在任务的「详情 → 活动」中点 **解除调用次数限制并继续**。CLI 可用 `deepwriter resume RUN --max-calls unlimited`。原任务的用量不清零。

[桌面使用说明](QUICKSTART.md) · [终端使用说明](CLI.md)
