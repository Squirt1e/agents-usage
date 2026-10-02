# 桌面版（macOS 菜单栏面板）开发说明

本目录说明如何构建、运行与验证
[`add-macos-menubar-usage-panel`](../../openspec/changes/archive/2026-09-15-add-macos-menubar-usage-panel/proposal.md)
变更引入的桌面路径。规划依据是同一变更下的 `proposal.md`、`design.md`、`specs/` 与
`tasks.md`；本文件只描述工程入口，不替代规格。

## 仓库结构

```
Cargo.toml                      Rust workspace 根（成员见下）
.cargo/config.toml              构建目标与最低系统版本链接参数
crates/usage-core/              采集核心：契约、适配器、存储、凭据、估算、调度
crates/usage-service/           独立可执行服务：占用数据目录、回环 HTTP/SSE
src-tauri/                      Tauri 宿主：菜单栏、窗口生命周期、受限命令/事件桥
src/shared/                     面板与服务共享的契约与脱敏（TypeScript）
src/desktop/                    两个窗口的前端：HTML 入口与样式留在根上，代码按窗口分目录
                                （panel/ 面板、settings/ 设置窗口，共用组件与逻辑在 components/、lib/）
tools/                           cargo 与 tauri 的包装脚本：绑定仓库内缓存（.dsh、target）后转发原命令
scripts/                         Node 脚本：前端构建/开发入口与提交信息校验
docs/desktop/                   环境基线、依赖锁定、语义对照、验收记录
```

面板组件的职责边界、样式 Token、状态语义、动效要求与新功能接入清单见
[`component-and-style-guide.md`](component-and-style-guide.md)。它从当前实现提炼工程约束；具体功能
行为仍以 `openspec/` 为准。

## 两个窗口

宿主开两个窗口，前端也对应两个 HTML 入口（`vite.config.ts` 的 `rollupOptions.input`，构建时都被
扁平化到 `dist/desktop-client` 根下）：

| 窗口 | 标签 | 入口 | 浏览器加载 | 外观与尺寸 |
| --- | --- | --- | --- | --- |
| 面板 | `panel` | `index.html` | `WebviewUrl::App("index.html")` | 无装饰、透明；标准模式 `350 × 内容高`，极简模式 `58 × 内容高`（详情优先显示在左侧，空间不足时显示在右侧），失焦保持可见、默认常驻 |
| 设置 | `settings` | `settings.html` | `WebviewUrl::App("settings.html")` | 系统标题栏、固定 `600 × 400`，不可缩放，失焦不关 |

- **设置只有这一个窗口。** 四个入口——面板顶部齿轮（→ 外观）、卡片配置图标（→ 该平台）、空状态的
  「管理平台」（→ 平台管理）、菜单栏图标右键的「打开设置」（→ 平台管理）——都走
  `panel_open_settings`；窗口已开时只前置并切到该分类，不开第二个。窗口建好后是隐藏的，
  前端挂载完成才调 `panel_settings_ready` 让宿主显示，因此看不到空窗口的首帧。
- **两个窗口共用一份设置。** 写入由宿主落盘后广播 `panel://settings` 给所有窗口，每个窗口各持一个
  `settings-store` 实例订阅它，并按值比较——同一个值再来一次算回声、不算变化，所以一次写入只让
  两边各重渲染一次。设置窗口改一项，面板当场反映。
  「这次写入是否改变采集内容」的判断在宿主（`providers_to_recollect`），不在发起写入的窗口——
  卡片在另一个窗口里，规则只写一份才不会漏。
- **面板不再有页面。** 设置与各平台配置都不在面板内，因此面板只剩总览一页：没有页面转场、没有
  「返回」按钮，窗口高度只由总览内容决定（上限是宿主按显示器算出的工作区）。浏览器里没有第二个
  窗口可开，`main.ts` 把同一套设置界面以 `600 × 400` 浮层挂到面板文档上。
- **开发期 URL**：面板走 `devUrl`（`http://127.0.0.1:5174/src/desktop/`），设置窗口走
  `http://127.0.0.1:5174/src/desktop/settings.html`（`settings_window_url()` 里按
  `tauri::is_dev()` 分支）。

