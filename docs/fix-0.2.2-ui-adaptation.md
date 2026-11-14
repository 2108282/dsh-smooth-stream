# 适配 DSH 0.2.2 新 UI：两次修复提交的方案与过程

本文记录 `dsh-smooth-stream` 从旧内核（DSH `0.1.0-rc.6` 契约）迁移到新版 `ui-conversation` / `ui-chat`（DSH `0.2.2-rc.2`）的完整过程，覆盖仓库最近两次提交：

| 提交 | 类型 | 内容 | 结果 |
| --- | --- | --- | --- |
| `46828cf` | `fix` | 把平滑流式整体迁移到新版 Chat renderer 契约 | 类型检查、279 项测试、生产构建全部通过 |
| `89c3077` | `chore` | 版本号 `0.6.2` → `0.9.0`、仓库元数据、重建 `lib/` | 打标签 `v0.9.0` 并发布安装包 |

> 结论先行：**失效原因不是 slot 名字写错，而是 Chat renderer 的所有权从 `ui-conversation` 迁到了 `ui-chat`，且新版给 renderer 增加了 hooks、子插槽与分组结构**。插槽 `conversation.chat.node` 与 key `assistant-step` 在新版一直存在，旧插件确实注册进去了，但它以旧契约“抢走”了官方 renderer，于是既丢功能又渲染异常。

---

## 1. 背景

- 插件最初面向 DSH `0.1.0-rc.6` 开发：devDependency 锁在 `ui-conversation@0.1.0-rc.6`，助手节点类型 `ChatNodeViewProps` 从 `ui-conversation` 导入，locale 命名空间是 `conversation`。
- 运行环境已升级到 `0.2.2-rc.2`：`ui-conversation` 只负责会话外壳、composer 与视图导航；`ui-chat` 负责 Chat target、节点定义、节点 renderer 与详情界面。
- 表现：插件管理里显示 `enabled/active`，但助手回复没有打字机效果，或效果异常、折叠/图片/右键菜单等交互失效。
- 另一层干扰：profile 实际加载的是 `/root/.dsh/plugin-src/dsh-smooth-stream/lib/client.js`，构建时间是 11 月 4 日，比工作区源码旧。**"插件 active" 只能说明装配成功，不能证明浏览器跑的是最新产物。**

## 2. 定位过程

按“先排除、再收敛”的顺序逐项验证，避免把跨版本 ABI 问题误判成 slot 拼写问题。

1. **确认 slot 没有消失**：`conversation.chat.node` 仍由 `ui-chat` 声明，`assistant-step` 仍是其 keyed entry。新版按 `ChatNodeKind` 分派 renderer，外层行还带 `data-chat-*` 与 turn-process 标记。
2. **确认类型/语义归属变了**：新版 `ChatNodeViewProps<'assistant-step'>` 与 `PropsLocale<'chat'>` 都在 `ui-chat`；旧插件从 `ui-conversation` 取类型、注册时传 `locale: 'conversation'`。
3. **确认官方 renderer 承担了更多职责**：`useDisclosure`、`useGroupAction`、`usePresentation`、`useContextMenu` 等 hooks，以及 `conversation.chat.reasoning.body`、`conversation.chat.message.images` 子插槽。谁成为该 key 的 renderer，谁就要承接这些能力。
4. **确认旧方案的注册方式在新版 SlotRegistry 下不可用**：同 key 再注册一份带 `children` 的 entry 会因“子插槽已声明”而抛错；且只有胜出的 entry 会收到 `renderSlot`，重复注册既拿不到子插槽，也会丢掉官方 locale/inject 元数据。
5. **确认旧的三帧派发补丁很脆**：它直接改写内部 `binding` 原型上的 `publish`，依赖私有字段形状，且没有可靠卸载恢复。新版仍是三层 rAF，优化目标还在，但实现必须重做。

## 3. 根因

| # | 根因 | 后果 |
| --- | --- | --- |
| 1 | renderer 契约迁移（`ui-conversation` → `ui-chat`，locale `conversation` → `chat`） | 旧 renderer 拿到的是过期 props 语义 |
| 2 | 旧方案“整套替换”助手渲染 | 官方的图片、翻译、右键菜单、折叠策略全部丢失 |
| 3 | 同 key 重复注册带 `children` | SlotRegistry 抛错或子插槽失效 |
| 4 | 依赖声明缺 `ui-chat`、devDependency 仍是 `rc.6` | 类型检查与运行时都对着旧契约 |
| 5 | 运行的是旧构建产物 | 即使源码改对，页面也不会变 |

## 4. 方案对比与选型

