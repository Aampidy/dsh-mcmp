# dsh-mcmp · 数学建模竞赛自动化论文撰写系统(v3)

[![npm](https://img.shields.io/badge/npm-dsh--mcmp-blue)](https://www.npmjs.com/package/dsh-mcmp)

DeepSeek Harness **持久化 Cordis 插件**:面向全国大学生数学建模竞赛论文撰写的全自动流水线。
粘贴赛题 → 发送一条以 `/loopbegin` 开头的消息 → 插件按 **中控台 + 五阶段流水线**(阶段零初始化 →
阶段一 EDA → 阶段二建模 → 阶段三撰写 → 阶段四排版,共 22 个子阶段)自动完成论文撰写,
每个子阶段由专家子智能体执行,再经**中控台双重质疑**(扫描验证模块 + 评审决策模块)验证,
问题按 P0-P3 评级处置(P0/P1/P2 阶段级回滚并持久化教训,P3 精确定点修改),
成果全部落盘,右下角浮动面板实时显示阶段/子阶段/中控台/回滚进度。
**无论流水线正常完成、出错还是被中止,最终都会生成一版完整、干净的 Markdown 论文(`Final_Paper.md`)。**

> 完整设计见仓库内两份设计文档:
> **`ARCHITECTURE.md`**(v3.18,流程架构设计书:中控台、五阶段、评级/回滚/教训机制)与
> **`PROMPTS.md`**(v3.5,全部子智能体 Prompt 模板,主循环提示词由其逐段生成)。

## 功能特性

- **消息触发**:输入文本以 `/loopbegin` 开头即自动运行(兼容斜杠命令路径)
- **五阶段 × 22 子阶段**:阶段零(初始化 4)→ 阶段一(EDA 3)→ 阶段二(建模 5)→ 阶段三(撰写 7)→ 阶段四(排版 3),共 22 个子阶段,线性推进 + 阶段级回滚
- **回滚上限可配置**:同一阶段回滚 ≥`--rollback-limit=N` 次(默认 10,1~99)强制锁定(架构 3.7)
- **中控台双重质疑**:执行Agent自检与中控台扫描验证执行**同一套六维度质疑标准**(逻辑自洽性/模型合理性/数据敏感性/视觉合理性/规范符合性/教训对照);扫描通过→索引 `VALIDATED`,发现问题→转交评审决策模块
- **唯一评级机构**:中控台评审决策模块按 **P0-P3** 评级——P0/P1/P2 经 DEPENDENCIES 链追溯根源阶段,阶段级回滚(物理移入 `deprecated/`、索引 `OBSOLETE`、写入教训文件、重跑);P3 精确定点修改(≤3 行代码/≤1 个句子/≤3 个参数,STAGING→VALIDATED)
- **教训持久化**:每次回滚(<10 次)写入 `ROLLBACK_LESSONS.yaml`(查重去重),所有执行Agent启动时必须完整读取(ACTIVE+RESOLVED)
- **防崩溃优先**:同一阶段回滚 ≥10 次强制 `FORCED_FINAL` 锁定、通知人工,问题降级为 P3 处理,保证必然产出
- **执行失败处理**:非质量问题重试 3 次指数退避(5s/10s/20s),全失败暂停人工介入(不计入回滚计数器),失败日志写入 `transactions.log`
- **索引导航**:`FILE_INDEX.yaml` 记录全部产出物的位置/状态(STAGING/VALIDATED/OBSOLETE/FORCED_FINAL)/依赖,上游状态跨阶段读取有权限校验
- **视觉模块集成**:涉及图表的子阶段(1.3/2.4/2.5/3.3/3.4/4.2/4.3)按两阶段流程调用视觉模块(详实描述→系统性质疑);不可用时标记"待人工确认"
- **论文兜底定稿**:4.3 产出 `Final_Paper.md`;即使流水线提前出错或中止,也会追加一次兜底定稿
- **实时进度面板**:浮动窗口显示总体进度、五阶段打点、当前子阶段、中控台模块、回滚计数与 P0-P3 评级、强制锁定提示、日志、产出文件,支持中止/重置
- **断点续跑与重置**:中断/关闭窗口不丢进度,再次 `/loopbegin` 自动续跑;`/loopreset` 或面板「重置(全新开始)」清空续跑记录
- **原生工作流卡片**:聊天区实时显示每个子智能体的运行状态(执行/扫描/评审/兜底)

## 五阶段流水线(共 22 个子阶段)

| 阶段 | 子阶段 | 核心产出 |
|------|--------|----------|
| 阶段零 初始化 | 0.1 创建目录 · 0.2 加载数据 · 0.3 初始化索引 · 0.4 初始化教训文件 | `config/`、`raw_data/`、`FILE_INDEX.yaml`、`ROLLBACK_LESSONS.yaml` |
| 阶段一 EDA | 1.1 清洗 · 1.2 特征工程 · 1.3 EDA可视化 | 清洗/变换后数据、EDA 图表与报告 |
| 阶段二 建模 | 2.1 模型筛选 · 2.2 模型建立 · 2.3 模型求解 · 2.4 图表生成 · 2.5 检验与质疑 | 假设/公式、`code/` 求解代码、模型图表、检验质疑报告 |
| 阶段三 撰写 | 3.1 重述与背景 · 3.2 假设与符号 · 3.3 建模与求解章节 · 3.4 结果分析 · 3.5 摘要 · 3.6 参考文献 · 3.7 附录代码 | `stage_03_outputs/01~07` 各章节 |
| 阶段四 排版 | 4.1 合并 · 4.2 修正路径 · 4.3 最终产出 | `merged_draft.md`、`merged_with_figures.md`、**`Final_Paper.md`** |

> 每个子阶段完成后:执行Agent按 3.3 六维度自检并写入 `_report.yaml`(SUCCESS/HAS_ISSUES/NEEDS_REVIEW)→
> 中控台扫描验证(SUCCESS 时)或评审决策(HAS_ISSUES/NEEDS_REVIEW 时)→ 通过后推进下一子阶段。

## 使用方法

1. **发送赛题**:把数学建模竞赛题目完整粘贴到对话框并发送;
2. **触发插件**:发送一条以 `/loopbegin` 开头的消息:
   - `/loopbegin` —— 默认启动(22 个子阶段)
   - `/loopbegin --rollback-limit=5` —— 同一阶段回滚上限改为 5 次(默认 10,1~99)
   - `/loopbegin --from 题目.txt` —— 从文件读取赛题(支持含空格/中文的文件名,也可用 `--from=文件` 形式)
   - `/loopbegin --model glm-vision/glm-4.7-Flash` —— 可选显式覆盖(也可用 `--provider 提供商 --model 模型` 分拆形式)。**默认不需要此参数**:流水线子任务的模型**强制跟随你在对话右下角选择的模型**(每次启动时读取当前选择);若无法读取,兜底使用 `deepseek-official/deepseek-v4-flash`
3. **查看进度**:右下角浮动面板(阶段打点、中控台、回滚、日志、文件)+ 聊天区工作流卡片。

辅助命令:`/loopstatus`(查看进度)、`/loopabort`(中止,已产出成果保留)、`/loopreset`(清空状态与断点续跑记录,下次 `/loopbegin` 从头全新开始;等价于面板「重置(全新开始)」按钮)。

### 触发规则

| 消息内容 | 是否触发 |
|---|---|
| `/loopbegin --rollback-limit=5`(开头) | ✅ |
| `  /loopbegin`(前导空格) | ✅ |
| `题目正文… /loopbegin`(不在开头) | ❌ |
| `/loopstatus`、`/loopabort`、`/loopreset` | 辅助命令,不触发 |

## 安装方式

> 插件包已发布到 npm([dsh-mcmp](https://www.npmjs.com/package/dsh-mcmp)),并声明了 `dsh.bundle`
> 补丁:安装后**自动注册配置行**,无需任何手动步骤。

### 安装(唯一方式)

```powershell
# 一条命令完成:安装包 + 自动注册(通过 bundle 机制)
pnpm dsh plugin --profile web add dsh-mcmp

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
├── config/                    # 项目配置(Project_Config.yaml 等)
├── raw_data/                  # 原始数据
├── FILE_INDEX.yaml            # ★ 索引文件:全部产出物的位置/状态/依赖(STAGING/VALIDATED/OBSOLETE/FORCED_FINAL)
├── ROLLBACK_LESSONS.yaml      # ★ 教训文件:回滚教训持久化,执行Agent启动必读
├── transactions.log           # 事务日志:执行失败、强制锁定、DAG 阻断等
├── stage_00_outputs/          # 阶段零产出(含 _report.yaml 上报文件)
├── stage_01_outputs/          # 阶段一产出(清洗/特征/EDA 图表与报告)
├── stage_02_outputs/          # 阶段二产出(建模文档、code 求解代码、figures 图表)
├── stage_03_outputs/          # 阶段三产出(01~07 各章节 Markdown)
├── stage_04_outputs/          # 阶段四产出(合并稿、修正稿)
├── code/                      # 建模求解核心代码(附录代码来源)
├── figures/                   # 全部图表
├── deprecated/                # 回滚废弃文件(物理移入,不删除;建议每场比赛结束后人工清理)
└── Final_Paper.md             # ★ 最终交付:完整、干净的 Markdown 论文(无论成败都会生成)
```

## 架构

> 插件按职责拆分为三个模块,主循环按《ARCHITECTURE.md》v3 实现。

```
用户消息(/loopbegin 开头)
   │  session/event 全局监听(或 commands 斜杠命令)
   ▼
程序入口模块(lib/index.js)
   ├─ 输入框内检测:斜杠命令注册 + 消息触发监听 + systemPrompt 模型侧提示
   ├─ 模型选择:父对话当前选择 / --model 显式覆盖 / 兜底 DeepSeek V4 Flash
   ├─ 题目检测:提取赛题(对话文本或 --from 文件)
   ├─ 识图能力探测(宿主服务/工具注册表扫描;子智能体以自身工具列表为准)
   └─ 启动解析与校验(--rollback-limit/--fresh/--model/--from)→ 委托主循环模块启动
   ▼
论文写作主循环模块(lib/pipeline.js,createPipeline 实例)
   ├─ 五阶段 × 22 子阶段:每个子阶段启动执行Agent(提示词由 PROMPTS.md 2.1/2.2 + 三 生成)
   ├─ 中控台·扫描验证模块:执行Agent上报 SUCCESS 后按 3.3 六维度扫描(PROMPTS.md 4.1)
   ├─ 中控台·评审决策模块:P0-P3 评级、根源定位、回滚裁定与 P3 定点修改(PROMPTS.md 5.1)
   ├─ 代码逻辑:回滚计数器、阶段级删除调度、强制锁定(FORCED_FINAL)、重跑、断点续跑
   ├─ 执行失败重试(3 次指数退避)+ 事务日志 transactions.log
   └─ 兜底定稿:不论成败补一版 Final_Paper.md
   ▼
显示界面模块(lib/client.js,标准 __ModuleLoader__ bundle)
   ├─ shell.overlay 浮动面板,每 1.2s fetch('/mcmp-api/state') 轮询
   └─ 五阶段打点/子阶段/中控台模块/回滚计数/P0-P3 评级/强制锁定提示/日志/文件/中止重置按钮
   (面板 API 路由 /mcmp-api/{state,abort,reset} 由程序入口模块注册并转发)
```

## 文件说明

> 仓库根目录即插件包本体(发布到 npm 的内容 = `lib/` + `cordis.patch.yml` + `package.json`;`tests/` 不随包发布)。

| 文件 | 内容 |
| --- | --- |
| `package.json` | 插件包清单:`dsh.bundle` 补丁声明、`dsh.client` 声明、`exports` 入口(`.` → Host,`./client` → 面板 bundle) |
| `cordis.patch.yml` | **bundle 补丁**:安装时自动注册插件行(`insert: mcmp`),无需手动编辑配置 |
| `ARCHITECTURE.md` | **流程架构设计书 v3.18**:中控台双模块、五阶段、评级/回滚/教训/索引机制与约束 |
| `PROMPTS.md` | **Prompt 设计 v3.5**:执行Agent/扫描验证模块/评审决策模块的全部提示词模板(主循环按此生成) |
| `lib/index.js` | **程序入口模块**:输入框内检测、模型选择、题目检测、识图能力探测、启动参数解析与校验、`/mcmp-api` 面板路由注册 |
| `lib/pipeline.js` | **论文写作主循环模块**:五阶段元数据与提示词构造、中控台扫描/评审调度、回滚与锁定、断点续跑、运行状态与进度快照、中止/重置 |
| `lib/client.js` | **显示界面模块**:浮动进度面板(标准 `__ModuleLoader__` bundle,`fetch` 轮询、显示与交互) |
| `tests/smoke.mjs` | **冒烟测试**:伪造 Cordis ctx 驱动插件,验证启动/扫描评审路由/回滚与强制锁定/P3 定点修改/失败重试/断点续跑/中止/兜底/`--from`/识图探测/`--model` 等路径,`node tests/smoke.mjs`(不随 npm 包发布) |

## License

MIT
