# 桌面版（macOS 菜单栏面板）开发说明

本目录说明如何构建、运行与验证
[`add-macos-menubar-usage-panel`](../../openspec/changes/add-macos-menubar-usage-panel/proposal.md)
变更引入的桌面路径。规划依据是同一变更下的 `proposal.md`、`design.md`、`specs/` 与
`tasks.md`；本文件只描述工程入口，不替代规格。

## 仓库结构

```
Cargo.toml                      Rust workspace 根（成员见下）
.cargo/config.toml              构建目标与最低系统版本链接参数
crates/usage-core/              采集核心：契约、适配器、存储、凭据、估算、调度
crates/usage-service/           独立可执行服务：占用数据目录、回环 HTTP/SSE
src-tauri/                      Tauri 宿主：菜单栏、窗口生命周期、受限命令/事件桥
src/shared/                     与前端共享的契约与脱敏（TypeScript）
src/client/                     现有网页仪表盘（保持不变）
src/desktop/                    桌面紧凑面板入口（约 350 逻辑像素）
tools/cargo.sh                  cargo 包装脚本（见「环境注意事项」）
tools/tauri.sh                  Tauri CLI 包装脚本
scripts/desktop/                面板前端构建/开发入口
docs/desktop/                   环境基线、依赖锁定、语义对照、验收记录
```

面板组件的职责边界、样式 Token、状态语义、动效要求与新功能接入清单见
[`component-and-style-guide.md`](component-and-style-guide.md)。它从当前实现提炼工程约束；具体功能
行为仍以 `openspec/` 为准。

## 命令

旧网页路径（未改动，仍然可用）：

```bash
npm run dev        # Node 服务 + Vite 网页开发
npm test           # vitest 全量
npm run build      # 构建服务端 + 网页 + 桌面面板前端
npm start          # 运行已构建的 Node 服务
```

桌面路径：

```bash
npm run build:desktop-web   # 构建面板前端到 dist/desktop-client
npm run build:desktop       # Tauri 打包（app + dmg）
npm run rust:check          # cargo check --workspace --all-targets
npm run rust:test           # cargo test --workspace
npm run rust:clippy         # cargo clippy，警告视为错误
npm run dev:desktop         # 热更新模式：构建 service 后交给宿主托管，Vite 由 beforeDevCommand 拉起
```

### 热更新（改样式/界面）

`npm run dev:desktop` 即热更新模式，启动后面板自动弹出并保持钉住，直接改代码即可：

- `src/desktop/panel.css`、`*.tsx`、`*.ts` 的改动经 Vite 热替换，无需重启宿主。
- `src-tauri/` 的 Rust 改动由 `tauri dev` 监听并自动重编译、重启应用；它同时还监听
  `crates/usage-core`（宿主依赖），但**不会构建 service 二进制**。
- **service 的改动不会自动生效**：service 只在 `npm run dev:desktop` 启动时构建一次。
  改了 `crates/usage-service/**`（或任何影响 service 的 `crates/**`）必须
  `bash tools/cargo.sh build -p usage-service` 并重启 dev 会话，否则面板连的还是旧 service——
  症状是新增的设置项写不进去、`/api/settings` 里缺字段，看起来像前端有 bug。
  打包版对应的是 `src-tauri/binaries/usage-service-<triple>`，由
  `node scripts/desktop/build-service.mjs`（`build:desktop` 的一环）暂存。
- service 进程由宿主托管：已有实例则复用，否则自动拉起并在退出时回收。因此单独的
  `npm run dev:service` 不再进入并发列表——它遇到已运行实例会按 CLI 语义直接退出，
  之前会把整个 dev 会话一起带崩。
- Vite 开发服务器由 `tauri.conf.json` 的 `beforeDevCommand` 唯一持有（端口 5174），
  退出时随之回收；不要再手动另起 `npm run dev:desktop-web`，否则会端口竞争。
- 打包版不受影响：面板仍是隐藏、点击托盘展开的弹层行为（自动显示只存在于
  `tauri::is_dev()` 分支）。dev 构建使用独立标识（`src-tauri/tauri.dev.conf.json`），
  可与已安装的打包版同时运行，两者共用同一个本地服务；停止 dev 会话用 Ctrl+C（或退出
  面板应用）。

单独运行服务二进制：

```bash
bash tools/cargo.sh run -p usage-service -- --self-check   # 不触碰网络/钥匙串/数据目录
```

## 两个版本的关系

- 旧 Node 网页继续使用 `~/Library/Application Support/agents-usage/usage.sqlite3`，端口
  仍是 4715。桌面路径不打开、不迁移、不改写该数据库。
- Rust 服务使用独立数据目录（设计为
  `~/Library/Application Support/agents-usage/desktop/`），默认端口与 4715 不同，并在被
  占用时公布实际端口。
- 两个版本共用 macOS 钥匙串中既有的服务名与账号标识，不复制密钥。桌面端在
  `agents-usage.deepseek` 下额外维护 `web-experimental` 账号项（实验性网页用量连接的
  登录 Token），由设置中的 `deepseekWebEnabled` 控制，默认关闭；旧 Node 网页不感知该
  连接，行为不变。
