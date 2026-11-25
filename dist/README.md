# 预编译安装包（dist）

## 正式修复版 0.10.7（main）

基于正式版 0.10.4，包含前台恢复诊断及无门槛开始捕获入口，状态可跨设置页面保持。

- 取消后台追赶固定 40ms 提交等待；重同步完成且无积压时退出恢复。
- 收起的思考与工具详情不再形成不可见的长时间吐字门禁，可见摘要仍有动画。
- 已显示到单行省略边界后，同步不可见路径尾巴，保留完整原文与原事件。
- 诊断按用户操作捕获 RAF 回调间隔、耗时、队列规模和 Long Task；不等于物理显示 FPS。
- 16 字追赶预算、字速/滚动设置及 context 包装规则不变；真实 WebView 实机数据仍待复现。

对应文件：

```text
dist/dsh-smooth-stream-0.10.7.tgz
dist/SHA256SUMS.txt
docs/changes-0.10.7.md
```

## 从仓库安装预编译版本

```text
github:2108282/dsh-smooth-stream#main
```

main 随源码提交预编译 lib，不声明 prepare，不需要运行本地构建脚本。GitHub 安装只会在本次 main 推送成功后包含正式版。

## 下载正式安装包

```sh
curl -L -O https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.10.7.tgz
```

也可从 DSH 插件管理器选择本地预编译包安装。升级时保留既有启用状态和配置，不先卸载插件、不重启 DSH；需要观察新版时刷新原页面。

单独安装到空 npm 项目可以使用：

```sh
npm install https://raw.githubusercontent.com/2108282/dsh-smooth-stream/main/dist/dsh-smooth-stream-0.10.7.tgz
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
