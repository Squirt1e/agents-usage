# 验证入口与检查项

把「改了东西之后要跑哪些检查」固定成可复制的命令，避免每次凭记忆挑测试（任务 1.4）。

## 入口

| 命令 | 覆盖 | 何时运行 |
| --- | --- | --- |
| `npm test` | vitest 全量（两个窗口的组件、契约、动效与宽度守卫） | 改动 `src/`、`tests/` 后 |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / eslint | 每次改动 |
| `npm run build:desktop-web` | 构建两个前端入口到 `dist/desktop-client`（`index.html` 与 `settings.html`） | 改动前端构建、资源或入口后 |
| `npm run rust:test` | Rust workspace 全部测试（含 `contract_conformance`） | 改动 `crates/`、`src-tauri/` 后 |
| `npm run rust:check` | `cargo check --workspace --all-targets` | 只想快速确认能编译时 |
| `npm run rust:clippy` | clippy，警告即错误 | Rust 代码评审前 |
| `npm run build:desktop` | Tauri 打包（app + dmg） | 交付或验收打包结果时（任务 8.6） |

测试与样例：`fixtures/contracts/` 里的样例由 Rust 侧 `contract_conformance` 与共享契约测试共同
读取，语义变化必须同时更新样例与实现。

## 契约两侧校验的约定

`fixtures/contracts/` 下的样例由两个运行时**同时**校验：

- TypeScript：`tests/contracts-conformance.test.ts`；
- Rust：`crates/usage-core/tests/contract_conformance.rs`，路径通过
  `usage-core::fixtures::load_fixture` 解析（`build.rs` 注入 `AGENTS_USAGE_FIXTURES_DIR`）。

任一侧行为变化都必须更新样例并让两侧同时通过。样例的写入规则见
[`fixtures/contracts/README.md`](../../fixtures/contracts/README.md)。

## 与「缺失不等于零」有关的检查

这条不变量由以下检查共同保证，改动适配器或界面时必须保持：

1. `tests/contracts.test.ts`：`normalizeMetric` 对 `undefined` 产出 `null` 并追加 `unavailable`。
2. `tests/contracts-conformance.test.ts`：`codex-windows.json` 要求缺失百分比的不兼容响应
   被拒绝而不是补 0；`deepseek-currencies.json` 要求可靠零值仍显示；`daily-statistics.json`
   要求缺失日期桶不产生指标、`0` 的桶照常显示。
3. `crates/usage-core/tests/contract_conformance.rs`：同一份样例的 Rust 侧断言，外加
   `MetricValue` 的缺失/零/文本三态。
4. `scripts/verify-baseline.mjs`：样例格式检查，禁止用 `undefined` 表达缺失。

## 与额度形态切换动画有关的检查

圆环与进度条是同一个形状的两种几何，形变由脚本逐帧绘制（WebKit 没有可插值的 `d` 属性），
因此它不在 CSS 的 transition/animation 里，而由下面两处共同守住：

1. `tests/panel-motion.test.ts`：例外表登记这次逐帧绘制的原因与它仍然生效的条件，并覆盖它旁边
   真正是 CSS 的切换（填充比例、重置时间行的语气与下划线）。
2. `tests/panel-quota-morph.test.tsx`：几何（两种静息形态、三段顺序、接缝处两端速度连续、每帧
   不出盒、无 NaN）与 DOM 行为（翻转提交当帧先写回真实帧、减弱动效直接落地、两种文字只在形变期间
   同时挂载、形变期间在 `.panel` 上标注"内容正在动画"）。
3. `tests/panel-height-hook.test.tsx`：形变期间窗口高度改为逐帧上报实测值（不再等布局稳定后
   再走 200ms 缓动），因此窗口与卡片同步收放。
