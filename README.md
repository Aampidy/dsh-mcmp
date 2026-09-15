# dsh-mcmp

[![npm](https://img.shields.io/badge/npm-dsh--mcmp-blue)](https://www.npmjs.com/package/dsh-mcmp)

DeepSeek Harness 的 Cordis 插件,做全国大学生数学建模竞赛的论文流水线:粘贴赛题,再发一条以 `/loopbegin` 开头的消息,后面的事情它自己跑——中控台加五个阶段(初始化 → EDA → 建模 → 撰写 → 排版),一共 22 个子阶段,全部由子智能体执行。每个子阶段跑完先自检,再由中控台扫描验证或评审决策,问题按 P0-P3 分级,该回滚的回滚、该定点改的定点改。进度在右下角浮窗里看。

**不管跑成什么样,最后都会落一份完整的 Markdown 论文:`Final_Paper.md`。**

流程设计见 `ARCHITECTURE.md`,各子智能体的提示词模板见 `PROMPTS.md`(主循环按它逐段拼提示词)。

## 安装

包已发到 npm([dsh-mcmp](https://www.npmjs.com/package/dsh-mcmp)),自带 `dsh.bundle` 补丁,装完自动注册配置行,不用手动改任何东西。

```powershell
pnpm dsh plugin --profile web add dsh-mcmp      # 安装
pnpm dsh plugin --profile web update dsh-mcmp   # 升级
pnpm dsh plugin --profile web remove dsh-mcmp   # 卸载
```

装完重启 `pnpm dsh web` 并刷新页面。验证:浏览器打开 `/mcmp-api/state`,有 JSON 返回就对了。

## 用法

1. 把赛题完整粘进对话框发出去;
2. 再发一条 `/loopbegin`;
3. 看右下角浮窗(阶段打点、中控台、回滚、日志、产出文件)和聊天区的工作流卡片。

`/loopbegin` 可以带参数:

| 参数 | 作用 |
|---|---|
| `--rollback-limit=N` | 同一阶段回滚上限,默认 10,可填 1~99;到顶就强制锁定 |
| `--from 题目.txt` | 从文件读赛题,文件名带空格或中文都行,也支持 `--from=题目.txt` |
| `--fresh` | 忽略断点记录,从头重跑 |
| `--model 提供商/模型` | 显式指定子任务模型,也可拆成 `--provider` 和 `--model` |

一般不需要 `--model`:子任务默认跟随你在对话右下角选的模型,每次启动时读一次当前选择;实在读不到才退回 `deepseek-official/deepseek-v4-flash`。

辅助命令:`/loopstatus` 看进度,`/loopabort` 中止(已产出的成果都留着),`/loopreset` 清空续跑记录,下次 `/loopbegin` 从头开始。浮窗上的「重置(全新开始)」和 `/loopreset` 是一回事。

### 什么时候会触发

| 消息 | 触发 |
|---|---|
| `/loopbegin --rollback-limit=5` 开头 | ✅ |
| `  /loopbegin` 前面有空格 | ✅ |
| `题目正文… /loopbegin` 不在开头 | ❌ |
| `/loopstatus`、`/loopabort`、`/loopreset` | 辅助命令,不触发 |

## 流水线

| 阶段 | 子阶段 | 主要产出 |
|---|---|---|
| 阶段零 初始化 | 0.1 创建目录 · 0.2 加载数据 · 0.3 初始化索引 · 0.4 初始化教训文件 | `config/`、`raw_data/`、`FILE_INDEX.yaml`、`ROLLBACK_LESSONS.yaml` |
| 阶段一 EDA | 1.1 清洗 · 1.2 特征工程 · 1.3 EDA可视化 | 清洗/变换后的数据、EDA 图表和报告 |
| 阶段二 建模 | 2.1 模型筛选 · 2.2 模型建立 · 2.3 模型求解 · 2.4 图表生成 · 2.5 检验与质疑 | 假设与公式推导、`code/` 求解代码、模型图表、检验质疑报告 |
| 阶段三 撰写 | 3.1 重述与背景 · 3.2 假设与符号 · 3.3 建模与求解 · 3.4 结果分析 · 3.5 摘要 · 3.6 参考文献 · 3.7 附录代码 | `stage_03_outputs/01~07` 各章节 |
| 阶段四 排版 | 4.1 合并 · 4.2 修正路径 · 4.3 最终产出 | `merged_draft.md`、`merged_with_figures.md`、`Final_Paper.md` |

每个子阶段完成后,执行 Agent 会按同一套六维度标准(逻辑自洽性、模型合理性、数据敏感性、视觉合理性、规范符合性、教训对照)先自检,写一份 `_report.yaml`;中控台看报告决定是走扫描验证还是走评审决策。

中控台是唯一的评级机构。P0/P1/P2 顺着 `DEPENDENCIES` 找到根源阶段做阶段级回滚:产出物理移进 `deprecated/`,索引状态置 `OBSOLETE`,教训写进 `ROLLBACK_LESSONS.yaml`,然后重跑。P3 直接定点改,最多 3 行代码、1 个句子或 3 个参数。同一阶段回滚到上限次数就锁成 `FORCED_FINAL` 并通知人工,剩下的问题降级按 P3 处理——这条兜底是为了保证论文一定出得来。

涉及到图表或视觉判断的子阶段(1.3、2.4、2.5、3.3、3.4、4.2、4.3)会调视觉模块:先让它把图表描述清楚,再对描述做一轮系统性质疑。视觉模块用不了就在产出和 `_report.yaml` 里标「待人工确认」。

执行失败和回滚不是一回事。失败(比如子智能体调用出错)按 5s/10s/20s 退避重试 3 次,仍然失败就停下来等人工,不占回滚计数,记录写进 `transactions.log`。

## 输出目录

工作区下建一个 `数学建模流水线/`:

```
数学建模流水线/
├── config/                    # 项目配置(Project_Config.yaml 等)
├── raw_data/                  # 原始数据
├── FILE_INDEX.yaml            # 索引:全部产出物的位置/状态/依赖
├── ROLLBACK_LESSONS.yaml      # 教训文件,执行 Agent 启动必须完整读一遍
├── transactions.log           # 事务日志:执行失败、强制锁定、DAG 阻断
├── stage_00_outputs/          # 阶段零产出(含 _report.yaml)
├── stage_01_outputs/          # 阶段一产出(清洗/特征/EDA 图表与报告)
├── stage_02_outputs/          # 阶段二产出(建模文档、code、figures)
├── stage_03_outputs/          # 阶段三产出(01~07 各章节 Markdown)
├── stage_04_outputs/          # 阶段四产出(合并稿、修正稿)
├── code/                      # 建模求解核心代码(附录代码从这里挑)
├── figures/                   # 全部图表
├── deprecated/                # 回滚废弃的文件,只移不删;比赛结束后可以自己清
└── Final_Paper.md             # 最终论文,无论成败都会生成
```

索引里的状态只有四种:`STAGING`(刚产出待验证)、`VALIDATED`(通过)、`OBSOLETE`(被回滚废弃)、`FORCED_FINAL`(强制锁定后的定稿)。

## 架构

```
用户消息(/loopbegin 开头)
   │  session/event 全局监听,或 commands 斜杠命令
   ▼
程序入口模块 lib/index.js
   ├─ 输入框内检测:斜杠命令注册、消息触发监听、systemPrompt 模型侧提示
   ├─ 模型选择:父对话当前选择 / --model 覆盖 / 兜底 DeepSeek V4 Flash
   ├─ 题目检测:对话文本或 --from 文件
   ├─ 识图能力探测(宿主服务与工具注册表;子智能体以自身工具列表为准)
   └─ 解析并校验启动参数(--rollback-limit/--fresh/--model/--from)→ 交给主循环
   ▼
论文写作主循环模块 lib/pipeline.js
   ├─ 五阶段 × 22 子阶段,逐个启动执行 Agent(提示词由 PROMPTS.md 拼出)
   ├─ 中控台·扫描验证模块:收到 SUCCESS 上报后按六维度扫描
   ├─ 中控台·评审决策模块:P0-P3 评级、根源定位、回滚裁定、P3 定点修改
   ├─ 回滚计数器、阶段级删除调度、强制锁定、重跑、断点续跑
   ├─ 执行失败重试(3 次指数退避)+ transactions.log
   └─ 兜底定稿:不论成败补一版 Final_Paper.md
   ▼
显示界面模块 lib/client.js(标准 __ModuleLoader__ bundle)
   ├─ shell.overlay 浮窗,每 1.2s 拉一次 /mcmp-api/state
   └─ 阶段打点/子阶段/中控台模块/回滚计数/评级/强制锁定提示/日志/文件/中止与重置
```

浮窗的数据和按钮走 `/mcmp-api/{state,abort,reset}`,这三个路由由入口模块注册并转发给主循环。

## 文件说明

仓库根目录就是插件包本体。发到 npm 的内容是 `lib/` + `cordis.patch.yml` + `package.json`,`tests/` 不随包发布。

| 文件 | 内容 |
| --- | --- |
| `package.json` | 包清单:`dsh.bundle` 与 `dsh.client` 声明、`exports` 入口(`.` 给 Host,`./client` 给面板 bundle) |
| `cordis.patch.yml` | bundle 补丁,安装时自动插入插件行(`insert: mcmp`) |
| `ARCHITECTURE.md` | 流程架构设计书:中控台两个模块、五阶段、评级与回滚机制、教训和索引的约束 |
| `PROMPTS.md` | 提示词模板:执行 Agent、扫描验证模块、评审决策模块 |
| `lib/index.js` | 入口模块:输入框内检测、模型选择、题目检测、识图探测、参数解析、`/mcmp-api` 面板路由 |
| `lib/pipeline.js` | 主循环:阶段元数据与提示词构造、扫描与评审调度、回滚与锁定、断点续跑、进度快照、中止与重置 |
| `lib/client.js` | 浮窗面板:轮询、显示与交互 |
| `tests/smoke.mjs` | 冒烟测试:伪造 Cordis ctx 驱动插件,覆盖启动、扫描评审、回滚与强制锁定、P3 定点修改、失败重试、断点续跑、中止、兜底、`--from`、识图探测、`--model`。`node tests/smoke.mjs` |

## License

MIT
