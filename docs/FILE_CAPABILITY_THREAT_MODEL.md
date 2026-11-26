# 文件/目录 Capability 威胁模型（任务二）

> 目标：renderer 运行请求只携带主进程签发的 capability token，裸路径字符串不能形成任何新的文件系统授权。
> 关联：A-02（chat:start 附件直读）、A-03（settings:set 扩权）、grantDrop 裸路径。

## 资产与信任边界

- 资产：用户本地文件（读取内容会进入模型上下文）、API Key、会话数据。
- 信任边界：renderer（sandbox + contextIsolation，无 Node 权限）默认不可信——假设可能被 XSS、供应链污染或开发服务器来源绕过控制。
- 主进程是唯一可执行文件系统操作的主体；所有文件访问必须经主进程 capability resolver。

## 威胁与缓解矩阵

| # | 威胁 | 攻击面 | 缓解 | 状态 |
|---|---|---|---|---|
| T1 | 伪造路径读取任意文件 | `chat:start` attachments、`attachments:read` | 只接受 capId；resolve 校验签名/有效期/用途/范围；裸路径拒绝 | 本轮实现 |
| T2 | 设置写入扩大目录授权 | `settings:set` workDir/docDir/galgame/sdkPath | 目录值必须携带选择器签发的 capId；纯字符串拒绝；授权只绑定 capId 对应 realpath | 本轮实现 |
| T3 | 拖拽接口签发任意路径 | `grantDrop(paths)` | 保留通道但 main 校验存在/类型/大小后签发**短时单用途** cap；不直接加入全局授权集；cap 不可用于目录/扩容 | 本轮实现 |
| T4 | cap 重放/跨会话复用 | 所有 cap 消费点 | cap 绑定 sessionScope/projectScope + 次数（默认 1-3）+ 过期；resolve 后核销 | 本轮实现 |
| T5 | junction/symlink 逃逸 | 任意文件读取 | issue 与 resolve 均用 `fs.realpath` 规范化；cap 绑定 realpath，解析后再次 realpath 对比 | 已实现（Gate 1）+ 本轮 |
| T6 | 大小/类型伪造 | 附件读取 | issue 时记录真实 size 与扩展名；resolve 后 importFile 前再校验 | 本轮实现 |
| T7 | dev URL 前缀混淆 | ipcGuard/will-navigate | URL 解析后精确比较 origin（protocol/host/port），弃用 startsWith | 本轮实现 |
| T8 | 过期 cap 仍可用 | 消费点 | expiresAt 强制；过期 resolve 返回 null | 本轮实现 |
| T9 | XSS 后拖拽签发任意存在文件 | grantDrop | 设计边界：Electron 无法区分真实拖拽手势与程序化调用；缓解为短时单用途 + 只读 + 不扩容；完整缓解需 OS 级手势验证（超出桌面应用范围，记录为残余风险） | 残余风险 |

## 授权链路（实现后）

```text
用户拖入/选择文件
  → main 签发 cap {capId(random128), realpath, kind, size, source, scope, expiresAt, usesLeft}
  → renderer 只持有 capId + 显示信息（name/size）
  → 运行时提交 capId
  → main resolveCapability(capId): 校验存在/未过期/次数/范围 → realpath
  → 读取前再次 realpath + 类型 + 大小校验 → 执行
```

## 验收负向用例（scripts/gate1-security.ts 扩展）

1. `attachments:read({path:'C:\\...'})`（无 capId）→ 拒绝
2. `attachments:read({capId: 伪造})` → 拒绝
3. cap 过期 → 拒绝
4. cap 用尽（usesLeft=0）→ 拒绝
5. cap 跨 session 复用 → 拒绝
6. `settings:set` workDir 纯字符串（无 capId）→ 拒绝，且不产生授权
7. `settings:set` workDir 携带不匹配的 capId → 拒绝
8. 拖拽注册后 cap 只能读该文件，不能用于目录
9. junction 逃逸：cap 绑定 realpath，symlink 变化后解析不一致 → 拒绝
10. dev URL `https://evil.example/x` 前缀包含 devUrl 的部分 → 拒绝（精确 origin）
