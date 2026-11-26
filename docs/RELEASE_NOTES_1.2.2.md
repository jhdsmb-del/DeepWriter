# DeepWriter v1.2.2

v1.2.2 是 Windows x64 正式稳定版，重点是把长文运行和发布验收中的边界问题落到可追溯的状态上。

## 这版修了什么

- **v1.2.0 runaway 修复**：长文续写受完成契约、调用次数、费用、墙钟和 Token 预算约束，不再无界运行。
- **accepted 正文污染**：文末 meta、refusal、JSON 等控制性尾部不会混入 accepted 正文；扫描有字节/行数上限，异常时拒绝接受。
- **accepted scope**：accepted 只来自当前 run、当前场景和明确的正文范围，越界或证据不足时不接受。
- **production narrative delta**：生产链路对正文、检查、修订和最终接受的 narrative delta 保留来源与校验结果，避免只凭模型输出宣告完成。
- **工具参数 delta**：OpenAI-compatible 及相关协议的工具参数按各自的 delta / snapshot 语义合并；合法的重复片段不再丢字，协议冲突会显式失败。
- **方向性事件**：交给、归还、借给等事件按 agent、source、recipient 等角色记录物品持有人；证据不足时进入待确认，不再猜测第一个出场角色。
- **人工仲裁闭环**：语义检查遇到无法自动判定的结果会进入人工复核；决定、依据和后续状态均可追踪，不静默放行。
- **跨 run story ledger**：故事事实、角色和场景状态通过跨 run ledger 延续，并保留来源、版本和冲突信息。
- **真实 Token 硬预算**：请求发送前按实际请求体、消息和最大输出预留 Token；每次内部重试独立预留，重启恢复未结预留，缺少 usage 按保守上界结算，重复结算幂等且不超发。

## 发布形式

- `DeepWriter-1.2.2-x64-setup.exe`：NSIS 安装版。
- `DeepWriter-1.2.2-x64-portable.exe`：portable 免安装版。

安装包未配置商业代码签名，Windows 可能显示 SmartScreen 提示。模型服务、费用和上下文能力仍取决于你配置的 Provider。
