# 2026-10-03 有限真实文本审阅

结论：两个可读样本都有冷峻悬疑的物件、动作与环境表达，但存在可定位的任务符合性和连续性问题。本审阅不构成文学质量达标、模型排名或商业验收；不改任何回归数字或验收门槛。

## 证据范围

唯一文本来源：`out/commercial-quality/eval/run-2026-10-03T05-18-09-126Z/samples.json`。审阅新增模型请求 **0**，未读取凭据、调用真实 API 或重新采样。该文件记录 `mode=real`、`model=deepseek-flash`、`experimentMode=trajectory`、单任务 `longform-multichapter`、`repeats=1`。

审阅者已知变体身份，属于**非盲、单任务、单次重复、同一模型的有限质评**。两稿各回灌自己的历史，系统提示和运行路线不同。篇幅与阶段轨迹不是控制相等的文学比较条件。

| 样本 | 可审阅状态 | 范围 |
| --- | --- | --- |
| `s-longform-multichapter-generic_baseline-r1` | `metrics.status=ok`、`eligibleForReview=true` | 大纲 + 第1、2、3章；generic 是直接流式基线，`terminalStatus=[]`，不能把它写成 Engine 终态证明 |
| `s-longform-multichapter-deepwriter_current_product-r1` | `metrics.status=ok`、`eligibleForReview=true` | 大纲 + 第1、2、3章；current 是普通 Agent 路线，不是正式 Grill 确认后的逐场景长文路线 |
| `s-longform-multichapter-deepwriter_hardened_candidate-r1` | `metrics.status=failed`、`eligibleForReview=false` | 两次 `longwrite_delivery_failed`，无成功章节；**不纳入文本评比** |

三臂整体 `fairness.anyFairnessFail=true`，`lineageValid.longform-multichapter.valid=false`，结构不完整。不能选择两臂成功文本就把整轮三臂实验写成通过。以下只描述现有两份可读文本，不推断其他任务、重复或模型的表现。

## 用户任务与可读优点

设定要求冷峻悬疑、克制叙事、人物声音各自独立、时间线连续、重要伏笔在收束处回收。第一阶段要求整部小说的分章大纲、一句话梗概及伏笔埋设/回收点；随后各章要求“根据之前的大纲”“约3300字”“保持……时间线与伏笔一致”。

两稿都使用照片、旧钥匙、面馆动作、江声和候车厅灯光来承载悬疑，较少直接宣布人物情绪。generic 第二章以“不看”“面凉了”表现老周回避；current 第一章以端碗失手、进后厨、擦不存在的灰表现识人后的反应，具有具体的场景可读性。current 大纲列出24章和五条伏笔回收表，结构规划较完整。这些局部优点不能抵消下列连续性问题，也不构成整体优劣排名。

## 可定位的问题

### Current：相对日期与时点漂移

样本 `deepwriter_current_product` 的 `stageOutputs[1]`（第1章）明确先写“天快亮的时候”，离开客运站、吃早面，再在江堤遇到苏晚；苏晚约“**今天下午三点，档案馆开门**”。`stageOutputs[2]`（第2章）直接接“林默一路走过去”，却把同一江堤会面写成“**比起昨天在雨里的样子**”“**你昨天问是什么东西**”“**昨天你说的东西**”。之后林默对老周说“**我上午去了档案馆**”，与第一章约定的下午三点也不一致。`stageOutputs[3]`（第3章、当晚六点）再次说“**所以你昨天在江堤上等我**”。

问题不是允许过夜还是不允许，而是正文未提供过夜或日期切换，却对同一会面反复改称昨天，并同时使用上午/下午的冲突时点。它直接违反用户要求的连续时间线，读者难以重建这一天。

### Current：自有大纲与已输出章次失配

`stageOutputs[0]` 大纲把面馆试探、档案馆重逢、合影、未寄信分别列在第2、3、4、5章；采砂场父女关系及保护性离开的完整解释列在第15章，毁档危机列在第18章。实际第1章已完成面馆试探与旧情重逢；第2章主要到档案馆查合影、预约看信；第3章已解释苏晚是采砂场主之女、三年前离开的保护动机，并告知“明天下午”销毁附件袋。

