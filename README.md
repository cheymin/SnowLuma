<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="SnowLuma 将 QQ 原生会话桥接到 OneBot、WebUI 与自动化工具" />
</p>

<p align="center">
  <a href="https://github.com/cheymin/SnowLuma/actions/workflows/docker-build.yml"><img alt="镜像构建" src="https://img.shields.io/github/actions/workflow/status/cheymin/SnowLuma/docker-build.yml?branch=main&style=flat-square&label=docker"></a>
  <a href="https://github.com/cheymin/SnowLuma/pkgs/container/snowluma"><img alt="GHCR 镜像" src="https://img.shields.io/badge/ghcr.io-snowluma-blue?style=flat-square"></a>
  <a href="https://github.com/SnowLuma/SnowLuma/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/SnowLuma/SnowLuma?style=flat-square"></a>
</p>

> [!NOTE]
> **Fork 改动说明**：本 fork 面向容器化与云端部署场景，对原版做了一些调整。原版发行方式与功能保持不变，详见下方「Fork 改动」章节。

## Fork 改动

本 fork 在原版 SnowLuma 基础上做了以下调整，主要目标是**单一容器、单端口暴露、开箱即用**：

### 1. 默认端口改为 7860

- `packages/common/src/runtime.ts` 中的 `DEFAULT_WEBUI_PORT` 由 5099 改为 **7860**
- `packages/core/config/runtime.json` 中 `webuiPort` 同步为 7860
- WebUI 服务端 `packages/core/src/webui/server.ts` 默认监听 7860
- 容器对外只暴露 7860 一个端口，所有子服务由内部反代统一接入

### 2. noVNC 集成到 WebUI

无需独立 VNC 客户端，登录 WebUI 后在侧边栏点击「远程桌面」即可在浏览器中操作 QQ 桌面客户端：

- 新增 `packages/core/src/webui/vnc-proxy.ts`：WebSocket → TCP 代理，将 `/api/vnc/ws` 转发到容器内 `127.0.0.1:5900`（x11vnc）
- 新增 `packages/webui/src/components/pages/vnc-page.tsx`：基于 `@novnc/novnc` 的远程桌面页面，支持鼠标/键盘输入、全屏切换
- WebUI 路由 `/vnc` 与侧边栏「远程桌面」菜单项
- **VNC 鉴权走面板 token**，不再需要单独的 VNC 密码

### 3. Docker 镜像构建

- 新增 `Dockerfile` 多阶段构建：Stage 1 用 `node:22-slim` 构建 SnowLuma；Stage 2 基于 `ubuntu:22.04` 安装 Xvfb、x11vnc、fluxbox、QQ NT 与所有运行时依赖
- 新增 `.github/workflows/docker-build.yml`：push 到 `main` 时自动构建并推送到 `ghcr.io/cheymin/snowluma:latest`（amd64，可通过 `workflow_dispatch` 手动触发 arm64 构建）
- QQ NT 3.2.31 deb 在构建时从腾讯 CDN 下载（amd64 与 arm64 自动选择）
- 容器内自动启动：Xvfb → fluxbox → QQ → x11vnc → SnowLuma
- 已设置 `ptrace_scope=0` 以允许 hook 注入 QQ 主进程

### 4. Hugging Face Space 一行部署

主镜像内置 nginx，HF Space 只需两行 Dockerfile：

```dockerfile
FROM ghcr.io/cheymin/snowluma:latest
ENV SNOWLUMA_HF_MODE=1
```

- `SNOWLUMA_HF_MODE=1` 触发 entrypoint 自动启动 nginx
- nginx 监听 7860，反代 SnowLuma（5099）/ OneBot HTTP（3000→`/http/`）/ OneBot WS（3001→`/ws/`）
- noVNC WebSocket 走 SnowLuma 的 `/api/vnc/ws`，无需额外配置

### 5. 进程注入过滤

