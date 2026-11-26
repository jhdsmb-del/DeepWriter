# DeepWriter v1.2.3 Beta

> Windows x64 · Beta candidate · 待独立验收

v1.2.3 是面向下一轮独立验收的 Beta 候选，不是稳定版，也不宣告 RC、released 或 1.0。它集中收敛了中文叙事语义、人工复核、故事记忆撤回和发布门的几个边界问题。

## 本轮修复

### 中文事件组：按谓词和局部角色判定

- 增加覆盖“把、被、连动、兼语、省主语、倒装、否定、计划、传闻、回忆、梦境”的中文最小对立语料。
- 交接、给予、借出等事件必须有明确的转移谓词与局部角色证据；普通处置式、否定、计划、传闻和回忆不会仅因出现“把/给”等字样就被当成已完成的交接。
- 这组语料是回归护栏，不等同于中文理解能力的完整质量证明；真实模型质量仍需真实基准和人工评审。

### 权威复核生命周期

- 场景语义复核由主进程返回带 hash 的权威快照，包含 `decisionStatus`、`runStatus`、`phase`、终态和是否需要下一步。
- Renderer 不再根据按钮结果自行猜测运行状态；接受、保留 unknown、要求重写和放弃都必须经过主进程的同一生命周期入口。
- 每个 run 以 owner、版本和 CAS 条件保护，重启后继续使用同一复核快照，避免重复决策、越权决策或把“复核中”误显示为“已完成”。

### 窄范围 `accept_unknown` 与 CAS

- `accept_unknown` 只用于“正文可以接受，但某个角色绑定或事件接收方仍无法确定”的窄场景。
- 缺少结构化 delta、hash 不匹配、registry 缺失、零变化、非法角色绑定、过期 revision 或并发冲突仍会拒绝；不会把 unknown 当成通用的放行按钮。
- 明确的用户 delta、当前 revision 和 compare-and-swap 条件会一起校验，成功后才写入下一版事实。

### Append-only 故事修订撤回

- 删除执行记录与撤回故事线修订现在是两个动作：默认删除只删除运行记录并保留故事记忆；危险动作才会明确撤回该 run 产生的修订。
- 撤回通过新的 tombstone / supersedes 记录表达，旧 revision、旧 hash 链和历史证据不会被物理改写。
- 后续 context、manifest 和新分支从 active view 构建，不再带入已撤回事实；既有分支按自己的 parent revision 保持隔离，重复撤回幂等，重启后结果一致。

### 发布门 shell 入口

- 发布候选快速门改用 Node 的参数数组和 `shell: false` 调用 npm，不再把 Windows `.cmd` shim 或拼接命令交给 shell 解释。
- 缺少 `npm_execpath` 时 fail-closed；每个检查按固定顺序执行，首个非零结果立即停止并保留原始退出码。

## 验证摘要

本地候选在版本切换前按固定顺序完成：

- `npm run build`：通过
- `npm run verify`：326/0
- `npm run ui:contracts`：44/44
- `npm run e2e`：66/0
- `npm run e2e:r43`：15/0
- `npm run e2e:r45`：21/0
- `npm run e2e:r46:g5`：28/0

制品另输出到独立的 `dist-1.2.3-final` 目录，旧 `dist-*` 不覆盖。

## 诚实边界

- 本轮没有真实付费 API 请求；mock / synthetic 结果不能代表真实模型的写作质量、费用或速度。
- 真实 Gate 1 基准、长时间 soak、真实安装/卸载矩阵、NVDA 人工矩阵、ARM64 和商业代码签名仍未完成。
- 当前目标平台仍是 Windows x64。未签名安装包可能触发 SmartScreen；请先在可恢复的测试目录试用并备份重要稿件。
- v1.2.3 仍是 Beta，`/latest` 应继续指向稳定版 v1.1.2；独立验收完成前不要把本版本用于不可恢复的生产流程。
