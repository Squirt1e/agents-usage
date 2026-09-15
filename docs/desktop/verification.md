# 验证入口与检查项

把「改了东西之后要跑哪些检查」固定成可复制的命令，避免每次凭记忆挑测试（任务 1.4）。

## 入口

| 命令 | 覆盖 | 何时运行 |
| --- | --- | --- |
| `npm run verify:legacy` | 旧网页：`tsc --noEmit`、`eslint .`、全部 vitest、生产构建（服务端 + 旧网页 + 面板前端），并校验三处产物存在 | 改动 `src/shared/`、`src/client/`、`src/server/`、`vite.config.ts` 或构建脚本后 |
| `npm run verify:legacy -- --no-build` | 同上但不做生产构建 | 只想快速回归时 |
| `npm run test:contracts` | TypeScript 侧契约测试（`tests/contracts.test.ts`、`tests/contracts-conformance.test.ts`） | 改动契约、适配器解析或样例后 |
| `npm run rust:test` | Rust workspace 全部测试（含 `contract_conformance`） | 改动 `crates/`、`src-tauri/` 后 |
| `npm run contract:test` | 上面两者 | 契约或样例变化时（默认组合） |
| `npm run verify:baseline` | 样例格式检查 + 两侧契约测试；`--with-legacy` 追加旧网页基线，`--no-rust` 只跑 TypeScript | 提交前的组合检查 |
| `npm run rust:check` | `cargo check --workspace --all-targets` | 只想快速确认能编译时 |
| `npm run rust:clippy` | clippy，警告即错误 | Rust 代码评审前 |
| `npm run build:desktop` | Tauri 打包（app + dmg） | 交付或验收打包结果时（任务 8.6） |

`npm test`（vitest 全量）与 `npm run verify:legacy` 的关系：前者是测试子集入口，后者额外包含
类型检查、lint、生产构建与产物校验。

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

## 尚未接入的检查

以下检查在对应任务完成前不会出现在上面的入口中，避免给出「已通过」的假象：

- 服务认证与会话校验测试（任务 4.3–4.5）；
- 窗口、托盘与多屏的实机验证（任务 8.4–8.5）；
- 实账号只读集成验证（任务 8.7），需要真实凭据，且必须与 fixture 结果分开报告。
