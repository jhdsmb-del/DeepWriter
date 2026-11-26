# Provider 扩展：官方接口与交付路线

核验日期：2026-10-03。本文记录官方文档调研与首层离线接线边界，不是新 Provider 真实账户已验证的声明。未读取真实 key、登录云账户或发送模型请求；模型、价格、地区与账户授权均需在真实使用时再次核验。现有 DeepSeek 实测不能证明其他 Provider 可用。

## 推荐顺序

1. 先完善现有兼容协议的认证、模型发现与价格身份，再接 OpenRouter、Moonshot/Kimi、MiniMax、Groq，以及 Azure OpenAI v1 API key。这一层复用 Chat/Responses，不新建 SDK 或凭据池。
2. 再实现 Gemini 原生 GenerateContent，单独处理原生消息、工具、思考签名、usage 与 `x-goog-api-key`；现有 Gemini 兼容预设保留。
3. 最后处理 Azure Entra / Google OAuth：明确登录、scope、租户/项目、刷新、撤销与恢复语义，不把短期 access token 当永久 API key。

每一层都须通过真实本地 HTTP/SSE 契约反证再展示为已实现。只添加预设卡片、模型 ID 或“支持推理”标签不算接线完成。

## 当前能力与缺口

调研起点定义 4 个协议：`deepseek-chat`、`openai-chat`、`openai-responses`、`anthropic-messages`；内置 DeepSeek，另有 OpenAI、Anthropic、Gemini 兼容、xAI、Qwen、GLM、Mistral、SiliconFlow 共 8 个预设。首层接线另增下表 5 个预设，共 13 个；不改变旧设置、默认模型或旧运行冻结身份。

证据入口：`src/shared/providerRegistry.ts`（预设/冻结契约）、`src/main/providerRegistry.ts`（加密凭据/发现/能力探测）、`src/main/providerAdapters.ts`（请求/SSE）、`src/main/providerSecurity.ts`（网络边界）、`src/main/executionSnapshot.ts`（冻结价格与费用闸门）。

| 现有实现 | 必须保留或补齐的边界 |
| --- | --- |
| 多个凭据引用、追加式加密版本、运行接受时冻结版本 | 不做随机 key 轮询；429、401 或恢复不能悄悄换账户/区域/账单身份 |
| `authStyle` 为 bearer/none，另有 `authHeaderName` | 已能表达专用静态认证头；`api-key` / `x-goog-api-key` 的值仍来自加密凭据，绝不进入 `extraHeaders` |
| 原发现仅读取 `data[].id/name/context_window/max_output_tokens` | 首层已按精确官方 origin/path 消费 OpenRouter/Kimi/Claude/Mistral schema；Gemini 原生仍未实现，不按 ID 猜 |
| 单次模型列表最多 500 项、默认响应上限 2 MiB | 大列表/分页须有总页数、字节数与项数上限；不能静默当作完整列表，也不能去掉上限 |
| 能力有 supported/unsupported/unknown 与来源证据 | “模型目录有 ID”不证明工具调用或推理参数有效；HTTP 200 也可能只是忽略了参数 |
| 用户声明/官方价格记录有精确身份与 hash | 未知价格仍拒绝付费执行；需明确用户上界快照或已核验价格，不能凭“兼容”借另一厂商价格 |
| HTTPS、公网 DNS 全结果校验、连接钉住已校验 IP、拒绝重定向 | 新认证/发现/刷新流不得绕过该传输层；Azure 私网 endpoint 当前不在支持范围 |
| Chat 推理只映射顶层 `reasoning_effort`，Responses 把 max 降为 high | OpenRouter 的对象式配置、模型专属努力枚举、Claude `output_config.effort` 等是实际缺口；不能把省略当成功应用 |

## 第一层新增 Provider 的实际契约

以下 Host 与路径分开保存；“已可复用”只指现有协议框架，不代表已接线或已通过真实账户验收。

