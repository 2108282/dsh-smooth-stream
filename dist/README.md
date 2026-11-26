# 预编译安装包（dist）

## 0.10.8（fix/remove-background-text-backlog 分支）

基于 0.10.7，移除后台文字积压收集及恢复追赶：

- 后台助手文本仅保留最新源快照，工具文字直接同步，不再建立待播放队列。
- 返回前台直接显示已收到的完整快照；后续新文字继续正常平滑输出。
- 移除三种恢复方式选择和每帧 16 字追赶预算，兼容旧配置。
- 修复重连基线、同批挂载节点及缓存恢复时序，保留正常前台接力。
- 真实 WebView 前后台切换效果仍待实机验证。

对应文件：

```text
dist/dsh-smooth-stream-0.10.8.tgz
dist/SHA256SUMS.txt
docs/changes-0.10.8.md
```

## 从仓库安装预编译版本

```text
github:2108282/dsh-smooth-stream#fix/remove-background-text-backlog
```

此分支随源码提交预编译 lib，不声明 prepare，不需要运行本地构建脚本。0.10.8 尚未合并到 main，安装时请使用此分支来源。

## 下载当前分支安装包

```sh
curl -L -O https://raw.githubusercontent.com/2108282/dsh-smooth-stream/fix/remove-background-text-backlog/dist/dsh-smooth-stream-0.10.8.tgz
```

也可从 DSH 插件管理器选择本地预编译包安装。升级时保留既有启用状态和配置，不先卸载插件、不重启 DSH；需要观察新版时刷新原页面。

单独安装到空 npm 项目可以使用：

```sh
npm install https://raw.githubusercontent.com/2108282/dsh-smooth-stream/fix/remove-background-text-backlog/dist/dsh-smooth-stream-0.10.8.tgz
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
