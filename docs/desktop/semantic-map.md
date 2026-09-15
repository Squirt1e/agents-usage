# 采集语义对照

本文件把各平台的上游接口语义逐项对照到 Rust 采集核心（`crates/usage-core`）与面板侧契约
（`src/shared/contracts.ts`、`src/shared/desktop-contract.ts`）。目的是让采集结果与界面行为
保持一致：字段名、枚举拼写、缺失值规则、日期/范围口径和连接身份都必须逐条对上，而不是只处理
成功请求。表中「早先实现」一列记录历史行为，用于解释为什么某些命名与兼容规则保留至今。

对照样例（脱敏）存放在 [`fixtures/contracts/`](../../fixtures/contracts/)：

| 样例 | 覆盖内容 |
| --- | --- |
| `codex-windows.json` | 窗口长度、重置时间单位、缺失值、不兼容响应 |
| `glm-connections.json` | GLM 套餐与钱包两个连接的独立标识、币种、未知额度项 |
| `deepseek-currencies.json` | 多币种余额、可靠零值、估算消费、不新增未验证指标 |
| `provider-errors.json` | 错误种类、状态映射、失败后保留最后一次成功快照 |
| `daily-statistics.json` | 时区、本地日界线、Codex 日期桶、GLM 查询区间、余额估算 |
| `redaction.json` | 请求头、嵌套字段、进程输出、账号掩码的脱敏结果 |

样例的 `input` 与 `expect` 是采集实现的验收依据，行为变化必须同时更新样例对应的测试。
Rust 侧由 `crates/usage-core/tests/contract_conformance.rs` 校验（`npm run rust:test`），
面板侧共享契约由 `tests/contracts.test.ts` 校验（`npm test`）。

## 1. 窗口（quota window）

| 项 | 早先实现 | 当前要求 |
| --- | --- | --- |
| Codex 主/次窗口 | `primary` / `secondary`，`windowDurationMins` × 60 = `windowSeconds` | 保持同一字段与换算，缺 `windowDurationMins` 时该指标不带 `windowSeconds` |
| Codex 重置时间 | `resetsAt`（Unix 秒）× 1000 → ISO-8601 | 仍是秒转毫秒后输出带偏移的 ISO-8601；缺 `resetsAt` 时不写 `resetAt` |
| Codex 桶 | `rateLimitsByLimitId` 优先，否则回退 `rateLimits`；桶 ID 取 `limitId` 或对象键 | 同前；桶 ID 必须进入指标 `details.bucketId`，供五小时/每周仪表定位 |
| Codex 已用/剩余 | `usedPercent` 与 `100 - usedPercent` 成对输出 | 同前，`direction` 分别为 `used` / `remaining` |
| GLM 窗口识别 | `WEEK*` 或 `7d`/`168h` → `weekly`；`TOKENS_LIMIT` 或 `5h` → `5h`；`TIME_LIMIT` → `tools.monthly` | 同前，键名固定 `quota.<window>.used` / `.remaining` |
| GLM 窗口长度 | `durationSeconds(windowDuration)`，缺失时按 5h=18000 / weekly=604800 兜底 | 同前，兜底值不得用于其它窗口 |
| GLM 未识别额度项 | 仅写入 `diagnostic.unknownLimits`，不生成指标 | 同前，且诊断内容必须脱敏 |
| DeepSeek | 没有额度窗口，只有余额 | 不新增套餐或 Tokens 窗口；无可靠来源即不渲染 |

不变量：**没有窗口来源的用量不得标为今日**；窗口指标的值缺失时必须为 `null`（`MetricValue::Null`
／`value: null`），不能变成 `0`。

## 2. 币种与金额

| 项 | 早先实现 | 当前要求 |
| --- | --- | --- |
| DeepSeek 余额 | `balance_infos[]` 每项拆成 `total` / `granted` / `topped-up` 三个指标，`unit` = 币种，`direction` = `balance` | 同前；每个币种各自成组，不合并、不换算汇率 |
| 数值形态 | `"86.42"` 字符串金额 → number；`0` 是可靠零值 | 同前；解析失败按不兼容处理，不落 0 |
| GLM 钱包 | `balance` + `currency` → `wallet.<CUR>.balance`，`confidence` 含 `experimental` | 同前；接口不兼容时保留上次成功值并报告不兼容 |
| Codex 额度 | `credits.balance` 为字符串，`unit` = `credits` | 同前，按数值输出，缺失不补 0 |
| 消费估算 | `spend.<CUR>.daily`，`direction` = `spend`，`confidence` 含 `estimated`（覆盖不完整时加 `partial`） | 同前，且必须按平台、连接、币种、日期隔离 |
| 消费账单 | `spend.<CUR>.daily.billed`，`direction` = `spend`，`confidence` 含 `experimental`，来源为网页后台接口，带本地日 `scope` | 实验通道，默认关闭；桌面主卡仅在连接开启且已配置 Token 时展示账单值，不展示余额差分估算 |
| 展示 | 界面按 `unit` 走货币格式化，失败时退化为 `数值 + 币种` | 同前；币种缺失不得猜默认币种 |