- 修改 `src/shared/` 或 `src/client/` 的共享代码后必须跑旧网页回归（`npm test`、
  `npm run typecheck`、`npm run lint`、`npm run build:client`）。

## 环境注意事项

1. **cargo 缓存**：本仓库的验证环境只允许写入仓库目录，而 cargo 需要写
   `$CARGO_HOME`，因此 `tools/cargo.sh` 把缓存指向仓库内的 `.dsh/cargo-home`，并把
   `CARGO_TARGET_DIR` 固定为仓库内的 `target/`。直接调用 `cargo` 在只读 `~/.cargo`
   的环境下会失败，请用包装脚本或 `npm run rust:*`。
2. **npm 缓存**：`~/.npm` 同样可能不可写，安装依赖时使用仓库内缓存：
   `npm install --cache "$PWD/.dsh/npm-cache"`。
3. **工具链**：仓库不提供 `rust-toolchain.toml`，因为固定精确版本会迫使 `rustup` 在每次
   全新检出时联网下载工具链，而本项目没有使用 nightly 特性。要求由
   `Cargo.toml` 的 `rust-version` 与状态说明描述。
4. **图标**：应用图标由品牌图生成（`bash tools/tauri.sh icon …`），生成结果已裁剪掉
   与 macOS 无关的平台目录。

## 当前实现进度

- 设置页说明只保留配置方法、操作后果与必要的数据源限制：正常连接不重复解释登录和连接关系，
  不展示 Keychain 内部账号项；故障恢复指引并入状态行。凭据获取步骤不写进面板——Token 怎么从
  浏览器拿到见 [`verification/real-machine.md`](verification/real-machine.md)，表单只留粘贴入口与
  占位提示。
  凭据校验失败时表单显示服务给出的原因，而不是宿主命令名：Tauri 宿主把服务的应答包成
  `service returned HTTP <status>( <状态短语>): <body>`（Rust 的 `StatusCode` 会带 `Bad Request`
  这类短语），面板（`src/desktop/desktop-client.ts` 的 `hostFailure`）解码后复用网页传输那套
  状态映射（`src/shared/usage-client.ts` 的 `serviceFailure`），传输层包装不进界面。原因可能是
  一整句，因此状态行允许换行：掩码/未配置与删除入口不收缩，反馈独占一行并在行内断行
  （`tests/panel-width.test.ts` 守住）。粘贴值自带的 `Bearer ` 前缀在服务端写入前被去掉，
  因此整段 `Authorization` 头也能直接用；凭据状态按服务实际返回的形状解析（本机服务是带
  `target` 字段的数组，旧网页是按目标键控的对象）。
- 采集核心（`crates/usage-core`）：契约、脱敏、Keychain、SQLite 存储、日消费估算、Codex/
  GLM/DeepSeek 采集器、连接级调度器，全部实现并有测试。
- 本地服务（`crates/usage-service`）：数据目录独占锁、私有服务发现、认证的回环
  HTTP/SSE API、受控退出。运行：`bash tools/cargo.sh run -p usage-service -- --timezone
  Asia/Shanghai`。
- Tauri 宿主（`src-tauri`）：模板托盘图标、左键展开/收起、右键菜单、无 Dock 生命周期、
  无装饰面板锚定、钉住/隐藏、单实例唤起、受限命令桥。钉住把窗口加入所有 Space，因此用户
  切换桌面后钉住的面板仍在新桌面上；取消钉住时清除该行为，临时弹出只留在它被展开的桌面。
  实现是一次性声明窗口集合行为（`apply_pinned` 里的 `set_visible_on_all_workspaces`），
  不是逐次切换重新显示窗口，面板位置不会被再次锚定。压在应用全屏窗口之上不在范围内
  （`canJoinAllSpaces` 不含 `FullScreenAuxiliary`，见变更的 `design.md`）。
  手动拖动后，内容或头部引起的高度更新会在原生窗口的一次操作里保留实时左上角，避免异步高度帧
  回放拖动前的旧坐标；高度上限按窗口当前所在屏幕计算，不再沿用托盘上次点击的屏幕；
  鼠标松开后先检查整个桌面的屏幕并集：面板仍完全在屏幕内时不回写位置；有任一部分出界时，
  选择平移距离最短的屏幕，只沿越界轴移动到最近边缘。拖动中不做纠偏，因此可以自然跨屏。
  顶边允许贴到屏幕边缘，以适应自动隐藏菜单栏的全屏空间。头部自动隐藏的鼠标命中判断先把
  主屏鼠标坐标与窗口坐标各自换算为点，跨不同缩放比例的屏幕也能正确计时；窗口首次显示且
  鼠标已在外面时同样开始计时。