这不是单纯多写了一些字，而是提前消费了自有大纲中多个后续章节的关键事件，未说明重排。既定章号与悬疑释放节奏发生漂移。第2章标题仍是“老街的面”，主体却先推进档案馆合影，也可作为核对锚点。

### Generic：整部大纲未完成

`stageOutputs[0]` 的大纲只到第6章，并以“**她袖口夹着一个没拆口的旧信封的一角（**”结束，括号与句子均未闭合。它列出伏笔索引和前期埋设，却没有提供用户请求的整部收束与主要回收安排。后面三章可读，不等于第一阶段的大纲任务完整。

记录中的 `validation.passed=true` 主要证明有大纲阶段、三个章节阶段及最低篇幅；该结果不能替代“大纲是否写完”的文本判断。本审阅不修改验证器或历史结果。

### Generic：核心事件时序与基础自校

原始设定是四十年前**坝成当夜**暴雨、未及时开闸。`stageOutputs[3]` 第3章老人却说“**放了三天……到了第三天……天开始下雨**”，将核心灾难移到第三天，且没有交代老人记忆不可靠或正在提出不同版本。

素材还规定渡口末班船在傍晚；`stageOutputs[1]` 第1章看表“十点四十”时仍写“是末班船”，没有解释班次变化。该章把“老周，坝成之日，切记。”称为“六个字”（不计标点实际八字）；第3章把“记者”称为“这三个字”（实际两字）。这些是可直接检查的连续性/基础校对失误，不涉及审美偏好。

### 篇幅：仅记录任务符合性

文件报告三章字符数：generic 为1725/2318/2890，current 为3556/3340/3335，要求均约3300。generic 尤其前两章明显不足；current 接近目标。此处沿用 `stageOutputs[].chars` 的记录口径，不把篇幅等同于情节密度、人物层次或审美质量，也不以此给模型排名。

## 与正式生产长文链的区别

直接代码证据表明，本轮 current 的大纲只是自然历史中的文本，没有绑定为正式 Grill 的已确认场景契约：

- `scripts/eval-runner.ts:1323` 将 current 路线设为 `mode='agent'`、`longMode=false`、`story=null`；`:1365` 回灌本变体历史；`:1470` 调用 `runStage` 时传入文本与阶段目标，而没有 Grill `approvedOutline/outlineHash`。
- `scripts/eval-tasks/tasks.json` 的章节模板只用自然语言要求“根据之前的大纲”；`scripts/eval-runner.ts:756` 构造评测 payload，没有提交已确认 Grill 大纲。
- 正式生产 `src/main/index.ts:3965` 检查 Grill gate，`:3970` 从 durable state 重建 canonical payload；`src/shared/grillMe.ts:171` 检查已确认状态及大纲 hash，不采信 Renderer 自带的答案/大纲内容。
- `src/main/executionSnapshot.ts:393` 为已确认 Grill 长文启用写作管线，`:401` 构建冻结 `sceneContracts`，`:446` 注入已确认大纲及 hash。`src/main/narrative/sceneContract.ts:1375` 再核验大纲身份；`:1618` 按本场必需事件、角色、时间与实际性证据评估正文。

因此，这两份样本的漂移更直接说明**普通 Agent 多轮评测没有结构化绑定已确认大纲，且模型未充分遵循自然语言历史契约**。它们不能单独证明正式 Grill→逐场景生产链同样缺少大纲绑定，也不能证明该生产链已能自动捕捉任意“今天/昨天”或整个长篇的所有日期错误。跨章相对日期与事件提前消耗，仍需在正式路线、明确契约和有限样本下另作可复核验证；不新增无限质量门槛。

## 使用边界

本文件提供已发生问题的短锚点，供后续针对性验证，不是总体模型结论或自动发布许可。三臂整体失败与 hardened 不可比较的事实保持原样；扩展、认证、交付可靠性等其他定向回归也不能替代文学质量证据。

## 附：评测任务与完成契约的适用性（只读复算，0新增真实请求）

本节核对的是当前 `eval-runner` 的普通评测模式，不是正式 Grill→已确认大纲→逐场景生产路线。修好稿件发布端口，不会自动消除任务设计上的不相容。

### 大纲阶段的200字不是三臂共同的输出限制

