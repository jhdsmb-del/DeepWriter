# DeepWriter 1.2.1

## 这次更新

- 修复自定义本地接口在测试/运行账本中的定价身份处理，未知价格仍会安全拒绝，不会伪装成零成本。
- 修复恢复态事件接收与 Galgame 写盘后的自动 lint 证据时序。
- Windows x64 同时提供 NSIS 安装版和 portable 免安装版。

## 已验证

- typecheck、UI 合约、主流程、恢复流程、Galgame 流程与 Gate 5 生命周期回归均通过。
- 版本目标为 `1.2.1`，应用仍是本地 Electron 桌面程序。

## 边界

真实付费基准、2 小时 soak、NVDA 人工矩阵、ARM64、商业代码签名及 macOS/Linux 制品不包含在本次 Windows x64 包中；详见 [STATUS.md](STATUS.md)。