| 方案 | 做法 | 问题 | 结论 |
| --- | --- | --- | --- |
| A. 继续 fork UI | 复制新版 Chat 组件，自己实现全部功能 | 每版都要跟官方重写，长期不可维护 | 否决 |
| B. 同 key 重新注册 | 再注册一个 `assistant-step` entry | 子插槽重复声明报错，丢失 locale/inject | 否决 |
| C. **原位包装官方 entry** | 只替换 `entry.component`，保留 entry 的 locale、children、inject、优先级 | 需要自己保证卸载恢复与 React 重渲染 | **采用** |
| D. 改内部实现 | 继续 monkey patch `uiConversation` 原型 | 私有字段一改就崩 | 改为特性检测 + 可卸载 |

方案 C 的核心取舍：**插件只接管“文字如何逐字出现”，其余一律交回官方组件。** 平滑算法、滚动跟随仍由插件实现，UI 语义、翻译、折叠、文件交互仍归官方。

## 5. 实施细节（`46828cf`）

### 5.1 renderer 适配层：`src/client/rendererAdapter.ts`

- 遍历 `ctx.slots.entries('conversation.chat.node')`，对每个 keyed entry 做**原位替换**：保存 `entry.component`，写入包装组件，卸载时还原。entry 上的 `options`（`locale`、`children`、`inject`、顺序、优先级）完全不碰，因此官方子插槽与注入能力继续有效。
- 包装组件不缓存 props，每次渲染都调用最新 `decorate` 结果，避免设置变化后仍渲染旧组件。
- 重渲染依赖 `useSyncExternalStore`：订阅 `ctx.slots.subscribe(CHAT_NODE_SLOT, …)` 与适配层自身的 `revision`。插件被卸载时 `revision` 自增并通知所有已挂载包装组件，让它们立刻切回官方组件，而不是等下次 slot 变更。
- 卸载路径用 `disposed` 标记短路：Cordis 已停用 ctx 后，React 仍可能重渲染包装组件，此时**不得再通过 ctx 查询服务**，只能读缓存的 `lastSlotVersion`。

### 5.2 助手节点包装：`src/client/NativeAssistantNodeView.tsx`

- `assistantTextSegments()`：按 `groupPart` 只挑当前行真正拥有的文本块（`reasoning` 行只要 reasoning，`response` 行只要 text），其余块（图片、工具、文件提及）原样保留。
- `revealAssistantBlocks()`：把平滑后的可见前缀分配回对应 block，**不改块数量、顺序、对象身份与不透明元数据**，只改 `text`/`reasoning.text`，官方组件因此可以继续按原结构渲染。
- `useAutomaticDisclosure()`：包装官方 `useDisclosure`，在推理流式期间自动展开、排空后收起；用户手动操作会被记住（`manual`），Turn reset 也会被识别。
- 接力与交接：`streamRelay` 以 `(session, turn, step, node, order)` 定作用域，`reasoning < response < tool` 排序；`keepStreamOnToolCall` 开启时等正文真正排空再呈现工具，关闭时即时交接。
- 状态与标记：包装后按 `typing` 覆写 `node.data.status`（`running` / `settled`），并在最近的 `[data-chat-flow-key]` 行上打 `data-smooth-stream-settled`，让滚动引擎与官方分组折叠共享同一个“是否还在流式”的信号。
- `FollowHost` 只在真正打字时启用，避免已结算行参与跟随。

### 5.3 接力状态机：`src/client/streamRelay.ts`

- 每个挂载的 renderer 持有一个租约（`Symbol`），`acquire/update/release` 显式管理生命周期；任何一个视口都不能释放别人的队列。
- `isBlocked()` 判断“自己前面是否还有未排空的同类内容”，`hasTool()` 判断同一步是否已经出现工具行。
- 中断、卸载、切换会话都会释放自身租约，不再依赖六秒强制放行这类兜底超时。

### 5.4 发布管线优化：`src/client/conversationPipeline.ts`

- 从“改原型 + 全局标记”改为**按 binding 实例**安装：`WeakMap` 记录补丁，`publish('animation-frame')` 合并到单帧 `requestAnimationFrame`，只影响 `animation-frame`，其余 publication 原样交给 DSH。
- 引用计数：同一 binding 可被多个安装者共享，最后一个租约释放时才还原原始方法；还原时把未完成的 publication 交回原始实现，避免丢帧。
- 特性检测：没有 `publish`/`flush`、没有 `requestAnimationFrame`、结构不匹配时直接跳过，不破坏官方三帧行为。

### 5.5 客户端入口：`src/client/index.ts`

