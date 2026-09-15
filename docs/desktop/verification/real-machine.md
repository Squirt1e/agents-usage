# 实机验证记录（任务 8.6 可自动化的部分）

本文件记录在真实 macOS 会话上、无需人工交互即可完成的那部分验证。需要人眼/交互/真实凭据的
部分（8.4 视觉对照、8.5 菜单栏交互、8.7 实账号、8.8 完整性能）在下方标注为「待人工确认」。

- 机器：macOS 26.6.2（Intel x86_64），app 来自
  `target/x86_64-apple-darwin/release/bundle/macos/Agents Usage.app`。

## 已自动验证（8.6 的打包与生命周期）

| 项 | 结果 |
| --- | --- |
| 打包 | `npm run build:desktop` 产出 `Agents Usage.app`（13MB）与 `Agents Usage_0.1.0_x64.dmg`（8.98MB） |
| 无 Node 启动 | `open` 启动后，`Contents/MacOS/` 下只有两个原生二进制：`agents-usage-desktop` 与 `usage-service`，没有 Node 参与 |
| 服务侧车启动 | 宿主启动后自动 spawn `usage-service`，服务在 0.54s 内发布 `service.json`（端口 47160） |
| 服务发现 | `service.json` 含 protocolVersion/instanceId/sessionToken/host/port/pid/ownedByDesktop，权限为仅当前用户可读 |
| Codex 发现 | 宿主发现本机 Codex（node `codex`），服务 spawn `codex app-server --stdio` 并取到真实额度快照（`codex.primary.used`、`secondary`、`credits.balance`、`activity.daily.tokens`） |
| DeepSeek 实账号 | 复用既有 Keychain 凭据，取到真实余额 `wallet.CNY.total/granted/topped-up` 与 `spend.CNY.daily` 估算 |
| GLM | 未配置凭据 → 套餐/钱包连接返回空快照（如实展示「未配置」，没有伪造数据） |
| 脱敏 | `/api/bootstrap`、`/api/snapshots`、`/api/diagnostics` 响应中无原始密钥；Keychain 只返回掩码后缀（如 `23cb`） |
| 认证 | 无 `X-Session-Token` 的写请求返回 403（由 service 集成测试覆盖） |
| 有序退出 | `osascript quit` 后，宿主 + 服务 + Codex 子进程全部退出，无残留（父进程看门狗 + Codex stdio 关闭） |
| 部署目标 | 二进制 `LC_BUILD_VERSION minos 10.15`，与 `tauri.conf.json` 一致 |

### 实测数值（8.8 部分）

| 指标 | 实测 |
| --- | --- |
| 启动到服务发现 | ~0.54s |
| 宿主（含 WebView）常驻内存 | ~60.5MB RSS |
| 服务常驻内存 | ~9.8MB RSS |
| 空闲 CPU | ~0.0%（采样时刻） |
| app 体积 | 13MB |
| dmg 体积 | 8.98MB |

## 待人工确认

- **8.4**：面板视觉与 PNG 对照。已截取菜单栏托盘图标截图
  `docs/desktop/verification/menubar-tray.png`（3584×2240，含托盘图标），但面板窗口本身需要
  点击托盘图标才会展开，且本环境无法进行图像对比。请在真机点击托盘图标，对照
  `openspec/changes/add-macos-menubar-usage-panel/assets/overview.png` 等图核对密度/配色/布局。
- **8.5**：失焦收起、置顶、拖动、位置恢复、多屏/缩放、钉住后切换桌面、全屏/Space/Mission
  Control 行为。需要人机交互，无法无头验证。多屏定位已修掉一个实机问题，复测时按这个顺序点一遍：

  > 本机是 2x 内置屏（1792×1120 点）＋ 1x 外接屏（2560×1440），外接屏顶边高出 320 点。
  > 面板原先按「目标屏的物理像素」下 `set_position`，而 tao 的 macOS 后端是用**窗口当前所在屏**
  > 的缩放系数把物理位置换算成窗口坐标的——目标屏与窗口所在屏缩放不同时就会错位：点外接屏的
  > 图标，面板落在离外接屏左边一半距离处（贴着内置屏），再点回内置屏的图标又过不来（窗口一直
  > 留在外接屏内）。现在整条定位链路都在**点**空间里算，并用 logical position 移动窗口，两个
  > 方向的切换都正确。
  >
  > 复测路径：内置屏点开 → 外接屏点开（应贴外接屏的图标，不是贴着内置屏）→ 外接屏再点 → 内置屏
  > 点开（应回到内置屏）。`tests::the_panel_is_placed_in_points` 与
  > `tests::a_display_reads_in_points_not_in_its_own_pixels` 守住这两个前提。

  钉住跨桌面（任务 5.7）：钉住面板并拖到屏幕中任意位置 → 切到另一个桌面（Control+→ 或三指
  横扫）→ 面板应在新桌面的同一位置可见，不需要再点菜单栏图标；取消钉住后再切一次 → 面板留在
  原桌面。某个应用的全屏 Space 不在范围（面板不会浮在全屏窗口之上）。接线由
  `tests::pinning_is_what_ties_the_panel_to_every_desktop` 守住，但它只证明窗口集合行为跟着
  钉住状态走，实机可见性仍需人眼确认。