## 3. 来源标识（source）

| 来源字符串 | 产生者 | 当前要求 |
| --- | --- | --- |
| `codex-app-server` | Codex stdio JSON-RPC | 保持 |
| `glm-monitor` | GLM 套餐监控接口 | 保持 |
| `glm-wallet-experimental` | GLM 实验钱包接口 | 保持 |
| `deepseek-balance` | DeepSeek 余额接口 | 保持 |
| `deepseek-web-usage` | DeepSeek 实验网页用量连接（开发者后台同款接口） | 实验通道，默认关闭；失败不影响稳定通道 |
| `balance-delta-estimator` | 余额差分估算 | 保持 |
| `<source>+experimental` | 旧编排器对「稳定 + 实验」合并结果的标记 | 不作为当前实现依据：新契约按连接保存来源与健康状态，不靠字符串拼接表达 |

新契约在保留 `source` 的同时增加**连接标识**与数据能力标记；界面按连接渲染，不解析来源字符串。

## 4. 错误与状态

| 项 | 早先实现 | 当前要求 |
| --- | --- | --- |
| 错误种类 | `missing_config` / `authentication` / `compatibility` / `network` / `rate_limit` / `process` / `storage` / `unknown` | 枚举拼写完全一致；未知种类不得导致解析失败 |
| 无数据快照状态 | `missing_config`、`authentication` → `disconnected`；其余 → `unavailable` | 同前 |
| 失败后缓存 | 保留 `snapshot`，`status` 变 `degraded`，追加 `stale` 置信度，`capturedAt`/`lastSuccessAt` 不改 | 同前，重启也不得把重启时间当作采集时间 |
| 失败计数 | 编排器按连接累计连续失败并计算退避 | 依赖连接级（GLM 套餐与钱包分别累计），任一方失败不影响另一方 |
| 错误文案 | 中文界面按种类映射（需要配置 / 认证失败 / 请求受限 / 接口不兼容 / 网络异常） | 保持同一映射，新增状态沿用同一词汇表 |

`provider-errors.json` 的 `cachedSnapshot`/`expect` 明确要求：失败时 `metrics` 保持原值，
不得清空或置零。

## 5. 统计日期与范围

| 项 | 早先实现 | 当前要求 |
| --- | --- | --- |
| 时区 | 启动时读取 `AGENTS_USAGE_TIMEZONE`，默认系统时区；非敏感设置可改 | 同前，持久化在非敏感设置中 |
| 本地日界线 | 余额观测用 `Intl.DateTimeFormat('en-CA', { timeZone })` 求 `YYYY-MM-DD` | 同一口径；同一瞬间在两侧必须落到同一天 |
| Codex 每日 Tokens | `dailyUsageBuckets` 中 `startDate` **等于 UTC 当日** 的桶才生成 `activity.daily.tokens` | 保持「按响应日期匹配」的语义，同时记录统计日期与范围；早先实现用 UTC 日期匹配、与本地日界线不一致，属于需要统一的差异（见下） |
| GLM 活动区间 | `startTime` = 昨天同一小时，`endTime` = 今天同一分钟（滚动约 24 小时） | **修正**：区间改为配置时区「统计日 00:00:00」到当前时刻；只有接口时区与响应范围确认一致后才标为今日 |
| 消费估算日期 | 观测记录带 `local_day`，跨日先结算前一天 | 同前，且按连接、币种隔离；半日启动标记覆盖不完整 |
| 倒计时 | 由绝对 `resetAt` 与当前时间计算，归零显示等待刷新 | 同前；前端定时器不直接触发无界请求 |

**需要解决的差异（属任务 3.4/4.2 范围）**：Codex 的每日桶用 UTC 日期匹配，而余额估算用配置时区
的本地日期。当前实现必须让「今天」的口径唯一：要么按响应确认的统计范围标注并单独呈现，要么统一
到配置时区。无论选择哪种，`daily-statistics.json` 已固定「同一瞬间 → 同一天」的验收要求。

## 6. GLM 连接标识