修复 `packages/bridge/src/injector.ts`：原生 addon 把 Electron 子进程（renderer / GPU / utility）误判为 "QQ 主进程"，导致 WebUI 进程列表显示 10+ 条目。新增 `isElectronChildProcess(pid)` 过滤掉带 `--type=` 的子进程，只保留真正的 QQ 主进程。

### 与原版的兼容性

- 所有上游功能保持不变：OneBot v11 协议、SDK、MCP、WebUI 主体逻辑
- OneBot HTTP（3000）和 WS（3001）端口不变
- 上游更新可直接 rebase，fork 改动集中在新增文件（Dockerfile / vnc-proxy.ts / vnc-page.tsx 等）和少量端口/依赖修改

---

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#docker-部署">Docker 部署</a> ·
  <a href="#hugging-face-space-部署">HF Space 部署</a> ·
  <a href="./docs/onebot-actions.md">动作参考</a> ·
  <a href="./packages/sdk/README.md">SDK</a> ·
  <a href="./packages/mcp/README.md">MCP</a> ·
  <a href="https://github.com/cheymin/SnowLuma/issues">问题反馈</a>
</p>

SnowLuma 是面向 QQ 客户端的 TypeScript 互操作运行时。它把 QQ 原生会话转换为 [OneBot v11](https://github.com/botuniverse/onebot-11) 动作与事件，并通过 WebSocket、HTTP、WebUI、SDK 和 MCP 提供统一入口；每个账号拥有独立会话，适合机器人开发、自动化与协议研究。

> [!CAUTION]
> **使用边界**：SnowLuma 是独立的第三方互操作项目，**与腾讯 / QQ 无任何隶属或授权关系**。本项目仅供学习与技术研究，请遵守《QQ 用户协议》及适用法律；软件按“现状”提供、不附带任何担保，使用风险自负。详见 [`EULA.md`](EULA.md)。
>
> **Disclaimer**: SnowLuma is an independent third-party interoperability project with no affiliation with or endorsement by Tencent / QQ. It is provided for study and research only, “as is” and without warranty. See [`EULA.md`](EULA.md).

## 运行链路

<p align="center">
  <img src="./assets/readme/runtime-map.svg" width="100%" alt="QQ 会话经过协议桥接与 OneBot 标准化后连接到 WebSocket、HTTP、WebUI、SDK 和 MCP" />
</p>

SnowLuma 将会话接入、协议解析、身份映射、OneBot 转换和网络适配拆成清晰边界。多个 QQ 账号可以并行运行，同时保持独立状态、日志与连接配置。

## 核心能力

| 场景 | SnowLuma 提供 |
| --- | --- |
| OneBot 接入 | OneBot v11 动作与事件，支持 WebSocket 服务端 / 客户端及 HTTP 服务端 / 上报 |
| 消息与媒体 | 文本、图片、语音、视频、文件、回复、提及、转发及 JSON / XML 卡片等常见消息元素 |
| 多账号运行 | 每个 QQ 账号独立维护会话、身份映射、消息存储与网络适配器 |
| WebUI 管理 | 账号状态、实时日志、连接配置、动作调试、密码管理与可定制总览 |
| 开发者工具 | 提供 [`@snowluma/sdk`](packages/sdk/README.md) 与 [`@snowluma/mcp`](packages/mcp/README.md) |
| 可观察错误 | 关键解析与执行失败会留下明确上下文，不以静默丢弃掩盖问题 |

## 快速开始

### 1. 选择发行包

前往 [Releases](https://github.com/SnowLuma/SnowLuma/releases) 下载与你的平台匹配的版本：

| 平台 | 完整版（内置 Node.js，推荐） | Lite（需要 Node.js 22+） |
| --- | --- | --- |
| Windows x64 | `SnowLuma-vX.Y.Z-win-x64.zip` | `SnowLuma-vX.Y.Z-win-x64-lite.zip` |
| Linux x64 | `SnowLuma-vX.Y.Z-linux-x64.tar.gz` | `SnowLuma-vX.Y.Z-linux-x64-lite.tar.gz` |
| Linux arm64 | `SnowLuma-vX.Y.Z-linux-arm64.tar.gz` | `SnowLuma-vX.Y.Z-linux-arm64-lite.tar.gz` |

完整版适合直接解压运行；Lite 版只移除了内置 Node.js，其余运行时依赖与 WebUI 静态资源保持一致。

### 2. 启动 SnowLuma

Windows 运行 `launcher.bat`。Linux 在解压目录执行：

```bash
chmod +x launcher.sh
./launcher.sh
```

### 3. 打开 WebUI

浏览器访问 [`http://localhost:7860`](http://localhost:7860)。初始账号为 `admin`，随机密码会显示在启动日志中；登录后即可接入已启动的 QQ 进程并配置 OneBot 连接。

<details>
<summary><strong>无人值守部署：通过环境变量确认协议</strong></summary>

同时设置以下两个变量可跳过 WebUI 的协议确认页面：

```bash
SNOWLUMA_ACCEPT_EULA=1
SNOWLUMA_ACCEPT_PRIVACY=1
```

两项必须同时设置，且环境变量确认不会写入持久化同意记录。设置变量即表示运营者已阅读并同意 [`EULA.md`](EULA.md) 与 [`PRIVACY.md`](PRIVACY.md)。

</details>

## Docker 部署

### 拉取镜像

```bash
docker pull ghcr.io/cheymin/snowluma:latest
```

### 运行容器

```bash
docker run -d \
  --name snowluma \
  -p 7860:7860 \
  -v snowluma-config:/app/config \
  -v snowluma-data:/app/data \
  -v snowluma-qq:/home/snowluma/.config \
  ghcr.io/cheymin/snowluma:latest
```

| 挂载路径 | 内容 | 说明 |
| --- | --- | --- |
| `/app/config` | OneBot 配置、运行时配置、TLS 证书 | 核心配置 |
| `/app/data` | 数据库、缓存 | 业务数据 |
| `/home/snowluma/.config` | QQ NT 登录态 | 保留登录状态，避免重启重新扫码 |

容器启动后：
1. 自动启动 Xvfb → fluxbox → QQ → x11vnc → SnowLuma
2. SnowLuma WebUI 监听 7860
3. 登录 WebUI → 侧边栏「远程桌面」→ 点击「连接」即可在浏览器中看到 QQ 桌面
4. 扫码登录 QQ → 「进程注入」页面加载 hook → 自动接入 OneBot

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SNOWLUMA_WEBUI_PORT` | `7860` | WebUI 监听端口 |
| `SNOWLUMA_RESOLUTION` | `1280x720x24` | Xvfb 虚拟桌面分辨率 |
| `SNOWLUMA_HOOK_AUTOLOAD` | `1` | 自动加载 hook 到 QQ 进程 |
| `SNOWLUMA_HF_MODE` | （未设置）| 设为 `1` 启用 HF Space 模式（自动启动 nginx） |
| `SNOWLUMA_ACCEPT_EULA` | （未设置）| 设为 `1` 跳过 EULA 确认页 |
| `SNOWLUMA_ACCEPT_PRIVACY` | （未设置）| 设为 `1` 跳过隐私协议确认页 |

## Hugging Face Space 部署

1. 新建 HF Space（SDK 选 Docker）
2. 上传 `Dockerfile`（仅需两行）：

```dockerfile
FROM ghcr.io/cheymin/snowluma:latest
ENV SNOWLUMA_HF_MODE=1
```

3. 在 Space 的 **Settings → Repository secrets** 添加：

   | Key | Value |
   | --- | --- |
   | `SNOWLUMA_ACCEPT_EULA` | `1` |
   | `SNOWLUMA_ACCEPT_PRIVACY` | `1` |

   （跳过协议确认，HF Space 重启时无人工干预）

4. Space 构建完成即可访问。访问地址就是 Space URL（默认 7860 端口）。

### 端口路由（HF 模式）

nginx 在容器内监听 7860，统一反代：

| 路径 | 上游 | 说明 |
| --- | --- | --- |
| `/` | `127.0.0.1:5099` | SnowLuma WebUI |
| `/http/` | `127.0.0.1:3000` | OneBot HTTP |
| `/ws/` | `127.0.0.1:3001` | OneBot WebSocket |
| `/api/vnc/ws` | SnowLuma 内部代理 → `127.0.0.1:5900` | noVNC WebSocket |

> ⚠️ HF Space 默认只持久化 `/data` 目录。若需保留配置与 QQ 登录态，请按 HF 官方文档开启 Persistent Storage 并自行处理路径映射。

## 选择接入方式

| 入口 | 适合场景 | 参考 |
| --- | --- | --- |
| WebSocket / HTTP | 对接现有 OneBot 机器人框架 | [OneBot 动作参考](docs/onebot-actions.md) |
| TypeScript SDK | 编写类型安全的客户端与消息逻辑 | [`packages/sdk`](packages/sdk/README.md) |
| MCP | 让支持 MCP 的工具查询或调用 SnowLuma 动作 | [`packages/mcp`](packages/mcp/README.md) |
| WebUI | 管理运行状态、日志、账号与连接 | 启动后访问 `http://localhost:7860` |

## 开发与贡献

本地开发需要 Node.js 22+ 与项目锁定版本的 pnpm。所有日常开发基于 `dev` 分支：

```bash
git clone https://github.com/SnowLuma/SnowLuma.git
cd SnowLuma
git checkout dev
pnpm install
pnpm typecheck
pnpm test
```

- 先读 [`CONTEXT.md`](CONTEXT.md) 了解模块边界与项目词汇。
- 提交代码前阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
- 开发方向与已完成事项见 [`RoadMap.md`](RoadMap.md)。

<details>
<summary><strong>主要目录</strong></summary>

| 路径 | 作用 |
| --- | --- |
| `packages/protocol` | QQ 协议定义、数据包解析、消息推送与 OIDB 服务 |
| `packages/onebot` | OneBot 动作执行、事件转换与网络适配 |
| `packages/core` | 运行时编排、QQ 会话桥接与 WebUI 服务端 |
| `packages/webui` | React 管理界面 |
| `packages/sdk` | 对外发布的 TypeScript SDK |
| `packages/mcp` | 面向 MCP 客户端的动作目录与执行入口 |

</details>

## 使用边界与许可

> [!IMPORTANT]
> SnowLuma 使用 **源码可见非商业许可**，**不是 OSI 开源许可**。源码可用于查看、学习、非商业自托管及私下修改；任何商业使用，以及公开发布修改版或衍生版，均需事先取得书面授权。

- 完整条款见 [`LICENSE`](LICENSE)。
- 随附的原生附加组件为专有组件，不在源码许可范围内。
- 二进制发行包另受 [`EULA.md`](EULA.md) 与 [`PRIVACY.md`](PRIVACY.md) 约束。
- 商业授权请联系 `motricseven@foxmail.com`。

SnowLuma is source-available for study and non-commercial self-hosting, but it is **not OSI open source**. Commercial use and public distribution of modified or derivative versions require prior written permission. Bundled native components are proprietary and excluded from the source license.

## 社区与支持

- [提交问题](https://github.com/SnowLuma/SnowLuma/issues)
- [QQ 群](https://qm.qq.com/q/g3UMLpWALe)
- [Telegram](https://t.me/napcatqq)

## 鸣谢

项目参考了 [LagrangeV2](https://github.com/LagrangeDev/LagrangeV2) 的协议定义与 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 的实现思路。

<p align="center">
  <a href="https://github.com/SnowLuma/SnowLuma/graphs/contributors"><img src="https://contrib.rocks/image?repo=SnowLuma/SnowLuma" alt="SnowLuma 贡献者" /></a>
</p>
