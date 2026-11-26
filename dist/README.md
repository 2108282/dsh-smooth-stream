# 预编译安装包（dist）

## 修复版本 0.10.10（`fix/backlog-replay-0.10.10`）

包含积压回放文字上移、助手/工具子调用/分组标题/SVG 创建时序及后台恢复顺序修复。当前包从修复分支获取；尚未合并到 main。

对应文件：

```text
dist/dsh-smooth-stream-0.10.10.tgz
dist/SHA256SUMS.txt
docs/changes-0.10.10.md
```

## 从仓库安装预编译版本

```text
github:2108282/dsh-smooth-stream#fix/backlog-replay-0.10.10
```

修复分支提交预编译 lib。GitHub 安装使用本节指定分支；合并到 main 后再更新为正式版分支。

## 下载修复版安装包

```sh
curl -L -O https://raw.githubusercontent.com/2108282/dsh-smooth-stream/fix/backlog-replay-0.10.10/dist/dsh-smooth-stream-0.10.10.tgz
```

也可从 DSH 插件管理器选择本地预编译包安装。升级时保留既有启用状态和配置，不先卸载插件、不重启 DSH；需要观察新版时刷新原页面。

## 单独安装到空 npm 项目

```sh
npm install https://raw.githubusercontent.com/2108282/dsh-smooth-stream/fix/backlog-replay-0.10.10/dist/dsh-smooth-stream-0.10.10.tgz
```

Host/Client peer 由宿主提供，不能把 npm 项目的 peer 提示当作已完成实时宿主验证。

## 校验

```sh
sha256sum -c SHA256SUMS.txt
```

## 兼容性与历史

- 支持声明：DSH >=0.2.2-rc.2 <0.3.0；自动化 SDK 为 0.2.2-rc.2。
- 不包含 node_modules、聊天数据或用户设置。
- 旧 0.10.3 及 local.2/local.3 包和记录保留用于追溯；local 版本不是当前正式版。
- 旧 DSH 0.1.x UI 使用 v0.6.2-legacy；本次不修改既有 Git 历史或删除备份分支。
- 更新安装包：在仓库根执行 pnpm build 与 npm pack --ignore-scripts --pack-destination dist，然后更新校验清单。
