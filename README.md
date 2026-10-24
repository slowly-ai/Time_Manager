# ChronoDesk

ChronoDesk 是一个 Windows 优先的本地优先任务计时与个人效率工作台。当前仓库包含：

- `apps/desktop`：React + Vite 桌面界面，支持任务、项目、正计时、番茄钟、历史记录、统计和设置。
- `apps/api`：云端 API 骨架，提供健康检查和同步接口入口。
- `packages/domain`：计时状态机与时间计算规则。
- `packages/contracts`：跨端共享的同步类型。

## 开发

```bash
npm install
npm run dev
```

当前核心数据保存在本地应用存储中，支持 JSON 导出。联网不是启动应用的前置条件；联网只用于后续接入云端同步。

`npm run dev` 仅用于浏览器开发预览，`npm run desktop:dev` 仅用于桌面开发调试。普通用户应安装构建出的 Windows 安装包，之后从开始菜单或桌面快捷方式直接打开 `ChronoDesk`，无需 Node.js、终端命令或网络连接。

## Windows 桌面运行与打包

项目使用 Tauri 2。需要先安装：

1. Visual Studio Community 或 Build Tools，勾选 `Desktop development with C++` 和 Windows SDK。
2. Rust MSVC 工具链：

```powershell
$rustupHome = 'G:\开发工具\Rustup'
$cargoHome = 'G:\开发工具\Cargo'
[Environment]::SetEnvironmentVariable('RUSTUP_HOME', $rustupHome, 'User')
[Environment]::SetEnvironmentVariable('CARGO_HOME', $cargoHome, 'User')
$env:RUSTUP_HOME = $rustupHome
$env:CARGO_HOME = $cargoHome
Invoke-WebRequest 'https://win.rustup.rs/x86_64' -OutFile 'G:\开发工具\rustup-init.exe'
& 'G:\开发工具\rustup-init.exe' -y --default-toolchain stable-msvc --profile minimal
```

如果官方源连接不稳定，可以在安装前使用 Rust 镜像：

```powershell
[Environment]::SetEnvironmentVariable('RUSTUP_DIST_SERVER', 'https://rsproxy.cn', 'User')
[Environment]::SetEnvironmentVariable('RUSTUP_UPDATE_ROOT', 'https://rsproxy.cn/rustup', 'User')
```

安装后重新打开终端，确认 `rustc --version` 和 `cargo --version` 可用。

```powershell
npm install
npm run desktop:dev
npm run desktop:build
```

`desktop:build` 会生成包含 WebView2 离线运行时的安装包。安装包首次安装不依赖网络，但体积会比在线引导安装器更大。

开发模式会打开桌面窗口。打包完成后，安装包位于：

```text
apps/desktop/src-tauri/target/release/bundle/nsis/
apps/desktop/src-tauri/target/release/bundle/msi/
```

优先分发 `nsis` 目录中的 `.exe` 安装程序。用户安装一次后，可以直接从 Windows 开始菜单启动应用。

## 应用自动更新

桌面版已接入 Tauri 更新插件。更新包和 `latest.json` 发布在 GitHub Releases，不需要单独购买服务器。应用启动时会检查新版本，用户可以选择稍后更新或立即下载并安装。

发布新版本前需要同步修改以下版本号：

- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/package.json`

然后创建并推送版本标签，例如：

```powershell
git tag v0.1.1
git push origin v0.1.1
```

`.github/workflows/release.yml` 会在 Windows runner 上构建 NSIS 安装包、生成签名更新产物并创建 GitHub Release。仓库需要配置以下 Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：本机签名私钥文件的完整内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成私钥时设置的密码；本项目当前生成的密钥无密码，留空即可。

公钥已经写入 Tauri 配置，私钥不要提交到 Git。当前已经安装的旧版本如果没有包含更新插件，不能自动发现更新；需要先手动安装一个启用自动更新的版本。

Windows 10 1803 及以上和 Windows 11 通常已经包含 WebView2；如果构建或运行时提示缺失，需要安装 Microsoft Edge WebView2 Runtime。

## 页面

- 今日工作台：任务清单、目标进度和当前专注。
- 所有任务：筛选、完成、删除和历史会话。
- 项目管理：项目颜色、任务数量和投入时间。
- 专注记录：按会话查看真实计时结果。
- 数据统计：最近 7 天趋势和项目分布。
- 设置：正计时/番茄钟、休息时长、每日目标和导出。
