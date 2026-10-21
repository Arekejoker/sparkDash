# 快速开始（简体中文）

sparkDash 是一个 **Web 看板**：后端跑在 Linux/DGX Spark 上，电脑、平板或手机用浏览器访问。它不是那种下载后双击运行的桌面 App；手机端可以“添加到主屏幕”，但需要安全上下文（HTTPS 或 localhost）。

## 环境

- Linux（DGX Spark / Ubuntu 22.04+，arm64 或 x86）
- Node.js 22+（本分支用 Node 24 验证）
- 能通过 SSH 访问要监控的 Spark
- 默认端口 `5555`

## 本机运行

```bash
git clone -b zh-cn https://github.com/Arekejoker/sparkDash.git
cd sparkDash
npm ci
npm run build
cp .env.example .env
```

编辑 `.env`，至少设置：

```dotenv
BIND_HOST=0.0.0.0
PORT=5555
SPARKDASH_TOKEN=换成一个足够长的随机值
SPARKDASH_ALLOW_OPEN_REMOTE=0
```

然后启动：

```bash
node server/index.js
```

浏览器打开 `http://<这台机器的地址>:5555`，首次会提示输入 `SPARKDASH_TOKEN`。

## Docker

先构建前端，再启动容器：

```bash
npm ci
npm run build
cp .env.example .env
# 同样设置 BIND_HOST / SPARKDASH_TOKEN / SPARKDASH_ALLOW_OPEN_REMOTE
docker compose up -d --build
```

`docker-compose.yml` 使用 host network、host PID，并挂载 `/proc`、`/sys`、`/`，所以只建议在自己的 DGX/Linux 主机上运行，见文件里的注释。

## 添加 Spark

启动后在页面里点 **添加 Spark**，填写主机地址、LAN IP 和 SSH 用户/密钥。也可以手动维护 `config/sparks.json`；该文件和 `config/` 下的运行数据默认不进入 Git，不要提交。

本机节点需要能读 `/proc`、`/sys` 并调用 `nvidia-smi`；远程节点通过 SSH 采集。

## 其他设备访问

- 电脑/平板/手机：同一局域网直接打开 `http://<host>:5555`
- 手机“添加到主屏幕”：需要 HTTPS（例如 Tailscale Serve、Caddy/Nginx 反代）或在本机 `localhost` 访问；普通 LAN `http://` 只能当网页用，不能安装 PWA
- 远程访问：优先 Tailscale/SSH 隧道，不要把 5555 直接映射到公网
- 如果设置了 `BIND_HOST=0.0.0.0`，务必设置 `SPARKDASH_TOKEN`，并建议 `SPARKDASH_ALLOW_OPEN_REMOTE=0`

## Windows / macOS

可以运行 Node 后端，但本机 GPU/`/proc` 指标依赖 Linux；更合适的做法是把后端跑在 DGX/Linux，其他电脑只当浏览器客户端。用 Docker Desktop 跑完整监控也不是官方主路径。

## 升级

```bash
git pull --ff-only
npm ci
npm run build
# 重启 node 或 docker compose
```

## 中文界面

默认中文，右下角 `EN / 中文` 切换。实现和限制见 [ZH-CN.md](ZH-CN.md)。本分支不包含 AI mode、EvalScope、Gemini 等 DGX 实验功能。
