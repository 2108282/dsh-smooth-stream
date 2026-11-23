# 预编译安装包（dist）

## 最新本地修复版：0.10.4-local.3（Git 分支 0.2.3）

- 修复单行 CSS 省略号后不可见尾巴仍占吐字预算、拖住后继工具的问题；可见标题仍有动画，16 字预算及用户参数不变。
- 新增 25 项回归；全量 445/445、类型检查、构建及语法检查均通过。
- 已由插件管理器升级安装并核对实际安装副本的构建字节；保留安装前的停用状态。启用并刷新原页面后才能实机复测。
- 没有新增掉帧诊断，不宣称初始恢复掉帧已经解决。
- 安装包 SHA256：`35a5e05bfb0dde355de55483c4557abaaabee0ed302ec213f6c7aa53ab860ec2`。
- 本轮尚未执行新的云端推送；下方 Git 分支引用需在推送成功后才包含本轮修复。

对应文件（仓库相对位置）：

```text
dist/dsh-smooth-stream-0.10.4-local.3.tgz
docs/changes-0.10.4-local.3.md
```

## 上一个本地修复版：0.10.4-local.2（Git 分支 0.2.3）

- 安装包：`dsh-smooth-stream-0.10.4-local.2.tgz`。
- 修改与验证记录：[后台恢复修改说明](../docs/changes-0.10.4-local.2.md)。
- SHA256：`9b15361855e1afe5981075d00ef87c3334af4603a6e4b32f2921e0a365925ddb`。
- 已通过类型检查、全量回归和构建，并经插件管理器安装启用；真实 WebView 视觉效果仍需复测。
- 分支名不是插件版本号。本次未更改原有 16 字追赶上限或用户设置。

直接引用此分支：

```text
github:2108282/dsh-smooth-stream#0.2.3
```

以下保留 `0.10.3` 的历史安装说明。

本目录存放已构建好的插件安装包，用于**不联网构建、直接用 npm/pnpm 安装**。源码、`lib/`（预编译 bundle）和本包同属一个提交，内容一致。

| 文件 | 说明 |
| --- | --- |
| `dsh-smooth-stream-0.10.3.tgz` | 预编译安装包（含 `lib/`、`src/`、`cordis.patch.yml`、README、LICENSE、manifest） |
| `SHA256SUMS.txt` | 校验值 |

- 版本：`0.10.3`（适配 DSH `>=0.2.2-rc.2 <0.3.0`；自动化测试依赖 `0.2.2-rc.2`，本机已在 DSH `0.2.2-rc.5` 配置中启用，尚未完成真实 QuickChat 前后台切换验证）
- 不含 `node_modules`、用户设置或聊天数据；安装后由 DSH 自行解析 `peerDependencies`。

## 直接从 Git 仓库安装（lib/ 已预编译）

```sh
pnpm dsh plugin --profile web add github:2108282/dsh-smooth-stream
```

`lib/client.js`、`lib/index.js` 已随源码提交，仓库不再声明 `prepare`，因此 pnpm 不需要执行任何构建脚本即可直接安装，无需 `onlyBuiltDependencies` 白名单。

## 用 npm 安装

```sh
npm install https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.10.3.tgz
```

安装包已校验：manifest 版本为 `0.10.3`，且包含与工作区一致的 `lib/client.js`、`lib/index.js`，不需要在本地跑构建。

`peerDependencies`（`@deepseek-ai/*`、`react`）由宿主提供；单独装进空项目时 npm 会给出未满足 peer 的提示，属于正常现象。

## 用 pnpm 安装

pnpm 10 对 `raw.githubusercontent.com` 的 tarball 会报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`，请改用 `github.com/.../raw/...` 形式（已实测通过）：

```sh
pnpm add "dsh-smooth-stream@https://github.com/2108282/dsh-smooth-stream/raw/main/dist/dsh-smooth-stream-0.10.3.tgz"
```

## 装进 DSH 插件 profile

先把包下载到手机/容器任意目录，再按本地路径安装（`dsh plugin add` 会转发给 pnpm）：

```sh
curl -L -O https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.10.3.tgz
pnpm dsh plugin --profile web add /绝对路径/dsh-smooth-stream-0.10.3.tgz
```

## 校验（可选）

```sh
sha256sum dsh-smooth-stream-0.10.3.tgz
# 期望：24157a95137c54e0fdd9cb8308d4048788a6fdab1b827ab6b761d63024975a87
```

## 说明

- 安装/升级前建议先移除同名插件登记再安装，避免包管理器把它当成同一目录的重复安装：

  ```sh
  pnpm dsh plugin --profile web remove dsh-smooth-stream
  pnpm dsh plugin --profile web add https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.10.3.tgz
  ```

- 安装后重启/刷新 DSH 页面，浏览器才会加载新的 `lib/client.js`。
- 旧 UI（DSH `0.1.x`）请使用 `v0.6.2-legacy` 发行版；本包只面向 `0.2.2-rc.2` 新 UI。
- 更新本目录：在仓库根执行 `pnpm build && npm pack --ignore-scripts --pack-destination dist`，再重算 `SHA256SUMS.txt`。