## 命令

```bash
npm test                    # vitest 全量（面板、契约、动效与宽度守卫）
npm run build:desktop-web   # 构建面板前端到 dist/desktop-client
npm run build:desktop       # Tauri 打包（app + dmg）
npm run rust:check          # cargo check --workspace --all-targets
npm run rust:test           # cargo test --workspace
npm run rust:clippy         # cargo clippy，警告视为错误
npm run dev:desktop         # 热更新模式：构建 service 后交给宿主托管，Vite 由 beforeDevCommand 拉起
```

### 发布（交给 GitHub Actions）

发版是三步：升版本号 + 写 `docs/release-notes/v<version>.md`，提交并推 `main`；打标签
`git tag v<version>`；推标签 `git push origin v<version>`。只有第三步会出包，前两步随便推——
`.github/workflows/release.yml` 的三个作业接手，本地不再手工打包上传：

1. `plan`（ubuntu，几秒）：读 `package.json` 的版本号，再依次判断三件事——这次推送的是标签吗
   （分支推送到此为止，直接 `pack=false`）、标签名等于 `v<package.json 的版本号>` 吗（不等就报错
   退出：照版本号打包会发出一份张冠李戴的 release）、`v<version>` 是不是已经发过（远端有同名 tag，
   或者 `gh release view` 找得到那个 release——手工建的 draft 也算，所以别人先建了草稿时重复推送
   不会再打一次包）。三关都过才把 `pack=true` 交给后面的作业；这个结论同时写进 run summary，
   跳过时一眼看得出为什么没打包。这一阶段还要检查 `docs/release-notes/v<version>.md` 在不在，
   缺了就地失败——正文缺失是提交时就能发现的问题，没理由让它先花掉 macOS 上一整轮构建；失败不留
   半成品，补上文件再推一次标签就行。
2. `verify`（ubuntu）：`npm ci` + `typecheck` + `lint` + `test`。分支推送靠它当 main 的门禁，
   标签推送靠它当出包前的最后一道，所以两个入口都跑。Rust 侧的 `rust:check` / `rust:test` / `rust:clippy` **仍留在本地**：
   宿主依赖 macOS 专有框架，Linux runner 跑不了，而放到 macOS 上等于为同一份 workspace 再编译
   一遍——`release` 作业本来就会编译 release 二进制，编译错误在那里一定会暴露。
3. `release`（macos-latest，`if: needs.plan.outputs.pack == 'true'`）：`npm run build:desktop --
   --target universal-apple-darwin`。runner 是 arm64，另一份架构由 `dtolnay/rust-toolchain` 装上；
   `build-service.mjs` 照 `TAURI_ENV_TARGET_TRIPLE` 同时编译两份 sidecar 并 `lipo` 合并。cargo
   缓存落在工作区的 `.cargo-home`（覆盖 `tools/cargo.sh` 默认的 `.dsh/cargo-home`），
   `actions/cache` 按 `Cargo.lock` 缓存 registry 与 `target`——release 构建是 `lto` +
   `codegen-units = 1`，不缓存就要整轮重编。最后 `gh release create` 用 `--notes-file` 把仓库里
   那份已提交的正文贴上去并建公开的 `v<version>` release；不带 `--target`——标签是推上来的、
   已经指向这次提交，release 挂在它上面即可。Tauri 原始 dmg 在上传前统一改名为
   `Agents-Usage_v<version>-macos.dmg`——一次建成，之后不再碰它。

**release 正文写在仓库里**：`docs/release-notes/v<version>.md`，与该版本的版本号在同一条提交，
骨架见 [`docs/release-notes/TEMPLATE.md`](../release-notes/TEMPLATE.md)。「这个版本里有什么」
只写一句话，站在用户视角说这个版本与上一个版本的区别，不列提交；正文里不写校验和（资产页上的
SHA-256 由 GitHub 现算）。流水线不生成正文、不留 draft，所以补发一个包只要升版本号 + 写正文。

