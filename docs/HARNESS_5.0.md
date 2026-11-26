# DeepWriter 5：谁决定下一步？

一次请求有最大输出长度，一项工作则可能需要几十次请求。5.0 将这两件事分开：服务商负责执行模型协议，用户决定整项任务有没有预算，Agent 根据工具结果和用户补充决定下一步。

### 从单次输出限制中继续

[ZCode 的输出续接实现](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/methods/turn-output-token-continuation.ts#L37-L68) 区分输出被截断和工具回合，[对应的控制流测试](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/tests/runtime-output-token-continuation-control-flow.test.ts) 涵盖取消和持久化的顺序。DeepWriter 采用显式区分，但不沿用固定三次续答。只要模型继续给出新正文，就从断处续写；旧段保留在最终答复中。较长的连续片段只把尾部带回下一次请求。没有收到完整参数的工具不会执行。

### 把补充要求送到真正能生效的时点

[DeepSeek Harness 的运行循环](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/core/agent-loop/src/agent.ts) 将助手消息保存、处理工具和后续步骤分开。[Pi 的循环](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/agent/src/agent-loop.ts) 在执行边界接续用户输入。DeepWriter 的补充要求归属于一个任务；进入下一次模型请求前，按顺序写成真正的用户消息。既不把人说的话包装成工具响应，也不取消正在执行的操作来腾出一个输入位置。

### 让选项可找到，不让它变成默认门槛

[Pi 的设置选择器](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/coding-agent/src/modes/interactive/components/settings-selector.ts) 将当前值放在选择入口，点进去再调整。DeepWriter 在“完成与预算”里显示是否设置了运行限制，不预填五个看似必填的数字。明确设置的金额和币种，在同一次运行和恢复中有效。模型原生上下文和单次最大输出属于服务商协议，不冒充用户设定的总预算。

[DeepSeek Harness 的请求参数构造](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/core/agent-loop/src/agent.ts#L611-L622) 将调用方有没有提供最大输出与具体的单次请求绑定。DeepWriter 同样区分：为上下文保留空间是一项本地计算，不表示作者想在传给服务商的参数中设一个上限。

[4.1 的任务清单、会话记忆和并发读取设计](HARNESS_4.1.md)
