# DeepWriter 1.2.1 发布候选制品元数据

> 构建目录：`dist-1.2.1-final`　|　平台：Windows x64　|　Electron：43.3.0　|　应用版本：1.2.1
>
> 本记录对应本地最终候选构建；未执行 commit、tag、push 或 GitHub Release。

## 制品校验

| 制品 | 大小（bytes） | SHA-256 | PE | FileVersion | ProductVersion | 签名 |
|---|---:|---|---|---|---|---|
| `DeepWriter-1.2.1-x64-setup.exe` | 132107859 | `7F437990F98D44BB40CC05265920D74F7253832D5D5CDCDECACF26A0E75B8153` | MZ | 1.2.1 | 1.2.1 | NotSigned |
| `DeepWriter-1.2.1-x64-portable.exe` | 131814710 | `13ED2CC236D428FF0CFF3CB16A235DBBC20530FFFE0CB8C5B3BD1F6F247E520D` | MZ | 1.2.1 | 1.2.1 | NotSigned |

## 内部文件

| 文件 | 大小（bytes） | SHA-256 | PE | FileVersion | ProductVersion |
|---|---:|---|---|---|---|
| `win-unpacked/DeepWriter.exe` | 225459712 | `50CA326969FC26FE027C71EAB1A063B28BD0536B80E8516E7F326F4585C3D59A` | MZ | 1.2.1 | 1.2.1.0 |
| `win-unpacked/resources/app.asar` | 135062670 | `4853F4EFBFED39CEF889015A42E6F45E17F1A0E883A18305219E8B9C5EC8CF37` | — | — | — |

## 发布门禁

- `npm run release:asar -- --dir=dist-1.2.1-final`：退出 0，6/6 PASS，敏感项 0。
- `npm run release:sbom`：退出 0；生产依赖 14、开发依赖 13、未知许可证 0。清单见 [`SBOM_DEPENDENCIES.md`](./SBOM_DEPENDENCIES.md)。
- `npm run build`：退出 0。
- 本轮为未配置商业证书的 Windows 构建，两个分发 EXE 与内部 EXE 的 Authenticode 状态均为 `NotSigned`；签名仍是发布前的独立待办。