**一个版本只出一次包**，所以 release 上的 dmg 与它 tag 指向的提交是同一份代码，正文也不会被
后来的构建改掉。已存在的 release 一个字都不碰：真撞上同名 release（比如构建期间别人建了）
就报错退出，绝不覆盖已经发出去的资产。要重发某个版本（包本身有问题）：
`gh release delete v1.2.0 --cleanup-tag --yes` 删掉 release 与 tag，再重跑那次 run，`plan` 会
重新判定为要打包。（GitHub 的 immutable releases 开关正是这条规矩的强制版，打开也不再冲突。）

版本号只有 `package.json` 一处：`src-tauri/tauri.conf.json` 的 `version` 指向
`../package.json`（Tauri 打包时现读，落到 `CFBundleShortVersionString`），`Cargo.toml` 的
`[workspace.package] version` 必须跟着一致。`tests/release-pipeline.test.ts` 守住这三者与流水线的
接线（触发时机、版本号来源、打包目标、产物命名、只打一次、正文来源、正文缺失即失败、
出包即发布、已发出的资产与正文不再变动）；`tests/release-dmg-name.test.ts` 直接执行命名脚本，
确认文件内容原样保留且文件名精确匹配发布约定。

### 热更新（改样式/界面）

`npm run dev:desktop` 即热更新模式，启动后面板自动弹出并保持常驻，直接改代码即可：

- `src/desktop/panel.css`、`*.tsx`、`*.ts` 的改动经 Vite 热替换，无需重启宿主。
- `src-tauri/` 的 Rust 改动由 `tauri dev` 监听并自动重编译、重启应用；它同时还监听
  `crates/usage-core`（宿主依赖），但**不会构建 service 二进制**。
- **service 的改动不会自动生效**：service 只在 `npm run dev:desktop` 启动时构建一次。
  改了 `crates/usage-service/**`（或任何影响 service 的 `crates/**`）必须
  `bash tools/cargo.sh build -p usage-service` 并重启 dev 会话，否则面板连的还是旧 service——
  症状是新增的设置项写不进去、`/api/settings` 里缺字段，看起来像前端有 bug。
  打包版对应的是 `src-tauri/binaries/usage-service-<triple>`，由
  `node scripts/desktop/build-service.mjs`（`build:desktop` 的一环）暂存。
- service 进程由宿主托管：已有实例则复用，否则自动拉起并在退出时回收。因此不需要另外手动起
  `npm run dev:service`——它遇到已运行实例会按 CLI 语义直接退出。
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

## 数据与凭据位置

- 服务使用独立数据目录 `~/Library/Application Support/agents-usage/desktop/`，占用该
  目录的独占锁，并在端口被占用时公布实际端口（见 `service.json`）。
- 凭据存放在 macOS 钥匙串既有的服务名与账号标识下（`agents-usage.<provider>`），不复制
  密钥。实验性网页用量连接的登录 Token 是 `agents-usage.deepseek` 下的 `web-experimental`
  账号项，由设置中的 `deepseekWebEnabled` 控制，默认关闭。

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
4. **图标**：应用图标的唯一源图是
   `assets/brand/agents-usage-gauge-v1.png`（1024×1024、透明圆角画布）。运行
   `./node_modules/.bin/tauri icon assets/brand/agents-usage-gauge-v1.png --output src-tauri/icons`
   生成各平台资源；本仓库是 macOS-only，配置引用 `src-tauri/icons/icon.icns`（应用包）和
   `src-tauri/icons/icon.png`（Tauri 的 Unix 运行时默认窗口图标）。ICNS 容器包含 16、32、128、
   256、512 点的 1×/2×表示，命令额外生成的 Windows、iOS、Android 与其余散装 PNG 不入库。
   菜单栏模板图由 `node scripts/desktop/generate-tray-icon.mjs` 可重复生成：18×18 与
   36×36 PNG 只含黑色和透明度，宿主再通过 `icon_as_template(true)` 交给 macOS 自动着色。

## 当前实现进度

