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

当前核心数据保存在本地浏览器存储中，支持 JSON 导出；安装 Rust 后可使用 `src-tauri` 构建 Windows 安装包。

## 页面

- 今日工作台：任务清单、目标进度和当前专注。
- 所有任务：筛选、完成、删除和历史会话。
- 项目管理：项目颜色、任务数量和投入时间。
- 专注记录：按会话查看真实计时结果。
- 数据统计：最近 7 天趋势和项目分布。
- 设置：正计时/番茄钟、休息时长、每日目标和导出。
