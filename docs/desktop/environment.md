# 环境基线与工具链（任务 1.2）

记录本仓库构建桌面版时所依据的实际环境。数值来自本机实测命令，不是文档抄录；更换机器
或升级工具链后应重新采集并更新本文件。

## 采集命令与结果

| 项 | 命令 | 实测结果 |
| --- | --- | --- |
| 架构 | `uname -m` | `x86_64`（Intel Core i7-9750H） |
| 系统 | `sw_vers` | macOS 26.6.2，Build 25G83 |
| Rust | `rustc -vV` | `rustc 1.98.0 (88d9e12ae 2026-08-18)`，host `x86_64-apple-darwin` |
| Cargo | `cargo --version` | `cargo 1.98.0 (797e8a9bc 2026-08-05)` |
| 已装目标 | `rustup target list --installed` | `x86_64-apple-darwin` |
| 已装工具链 | `rustup toolchain list` | `stable-x86_64-apple-darwin`（默认） |
| 编译器 | `cc --version` | Apple clang 21.0.0 (clang-2100.1.1.101)，Target `x86_64-apple-darwin25.6.0` |
| Xcode 工具 | `xcode-select -p` | `/Library/Developer/CommandLineTools`（CLT 26.6.0.0） |
| Node | `node --version` | v24.19.0 |
| npm | `npm --version` | 11.17.0 |
| Tauri CLI | `node_modules/.bin/tauri --version` | `tauri-cli 2.11.4` |

## 构建目标与最低系统版本

- **目标三元组**：`x86_64-apple-darwin`，写在 `.cargo/config.toml` 的 `[build] target`，
  这样 `npm run rust:*` 与 Tauri 打包使用同一个目标，不需要额外传参。
- **最低系统版本**：Intel 10.15、Apple Silicon 11.0，通过
  `.cargo/config.toml` 的 `-mmacosx-version-min` 链接参数指定，并写入
  `src-tauri/tauri.conf.json` 的 `bundle.macOS.minimumSystemVersion`。
- **复核方式**：对构建产物执行
  `otool -l target/x86_64-apple-darwin/debug/agents-usage-desktop | grep -A5 LC_BUILD_VERSION`
  与本文件的数值对照。任务 8.6 打包后需要按同样方式再复核一次发布构建，若 Tauri 或
  WKWebView 实际要求更高，以实测值为准更新配置与本文件。

## 依赖锁定

版本清单与选择理由见 [dependencies.md](dependencies.md)。锁定通过仓库根 `Cargo.lock`
与 `package-lock.json` 提交完成；不在 `rust-toolchain.toml` 中固定精确工具链版本，原因见
下。

## 环境限制（会影响命令写法）

1. `~/.cargo` 在本仓库的验证环境下不可写，`cargo` 直接运行会报
   `Operation not permitted`。因此新增 `tools/cargo.sh`：把 `CARGO_HOME` 指向仓库内
   `.dsh/cargo-home`、把 `CARGO_TARGET_DIR` 固定为仓库内 `target/`。所有 Rust 命令都应
   通过它或 `npm run rust:*` 执行。
2. `~/.npm` 同样可能不可写，安装依赖需要
   `npm install --cache "$PWD/.dsh/npm-cache"`。
3. 已有 `rust-toolchain.toml` 曾尝试固定 `1.98.0`，会导致 `rustup` 在仓库内触发工具链
   下载（本环境写 `~/.rustup/tmp` 被拒绝）。因为项目不使用 nightly 特性，改为只保留
   `Cargo.toml` 的 `rust-version = "1.98"` 约束。
4. `tauri icon` 会生成 iOS/Android 资源；本变更只交付 macOS，生成后已删除
   `src-tauri/icons/{ios,android}`。
5. 只配置了本机架构。交付范围是「当前 Mac 可运行的应用」，因此未添加
   `aarch64-apple-darwin` 交叉构建与通用二进制打包。