4. `npm run rust:test`（`src-tauri` 的 `a_resize_keeps_the_panel_where_the_user_put_it`）：窗口高度变化只改高度、不改位置，必要时才收进可用区域。
5. `tests/panel-width.test.ts`：面板不提供横向滚动（页面级 `clip`、内容区不让出横向轴、底部详情中的长文案允许断行）。浏览器侧的实测方式：向连接错误注入一段很长且不可断行的英文文案，打开底部“连接异常”详情，再读 `documentElement.scrollWidth`／`.panel-body.scrollWidth`，两者都必须等于各自的 `clientWidth`，且手动设置 `scrollLeft` 不产生位移。
6. 热区边界（浏览器实测，jsdom 无布局）：在圆环形态下命中 `elementFromPoint` 于环心、环身、环下方一行空白，期望分别是 `.quota-shape-button`、`.quota-shape-button`、`.quota-item`；在进度条形态下命中标签行与进度条为按钮、进度条下方为 `.quota-item`、重置文字为 `.quota-reset-toggle`。注意 `.quota-shape` 必须 `pointer-events: none`，否则它 `overflow: visible` 的绘制盒（进度条形态下比按钮低 20px）会把热区拖到重置行上。
7. `tests/panel-quota-morph.test.tsx` 另有一条分层断言：切换按钮盖住整个条目且置于内容之下，
   重置时间行在其上方、只在自身可点时吃掉点击——这条决定"除重置文字外整块都是热区"。

## 与两个窗口有关的检查

设置从面板内的页面变成独立窗口之后，以下几条一起保证「改一处、另一处立刻可见」与「设置窗口不会
被面板的规则带走」：

1. `tests/settings-store.test.ts`：写入立刻采纳自己的答案、宿主广播同一个值算回声（只通知一次）、
   嵌套字段（`platformVisibility`）的变化能被认出来、`dispose()` 后不再监听。
2. `tests/settings-window.test.tsx`：分类只挂载一个、方向键在同一控件内移动、`panel://settings-section`
   到达时切分类、`settings_ready` 只在首次渲染后发一次；两个窗口同屏时（`renderBothWindows`）
   改一项，面板上的卡片当场变化。
3. `tests/panel-settings.test.tsx`：面板四个入口各自请求哪个 section；面板本身不再渲染设置界面。
4. `src-tauri/src/lib.rs`：`only_writes_that_change_what_is_collected_re_collect`（呈现类写入不触发
   采集、采集类写入触发且同平台去重）、`the_settings_write_is_broadcast_to_every_window`（写入后
   广播、凭据写入同样会重新采集）、`a_section_request_lands_on_a_real_section`、
   `the_settings_window_is_fixed_and_decorated`（尺寸、装饰、不置顶、不注册失焦收起）、
   `the_settings_window_sits_beside_the_panel_not_on_it` 与 `..._stays_inside_a_work_area_it_does_not_fit`。
5. `tests/panel-motion.test.ts`：守卫读 `panel.css` 与 `settings.css` 两份样式，分类选中与内容入场
   都在登记表里；面板的页面转场条目已随页面一起删除。
6. `tests/panel-width.test.ts`：设置窗口把面板的 350px 宽度与 320px 最小高度中和掉，且 `panel.css`
   自己不被这些中和改动。

## 两个窗口的打包产物检查

`npm run build:desktop` 会在 `target/<triple>/release/bundle/macos/Agents Usage.app` 产出一个
可直接打开的应用，两个前端文档都被嵌进宿主二进制（`frontendDist`）：

```bash
BIN="target/x86_64-apple-darwin/release/bundle/macos/Agents Usage.app/Contents/MacOS/agents-usage-desktop"
strings -a "$BIN" | grep -E '^/(index|settings)\.html$'   # 两个文档都在
```

打包这一步在本仓库可复现并可验证（构建成功、两个文档都在）。它**不能**替代下面的人工检查：
窗口的外观、落点与生命周期只有真正的窗口服务器能回答。

## 需要真实 macOS 会话的检查

下面这些只能人工在真机上跑（jsdom 没有布局，也没有第二个窗口）。逐条记录结论与截图：

启动方式：`npm run build:desktop` 后打开上面的 `.app`（或 `npm run dev:desktop` 走热更新）。
本轮改动见 `git log --oneline` 里 `split-settings-into-a-window` 的四笔提交（store / 前端与主面板 /
宿主 / 文档）。

1. **设置窗口的外观与尺寸**：从面板顶部齿轮打开，确认带系统标题栏、固定 560×380、不可拖动边缘
   缩放，内容超出时只有内容区滚动。
2. **位置与并排**：面板在屏幕左侧时设置窗口出现在它右边，面板贴右边缘时出现在左边，都在工作区内；
   从菜单栏右键打开（没有面板作参照）时落在工作区右侧。
