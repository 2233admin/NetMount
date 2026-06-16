<h1 align="center">
  <br>
<img src="https://raw.githubusercontent.com/VirtualHotBar/NetMount/main/public/img/color.svg" width="150"/>
  <br>
  NetMount
  <br>
</h1>

<h4 align="center">统一管理和挂载云存储设施</h4>

<p align="center">
  <a href="https://www.netmount.cn">首页</a> -
  <a href="https://docs.netmount.cn">文档</a> -
  <a href="https://blog.hotpe.top">博客</a> 
</p>


## 关于此 Fork

上游 [NetMount](https://github.com/VirtualHotBar/NetMount) 是带图形界面的 Tauri 桌面应用。本 fork 抽出 runtime seam,加了一套**无界面 headless CLI**,可在服务器 / 无桌面环境直接挂载和管理云存储。

新增:
- `cli/` -- daemon、storage、mount、file、sync、task、stats、config 等命令,用法见 [`docs/CLI-UX-DESIGN.md`](docs/CLI-UX-DESIGN.md)
- openlist + rclone 桥接,复用上游业务逻辑,不改 GUI 行为

AGPL-3.0,上游版权与 LICENSE 完整保留。不含任何凭证抓取 / 导出工具。

## 发布版
在仓库的 [Releases](https://github.com/VirtualHotBar/NetMount/releases) 页面或[官方站点](https://www.netmount.cn/download)可以下载到最新发布的版本。

## 开发
招募本项目的维护者，如果你觉得本项目有价值或对你有帮助，请一起完善本项目。

技术栈：Rust + TypeScript + Tauri + React + Vite

依赖框架：[Rclone](https://github.com/rclone/rclone) , [OpenList](https://github.com/OpenListTeam/OpenList)。

开发环境:Nodejs(包管理PNPM) + Rust

命令:
- 安装依赖：pnpm install
- 启动开发环境：pnpm tauri-dev
- 构建可执行文件：pnpm tauri-build

## 截图
![image](https://github.com/VirtualHotBar/NetMount/assets/96966978/a919b68e-a165-411f-a99b-d184b3f264b0)

## 鸣谢
- [缤纷云 Bitiful](https://www.bitiful.com/) - 为本项目提供CDN和存储资源。

## 许可证

NetMount的自编代码基于 AGPL-3.0 许可证开源。[详细信息请参阅](https://docs.netmount.cn/license/)
