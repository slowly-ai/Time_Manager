# Tempo

Tempo 是一个 Windows 优先的离线优先事件计时应用原型。当前仓库包含：

- `apps/desktop`：React + Vite 桌面界面，支持事件创建、本地持久化、计时恢复和统计。
- `apps/api`：云端 API 骨架，提供健康检查和同步接口入口。
- `packages/domain`：计时状态机与时间计算规则。
- `packages/contracts`：跨端共享的同步类型。

## 开发

```bash
npm install
npm run dev
```

当前环境可先使用浏览器预览；安装 Rust 后可继续接入 `src-tauri` 构建 Windows 安装包。