- `SKIP_WRAP` 从 `['assistant-step','user','steering','command-input']` 改为 `['user','steering','command-input','turn-process','turn-tail']`：助手行改由包装器接管，而新版 `turn-process`/`turn-tail` 这类宿主流程行**不再套通用跟随包装**（它们有自己的空行/折叠布局规则）。
- 平滑开关在 renderer 内部由设置快照控制：`enabled=false` 时直接渲染官方 `Inner`，不注入平滑层；开关切换不再需要反复替换 slot entry。
- Host 启动配置的 `preset` 显式传入包装器，修正“配置被读取却始终用 balanced”的问题。

### 5.6 设置面与 Host RPC

- 客户端设置入口迁移到新版真实存在的 `settings.section` 与 `settings.plugins.tab`，删掉 `0.2.2-rc.2` 中不存在的插件详情/旧 item slots 注册。
- Host 侧设置改为用 `StreamSettingsSchema(saved)` 解析本地 JSON（补齐默认值与嵌套 `debugTuning`），不再手工浅合并。
- RPC handler 对齐新版四参数签名，`baseUrl` 从 `httpCtx` 获取，避免在 deactivated context 上取 `connection`。

### 5.7 依赖与兼容声明

| 项 | 旧 | 新 |
| --- | --- | --- |
| devDependencies | `@deepseek-ai/*@0.1.0-rc.6` | `0.2.2-rc.2` |
| peerDependencies | 无 `ui-chat` | 显式声明 `ui-chat`、`ui-renderer`（`>=0.2.2-rc.2 <0.3.0`） |
| client inject | 只有 `ui-conversation` | 增加 `ui-chat`、`ui-settings`、`ui-settings-plugins` |
| `engines.dsh` | 无 | `>=0.2.2-rc.2 <0.3.0` |
| README 兼容表 | 0.1.x 全绿 | 0.2.2-rc.2 已验证，0.1.x 指向旧发行版 |

### 5.8 测试

新增/迁移的用例覆盖了这次改动最容易回归的边界：

- `tests/renderer-adapter.client.spec.tsx`：原位替换、保留元数据、卸载恢复、已挂载组件在 disposal 时切回官方组件。
- `tests/native-assistant.client.spec.tsx`：分组投影、逐字揭示、保留其他块、工具前交接。
- `tests/conversation-pipeline.client.spec.tsx`：单帧派发、引用计数、卸载还原、未完成 publication 归还。
- `tests/stream-relay.client.spec.tsx`：跨会话/跨步骤隔离、租约释放。
- `tests/follow-native.client.spec.tsx`、`tests/entry-settings.client.spec.tsx`、`tests/locale-routing.client.spec.tsx`：跟随、开关、locale 路由。
- 旧 `tests/stream.client.spec.tsx` 中“替换并恢复 entry”的断言同步改为“包装保持稳定、由设置决定是否平滑”。

## 6. 发版收尾（`89c3077`）

- `package.json`：`version` `0.6.2` → `0.9.0`；`repository`/`bugs` 指向 `2108282/dsh-smooth-stream`。
- 设置卡片控制器里的 fallback 版本号同步为 `0.9.0`，避免界面显示旧版本。
- 重新执行 `tsdown` 生成 `lib/index.js`、`lib/client.js`，与源码对齐后一并提交。
- 打标签 `v0.9.0`；同时把改造前的 `5fc1786` 归档为 `v0.6.2-legacy`，两版各自带安装包与 `SHA256SUMS.txt`，方便回退。

## 7. 验证

在本仓库执行：

```bash
pnpm run typecheck   # tsc -p tsconfig.json --pretty false
pnpm run test        # vitest run
pnpm run build       # tsdown
pnpm pack            # 生成安装包
```

结果：

| 检查 | 结果 |
| --- | --- |
| `typecheck` | 通过 |
| `vitest run` | 14 个文件、**279/279 通过**、0 跳过 |
| `tsdown` 生产构建 | 通过（`lib/index.js` 25.28 kB、`lib/client.js` 260.52 kB） |
| `git diff --check` | 通过 |

安装包为 `dsh-smooth-stream-0.9.0.tgz`，只包含 `lib/`、`src/`、`cordis.patch.yml`、README、LICENSE 与 manifest，不含 `node_modules`、用户设置或聊天数据。

预编译包已随仓库提交到 [`dist/`](../dist/README.md)（附 `SHA256SUMS.txt`），可直接用 npm 安装，不必在本地构建：

```sh
# npm（已验证：装出的包 version=0.9.0，含预编译 lib/）
npm install https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.9.0.tgz

# pnpm：请用 github.com/.../raw/... 形式，raw.githubusercontent 在 pnpm 10 下会报 integrity 缺失
pnpm add "dsh-smooth-stream@https://github.com/2108282/dsh-smooth-stream/raw/main/dist/dsh-smooth-stream-0.9.0.tgz"
```

装进 DSH 插件 profile：

