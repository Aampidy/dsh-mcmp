# mcmp-1 · 数学建模论文自动化流水线

[![npm](https://img.shields.io/badge/npm-dsh--mcmp-blue)](https://www.npmjs.com/package/dsh-mcmp)

DeepSeek Harness **动态 Cordis 插件**:面向全国大学生数学建模竞赛论文撰写的全自动流水线。
粘贴赛题 → 发送一条以 `/loopbegin` 开头的消息 → 插件按 8 大步骤、每步多次迭代自动完成论文撰写,
全程由专家子智能体「先质疑、再迭代」驱动,成果全部落盘保存,右下角浮动面板实时显示进度百分比。

## 功能特性

- **消息触发**:输入文本以 `/loopbegin` 开头即自动运行(兼容斜杠命令路径)
- **8 大步骤 × 多迭代**:每轮 19 次迭代,外循环轮数可配置(`--round=N`,默认 1 轮)
- **质疑驱动**:每个子智能体必须先对上一版成果提出 ≥3 条质疑,再开始本轮工作
- **成果全落盘**:每步迭代完整追加保存(含质疑清单),旧内容绝不覆盖;代码保留全部历史版本
- **实时进度面板**:独立浮动窗口(可拖拽/最小化/关闭),显示百分比进度条、当前轮/步骤/迭代、8 步骤打点、日志、产出文件,支持一键中止
- **原生工作流卡片**:聊天区实时显示每个子智能体的运行状态(按阶段分组)

## 八大步骤(每轮 19 次迭代)

| 步骤 | 内容 | 迭代次数 |
|------|------|----------|
| S1 | 赛题分析 | 3 次(初步拆解→深度分析→最终定调) |
| S2 | 模型求解 | 3 次(模型建立→模型求解→模型验证) |
| S3 | 编程实现 | 3 次(核心代码→完善调试→优化封装) |
| S4 | 图表生成 | 3 次(基础图表→美化优化→精选定稿) |
| S5 | 流程与架构图 | 3 次(结构设计→细节完善→美化定稿) |
| S6 | 论文撰写 | 2 次(初稿→深化润色) |
| S7 | 编译与合规检查 | 1 次 |
| S8 | 评审改进循环 | 1 次 |

## 使用方法

1. **发送赛题**:把数学建模竞赛题目完整粘贴到对话框并发送;
2. **触发插件**:发送一条以 `/loopbegin` 开头的消息:
   - `/loopbegin` —— 默认 1 轮
   - `/loopbegin --round=3` —— 3 轮外循环(上限 10)
   - `/loopbegin --from 题目.txt` —— 从文件读取赛题(支持含空格/中文的文件名,如 `--from 2024 年高教社杯全国大学生数学建模竞赛题目.md`,也可用 `--from=文件` 形式)
3. **查看进度**:右下角浮动面板(百分比、步骤打点、日志、文件)+ 聊天区工作流卡片。

辅助命令:`/loopstatus`(查看进度)、`/loopabort`(中止,已产出成果保留)。

### 触发规则

| 消息内容 | 是否触发 |
|---|---|
| `/loopbegin --round=3`(开头) | ✅ |
| `  /loopbegin`(前导空格) | ✅ |
| `题目正文… /loopbegin`(不在开头) | ❌ |
| `/loopstatus`、`/loopabort` | 辅助命令,不触发 |

## 安装方式

> 插件包已发布到 npm([dsh-mcmp](https://www.npmjs.com/package/dsh-mcmp)),并声明了 `dsh.bundle`
> 补丁:安装后**自动注册配置行**,无需任何手动步骤。

### 安装(唯一方式)

```powershell
# 一条命令完成:安装包 + 自动注册(通过 bundle 机制)
pnpm dsh plugin --profile web add dsh-mcmp
# 等价调用形式:
#   dsh plugin --profile web add dsh-mcmp
#   npx @deepseek-ai/dsh plugin --profile web add dsh-mcmp

# 然后重启:
#   重启 pnpm dsh web → 刷新网页
#   验证:浏览器访问 /mcmp-api/state,返回 JSON 即成功
```

**升级**:

```powershell
pnpm dsh plugin --profile web update dsh-mcmp
```

**卸载**:

```powershell
pnpm dsh plugin --profile web remove dsh-mcmp
```

## 输出目录(工作区 `数学建模流水线/`)

```
数学建模流水线/
├── 00_赛题原文.md        # 启动时自动保存的赛题
├── 01_赛题分析.md ~ 08_评审改进.md   # 八大步骤完整成果(逐迭代追加,含质疑清单)
├── 代码/                 # 全部验证与求解代码(_vN 后缀保留历史版本,绝不删除)
├── 图表/                 # 全部图表(含归档)
├── 论文/                 # LaTeX 源码(若环境支持)
└── 流水线说明.md         # 目录说明
```

## 架构

```
用户消息(/loopbegin 开头)
   │  session/event 全局监听(或 commands 斜杠命令)
   ▼
Host 插件(dsh-mcmp,HOST 组合)
   ├─ 提取赛题(对话文本或 --from 文件)
   ├─ 断点续跑:扫描会话日志中 tool-workflow/* 记录,跳过已完成迭代
   ├─ 编排器:按 8 步骤 × 19 迭代 × N 轮逐个启动专家子智能体(subagents.spawn)
   │       子智能体:读必读文件 → 质疑先行 → 完成任务 → 追加落盘 → 返回总结
   ├─ 向会话追加 tool-workflow/* 事件 → 聊天区原生工作流卡片
   └─ 面板 API:webServer 路由 /mcmp-api/{state,abort,reset}
   ▲
Client 插件(dsh-mcmp,标准 __ModuleLoader__ bundle)
   ├─ shell.overlay 浮动面板,每 1.2s fetch('/mcmp-api/state') 轮询
   └─ 进度条/步骤打点/日志/文件/中止按钮(拖拽仅绑定标题文字)
```

## 文件说明

> 仓库根目录即插件包本体(发布到 npm 的内容 = `lib/` + `cordis.patch.yml` + `package.json`)。

| 文件 | 内容 |
| --- | --- |
| `package.json` | 插件包清单:`dsh.bundle` 补丁声明、`dsh.client` 声明、`exports` 入口(`.` → Host,`./client` → 面板 bundle) |
| `cordis.patch.yml` | **bundle 补丁**:安装时自动注册插件行(`insert: mcmp`),无需手动编辑配置 |
| `lib/index.js` | **Host 半**:命令注册、断点续跑、Host 侧子智能体编排、`/mcmp-api` 面板路由 |
| `lib/client.js` | **Client 半**:浮动进度面板(标准 `__ModuleLoader__` bundle,`fetch` 轮询) |

## License

MIT
