# 预编译安装包（dist）

本目录存放已构建好的插件安装包，用于**不联网构建、直接用 npm/pnpm 安装**。源码、`lib/`（预编译 bundle）和本包同属一个提交，内容一致。

| 文件 | 说明 |
| --- | --- |
| `dsh-smooth-stream-0.9.0.tgz` | 预编译安装包（含 `lib/`、`src/`、`cordis.patch.yml`、README、LICENSE、manifest） |
| `SHA256SUMS.txt` | 校验值 |

- 版本：`0.9.0`（适配 DSH `>=0.2.2-rc.2 <0.3.0`，验证目标 `0.2.2-rc.2`）
- 不含 `node_modules`、用户设置或聊天数据；安装后由 DSH 自行解析 `peerDependencies`。

## 安装

### 1. 在线：直接装仓库里的包

```sh
pnpm dsh plugin --profile web add https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.9.0.tgz
```

`dsh` 已在 `PATH` 时：

```sh
dsh plugin --profile web add https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.9.0.tgz
```

### 2. 离线：先下载再按本地路径安装

```sh
# 任意目录
curl -L -O https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.9.0.tgz

# 安装本地 tarball
pnpm dsh plugin --profile web add /绝对路径/dsh-smooth-stream-0.9.0.tgz
```

### 3. 校验（可选）

```sh
sha256sum dsh-smooth-stream-0.9.0.tgz
# 期望：6c41f32c3c6cc66ccf501d6a479aa61cf7979fcacc521f090fd217c8c82c751c
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