- 设置页说明只保留配置方法、操作后果与必要的数据源限制：正常连接不重复解释登录和连接关系，
  不展示 Keychain 内部账号项；故障恢复指引并入状态行。凭据获取步骤不写进面板——Token 怎么从
  浏览器拿到见 [`verification/real-machine.md`](verification/real-machine.md)，表单只留粘贴入口与
  占位提示。
  凭据校验失败时表单显示服务给出的原因，而不是宿主命令名：Tauri 宿主把服务的应答包成
  `service returned HTTP <status>( <状态短语>): <body>`（Rust 的 `StatusCode` 会带 `Bad Request`
  这类短语），面板（`src/desktop/lib/desktop-client.ts` 的 `hostFailure`）解码后复用网页传输那套
  状态映射（`src/shared/usage-client.ts` 的 `serviceFailure`），传输层包装不进界面。原因可能是
  一整句，因此状态行允许换行：掩码/未配置与删除入口不收缩，反馈独占一行并在行内断行
  （`tests/panel/panel-width.test.ts` 守住）。粘贴值自带的 `Bearer ` 前缀在服务端写入前被去掉，
  因此整段 `Authorization` 头也能直接用；凭据状态按服务实际返回的形状解析（本机服务是带
  `target` 字段的数组，早先的服务版本是按目标键控的对象）。
- 采集核心（`crates/usage-core`）：契约、脱敏、Keychain、SQLite 存储、日消费估算、Codex/
  GLM/DeepSeek 采集器、连接级调度器，全部实现并有测试。
- 本地服务（`crates/usage-service`）：数据目录独占锁、私有服务发现、认证的回环
  HTTP/SSE API、受控退出。运行：`bash tools/cargo.sh run -p usage-service -- --timezone
  Asia/Shanghai`。
- Tauri 宿主（`src-tauri`）：模板托盘图标、点击图标（左右键都算）打开菜单、菜单按用途分四块（分割线隔开）：
  显示面板 / 隐藏面板——菜单中的显隐入口，按面板当前是否可见切换那一个动作，展开时以托盘图标当前的
  屏幕矩形为锚点（点击不再携带 rect，图标在哪个显示器，面板就开在哪个显示器）；面板形态「标准模式 / 极简模式」与主题
  「浅色 / 深色 / 跟随系统」两组带勾选的单选条目，勾选跟随当前设置（在设置窗口里改也会立刻反映过来）；
  打开设置；重启应用；退出。两组的点击都走与窗口相同的设置写入（`write_settings`），因此持久化、
  广播给两个窗口、需要时重新铺窗，都由同一条路径负责；主题文案与设置窗口「外观」页一致。
  无 Dock 生命周期、无装饰面板锚定、固定尺寸设置窗口、主动隐藏、单实例唤起、受限命令桥。面板默认置顶并加入所有 Space，
  失焦或切换桌面后仍保持可见。实现是一次性声明窗口集合行为（`keep_panel_on_all_desktops` 里的 `set_visible_on_all_workspaces`），
  不是逐次切换重新显示窗口，面板位置不会被再次锚定。压在应用全屏窗口之上不在范围内
  （`canJoinAllSpaces` 不含 `FullScreenAuxiliary`，见变更的 `design.md`）。
  手动拖动后，内容或头部引起的高度更新会在原生窗口的一次操作里保留实时左上角，避免异步高度帧
  回放拖动前的旧坐标；高度上限按窗口当前所在屏幕计算，不再沿用托盘上次点击的屏幕；
  鼠标松开后先检查整个桌面的屏幕并集：面板仍完全在屏幕内时不回写位置；有任一部分出界时，
  选择平移距离最短的屏幕，只沿越界轴移动到最近边缘。拖动中不做纠偏，因此可以自然跨屏。
  顶边允许贴到屏幕边缘，以适应自动隐藏菜单栏的全屏空间。头部自动隐藏的鼠标命中判断先把
  主屏鼠标坐标与窗口坐标各自换算为点，跨不同缩放比例的屏幕也能正确计时；窗口首次显示且
  鼠标已在外面时同样开始计时。右键菜单的「重启应用」先回收自己拥有的服务与它的 Codex 子进程
  再重新启动：`AppHandle::restart` 重新 spawn 可执行文件、不会发出 `ExitRequested`，所以清理由
  重启分支自己做，新实例也不会附着到正在退出的旧服务上；用户独立启动的服务仍不受影响。