```sh
# 先把包下载到本地，再按路径安装（DSH 的 plugin add 会转发给 pnpm）
curl -L -O https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.9.0.tgz
pnpm dsh plugin --profile web add /绝对路径/dsh-smooth-stream-0.9.0.tgz
```

该 tgz 与 Release 附件逐文件比对一致；Release 附件适合手动下载，仓库内的 `dist/` 才是能被 npm/pnpm 直接拉取的安装源。

## 8. 维护约定（防止同类问题复发）

1. **不要静态导入 `@deepseek-ai/*` 运行时符号**：宿主用 `node --import tsx/esm` 启动，tsx 会套用宿主 `tsconfig` 的 `paths`，外部插件的裸导入可能被重定向进宿主源码，一旦宿主改名就会以模块实例化错误炸启动。类型导入（`import type`）不受影响。
2. **不要用同 key + `children` 再注册**：`SlotRegistry` 会因重复声明子插槽抛错。要改行为就替换 `entry.component`，保留 entry 元数据。
3. **包装而不是克隆官方 renderer**：新增 UI 功能通常挂在 hooks / 子插槽上，克隆一份等于永久放弃这些能力。
4. **任何 monkey patch 都要可卸载**：订阅归属、引用计数、原始方法恢复、未完成工作归还，四件事缺一不可。
5. **状态按 `session/turn/step/groupPart` 分域**：不要用全局单例表示“当前正在流式”，否则多会话、多分组必然互相阻塞。
6. **区分“插件 active”与“产物已更新”**：改完源码务必重新构建并确认浏览器加载的是新 bundle。

## 9. 已知边界与后续性能观察

本次适配解决了“能不能用/功能是否完整”，**没有做移动端性能基准**。实际使用中，模型工具调用与长思考阶段的吐字仍可能卡顿，源码层面已确认几处叠加开销（尚未做运行时采样）：

| 热点 | 位置 | 说明 |
| --- | --- | --- |
| 每帧重建字符数组 | `src/client/NativeAssistantNodeView.tsx`（`revealAssistantBlocks`） | 每个揭示帧都把累计文本重新展开为字符数组，长思考下分配与 GC 压力明显 |
| 工具结果 DOM 改写 | `src/client/useProgressiveDomText.ts` | `MutationObserver` + Text 节点前缀改写，每帧遍历待显示节点 |
| 单帧派发提高更新密度 | `src/client/conversationPipeline.ts` | “更快”不等于“更省”，高频输入下总工作量上升 |
| 官方展开态思考 | 宿主 `ui-chat` 的 `ReasoningContent` / `MarkdownText` | 展开时才挂载正文，长思考每次更新都要走 Markdown |
| 折叠动画 | 宿主 `flow-motion.ts` | 读高度后写 `height`/`margin`，在交接点产生布局计算 |
| 长会话 DOM | 宿主 Chat flow | 仅回合导航栏虚拟化，历史内容仍在 DOM 中 |

可行的缓解顺序（一次只改一项，用同一段长思考与同类工具结果对比）：

1. 关闭“自动展开思考”，避免展开态 Markdown 与翻译持续参与。
2. 单独关闭“极速派发”，观察主线程负载是否下降。
3. 工作详情改 `compact`、折叠时机改 `completion`，减少展开内容与折叠动画范围。
4. 单独停用思考翻译做对照（点击“原文”只切换显示，不会停止翻译处理）。
5. 关闭插件总开关对比工具阶段，判断卡顿是官方 UI 本身还是被平滑层放大。

代码侧的改进方向：缓存字符边界做增量投影、把富文本提交限制在 20–30 次/秒并按耗时自适应、工具结果改为批量呈现、为极速派发加入负载回退、翻译延后到段落稳定。

## 10. 相关文件

| 文件 | 作用 |
| --- | --- |
| [`src/client/rendererAdapter.ts`](../src/client/rendererAdapter.ts) | 原位包装 slot entry，卸载恢复 |
| [`src/client/NativeAssistantNodeView.tsx`](../src/client/NativeAssistantNodeView.tsx) | 文本投影、揭示、自动展开、接力与交接 |
| [`src/client/streamRelay.ts`](../src/client/streamRelay.ts) | 会话/回合/步骤级租约状态机 |
| [`src/client/conversationPipeline.ts`](../src/client/conversationPipeline.ts) | 可卸载的单帧发布优化 |
| [`src/client/index.ts`](../src/client/index.ts) | 入口装配、slot 注册、设置闸门 |
| [`src/plugin.ts`](../src/plugin.ts) | Host 设置读写与 RPC |
| [`tests/`](../tests) | 14 个测试文件、279 项断言 |

---

*记录时间：2026-11-14。对应提交 `46828cf`（适配）、`89c3077`（发版）。*
