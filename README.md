# agents-usage

一个只在本机运行的 AI 用量面板，把 Codex 订阅额度、GLM Coding Plan 配额、DeepSeek 钱包余额与本地估算的今日消费放在同一个页面中。采集器只读取用量数据，不会调用模型、购买额度、充值、修改订阅或消耗 Codex 用量重置。

## 支持的数据

- **Codex**：通过本机 `codex app-server` 和当前 Codex 登录读取所有可用额度窗口、重置时间、计划类型、credits，以及客户端支持时的活动统计。
- **GLM Coding Plan**：从所选中国区或国际区的只读 monitor 接口读取五小时、每周等配额及活动数据。
- **DeepSeek**：通过官方余额接口分别展示每种币种的总余额、赠送余额和充值余额；今日消费根据本机连续余额样本估算。
- **GLM 钱包（实验）**：默认关闭，仅供已确认端点兼容性的高级用户使用。它依赖非公开稳定接口，数据和认证方式可能随时失效，且故障不会影响 Coding Plan 数据。

## 本地安装与启动

需要 macOS、Node.js 24 或更高版本，以及已安装的 Codex CLI。

```bash
npm install
npm run build
npm start
```

默认打开地址为 `http://127.0.0.1:4715`。服务只允许 IPv4 或 IPv6 回环地址，生产构建由同一进程提供页面和 API。

开发模式：

```bash
npm run dev
```

## 连接账号

1. **Codex**：先在 Codex 应用或 CLI 中完成登录。面板把认证委托给 `codex app-server`，不会读取或复制原始认证文件。
2. **GLM**：在“连接设置”选择中国区或国际区，输入 Coding Plan API Key。新密钥会先通过只读用量请求验证，再替换旧值。
3. **DeepSeek**：输入 API Key；验证仅调用官方 `/user/balance` 读取接口。
4. **实验 GLM 钱包**：先配置 `AGENTS_USAGE_GLM_WALLET_ENDPOINT` 为明确的 HTTPS 端点，再在页面阅读风险提示并启用，随后录入单独的账号凭据。关闭功能会删除这份实验凭据。

GLM 和 DeepSeek 的密钥只存入 macOS Keychain。浏览器只能看到“是否已配置”和末四位提示，无法取回已保存的值。

## 如何理解数据标签

- **平台数据**：来自平台拥有或正式文档描述的只读接口。
- **实验功能**：来自没有公开稳定契约的接口，可能突然不可用。
- **估算**：由本机观测推导，不等同于账单。
- **部分数据**：当天并非从本地零点开始持续观测，可能漏算离线期间消费。
- **已过期**：最新采集失败，当前仍展示上一次成功快照。
- **不可用**：平台没有提供该值，或尚无成功快照；不会用 `0` 冒充未知值。

额度同时保留“已用”和“剩余”语义。重置时间显示绝对本地时间和动态倒计时；倒计时归零后只会显示“等待刷新”，不会自行假定额度已经恢复。不同币种不会相加或换算。

### DeepSeek 今日消费限制

今日消费等于同一币种当天相邻余额样本的正向下降之和。充值、赠送或退款造成的余额增加会被视为调整边界且不产生负消费。服务未运行、网络中断或当天中途首次启动都可能漏掉消费，因此结果始终标记为“估算”，覆盖不完整时还会标记为“部分数据”。它适合预算提醒，不适合作为发票或财务对账依据。

## 配置

常用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENTS_USAGE_HOST` | `127.0.0.1` | 仅接受 `127.0.0.1` 或 `::1` |
| `AGENTS_USAGE_PORT` | `4715` | 本地 HTTP 端口 |
| `AGENTS_USAGE_TIMEZONE` | 系统时区 | DeepSeek 日界线和显示时区 |
| `AGENTS_USAGE_DATA_DIR` | `~/Library/Application Support/agents-usage` | SQLite 数据目录 |
| `AGENTS_USAGE_OBSERVATION_RETENTION_DAYS` | `30` | 余额明细保留天数；旧明细压缩为每日摘要 |
| `AGENTS_USAGE_EXPERIMENTAL_GLM_WALLET` | `false` | 实验钱包的初始开关；页面设置会覆盖它 |
| `AGENTS_USAGE_GLM_WALLET_ENDPOINT` | 空 | 实验钱包 HTTPS 读取端点 |

各平台还支持 `AGENTS_USAGE_<PROVIDER>_REFRESH_MS`、`_TIMEOUT_MS`、`_COOLDOWN_MS` 和 `_MAX_BACKOFF_MS`，其中 `<PROVIDER>` 为 `CODEX`、`GLM` 或 `DEEPSEEK`。

## 数据、诊断与恢复

SQLite 默认位于 `~/Library/Application Support/agents-usage/usage.sqlite3`。`GET /api/diagnostics` 会显示数据库位置和大小、采集器版本、最后成功时间、当前退避、兼容性错误和凭据是否存在；所有内容在返回前统一脱敏。

重置前先停止服务。删除上述 `agents-usage` 数据目录会清除快照、余额样本、每日摘要和非敏感设置，但不会自动删除 Keychain 项。建议先在面板逐一删除 GLM、DeepSeek 和实验钱包凭据，再删除数据目录。重启后会得到全新的本地状态。

卸载时执行同样的凭据删除流程，停止服务，然后移除项目和应用数据目录。卸载不会更改任何远端提供商账户或订阅。

## 验证

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:browser
npm run test:security
npm run test:e2e
npm run build
```