- 面板界面（`src/desktop`）：默认「标准」模式为约 350 逻辑像素中文紧凑主题，只有总览一页：三平台卡片、底部状态行与
  消息浮层；标题栏按指针规则收起时，底部状态区同步淡出并退出布局。设置界面在独立的 600×400
  设置窗口里，左侧分类纵排（平台管理 / 外观 / Codex / GLM /
  DeepSeek），右侧是唯一的内容滚动区；平台管理是第一个分类，支持指针拖拽排序并即时持久化；
  外观包含面板模式：标准 / 极简、主题：浅色 / 深色 / 跟随系统、全局额度数值：剩余 / 已用，以及“低额度提醒”和“低余额提醒”；
  默认深色、显示剩余额度，两项提醒的默认值都是 10，设为 0 即关闭。低额度提醒按剩余百分比判断，低余额提醒
  对 GLM 钱包与 DeepSeek 的各币种原始金额独立判断，不做汇率换算或合计。跟随系统响应 macOS 外观变化。Codex 双仪表、
  GLM 套餐/钱包、DeepSeek 余额与可选的网页账单用量
  都按平台分到各自的分类里；每张卡片内部统一为主要指标与辅助分组，Codex Tokens 和 DeepSeek
  消费/Tokens/请求归入无可见标题的“今日用量”语义分组，GLM 钱包归入带标题的“钱包”分组。DeepSeek 网页用量连接关闭时主卡不显示今日
  用量，启用但未配置 Token 时只显示毛玻璃占位，不回退展示余额差分估算。两套配色共用同一组
  颜色变量，规则中不写硬编码颜色
  （由 `tests/panel/panel-palette.test.ts` 守住）。浅色采用 macOS 设置风格的系统灰背景、白色分组卡片、
  中性深灰文字与细分隔线；平台管理行之间使用直线分隔，不给分隔线附加行圆角。操作、焦点和选中使用系统蓝，开启状态使用系统绿，青绿／草绿／靛蓝
  保留给平台额度与标识，详见
  [`refine-light-palette`](../../openspec/changes/archive/2026-09-15-refine-light-palette/proposal.md)。开关的关闭态由
  轨道表达，旋钮在关闭与开启两态都是同一个白色滑块（浅色下由 `--switch-thumb-shadow` 补出边界），
  禁用则整块淡化——关闭因此不会读作「点不动」，见
  [`fix-light-switch-off-state`](../../openspec/changes/archive/2026-09-15-fix-light-switch-off-state/proposal.md)。
  界面动效按仓库规则「所有切换都要有过渡动画」
  实现（`AGENTS.md` §1）：分类选中、内容入场、窗口高度、状态切换、数值变化各自用
  transition / animation / 逐帧上报，`prefers-reduced-motion` 统一关闭，切换点登记在
  `tests/panel/panel-motion.test.ts`（该守卫读 `panel.css` 与 `settings.css` 两份样式）。