- 面板界面（`src/desktop`）：约 350 逻辑像素中文紧凑主题，三平台总览、设置页（平台管理为
  第一项，支持指针拖拽与方向键排序并即时持久化；外观包含主题：浅色 / 深色 / 跟随系统，
  以及全局额度数值：剩余 / 已用；默认深色并显示剩余额度，跟随系统响应 macOS 外观变化）、Codex 双仪表、GLM 套餐/钱包、
  DeepSeek 余额与可选的网页账单用量、单平台配置。DeepSeek 网页用量连接关闭时主卡不显示今日
  用量，启用但未配置 Token 时只显示毛玻璃占位，不回退展示余额差分估算。两套配色共用同一组
  颜色变量，规则中不写硬编码颜色
  （由 `tests/panel-palette.test.ts` 守住）。浅色采用 macOS 设置风格的系统灰背景、白色分组卡片、
  中性深灰文字与细分隔线；平台管理行之间使用直线分隔，不给分隔线附加行圆角。操作、焦点和选中使用系统蓝，开启状态使用系统绿，青绿／草绿／靛蓝
  保留给平台额度与标识，详见
  [`refine-light-palette`](../../openspec/changes/refine-light-palette/proposal.md)。开关的关闭态由
  轨道表达，旋钮在关闭与开启两态都是同一个白色滑块（浅色下由 `--switch-thumb-shadow` 补出边界），
  禁用则整块淡化——关闭因此不会读作「点不动」，见
  [`fix-light-switch-off-state`](../../openspec/changes/fix-light-switch-off-state/proposal.md)。
  界面动效按仓库规则「所有切换都要有过渡动画」
  实现（`AGENTS.md` §1）：换页、窗口高度、状态切换、数值变化各自用 transition / animation /
  逐帧上报，`prefers-reduced-motion` 统一关闭，切换点登记在 `tests/panel-motion.test.ts`。
- 额度展示的圆环与进度条是同一条描边的两种几何，二者只能通过点击条目本身切换（整个条目都是
  热区，重置时间行只有自身可点时例外；设置页没有形态开关）。全局设置的「外观」提供一个
  「额度数值」的「剩余 / 已用」选择，统一作用于 Codex 与 GLM，默认显示剩余量；缺少所选方向的指标时显示
  `—`，不从另一方向伪造。形态切换动画见
  [`fix-quota-shape-morph`](../../openspec/changes/fix-quota-shape-morph/proposal.md)：几何由
  `src/desktop/quota-morph.ts` 的纯函数给出（断开解开 → 回直 → 下移三段），`QuotaDisplay`
  逐帧绘制（WebKit 没有可插值的 `d`），布局由 CSS 从 `--quota-drop` 推出，静态检查见
  `tests/panel-quota-morph.test.tsx`。
- GLM 套餐的 5 小时与每周额度由接口的窗口单位和数量区分；两者即使共用 `TOKENS_LIMIT` 或
  `CREDIT_LIMIT` 类型，也不会覆盖彼此。接口暂未返回每周额度时，卡片仍保留「每周额度」并显示
  `—`，不拿 5 小时的数值代替；月度工具额度若返回也照常显示。
- 手动刷新成功时不显示 toast；屏幕上该平台卡片的额度圆环/进度条与数字从 0 重播，即使新旧读数相同也重播。
  失败仍显示平台名加「刷新失败」的 toast，冷却和连接错误提示维持原状。数字重播使用 CSS 位移的数字列，
  减弱动效时由面板的统一规则直接显示最终读数。
- 刷新结果的成败来自服务刷新后发布的状态，而不是刷新应答：服务对手动刷新只回一句
  「已收到并执行」（`refresh-requested`），结果以该平台的新状态发布，因此客户端把它读成
  `RefreshStatus.requested`（不裁决），面板按卡片自身状态行所用的同一份事实判定。失败提示与成功重播只对
  结果到达时屏幕上确实存在的卡片执行——平台已被隐藏、已进入子页或面板还在加载态时不执行。
  见 [`fix-refresh-verdict-messages`](../../openspec/changes/fix-refresh-verdict-messages/proposal.md)。
- 高峰/错峰时段提醒见
  [`add-peak-window-reminder`](../../openspec/changes/add-peak-window-reminder/proposal.md)：
  判定是纯前端计算（`src/desktop/peak-windows.ts`，按定义自身时区取本地星期与时刻，支持跨午夜
  回绕），内置官方时段表目前只有 DeepSeek（北京周一至五 09:00–12:00、14:00–18:00，带来源与
  核实日期），无内置定义的平台（GLM/Codex）不显示时段信息；仅高峰时显示卡片警示描边、阴影与
  边界标签，错峰保持普通外观且无文字。面板展开期间跨过任一时段边界仍经现有 toast 提示一次；设置在每平台配置的
  「高峰时段提醒」区块（内置只读说明、自定义时段编辑器、关闭），设置字段 `peakReminder`
  两侧契约镜像且向后兼容。

尚未完成的是需要真实 macOS 桌面会话的验收（任务 8.4–8.8）：WebView 视觉对照、菜单栏实机
行为、Finder 启动、实账号只读验证与性能测量。
