# 回放文字位置与创建顺序修复 — 0.10.10

- 基于 0.10.9 修复积压回放期间文字上移，以及助手正文、工具子调用、分组标题和 SVG renderer 的创建顺序问题。
- 补强后台恢复与前台等待批次之间的顺序协调，保持原始批次内容快照，后续增长等待原批次完成。
- 版本号同步至 `0.10.10`，包含设置卡与诊断导出备用版本号、预编译库及安装包。

## 验证与范围

- `pnpm typecheck` 通过。
- `pnpm test` 通过：31 个测试文件、559 项测试全部通过。
- `pnpm build`、`node scripts/check-lib-fresh.mjs` 与 `git diff --check` 通过。
- 安装包：`dist/dsh-smooth-stream-0.10.10.tgz`；SHA-256 见 `dist/SHA256SUMS.txt`。
- 真实 WebView 的视觉/滚动动画仍待实机验证；本次不修改当前 profile 的安装状态。
