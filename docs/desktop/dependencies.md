# Rust 依赖解析说明

本文件记录 Rust workspace 的依赖选择与锁定依据（任务 1.2）。版本号取自仓库中已提交的
`Cargo.lock`，修改依赖时应同时更新这里的表格。

## 已锁定版本

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| tauri | 2.11.5 | 桌面宿主：托盘、窗口、受限命令/事件桥 |
| tauri-build | 2.6.3 | 宿主构建脚本（权限与配置校验） |
| @tauri-apps/cli（npm） | 2.11.4 | `npm run build:desktop` / `dev:desktop-host` 使用的 CLI |
| serde / serde_json | 1.0.229 / 1.0 | 契约序列化，字段名与 TypeScript 契约一致 |
| thiserror | 2.0.20 | 采集与存储错误类型 |
| anyhow | 1.0.104 | 服务二进制顶层错误 |
| tokio | 1.53.1 | 异步运行时（进程、定时器、网络、文件） |
| reqwest | 0.12.28 | 只读 HTTPS 查询；`rustls-tls` 不依赖系统 OpenSSL |
| chrono / chrono-tz | 0.4.45 / 0.10.4 | 本地日界线、重置倒计时与时区校验 |
| tracing / tracing-subscriber | 0.1.44 / 0.3 | 日志；输出前统一脱敏 |
| url | 2.5.8 | 端点来源校验（HTTPS、禁止跨域重定向转发凭据） |
| sha2 | 0.10.9 | 服务发现与握手校验摘要 |
| rand | 0.9.5 | 实例标识与会话凭证 |

Vite 7.1.4、React 19.1.1、Node 24.19.0 沿用既有网页依赖；桌面面板与旧网页共享同一套
前端依赖，避免两套构建链。

`rusqlite` 曾经出现在依赖草稿中，但任务 2.1 之前没有使用者，因此暂时不写入 workspace
依赖；若最终存储方案需要它，再按此处记录的格式补记版本。

## 构建目标与系统版本

- 目标三元组：`x86_64-apple-darwin`（见 `.cargo/config.toml`）。
- 本机 macOS 26.6.2（Build 25G983），Intel x86_64；因此首版交付物只针对该架构。
- 链接最低系统版本：Intel 10.15、Apple Silicon 11.0（`.cargo/config.toml` 的
  `-mmacosx-version-min`），与 `src-tauri/tauri.conf.json` 的
  `bundle.macOS.minimumSystemVersion` 保持一致。
- 该值需在任务 8.6 打包时用 `otool -l` 复核实际 `LC_BUILD_VERSION`，若 Tauri/WKWebView
  实际要求更高，则以打包结果为准更新本文件与配置。