`scripts/eval-tasks/tasks.json` 将 `longform-multichapter` 设为 `mode=longwrite`、`longMode=true`，大纲阶段 `targetChars=200`，却要求整部小说的分章标题、一句话梗概及伏笔埋设/回收。任务没有指定必须24章；24章是05:18这批 current 实际输出的自有规划。

`scripts/eval-runner.ts` 只对 current 强制 `mode=agent`、`longMode=false`；generic 直连模型，两者没有 hardened 的长文完成契约。因此，同一个200字阶段目标对三臂不是同一种行为：hardened 在 `executionSnapshot.ts` 建立长度完成与稿件文件契约，另外两臂可保留远超200字的大纲。

当前 `AgentRunEngine.ts` 的 `currentTargetLimit` 首轮取目标下限，流中用 `takeCodePoints(candidate, currentTargetLimit)` 强裁。长文自然句末窗口与残句续写可补尾，最终文件不保证恰好200字；但这不是保留整部大纲的机制。只读反事实复算：把05:18 current已保存的3326字、24章大纲按该首轮规则取前200个code point，内容停在卷一导语，连第1章细目都未保留。不能据此宣称失败的 hardened 实际生成了同一份24章大纲：它没有成功的大纲阶段产物。本事实说明现有阶段契约无法等价保留这类规划，不能把截断后的局部文件称为完整大纲或整部长文。

### 输入公平性与任务适用性是不同判断

05:18批次 `ledger.json` 的第一阶段三臂实际 `actualUserHash` 相同（`9a0f589d…`），`actualHistoryHash` 相同（`4f53cda1…`，空历史），system hash不同符合变体设计。证据不支持“hardened首轮漏传素材”的说法。问题是输出/完成契约不同，而不只是system提示不同。

trajectory模式回灌各臂自己的成功文本，历史自然分叉；controlled模式改用仓库的合成golden history，输入更易等价，却不能证明本臂实际大纲或上一章被成功承接。已有公平性检查不能替代“大纲是否完整”“章次是否遵循”“文件是否包含所宣称全文”的检查。

### 剩余10请求护栏内的有限候选

不修改任务或阈值时，longform有大纲加三章共4阶段，三臂最低12请求，已超出剩余10次内部护栏。`character-consistency`最低18次。`style-transfer`最低6次，但hardened为非longMode，不验证长文稿件文件。`renpy-scene-branch`最低3次，但800字长文裁切与完整脚本语法也存在相容性风险，不宜仅因省请求替代小说交付验证。

现有 `failure-recovery` 是较小候选：150字断裂续写，再450字承接，三臂理想6请求。hardened启用longwrite及真实发布端口，可验证**两个短续写阶段及各自文件**；它不是单一600字合稿文件的既有验收，更不是10k、24章或正式Grill全链的替代证明。补尾/重试可能超过10次，理想6次不构成成功保证。

最小本地预验证路线（本次只提出，不执行真实请求）：

1. 先复用 `scripts/eval-pricing.test.cjs` 的真实SQLite稿件/文件哈希测试及缺发布器负例，仅使用本地synthetic端点，确认发布端口与失败门均有效。
2. 再以原 `failure-recovery`、`scale=1`、`repeats=1`、trajectory模式跑本地mock，保持10次请求上限；不缩字数、改阶段或调阈值以换绿灯。
3. 复查hardened两阶段均completed；SQLite的manuscript artifact为completed；实际文件、对象缓存、正文内容与SHA-256/code-point计数一致；第二阶段历史包含第一阶段真实产物，文本完成断句且无整段重复。当前export的 `createUnifiedOrchestration().evidencePaths` 和现有稿件fixture已有这些取证接缝。
4. 本地若失败、超过10次或只有partial，不消耗后续真实预算，也不登记为全文成功。若通过，仅可建议在剩余金额与10次护栏内做同任务有限真实观察；本节没有实施或授权额外真实请求。

### 随后实际执行的本地前置验证：未通过

经root明确授权，随后执行上述本地方案，未发真实API请求、未读取真实Key、未修改生产代码或阈值。构建使用独立 `out/eval-runner-review-local.mjs`，没有覆盖Desktop构建。默认沙盒先阻止esbuild扫描祖先目录，端点实收0；本地构建获准重试后正常执行，此环境失败不计作产品用例失败。