- **8.7**：GLM 套餐/钱包的实账号验证。当前机器未配置 GLM 凭据，无法接通；如提供真实 GLM
  凭据可复测。DeepSeek 已用真实凭据接通（见上）。
- **8.8**：显示/刷新瞬间的 CPU 峰值、内存变化与完整性能测量；以上仅为采样值。

## 结论

桌面版能在当前 Mac 上无 Node 启动、发现并驱动 Codex、复用 Keychain 凭据读取 DeepSeek 余额、
通过回环 HTTP 服务面板与配套网页，并在退出时清理全部子进程。剩余验收项需要人眼与真实 GLM
凭据，无法在无头环境代完成。

## DeepSeek 实验网页用量连接（add-deepseek-web-usage-collector）

需要真实网页登录态，自动化测试无法覆盖，按下述步骤人工验证：

1. 登录 platform.deepseek.com，打开开发者工具，从任一 `platform.deepseek.com/api/`
   请求复制 `Authorization` 请求头中 `Bearer ` 之后的整段 Token。
2. 面板 → 配置 DeepSeek → 「网页用量连接」：确认开关默认关闭；打开开关，粘贴 Token，
   点「验证并保存」。校验通过后应显示掩码后缀（如 `····ab12`）。
3. 手动刷新 DeepSeek：卡片「今日消费」应显示账单值并带「实验数据源」标记，且与后台
   用量页的当日消费一致（按币种分别核对，不得与其他币种相加）；「今日 Tokens」「今日请求」
   出现数值。CNY 估算标记（橙色「估算」）不再出现在今日消费条目上。
4. 关闭「网页用量连接」：卡片只保留余额，今日消费、Tokens 与请求次数整体隐藏；重新打开后
   无需重新粘贴 Token 即可恢复采集。开启但删除 Token 时，主卡显示毛玻璃用量占位，不出现
   「前往配置」式状态块。
5. 登出后台或等待 Token 过期后刷新：网页用量连接显示认证错误与重新粘贴引导，
   余额展示不受影响，主卡不回退显示估算消费。

### 一次实机粘贴失败的排查（fix-credential-validation-feedback）

在真机上粘贴网页登录 Token 校验失败，面板只显示「桌面宿主命令失败: panel_validate_credential」。
按当时运行的实例逐个核对（读服务发现文件，查 `/api/settings`、`/api/snapshots`，并对
`platform.deepseek.com` 的两个用量接口做只读探测）：

| 观察 | 结论 |
| --- | --- |
| 服务返回 `credentials: [{target:"deepseek", configured:true, suffix:"23cb"}, …]`，面板却显示「尚未配置」 | 面板只认按目标键控的对象，凭据状态全部读丢（已修） |
| 直接 `PUT /api/credentials/deepseek-web` 提交无效值 → `400 {"error":"DeepSeek web cost rejected the request (code 40003): Authorization Failed (invalid token)"}` | 校验链路本身通；服务给出了原因，面板把它换成了命令名（已修） |
| 无 `Authorization` 头 → `40002 Missing Token`；无效 Token → `40003 Authorization Failed (invalid token)`（HTTP 200 信封） | 40003 属认证失败，旧代码归为 `compatibility`，界面因此提示「接口可能已改版」（已修） |
| 服务进程的 reqwest 能拿到后台真实业务应答 | 本机网络、代理与固定 origin 都不是失败原因 |

失败那次的粘贴值没有被记录（服务不落库失败值、Keychain 未写入），因此「当时粘的是不是有效
Token」无法回放；修复后同样的失败会显示服务给出的原因，并且整段 `Authorization` 头可以直接粘贴。
用真实有效 Token 复测（任务 5.3 的剩余部分）仍需人工完成。

### 复测第二轮：认证通过后的两个问题

第二轮粘贴（同一台机器、同一个 Token）越过了认证，改为在解析阶段失败。面板显示的是
`桌面宿主命令失败: panel_validate_credential (service returned HTTP 400 Bad Request: {"error":"the
DeepSeek web cost response no longer provides biz_data"})`。

| 观察 | 结论 |
| --- | --- |
| 宿主抛的是 `service returned HTTP 400 Bad Request: …`（Rust 的 `StatusCode` 带状态短语），第一版的解码正则只认 `HTTP 400:` | 解码漏配 → 整串宿主错误被当作文案显示（已修，正则接受可选短语，测试用这条原文） |
| 失败文案是一整句英文，凭据状态行是单行 flex | 「尚未配置」被压成每行一个字（竖排）（已修：状态不收缩、反馈独占一行、无空格文本断行，`panel-width` 守卫 + 入场动画登记） |
| 对着后台前端 bundle（`fe-static.deepseek.com/platform/static/main.*.js`）核对：`by_api_key/cost`、`amount` 的 query 只有 `start`/`end`/`tz`，而 `end` 由 `h7(endDate,tz)+86400` 得出 | 后台只提交**整日**窗口；我们发的是「当前时刻」（已修：窗口改为完整本地日） |
| 登录态校验走的是 `PUT /api/credentials/deepseek-web` → 采集器实测一次 | 认证已通过（40003 消失），说明 Token 与 `Bearer ` 归一化都没问题 |

如果重测仍报接口不兼容，错误文案会给出后台实际返回的信封字段名——这是这一轮补上的诊断，用它即可
判断后台改成了什么形状，不需要再靠猜。