| Provider | 推荐协议、Host 与路径 | 认证与模型发现 | 推理/限制与当前缺口 |
| --- | --- | --- | --- |
| OpenRouter | Chat；`https://openrouter.ai` + `/api/v1/chat/completions`；另有 `/api/v1/responses` 与 `/api/v1/messages` | `Authorization: Bearer`；`GET /api/v1/models`。目录含 `context_length`、`top_provider.max_completion_tokens`、`supported_parameters`、价格等 | 推理对象 `reasoning`，不是无条件顶层 effort；须保留 `reasoning_details`。路由可换上游，价格/隐私/能力不能仅冻结品牌名。[快速开始](https://openrouter.ai/docs/quickstart)、[模型 schema](https://openrouter.ai/docs/api/api-reference/models/get-models)、[推理](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) |
| Moonshot/Kimi | Chat；`https://api.moonshot.ai` + `/v1/chat/completions`；官方另支持 `/v1/responses`、`/anthropic/v1/messages` | Bearer；`GET /v1/models` 含 `context_length` 和 `supports_reasoning/image_in/video_in`。国际/中国平台 key 不互通，不能因同名模型跨站用 key | 当前 K3 支持 `reasoning_effort=low/high/max`；K2.x 是独立 thinking 契约，部分必须回传 `reasoning_content`；采样限制按模型核验，不统一塞 temperature/top_p。[接口概览](https://platform.kimi.ai/docs/api/overview)、[模型发现](https://platform.kimi.ai/docs/api/list-models)、[参数参考](https://platform.kimi.ai/docs/api/models-overview) |
| MiniMax | Chat；`https://api.minimax.io` + `/v1/chat/completions`；另支持 `/v1/responses`、`/anthropic/v1/messages` | Bearer；`GET /v1/models`，目录基础字段不能虚构 context/output 上限。国内 endpoint 须使用国内官方配置，不替国际 key 改域名 | `thinking`、`reasoning_effort`、`reasoning_split` 按模型；某些模型不能关闭思考，effort 只对特定模型有效。须保留 `<think>` / `reasoning_content` 多轮内容，不能仅显示后丢弃。[OpenAI SDK](https://platform.minimax.io/docs/api-reference/text-openai-api)、[模型列表](https://platform.minimax.io/docs/api-reference/models/openai/list-models)、[Messages](https://platform.minimax.io/docs/api-reference/text-chat-anthropic) |
| Groq | Chat；`https://api.groq.com` + `/openai/v1/chat/completions`；Responses 可选 | Bearer；`GET /openai/v1/models`。可用目录与详细规格分开，不能将每个 ID 视为固定大上下文 | GPT-OSS 的 low/medium/high 与其他模型的 none/default 等不同；`reasoning_format` 与 `include_reasoning` 互斥，parsed 结果使用 `reasoning` 字段。部分 OpenAI 字段会返回 400，非全兼容。[兼容说明](https://console.groq.com/docs/openai)、[模型](https://console.groq.com/docs/models)、[推理](https://console.groq.com/docs/reasoning) |
| Azure OpenAI v1 | Responses；`https://<resource>.openai.azure.com` 或官方资源 `services.ai.azure.com` Host + `/openai/v1/responses`；Chat 可选 | 原始 `api-key` Header；`GET /openai/v1/models` 是模型目录，不等于账户已经部署。请求 `model` 必须是该资源的 deployment 名称 | v1 无需旧版日期 `api-version`；区域/部署/模型决定能力。优先用户明确填写 deployment；不自动申请 ARM 管理权限枚举订阅。[v1 生命周期](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)、[模型接口](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/models)、[部署名示例](https://learn.microsoft.com/en-us/azure/developer/ai/get-started-azure-openai-starter-kit) |

第一层默认只保存精确用户选择，不自动使用 latest/auto/fallback 模型。OpenRouter 对需要冻结的任务建议显式限制上游、禁 fallback，并用 `require_parameters=true` 防止忽略控制；`data_collection=deny` / `zdr=true` 是可选路由政策，不能宣称覆盖第三方工具或构成法律合规。当前适配器尚不能表达这些请求体政策，须受控映射后才声称支持。[官方路由说明](https://openrouter.ai/docs/guides/routing/provider-selection)

国内配置需使用该站点的精确 Host：Kimi 中国文档是 `api.moonshot.cn`；MiniMax 中国文档目前是 `api.minimax.cn`，旧 `platform.minimaxi.com` 文档会跳转至 `platform.minimax.cn`。不能从旧博客复制 `api.minimaxi.com` 后冒称已按当前官方接口核验，更不能为同一凭据自动尝试两个站点。[Kimi 中国模型列表](https://platform.kimi.com/docs/api/list-models)、[MiniMax 中国接口](https://platform.minimax.cn/docs/api-reference/text-openai-api)、[MiniMax 中国模型列表](https://platform.minimax.cn/docs/api-reference/models/openai/list-models)

OpenRouter 返回价格的原单位是每 token 的美元字符串，不能当每百万 token；需保留响应来源/时间/原值及精确转换，绑定 OpenRouter origin/model，而非拿 OpenAI/Anthropic 原生价格。目录存在 request/image/web-search 等额外计价维度时，无法形成保守费用上界就保持未知；缓存字段缺失也不是“免费”。目录可用性不保证账户账单金额。[模型价格字段](https://openrouter.ai/docs/api/api-reference/models/get-models)

## 现有 8 个预设需同步核对的事实

| 预设 | 官方契约与发现 | 不应夸大的支持范围 |
| --- | --- | --- |
| OpenAI | `api.openai.com/v1/responses`，Bearer；`GET /v1/models`；`reasoning.effort` 枚举按模型。使用 `store:false` 的多轮任务仍需保留相应输出 items | Responses 不是 Chat 包装：采样参数与工具能力有模型限制；当前固定 max→high、总发 temperature 不能代表所有模型。[API 概览](https://developers.openai.com/api/reference/overview)、[推理指南](https://developers.openai.com/api/docs/guides/reasoning) |
| Anthropic | `api.anthropic.com/v1/messages`；当前 `x-api-key` 仍支持，`anthropic-version` 必需；`GET /v1/models` 有分页、context/max_tokens 与能力元数据 | 新模型的 effort 用 `output_config`；thinking 签名块需原样回传。现有开启预算/半 output 配额不等于完整新模型语义。[认证](https://platform.claude.com/docs/en/api/overview)、[Models](https://platform.claude.com/docs/en/api/models/list)、[effort](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)、[消息块](https://platform.claude.com/docs/en/api/messages/create) |
| Gemini 兼容 | `generativelanguage.googleapis.com/v1beta/openai/chat/completions`；Bearer 携带 Gemini API key；兼容 models 列表 | `reasoning_effort` 与原生 thinking level/budget 不能并用，不能假定所有模型支持关闭思考。它不是 Gemini 原生协议。[官方兼容文档](https://ai.google.dev/gemini-api/docs/openai) |
| xAI | `api.x.ai/v1/responses`；Bearer；目录 `/v1/models`；`reasoning.effort` 按模型，部分不能关闭 | 某些模型的 effort 控制 agent 数而非思考深度；加密 reasoning items 多轮回传不可丢。不得把 max→high 隐式降级表述为原样应用。[Responses](https://docs.x.ai/developers/rest-api-reference/inference/responses)、[推理](https://docs.x.ai/developers/model-capabilities/text/reasoning) |
| Qwen/百炼 | `/compatible-mode/v1/chat/completions`，Bearer；官方推荐北京/新加坡等 workspace-specific Host，区域 key 受绑定限制 | 保留旧用户 Host，不无声迁移。`enable_thinking` / `thinking_budget` 是独立字段，不能套顶层 effort；各区域/供应方 model 同名也不共用价格。[兼容与区域](https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope)、[视觉推理参数](https://help.aliyun.com/en/model-studio/visual-reasoning) |
| GLM/智谱 | `open.bigmodel.cn/api/paas/v4/chat/completions`，Bearer；当前预设未配置模型发现，手动模型是诚实路径 | `thinking.type` 是模型专属控制，不等价顶层 effort。Coding Plan 或其他独立 endpoint 不自动继承按量调用的 key/配额。[官方兼容示例](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction) |
| Mistral | `api.mistral.ai/v1/chat/completions`，Bearer；`GET /v1/models` 包含 `max_context_length` / capabilities | 推理可涉及 `prompt_mode=reasoning`，不冒称通用 effort；需保留各模型实际工具/输出限制。[Chat](https://docs.mistral.ai/api/endpoint/chat)、[Models](https://docs.mistral.ai/api/endpoint/models) |
| SiliconFlow | 国际官方文档为 `api.siliconflow.com/v1`；中国官方文档为 `api.siliconflow.cn/v1`，均有 Chat 路径 | 中国/国际作为明确 endpoint 选择说明；不能用 2025 年旧迁移公告否定当前国际文档，也不能根据模型上游品牌借价。当前默认 `.com` 应清楚注明站点。[国际](https://docs.siliconflow.com/en/userguide/capabilities/text-generation)、[中国](https://docs.siliconflow.cn/docs/userguide/capabilities/text-generation) |

## Gemini 原生与 OAuth（尚未实现）

原生 GenerateContent 使用 `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`，流式为 `:streamGenerateContent?alt=sse`。API key 放 `x-goog-api-key`，不使用 query key（防止 URL/日志泄漏）。原生消息是 `contents/parts`，工具是 `functionCall/functionResponse`；usage 与结束原因也需单独归一化，不能把 Chat SSE 解析器直接贴上去。[生成接口](https://ai.google.dev/api/generate-content)、[Key 文档](https://ai.google.dev/gemini-api/docs/api-key)

原生 `GET /v1beta/models` 返回 `models[]` / `nextPageToken`，含 `inputTokenLimit`、`outputTokenLimit`、`supportedGenerationMethods`。按这些实际字段选择可生成文本的模型，不把 embedding 模型混成 Chat。思考使用 `generationConfig.thinkingConfig`，level/budget 的支持与禁用语义按模型；签名需在工具及多轮调用中保留，不能记录为可显示普通 reasoning 文本后丢弃。当前 Google 还提供 Interactions API，属于另一个状态契约，后续独立评估，不把它混称 GenerateContent 已支持。[Models](https://ai.google.dev/api/models)、[生成配置](https://ai.google.dev/api/generate-content)、[思考与签名](https://ai.google.dev/gemini-api/docs/thinking)

Google 当前区分标准 API key 与授权 key，并限制不受限标准 key。UI 应说明 key 的项目、限制/状态与失败原因，不要求用户关闭限制来“解决连接”。登录 Google 账户不自动获得 Gemini API 计费授权。[Key 安全](https://ai.google.dev/gemini-api/docs/api-key)

| 认证方式 | 未来安全接线 | 当前状态 |
| --- | --- | --- |
| Bearer / x-api-key / api-key / x-goog-api-key 静态 key | Header 名称来自受控协议，值来自 provider-bound 加密凭据版本；脱敏、导出排除、失败不跨 key 自动重试 | 静态 Header 基础已存在；新增 Provider 仍需离线及 owner 授权的账户验收 |
| Azure Entra | 明确 tenant/resource/audience 与登录操作；刷新服务只向固定身份端点发送刷新凭据；冻结运行保存非秘密身份引用，运行时取同一身份的短期 token | 尚无 token 获取/刷新器。v1 指南示例用 `https://ai.azure.com/.default`，REST 文档仍列 `cognitiveservices.azure.com/.default`，须按实际 endpoint/官方身份库确认，不能全局猜一个 scope。[v1 指南](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)、[REST 认证](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses) |
| Google OAuth / ADC | 明确用户授权项目与所需 scope，Bearer 短期 token + 必要的 `x-goog-user-project`；刷新/注销/过期即暂停且不换 API key | 官方 OAuth 示例是独立凭据流程，不是现静态 key 存储。不要自动扫描用户 ADC/gcloud/token.json，不把官方 Retriever 示例 scope 扩大解释为所有原生模型权限。[官方 OAuth](https://ai.google.dev/gemini-api/docs/oauth) |

## 实施门槛与验收

首层后端现已接线 `providerAuth.ts` / `providerDiscovery.ts`、Registry 与既有 Chat/Responses/消息适配器：静态 key 的 4 种 Header 通过真实 loopback HTTP；发现元数据不提升为 `protocol_probe`；目录价绑定源/币种/单位/hash，但 OpenRouter 路由与 reasoning 计费未冻结，所以目录报价不能自行通过费用闸门。目录模型最多 500 个、每页最多 2 MiB、Claude 最多 10 页，未完成或越界不假称完整。Azure 预设 Host 为待填写占位符，不自动将目录模型当 deployment。用户仍须声明缺失规格与参考上界；无价/无上下文的拒绝保持不变。

定向入口为 `node --test scripts/provider-expansion.test.cjs`（16/0），既有 `r44p`（23/0）与 `r61:provider-adapters`（13/0）保持通过；主进程 TypeScript 静态检查通过。新反证包含专用认证只出现一次、secret extra-header 请求前拒绝、30x 跨 origin 目标 0 请求、混合 DNS 拒绝、真实 SQLite 凭据版本/模型落库，以及“HTTP 200 只有正文”不标推理已验证。这些数字仅指离线合成 fixture，不代表云账户或厂商计费验收。

高级 OpenRouter 路由对象/opaque reasoning、模型专属 thinking/签名、原生 Gemini、OAuth 获取/刷新、超过安全上限的完整目录仍是未实现或需后续明确接线的范围，不将预设数量当功能验收。

首批实现应新增独立认证/发现模块，复用同一安全传输；接线只改 Provider 契约/服务/适配器的小范围代码，保留旧 DB 行、设置字符串、冻结运行指纹与加密版本。网络模型、Renderer、Engine、CLI 主流程不属于本次静态调研授权。

认证身份最少包含 providerId、canonicalOrigin、协议、认证 Header 名称、credentialRefId/version。Azure 再加部署/区域；OAuth 再加 tenant/project/audience/scope/expiry。价格包含 provider/origin/model/currency/单位/hash/来源/核验时间，不将用户输入的来源文本升级为官方证据。

必须覆盖这些离线反证：

- 同一合成 key 经实际 HTTP 请求分别产生 Bearer、`api-key`、`x-api-key`，认证只出现一次；大小写重复 Header、换行注入、secret extraHeaders 或跨 provider 引用在请求前拒绝。
- 30x 指向另一个本地服务时，目标实收 0，key 不跟随；公网→loopback、DNS 混合私网、路径/Host 变更不继承已验证能力/价格。
- Chat / Responses 本地 SSE 的正文、工具块、reasoning、usage 与终止准确；未知事件或 HTTP 200 不直接把能力标为 supported。
- 按真实 schema 消费 context/output/能力字段；缺失、负数、重复 ID、跨源、目录漂移、超大/分页未完成保持未知或明确拒绝；不拿“model 名字像 GPT/Claude”作能力证据。
- per-token→per-1M 单位换算与源/币种/hash 保留；未知/额外维度/错币种/错 origin/错 model 均不能通过费用闸门，冻结任务不受后来改价影响。
- 多 key/轮换后，已接受任务使用原引用版本；撤销/解密失败进入诚实暂停，不跨 key/跨 Host 自动继续。

离线通过后仍需 owner 单独授权一次有上限的真实账户请求，分别记录 endpoint/model/protocol、凭据非秘密引用、usage、费用状态与来源、取消/超时；不得复用 DeepSeek、RC1 或另一 Provider 的证据。未授权真实测试可以标“离线契约通过、真实账户未验证”，不写“全平台完全兼容”。