- `scripts/eval-pricing.test.cjs` 的实际SQLite/文件交付正例和缺发布器负例：2通过、0失败，仅本地synthetic端点。它们证明交付端口及失败门有效，不证明续写任务或文学质量通过。
- 原任务命令：`--mock --task=failure-recovery --scale=1 --repeats=1 --experiment=trajectory --max-requests=10 --save-content`。
- 实际产物：`out/commercial-quality/local-failure-review/eval/run-2026-10-03T07-21-18-505Z/`。共7次**本地**请求，未耗尽10次上限。generic/current各完成2阶段；hardened首阶段在3次候选后停于 `waiting_user / strong_constraint_repair_exhausted`，第二阶段未执行，成功阶段数0。
- runner整体 `exit=1 / fairness_blocked`；lineage同起点/协议/采样为true，`structuralIntegrity=false`，阶段数2/2/1，hardened成功输出阶段0/2。保留这个raw红，不以另外两个样本成功抹平。
- `manifest.hostDelivery` 明确保存本次隔离临时 `dw-eval-lFEHsV/eval.db` 路径。只读查询该fixture，未遍历用户配置目录：hardened为上述waiting_user；SQLite的manuscript artifact行数0；冻结 `documentsDir` 下文件数0。因此**没有**两阶段完成、文件char/hash、两阶段实际历史闭环的正向证据。不能补写文件或构造假SQLite记录来通过。

### 可复现生产缺口：把旧文/禁止重复的引语升级成正向主题锚点

这次失败不是发布器缺失。冻结strong约束默认仍为enabled、themeLockMode=strong；其 `themeAnchors` 恰为 `你不该来这里`、`是——`。前者来自【前文】人物对白，后者来自前文及“不要重述或复制前文的结尾（\"是——\"之后）”的排除指令。

`src/main/strongConstraints.ts:51` 的 `extractThemeAnchors` 在整个task上无条件提取所有引号内容；末尾noise过滤只看被提取的短语，已经丢失来源、否定和旧文作用域。`src/main/executionSnapshot.ts:381` 在普通生产longwrite的execute快照也调用它；`strongConstraints.ts:278` 将未命中这些自动锚点作为主题缺口，`AgentRunEngine` 经有限repair后暂停。因此这是普通续写用户可遭遇的输入契约冲突，不只是mock长度或fixture文本问题。raw证据的三次候选哈希相同，主题缺口连续撤回，最终 `strong_constraint_latest.status=paused`。

不改源码的实际函数内存复算还得到：

- 原任务加一段以“老周。他把湿透的外套……”衔接的新正文，保持机房/林默/钥匙事件，不复述原对白或残句：strong函数拒绝，唯一缺口 `topic_anchor_missing`。
- 最小任务“不要重述或复制前文的结尾‘是——’，直接从断裂处继续……”仍提取正向 `是——`，合规新文被拒；反而补回这个残句后strong函数返回ok。**这只是该约束函数的反例，不是整条run完成或文件交付通过**，文本完整性/禁重复仍应另行检查。
- 正向“围绕‘灯塔’与‘守夜人’写故事”：正确题材正文通过，纯会计账本正文拒绝。显式 `mustKeep=旧钥匙` 缺失仍硬拒，显式 `avoid=旧钥匙` 出现仍硬拒。这些控制例必须在修复后继续成立。

最小生产修复定位是 `extractThemeAnchors` 的**正向来源与作用域识别**：区别真正主题指令、【前文】/示例/旧片段，以及“不要/不得/禁止重复”等否定指令；不得把负向引语用作必须出现的正向证据。严格正反例还应覆盖混合指令“围绕灯塔续写，但别复述旧句”：保留灯塔正向约束，旧句不升格为主题，离题仍拒；显式逐项mustKeep和avoid硬约束不得被删除。不得通过关strong、降低阈值、增加无限repair或清洗本次失败记录换绿灯。

本地预验证结论为不通过；不建议直接消耗剩余真实请求运行这个未修复的原任务。上述新增7次均为synthetic本地请求，不能算入owner真实API花费或把mock费用字段当成真实支出；0稿件证据及原三批真实评测失败结论保持原样。