- 「极简」是桌面主面板的可选展示模式，旧设置与新安装默认仍为「标准」。在设置窗口「外观」中切换。
  极简模式使用约 58 点宽的竖栏，每个平台的圆环中心是透明底品牌图标，圆环下只画读数本身：
  平台上方的一行三点把手展开后占 16 点高，随底部操作图标一起在失焦时收起；指针移到把手时平台立即失去高亮，按住拖动时操作区保持展开，松开后再按指针位置决定是否收起。额度为 0 时进度弧及其圆头都隐藏。
  窗口短名（5h／7d／30d）、「余额」这类说明和状态词都不再出现在栏里（无障碍名称与详情卡片仍然给出），
  因为 58 点放不下第二行；余额不绘制百分比弧，多币种显示「多币种」。竖栏沿用标准模式面板的底色渐变与
  1 点描边，外框圆角沿用标准模式面板的 14 点、聚焦平台底板按内缩三点取 11 点（22 点的胶囊形会被竖栏的
  圆环读成另一套形状）。相邻平台项之间留 6 点间距，平台读数与下一项的圆环不再贴在一起。点平台项在旁边
  展开可信指标详情，
  再点一次、点外部或按 Escape 关闭；指针进入拖动把手、刷新／设置或连接异常控件时立即取消平台选中，
  穿过平台之间的空隙时等待 200 毫秒再关闭，避免从一个圆环移到另一个时闪烁（宿主的采样间隔是 150 毫秒）。
  指针从圆环移到它打开的卡片上不算离开（那是同一个平台的表面），圆环还持有键盘焦点时也不算离开（键盘读者也有「焦点在平台上」），
  连接详情是点出来的、不是悬停出来的，不受这条规则影响。详情不滚动：窗口按卡片的自然高度生长，只有显示器确实放不下时才
  被裁切。竖栏随标准模式共用的指针聚焦状态展开底部刷新、设置图标，指针离开立即收起
  （极简栏不套用标准模式面板的 5 秒延迟）；刷新／设置排在平台项之下并撑高竖栏，不再盖在圆环上滑入。
  连接异常是竖栏里独立的一行（圆点加数量），指针不在面板上时也可见，激活后打开连接详情；详情卡片
  本身不再带底部的感叹号分隔行。所有平台隐藏时仍有「管理平台」入口。极简栏按当前面板所在显示器的逻辑点定位：右边界齐平（0 点）、上边界 40 点
  （`MINIMAL_RAIL_RIGHT_INSET` / `MINIMAL_RAIL_TOP_INSET`），工作区不足时向可操作区域钳制——Dock 占住右侧那条时竖栏停在 Dock 左边而不是压在上面。竖栏窗口在打开、切换和关闭详情时保持 58 点宽，只有竖栏高度沿缓动
  曲线过渡；真实平台卡片与连接详情由独立透明窗口显示，左侧放不下完整窗口时改放右侧。详情窗口自行读取同一份快照与设置，并复用
  既有卡片组件和操作接口；宿主即时通知悬停选择，竖栏在悬停时重发该平台的选择（指针在同一圆环内移动时按
  250 ms 节流）、在宿主关闭时清除旧高亮，轮询只用于恢复漏掉的状态。webview 只在窗口是 key 时收到指针事件，
  而常驻的竖栏常年不是（读者在别的应用里、设置窗口持有 key），因此宿主在既有的指针轮询里把光标位置转发给竖栏，
  由竖栏用同一个「这个点下面是哪个平台」的判断补上悬停；读到真实指针事件的这段时间里竖栏忽略该补发，读者按 Escape
  关掉的卡片因此不会被自动打开。同一份指针位置也用来画悬停反馈：非 key 的 webview 收不到 `:hover`，面板文档
  （`PanelApp`）与独立详情文档（`MinimalDetailWindow`）各自把指针下的控件标成 `.is-hover`，与 `:hover` 逐条同值
  （`tests/panel/panel-probe-hover.test.ts` 比对两边，见 `panel/probe-hover.ts`）：竖栏的刷新／设置、
  连接异常徽标、空态链接，标准面板的工具栏、连接触发器与卡片控件，卡片里的配置／额度形态／重置时间；
  指针从一个窗口移到另一个窗口（或移出两者）时宿主补发一次空探针，窗口隐藏前各清一次，反馈不残留。
  隐藏的 webview 收不到宿主的广播，
  因此详情窗口在每次「选中从无到有」时补读一次快照与设置，并且等这次补读落地后才淡入：主题和读数都是打开时的当前值，
  不会先按旧主题出现再跳成新主题，也不停在文档挂载那一刻。
  高峰期间对应圆环的内底与平台图标同步轻柔呼吸，图标在原色和既有高峰色间变化，进度环和数值保持静止；减弱动效时显示静态高峰状态。
  详情卡片就是总览那张卡片：详情只提供 1 点描边与底色，**每个视图自带 10 点内边距**——平台卡片由
  `.provider-card` 提供（高峰竖线因此贴在卡片左边缘，与总览一致，而不是浮在卡片内部），连接状态不是卡片，
  由 `.minimal-detail-connection` 提供同样的 10 点；详情容器本身不再内缩，新增详情视图必须自己带这一层，
  否则它的标题与读数会贴在容器边上。详情宽度 332 点（卡片 330 加两侧描边），原生窗口 339 点（再加 7 点透明指向区）。
  详情窗口在卡片增高时不显示临时滚动条，并为指向竖栏的三角形
  留出透明绘制空间；宿主按当前平台项的顶边定位详情，三角形指向该项中点；显示器下缘空间不足时再把卡片向上钳制，
  跨窗口指针离开后关闭；卡片在宿主把窗口放上屏幕之后才淡入，平台之间切换只做卡片内容的交叉淡入。此方案由
  固定宽度与独立占位窗口两次实机实验验证，记录见 `openspec/changes/fix-minimal-detail-blink/`。切回标准模式时，
  只要面板还在屏幕上，宿主就按托盘锚点把窗口重新铺回 350 点宽——切换模式不是一次显示，不会重走
  显示流程。重新显示时按该显示器重新定位，内容更新不会重置手动拖动的位置。配套网页继续使用卡片总览。
