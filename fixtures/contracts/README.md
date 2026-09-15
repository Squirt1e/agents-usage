# 共享契约样例（脱敏）

这些 JSON 是 Rust 与 TypeScript 两个运行时的共同验收依据（任务 1.3 建立，任务 1.4 接入校验
入口）。样例只包含人工构造或脱敏后的数据，不含真实账号、密钥、端点或会话。

## 约定

- 每个文件是一个对象，至少包含 `id`、`description`，以及 `input`/`cases` 等载荷与 `expect`
  期望值。期望值写的是**语义**（缺失、可靠零、枚举拼写、单位换算），不是某个实现的中间结构。
- 缺失值一律写 `null`，不写 `undefined`，也不写 `0`。样例本身就是「缺失不等于零」的规范。
- 时间戳写成带偏移的 ISO-8601；外部接口的时间戳单位在样例里显式标注（Codex 秒、GLM 毫秒）。
- 端点只使用保留域（例如 `example.invalid`）；凭据只使用 `not-a-real-*` 之类的禁值。唯一的例外
  是 `redaction.json`，它故意包含这些字符串以验证脱敏结果。

## 校验入口

| 命令 | 作用 |
| --- | --- |
| `npm run test:contracts` | TypeScript 侧契约测试（`tests/contracts.test.ts`、`tests/contracts-conformance.test.ts`） |
| `npm run rust:test` | Rust 侧全部测试，含 `crates/usage-core/tests/contract_conformance.rs` |
| `npm run contract:test` | 上面两者一起跑 |
| `npm run verify:baseline` | 样例格式检查 + 两侧契约测试（加 `--no-rust` 只跑 TypeScript，加 `--with-legacy` 再跑旧网页基线） |

两侧测试读取**同一份**文件：Rust 通过 `usage-core::fixtures::load_fixture`，TypeScript 通过
`tests/contracts-conformance.test.ts` 的 `fixture()`。任何语义变化必须同时更新样例与两侧实现，
否则至少一侧会失败。

## 文件清单

| 文件 | 覆盖 |
| --- | --- |
| `codex-windows.json` | 五小时/每周窗口、秒转毫秒、缺失重置时间、不兼容响应 |
| `glm-connections.json` | 套餐与钱包连接标识、键名约定、未知额度项、空活动响应 |
| `deepseek-currencies.json` | 多币种余额、可靠零值、估算消费、不新增未验证指标 |
| `provider-errors.json` | 错误词汇表、状态映射、失败后保留最后成功快照 |
| `daily-statistics.json` | 时区与本地日界线、Codex 日期桶、GLM 区间修正、余额估算 |
| `redaction.json` | 请求头/嵌套字段/进程输出脱敏、账号掩码保留 |
| `new-old-semantics.json` | 语义对照的机读版本：缺失/零/文本值、错误枚举、时间戳换算 |
| `codex-cli-discovery.json` | Codex CLI 发现顺序与绝对路径规则（Finder 启动无交互式 shell PATH） |

语义说明见 [`docs/desktop/semantic-map.md`](../../docs/desktop/semantic-map.md)。