3. **失焦不关**：点回面板、点其他应用，设置窗口都留在原处；再点它恢复输入。
4. **Escape**：设置窗口里按 Escape 只关它自己，面板保持原样。
5. **实时生效**：面板与设置窗口并排，在设置窗口把主题切到浅色、隐藏一个平台、改某平台区域，
   面板当场跟着变（区域改动应看到该卡片重新采集）。
6. **三个主题下的观感**：浅色 / 深色 / 跟随系统各看一遍设置窗口的分类导航与表单。
7. **开发期 URL**：`npm run dev:desktop` 后确认设置窗口加载的是
   `http://127.0.0.1:5174/src/desktop/settings.html`，改 `settings.css` 能热替换。
8. **面板高度**：隐藏全部平台后窗口不再停在 320，而是收到空状态需要的高度；卡片很多时窗口停在
   工作区高度并在内部滚动；钉住后面板失焦、标题栏收起时窗口跟着变矮、底部不留空白。

## 实机验证记录（设置窗口，2026-09-15）

在一台已登录的 macOS 26.6（Aqua 会话）上跑的是**开发构建**（`npm run dev:desktop`，独立 bundle
标识 `com.agents-usage.desktop.dev`），用 `osascript` 读真实窗口几何、用 `screencapture` 看渲染、
用宿主自己的 `diag_log`（`$TMPDIR/agents-usage-panel-events.log`）核对事件顺序。

截图存于本节同级的 [`verification/`](verification/)：`settings-window-dark.png` 是设置窗口的
深色渲染，`settings-and-panel.png` 是它与面板并排（面板在右、设置在左）。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 窗口尺寸与装饰 | 通过 | AX 读到 `[设置] size=560380`；截图显示系统标题栏（红黄绿三键）＋标题「设置」（见 `verification/settings-window-dark.png`） |
| 位置：面板在屏幕右侧 | 通过 | 面板 `pos=2200,40`，设置窗口落在它**左侧** `(1630,40)`，与 `settings_window_origin` 的规则一致（`position_settings_window target=(1630,40)`） |
| 布局与分类 | 通过 | 截图：左侧纵排「平台管理 / 外观 / Codex / GLM / DeepSeek」，平台管理为当前项，右侧是内容区 |
| 深色主题观感 | 通过 | 截图：窗口底色与面板同一套变量，导航选中项有青色指示条 |
| 失焦不关 | 通过 | 记录到面板 `focus(true)`/`focus(false)`，而设置窗口打开后 `hide_panel` 调用数为 **0**，设置窗口始终在窗口列表里 |
| 主面板高度 | 通过 | 宿主日志 `panel_set_height applied=` 的取值集合是 **304…352**，全部高于旧下限——不再有「所有平台隐藏就落回 320」的行为；面板宽度恒为 350 |
| 设置窗口入口 | 通过 | 菜单栏右键菜单读作「显示/隐藏面板 / 设置… / 退出」，点「设置…」后 `open_settings section=platforms` → `reveal_settings_window` |
| 开发期 URL | 通过 | 由 `tests/desktop-dev-entry.test.ts` 抓取两个文档；本轮两个窗口都由 dev server 正常加载 |
| **Escape 关闭设置窗口** | **无法驱动** | 见下 |

### 一个无法在本机驱动、且可能是真实问题的点

**Escape 无法验证，而且原因不只是测试环境的限制。** 宿主用
`set_activation_policy(ActivationPolicy::Accessory)`（菜单栏应用不占 Dock），macOS 因此不会让它的
窗口成为 key window，合成键盘事件（`CGEvent`）也就落不到它的 webview 上。同一台机器上对 TextEdit
做同样的注入是成功的（读回了输入的字符），所以不是注入权限的问题，而是这个应用**收不到键盘事件**。

这不只影响 Escape：它意味着当前构建里设置窗口的键盘输入整体是可疑的。本轮没有把这一点当作
"通过"，也没有就此改代码——改激活策略（或给设置窗口单独提升）是产品取舍，需要先确认是否要支持
键盘操作（Tab 遍历、Escape、Cmd+W），再决定。

## 尚未接入的检查

以下检查在对应任务完成前不会出现在上面的入口中，避免给出「已通过」的假象：

- 服务认证与会话校验测试（任务 4.3–4.5）；
- 窗口、托盘与多屏的实机验证（任务 8.4–8.5）；
- 实账号只读集成验证（任务 8.7），需要真实凭据，且必须与 fixture 结果分开报告。