- 平台图标固定取自 [LobeHub Icons](https://github.com/lobehub/lobe-icons) 的
  `@lobehub/icons-static-svg@1.95.1`（OpenAI 图形标识用于 Codex、ChatGLM、DeepSeek），按其 MIT 许可使用，
  许可文本见 `src/desktop/assets/brands/LICENSE.lobehub.txt`。解析图标资源的只有
  `src/desktop/components/BrandMark.tsx` 一处：极简栏的圆环中心与总览卡片头部、平台管理行、设置分类导航的
  平台徽标都由它取图，新增平台或升版本只改这一个文件。徽标里的图标以遮罩取形状、用该平台的强调色填充
  （字母徽标当年的颜色），因此两套主题共用同一组变量；Codex 的图形没有品牌色，则以无底色单色路径随主题着色。
  总览卡片、平台管理行与设置导航里不再出现 `CX`／`GL`／`DS` 字母，由 `tests/panel/brand-badges.test.ts` 守住。
- 额度展示的圆环与进度条是同一条描边的两种几何，二者只能通过点击条目本身切换（整个条目都是
  热区，重置时间行只有自身可点时例外；设置页没有形态开关）。全局设置的「外观」提供一个
  「额度数值」的「剩余 / 已用」选择，统一作用于 Codex 与 GLM，默认显示剩余量；缺少所选方向的指标时显示
  `—`，不从另一方向伪造。额度区不常驻显示口径或点击说明，既有热区通过 hover/active/focus 反馈操作。
  低额度提醒始终按可信的剩余额度判断：优先使用显式剩余读数，只有剩余缺失时才以 `100 - 已用` 换算，
  因此切换“剩余 / 已用”不会改变提醒结果。命中提醒值时只有填充与百分比数字切换为警戒红色，并在
  无障碍名称中说明；窗口标签、轨道和重置时间不变。显示 0% 或读数未知时填充改用平线帽，不留下圆角亮点。
  低余额提醒只把命中阈值的真实余额金额切换为同一警戒红色，并在无障碍名称中说明“低余额提醒”；
  缓存余额照常判断，占位、缺失和无法解析的余额不提醒，标签、币种标识和其它消费指标保持原样。
  形态切换动画见
  [`fix-quota-shape-morph`](../../openspec/changes/archive/2026-09-15-fix-quota-shape-morph/proposal.md)：几何由
  `src/desktop/panel/quota-morph.ts` 的纯函数给出（断开解开 → 回直 → 下移三段），`QuotaDisplay`
  逐帧绘制（WebKit 没有可插值的 `d`），布局由 CSS 从 `--quota-drop` 推出，静态检查见
  `tests/panel/panel-quota-morph.test.tsx`。
- GLM 套餐的 5 小时与每周额度由接口的窗口单位和数量区分；两者即使共用 `TOKENS_LIMIT` 或
  `CREDIT_LIMIT` 类型，也不会覆盖彼此。窗口名与 Codex 统一为「5小时」「7天」，月度工具额度简写为
  「月度」。接口暂未返回每周额度时，卡片仍保留「7天」并显示 `—`，不拿 5 小时的数值代替。
- 手动刷新成功时不显示 toast；屏幕上该平台卡片的额度圆环/进度条与数字从 0 重播，即使新旧读数相同也重播。
  失败仍显示平台名加「刷新失败」的 toast，冷却和连接错误提示维持原状。数字重播使用 CSS 位移的数字列，
  并且只由本次刷新触发一次；圆环与进度条互换时数字保持静态。减弱动效时由面板的统一规则直接显示最终读数。
  刷新进行期间顶部按钮显示“正在刷新”、设置
  `aria-busy` 并旋转图标，禁用防重入；全部请求结束后恢复。
- 刷新结果的成败来自服务刷新后发布的状态，而不是刷新应答：服务对手动刷新只回一句
  「已收到并执行」（`refresh-requested`），结果以该平台的新状态发布，因此客户端把它读成
  `RefreshStatus.requested`（不裁决），面板按卡片自身状态行所用的同一份事实判定。失败提示与成功重播只对
  结果到达时屏幕上确实存在的卡片执行——平台已被隐藏、已进入子页或面板还在加载态时不执行。
  见 [`fix-refresh-verdict-messages`](../../openspec/changes/archive/2026-09-15-fix-refresh-verdict-messages/proposal.md)。
- 底部同步摘要只按当前可见平台聚合：没有可见平台显示“未展示平台”，任一平台没有成功时间显示
  “部分平台尚未同步”，全部具备成功时间时才取其中最早时间显示“全部同步于 HH:mm”并点亮绿点。
- 高峰/错峰时段提醒见
  [`add-peak-window-reminder`](../../openspec/changes/archive/2026-09-15-add-peak-window-reminder/proposal.md)：
  判定是纯前端计算（`src/desktop/lib/peak-windows.ts`，按定义自身时区取本地星期与时刻，支持跨午夜
  回绕），内置官方时段表目前只有 DeepSeek（北京周一至五 09:00–12:00、14:00–18:00，带来源与
  核实日期），无内置定义的平台（GLM/Codex）不显示时段信息；仅高峰时显示头部胶囊与卡片内侧短强调线，
  不改变整卡描边或增加外发光，错峰保持普通外观且无文字。面板展开期间跨过任一时段边界仍经现有 toast 提示一次；设置在每平台配置的
  「高峰时段提醒」区块（内置只读说明、自定义时段编辑器、关闭），设置字段 `peakReminder`
  两侧契约镜像且向后兼容。自定义编辑器的形态见
  [`refine-peak-window-editor`](../../openspec/changes/archive/2026-09-16-refine-peak-window-editor/proposal.md)：
  一条时段是一张两行卡片（星期多选 + 删除，`开始 09:00 → 结束 18:00`），跨午夜时该行自己亮出
  「跨天」；区块底部按**当前草稿**给出判定预览（`现在 高峰 · 距错峰 2 小时 30 分钟`），预览与
  总览卡片共用 `peakStateAt`，因此不会出现两个答案；保存入口旁是修改状态（错误原因 /
  `有未保存的改动` / `已保存`），没有改动时禁用。模式与时段草稿都在设置到达后**回填**——这个
  窗口先渲染、设置后到，两项若只在挂载时播种一次，已保存的时段表会显示成「关闭 + 空列表」，
  再点保存还会报「至少需要一条时段」。删除是先过渡再从数据里移除（与消息栈同一套 `is-leaving`），
  所以每行需要稳定 key，不能用下标。

- 设置窗口的完整审查与整改见
  [`polish-settings-window`](../../openspec/changes/archive/2026-09-16-polish-settings-window/proposal.md)：修掉
  Codex CLI 路径不回填（打开该页点保存会抹掉已存路径）、给删除凭据加就地确认、把禁用态分成
  「持续不可用」（`--disabled-*` 表面，标签仍可读）与「写入期间的短暂禁用」（保留淡化）两档、
  把连接状态收敛成区块正文首行一种呈现并补齐每种失败的恢复建议、把 11 档字号收敛成 8 个命名档
  （`tests/panel/panel-type-scale.test.ts` 守住）、去掉与 pane 标题重复的区块标题、补上开关自身的
  pending 态与外观控件的真忙态、把滚动条抑制收进面板文档让设置窗口恢复系统滚动指示。

尚未完成的是需要真实 macOS 桌面会话的验收（任务 8.4–8.8）：WebView 视觉对照、菜单栏实机
行为、Finder 启动、实账号只读验证与性能测量。
