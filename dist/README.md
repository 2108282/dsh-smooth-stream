# 预编译安装包（dist）

本目录存放已构建好的插件安装包，用于**不联网构建、直接用 npm/pnpm 安装**。源码、`lib/`（预编译 bundle）和本包同属一个提交，内容一致。

| 文件 | 说明 |
| --- | --- |
| `dsh-smooth-stream-0.9.0.tgz` | 预编译安装包（含 `lib/`、`src/`、`cordis.patch.yml`、README、LICENSE、manifest） |
| `SHA256SUMS.txt` | 校验值 |

- 版本：`0.9.0`（适配 DSH `>=0.2.2-rc.2 <0.3.0`，验证目标 `0.2.2-rc.2`）
- 不含 `node_modules`、用户设置或聊天数据；安装后由 DSH 自行解析 `peerDependencies`。

## 直接从 Git 仓库安装（lib/ 已预编译）

```sh
pnpm dsh plugin --profile web add github:2108282/dsh-smooth-stream
```

`lib/client.js`、`lib/index.js` 已随源码提交，仓库不再声明 `prepare`，因此 pnpm 不需要执行任何构建脚本即可直接安装，无需 `onlyBuiltDependencies` 白名单。

## 用 npm 安装

```sh
npm install https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.9.0.tgz
```

已验证：安装后 `node_modules/dsh-smooth-stream/package.json` 的 `version` 为 `0.9.0`，且 `lib/client.js`、`lib/index.js` 均已就位，不需要在本地跑构建。

`peerDependencies`（`@deepseek-ai/*`、`react`）由宿主提供；单独装进空项目时 npm 会给出未满足 peer 的提示，属于正常现象。

## 用 pnpm 安装

pnpm 10 对 `raw.githubusercontent.com` 的 tarball 会报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`，请改用 `github.com/.../raw/...` 形式（已实测通过）：

```sh
pnpm add "dsh-smooth-stream@https://github.com/2108282/dsh-smooth-stream/raw/main/dist/dsh-smooth-stream-0.9.0.tgz"
```

## 装进 DSH 插件 profile

先把包下载到手机/容器任意目录，再按本地路径安装（`dsh plugin add` 会转发给 pnpm）：

```sh
curl -L -O https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.9.0.tgz
pnpm dsh plugin --profile web add /绝对路径/dsh-smooth-stream-0.9.0.tgz
```

## 校验（可选）

```sh
sha256sum dsh-smooth-stream-0.9.0.tgz
# 期望：4d9da47bb2b8de862f5f4a451c00b2bf72ac69a5a9ebd633907cda28a14bad84
```

## 说明

- 安装/升级前建议先移除同名插件登记再安装，避免包管理器把它当成同一目录的重复安装：

  ```sh
  pnpm dsh plugin --profile web remove dsh-smooth-stream
  pnpm dsh plugin --profile web add https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.9.0.tgz
  ```

- 安装后重启/刷新 DSH 页面，浏览器才会加载新的 `lib/client.js`。
- 旧 UI（DSH `0.1.x`）请使用 `v0.6.2-legacy` 发行版；本包只面向 `0.2.2-rc.2` 新 UI。
- 更新本目录：在仓库根执行 `pnpm build && npm pack --ignore-scripts --pack-destination dist`，再重算 `SHA256SUMS.txt`。