| 项 | 早先实现 | 当前要求 |
| --- | --- | --- |
| 连接身份 | provider 级快照；套餐是 stable 通道，钱包是 experimental 通道，结果由编排器合并 | 连接级：`glm-quota` 与 `glm-wallet` 各自持有凭据、有效性、超时、缓存与最后成功时间 |
| 连接身份的判定 | 面板按 `state.connection ?? snapshot.connection` 派生，两者都缺时当作主连接 | 服务按连接逐条发布，身份在 `connections`；面板必须按 state 级标识 → 快照标识 → `connections` 中唯一一条解析（`stateConnection()`），只有无法判定时才退回主连接。首次成功之前同样要判对，否则已关闭的实验连接会以「余额／Coding Plan」的名义混进底部连接状态 |
| 关闭的实验连接 | 无 | 开关关闭时既不采集也不写健康记录（关闭是用户的选择，不是连接故障）；面板据此既不把它计入「连接异常」，也不在浮层里列出 |
| 关闭后的残留读数 | 无 | 关闭只停止采集与记录，不擦除上次落库的快照，服务照旧把它发布出去；因此总览必须主动摘掉该连接（`switchedOffConnection()` 走 `withoutConnection`），卡片再按 `glmWalletEnabled` / `deepseekWebEnabled` 兜一层，否则关闭前采集到的余额会一直显示在一个再也不会更新的模块里 |
| 显隐 | 无（旧 Node 只有实验开关 `glm.wallet.enabled`） | 桌面侧也只有一个开关：`glmWalletEnabled` 同时决定采集与卡片上的钱包模块是否出现，没有独立的显隐设置；关闭保留凭据，撤销凭据只走凭据表单的删除按钮（与 `deepseekWebEnabled` 一致） |
| 合并方式 | 成功则拼接指标并在 `source` 加 `+experimental`，失败写入 `diagnostic.experimentalError` | 按连接合成视图：任一方失败或未启用时，另一方照常显示，不共享错误 |
| 凭据 | 套餐 `glm/default`，钱包 `glm/wallet-experimental` | 保持同一 Keychain 服务名与账号标识 |
| 启用语义 | 钱包由 `glm.wallet.enabled`（或环境开关）控制，关闭时删除钱包凭据 | 桌面侧一个开关管采集与展示，关闭既不采集也不显示、但保留凭据；删除凭据是独立的显式操作，且始终不影响套餐连接 |
| DeepSeek 网页用量连接 | 无 | 实验连接 `deepseek:web`，凭据 `deepseek/web-experimental`（网页登录 Token），由 `deepseekWebEnabled` 设置控制；关闭保留凭据，采集失败仅影响该连接，桌面主卡不回退展示余额差分估算 |
| 网页登录态被拒 | 无 | 后台业务码 `40002 Missing Token` 与 `40003 Authorization Failed (invalid token)` 都算认证失败（引导重新粘贴）；写入前去掉粘贴值自带的 `Bearer ` 前缀，整段 `Authorization` 头不应因此被判成无效 |
| 网页用量的查询窗口 | 无 | 后台用量页只提交整日窗口（`start` = 本地日零点，`end` = 下一个本地日零点，另带 `tz` 偏移秒），因此实验采集也提交完整本地日，SHALL NOT 用「当前时刻」当窗口终点 |
| 网页用量载荷位置 | 无 | 后台前端读 `data.biz_data`；载荷直接放在 `data` 下（少一层包装）时按同一份载荷读取；两种都读不到时按接口不兼容报错，错误文案必须点明缺失位置并列出信封字段名（字段名不是值） |
| 凭据校验失败的回显 | 早先的实现把服务应答里的 `error` 原样显示在表单里 | 面板必须显示同样的原因：宿主错误串 `service returned HTTP <status>: <body>` 在面板侧解码后复用同一套状态映射，命令名只用于服务没给出原因的情况 |
| 凭据状态形状 | Node 旧服务回按目标键控的对象（钱包键名 `glmWallet`） | 桌面服务回带 `target` 字段的状态数组；面板两种形状都读，任一形状下「已配置 + 末尾掩码」都必须显示出来 |

## 7. 缺失值与序列化约定

- 缺失一律为 `null`（Rust `Option::None` → `null`），**禁止**用 `0`、空字符串或「暂不可用」占位；
  只有平台确实返回的 `0` 才作为可靠零值展示。
- 契约字段命名保持 camelCase（Rust 用 `#[serde(rename_all = "camelCase")]`）；外部接口字段保持
  其原始命名（如 `usedPercent`、`balance_infos`、`nextResetTime`），转换只发生在适配器内部。
- 时间戳统一为带偏移的 ISO-8601；外部时间戳单位（Codex 秒、GLM 毫秒）在适配器内换算并写入样例。
- 枚举拼写（provider、confidence、direction、status、error kind）与旧契约完全一致。
- 账号掩码沿用「最后四位」规则，且只用于展示，不落库、不进日志。

## 8. 覆盖范围说明

- 样例只覆盖契约语义与解析结果，不访问真实账号；`glm-connections.json` 的钱包端点使用
  `example.invalid`，真实端点可达性属任务 8.7 的实账号验证。
- Codex 的 `account/usage/read` 属于可选数据：整项缺失时隐藏指标，不影响额度数据（任务 6.6）。
- 未验证来源（DeepSeek 套餐、DeepSeek/GLM 每日 Tokens）不进入样例，也不得实现。
