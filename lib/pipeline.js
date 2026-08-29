/**
 * dsh-mcmp · 数学建模竞赛自动化论文撰写系统 —— 论文写作主循环模块(Host 侧)
 *
 * 按《ARCHITECTURE.md》v3.18 与《PROMPTS.md》v3.5 实现正式流水线:
 *  - 五阶段流水线(执行层):阶段零(初始化)→ 阶段一(EDA)→ 阶段二(建模)→
 *    阶段三(撰写)→ 阶段四(排版),共 22 个子阶段,每个子阶段由专家子智能体执行;
 *  - 中控台(Supervisor)两个职能模块,均为独立子智能体:
 *    扫描验证模块(执行Agent上报 SUCCESS 后按 3.3 六维度扫描,通过→索引 VALIDATED,
 *    发现问题→转交评审决策模块)、评审决策模块(唯一评级机构,P0-P3 评级;
 *    P0/P1/P2→定位根源阶段、物理删除(deprecated/)、索引 OBSOLETE、写入教训文件、
 *    阶段级回滚重跑;P3→精确定点修改;同一阶段回滚≥10 次→FORCED_FINAL 强制锁定);
 *  - 核心文件:FILE_INDEX.yaml(索引)、ROLLBACK_LESSONS.yaml(教训)、
 *    transactions.log(事务日志)、_report.yaml(Agent上报)、Final_Paper.md(兜底定稿);
 *  - 执行失败(非质量问题):重试 3 次指数退避(5s/10s/20s),全失败暂停人工介入,
 *    不计入回滚计数器(架构 3.8);
 *  - 断点续跑:按会话落盘的 substage-done/rollback 事件回放游标(仅识别 v3 流程名)。
 *
 * 快照契约(供入口 /loopstatus 与显示界面浮窗渲染,见 lib/index.js 顶部注释):
 * stages/cur/supervisor/total/done/pct 字段按本模块 snapshot() 输出。
 * 通过 createPipeline({ fs, subagents, agents, retryBackoffMs }) 创建实例;
 * 程序入口模块(lib/index.js)负责触发与装配,显示界面模块(lib/client.js)经
 * /mcmp-api 路由访问 snapshot/abort/reset 完成显示与交互。
 */

export const FLOW_NAME = '数学建模竞赛自动化论文撰写系统v3'
// 流水线子阶段总数(4+3+5+7+3);入口模块用它做「已完成无需重复」校验
export const PER_ROUND = 22

// 架构核心文件名(附录A)
const INDEX_FILE = 'FILE_INDEX.yaml'
const LESSONS_FILE = 'ROLLBACK_LESSONS.yaml'
const TX_LOG = 'transactions.log'
const FINAL_PAPER = 'Final_Paper.md'
const DEPRECATED_DIR = 'deprecated/'
// 防崩溃:同一阶段回滚上限(架构 3.7);默认 10,可由 --rollback-limit 参数化配置
const DEFAULT_ROLLBACK_LIMIT = 10

// ---------- 统一质疑标准(架构 3.3,全部六个维度,Agent自检与中控台扫描同标准) ----------
const DIM_STANDARD = [
  '【统一质疑标准(3.3,自检/扫描必须覆盖全部六个维度)】',
  '1. 逻辑自洽性:结论是否支持上一阶段假设?段落逻辑是否顺畅?编号体系是否一致?',
  '2. 模型合理性:是否符合常识?有无更优替代方案?模型复杂度与问题是否匹配?',
  '3. 数据敏感性:结论对数据变化是否过于敏感?关键假设放宽后是否稳定?',
  '4. 视觉合理性:图表是否清晰表达数据特征或模型结构?图表类型是否合理?可视化结果是否与数值结论一致?',
  '5. 规范符合性:LaTeX语法、Markdown格式、路径是否存在、引用编号是否连续?',
  '6. 教训对照:是否重复历史教训文件中的错误?逐条比对 AVOIDANCE_GUIDANCE。',
].join('\n')

// ---------- 视觉模块两阶段流程(架构 3.3 / 提示词 2.1-5) ----------
const VISION_FLOW = [
  '【视觉模块调用(涉及图表时,按两阶段流程执行)】',
  '第一阶段——详实描述:调用视觉模块对图表内容进行清晰、完整、有条理的自然语言描述(数据分布、拟合/对比关系、趋势方向与关键转折点、数据密度与重叠遮蔽、分组分离度、坐标轴与标注、视觉特征、背景信息与数据来源偏见、图表叙事与行动建议)。',
  '第二阶段——审阅与质疑:对视觉描述进行系统性质疑(描述合理性、上下文一致性、趋势审阅、密度与遮蔽审阅、分组审阅、背景偏见审阅、叙事与行动审阅、误导性识别、结论验证),发现问题纳入整体质疑结果按 3.4 评级处置。',
  '视觉模块不可用时,必须在产出与 _report.yaml 中标记"待人工确认"。',
].join('\n')

// ---------- 五阶段 × 22 子阶段(PROMPTS.md 三) ----------
const STAGES = [
  { key: '阶段零', name: '初始化', dir: 'stage_00_outputs', subs: [
    { id: '0.1', name: '创建目录', task: '创建标准化目录结构', outputs: 'config/、raw_data/、stage_XX_outputs/、deprecated/、code/、figures/', focusDims: '规范符合性', focusItems: '目录结构完整?权限正确?', vision: false },
    { id: '0.2', name: '加载数据', task: '读取竞赛附件数据', outputs: '数据加载报告(文件名、行数、列数、编码)', focusDims: '规范符合性、逻辑自洽性', focusItems: '完整读取?编码正确?隐藏Sheet?', vision: false },
    { id: '0.3', name: '初始化索引', task: '创建FILE_INDEX.yaml', outputs: '含PROJ-001和DATA-001记录', focusDims: '规范符合性', focusItems: '格式正确?准确记录所有初始文件?', vision: false },
    { id: '0.4', name: '初始化教训文件', task: '创建ROLLBACK_LESSONS.yaml', outputs: '空框架(LESSONS: [])', focusDims: '规范符合性', focusItems: '创建成功?格式正确?', vision: false },
  ] },
  { key: '阶段一', name: 'EDA', dir: 'stage_01_outputs', subs: [
    { id: '1.1', name: '清洗', task: '处理缺失值、异常值', outputs: '清洗后数据集(CSV)、清洗报告', focusDims: '逻辑自洽性、数据敏感性、教训对照', focusItems: '插补方法合理?剔除有依据?无未来信息?按3.3教训对照维度逐条比对AVOIDANCE_GUIDANCE', vision: false },
    { id: '1.2', name: '特征工程', task: '特征缩放、编码、新特征构造', outputs: '变换后数据集、特征工程报告', focusDims: '逻辑自洽性、模型合理性、教训对照', focusItems: '标准化方法合理?特征有业务意义?按3.3教训对照维度逐条比对AVOIDANCE_GUIDANCE', vision: false },
    { id: '1.3', name: 'EDA可视化', task: '生成EDA图表', outputs: '热力图、直方图、箱线图等', focusDims: '视觉合理性、规范符合性', focusItems: '图表清晰?类型合理?标尺标注单位?', vision: 'must' },
  ] },
  { key: '阶段二', name: '建模', dir: 'stage_02_outputs', subs: [
    { id: '2.1', name: '模型筛选', task: '根据问题类型筛选候选模型', outputs: '候选模型列表、适用性分析', focusDims: '模型合理性、逻辑自洽性、教训对照', focusItems: '模型贴切问题?考虑更优方案?按3.3教训对照维度逐条比对AVOIDANCE_GUIDANCE', vision: false },
    { id: '2.2', name: '模型建立', task: '建立数学模型,声明假设,推导公式', outputs: '假设清单、公式推导(含LaTeX)', focusDims: '逻辑自洽性、模型合理性、规范符合性', focusItems: '假设合理?推导正确?LaTeX语法正确?', vision: false },
    { id: '2.3', name: '模型求解', task: '编写代码,执行计算', outputs: '求解代码(/code/)、计算结果表', focusDims: '规范符合性、数据敏感性', focusItems: '代码可执行?结果合理?含注释?', vision: false },
    { id: '2.4', name: '图表生成', task: '生成数据对比图、结构示意图、流程图、结果可视化图', outputs: '图表文件(/stage_02_outputs/figures/),索引中有FILE_ID', focusDims: '视觉合理性、规范符合性', focusItems: '图表清晰表达?类型合理?坐标轴标注完整?无截断误导?', vision: 'must' },
    { id: '2.5', name: '检验与质疑', task: '按3.3标准对模型系统性质疑', outputs: '检验与质疑报告(含模板中的表格)', focusDims: '全部六个维度', focusItems: '覆盖六个质疑维度(逻辑自洽性、模型合理性、数据敏感性、视觉合理性、规范符合性、教训对照)?发现问题仅事实上报?报告本身作为阶段产出接受中控台扫描验证', vision: 'if',
      extra: '检验与质疑报告模板:\n# 检验与质疑报告\n## 1. 被质疑的模型/图表\n## 2. 质疑依据(表格:维度/检查结果/说明)\n## 3. 结论(是否发现严重问题,仅事实上报)\n## 4. 改进方向' },
  ] },
  { key: '阶段三', name: '撰写', dir: 'stage_03_outputs', subs: [
    { id: '3.1', name: '重述与背景', task: '撰写问题重述与背景', outputs: '/stage_03_outputs/01_problem_restatement.md', focusDims: '逻辑自洽性、教训对照', focusItems: '准确理解题目?背景充分?按3.3教训对照维度逐条比对AVOIDANCE_GUIDANCE', vision: false },
    { id: '3.2', name: '假设与符号', task: '撰写假设与符号说明', outputs: '/stage_03_outputs/02_assumptions.md', focusDims: '逻辑自洽性、规范符合性、教训对照', focusItems: '假设对应模型?符号清晰定义?按3.3教训对照维度逐条比对AVOIDANCE_GUIDANCE', vision: false },
    { id: '3.3', name: '建模与求解章节', task: '撰写建模与求解(含图表嵌入)', outputs: '/stage_03_outputs/03_modeling_solution.md', focusDims: '逻辑自洽性、规范符合性、视觉合理性', focusItems: '图表嵌入正确?编号与正文一致?图表在索引中存在?', vision: 'if' },
    { id: '3.4', name: '结果分析', task: '撰写结果分析与模型评价', outputs: '/stage_03_outputs/04_analysis.md', focusDims: '逻辑自洽性、数据敏感性、教训对照', focusItems: '分析充分?评价客观?按3.3教训对照维度逐条比对AVOIDANCE_GUIDANCE', vision: 'if' },
    { id: '3.5', name: '摘要', task: '撰写摘要(最后进行)', outputs: '/stage_03_outputs/05_abstract.md', focusDims: '逻辑自洽性、规范符合性', focusItems: '覆盖核心贡献?含关键数值?', vision: false },
    { id: '3.6', name: '参考文献', task: '整理参考文献', outputs: '/stage_03_outputs/06_references.md', focusDims: '规范符合性', focusItems: '编号连续?格式统一?', vision: false },
    { id: '3.7', name: '附录代码', task: '将/code/核心代码整理为附录', outputs: '/stage_03_outputs/07_appendix_code.md', focusDims: '规范符合性', focusItems: '代码完整?注释清晰?变量名与正文一致?引用的代码文件在索引中存在对应记录', vision: false,
      extra: '代码筛选标准:仅核心求解代码,排除测试/调试代码,单段≤100行。' },
  ] },
  { key: '阶段四', name: '排版', dir: 'stage_04_outputs', subs: [
    { id: '4.1', name: '合并', task: '合并各章节', outputs: '/stage_04_outputs/merged_draft.md', focusDims: '规范符合性', focusItems: '章节顺序正确?无遗漏?', vision: false },
    { id: '4.2', name: '修正路径', task: '修正图表路径', outputs: '/stage_04_outputs/merged_with_figures.md', focusDims: '规范符合性、视觉合理性', focusItems: '路径存在?引用格式正确?', vision: 'if' },
    { id: '4.3', name: '最终产出', task: '生成Final_Paper.md', outputs: '/Final_Paper.md', focusDims: '全部六个维度', focusItems: '格式符合6.1?引用正确?所有图表路径有效?编号连续?', vision: 'must' },
  ] },
]
const FLAT = []
STAGES.forEach((st, si) => { st.subs.forEach((sub, ii) => { FLAT.push({ s: si, i: ii, key: sub.id, name: sub.name }) }) })
// 每阶段在 FLAT 中的起始下标(阶段级回滚/断点续跑游标复位用)
const STAGE_OFFSETS = []
{ let o = 0; for (const st of STAGES) { STAGE_OFFSETS.push(o); o += st.subs.length } }

// 执行失败重试(架构 3.8 / 提示词 2.2):重试 3 次指数退避
const DEFAULT_RETRY_DELAYS = [5000, 10000, 20000]

/**
 * 创建论文写作主循环实例。
 * @param {object} services 宿主服务:{ fs, subagents, agents } + 可选 retryBackoffMs(测试用)
 * @returns 主循环对外接口:{ isRunning, progressPercent, completedIterations, snapshot, log, trackSession, start, abort, reset }
 */
export function createPipeline({ fs, subagents, agents, retryBackoffMs }) {
  const RETRY_DELAYS = Array.isArray(retryBackoffMs) && retryBackoffMs.length > 0 ? retryBackoffMs : DEFAULT_RETRY_DELAYS

  // ---------- 运行状态 ----------
  function freshState() {
    return {
      status: 'idle', runId: '', rounds: 0, round: 0, total: 0, done: 0,
      phase: '', agentLabel: '', logs: [], files: [], error: '',
      title: '', wsDir: '', problemPath: '', startedAt: 0, endedAt: 0,
      vision: null, visionLive: '',
    }
  }
  let state = freshState()
  let active = null
  let lastSession = null // 最近一次运行所属会话,供「清空状态」追加重置标记
  const recording = new Map()
  // v3 运行期状态(供 snapshot 输出 stages/supervisor 契约字段)
  let stageDone = new Array(STAGES.length).fill(0) // 每阶段已完成子阶段数
  let supervisor = null // { module, rollbackCount, rollbackLimit, forcedFinal, issues:{P0..P3} }

  function fmtTime(ts) {
    const d = new Date(ts)
    const p = (n) => (n < 10 ? '0' + n : String(n))
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }

  function pushLog(m) {
    state.logs.push({ t: fmtTime(Date.now()), m })
    if (state.logs.length > 60) state.logs.splice(0, state.logs.length - 60)
  }

  function mintRunId() {
    return 'run-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1679616).toString(36)
  }

  function makeController() {
    try {
      if (typeof AbortController === 'function') return new AbortController()
    } catch (err) { /* ignore */ }
    const listeners = []
    const sig = {
      aborted: false,
      reason: undefined,
      addEventListener: (t, fn) => { if (t === 'abort') listeners.push(fn) },
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }
    return {
      signal: sig,
      abort: (reason) => {
        if (sig.aborted) return
        sig.aborted = true
        sig.reason = reason
        for (const fn of listeners) { try { fn() } catch (err) { /* ignore */ } }
      },
    }
  }

  function pickProvider() {
    try {
      const names = subagents && typeof subagents.list === 'function' ? subagents.list() : []
      if (names && names.length > 0) return names.indexOf('spawn') >= 0 ? 'spawn' : names[0]
    } catch (err) { /* ignore */ }
    return undefined
  }

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) { resolve(); return }
      const t = setTimeout(resolve, ms)
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
      }
    })
  }

  // ---------- 事务日志(架构 3.8 / 附录A):尽力写入,失败静默 ----------
  async function txLog(args, line) {
    if (!fs || !args.wsDir) return
    try {
      const t = await fs.resolve(args.wsDir + '/' + TX_LOG)
      let prev = ''
      try { prev = await fs.readText(t) } catch (err) { /* 首次写入 */ }
      await fs.writeText(t, prev + line + '\n')
    } catch (err) { /* 宿主 fs 不支持写入时忽略(面板日志仍可见) */ }
  }

  // ---------- 读取 _report.yaml(执行Agent上报;处理后的移入 deprecated/ 由中控台子智能体执行) ----------
  // expectId:当前子阶段 id;报告内 agent_id 与之一致才有效,防止误读上一子阶段的旧报告(架构 3.10.2)
  async function readReportText(args, stage, expectId) {
    if (!fs || !args.wsDir) return null
    try {
      const t = await fs.resolve(args.wsDir + '/' + stage.dir + '/_report.yaml')
      const txt = await fs.readText(t)
      if (expectId !== undefined) {
        const m = /^\s*agent_id\s*:\s*"?([^"\n]+?)"?\s*$/m.exec(txt)
        if (m && m[1].trim() !== expectId) return null // 旧报告残留,视为缺失
      }
      return txt
    } catch (err) { return null }
  }

  async function readReportStatus(args, stage, expectId) {
    const txt = await readReportText(args, stage, expectId)
    if (!txt) return null
    const m = /^\s*status\s*:\s*"?([A-Z_]+)"?\s*$/m.exec(txt)
    return m ? m[1] : null
  }

  async function listOutputs(args, stage) {
    if (!fs || !args.wsDir) return []
    try {
      const t = await fs.resolve(args.wsDir + '/' + stage.dir)
      const entries = await fs.listDir(t)
      return (entries || []).map((e) => e.name).slice(0, 40)
    } catch (err) { return [] }
  }

  // ---------- 断点续跑:回放本会话最后一次 v3 运行的 substage-done/rollback 事件,得到连续完成的子阶段数 ----------
  function completedIterations(session) {
    if (!session || !Array.isArray(session.events)) return 0
    let current = null
    for (const ev of session.events) {
      try {
        if (ev.type === 'tool-workflow/mcmp-reset') {
          // 用户点过「清空状态/重置」:此前的运行记录作废,只从标记之后开始计数
          current = null
          continue
        }
        if (ev.type === 'tool-workflow/run-start') {
          const d = ev.data || {}
          current = d.name === FLOW_NAME ? [] : null
        } else if (current && ev.type === 'tool-workflow/substage-done') {
          current.push(ev.data || {})
        } else if (current && ev.type === 'tool-workflow/rollback') {
          current.push(ev.data || {})
        }
      } catch (err) { /* 单条事件解析失败忽略 */ }
    }
    if (!current) return 0
    let p = 0
    for (const ev of current) {
      if (ev.subKey !== undefined) {
        const expect = FLAT[p % FLAT.length]
        if (expect && expect.key === ev.subKey) p += 1
      } else if (ev.targetIdx !== undefined) {
        const idx = Number(ev.targetIdx)
        if (Number.isSafeInteger(idx) && idx >= 0 && idx < STAGE_OFFSETS.length) {
          p = Math.min(p, STAGE_OFFSETS[idx])
        }
      }
    }
    return p
  }

  function snapshot() {
    const done = state.done
    const total = state.total
    const pct = total > 0 ? Math.min(100, Math.floor((done * 100) / total)) : 0
    const round = state.rounds > 0 ? Math.min(Math.floor(done / PER_ROUND) + 1, state.rounds) : 0
    let cur = null
    if (state.status === 'running' && total > 0 && done < total) {
      const f = FLAT[done % PER_ROUND]
      const st = STAGES[f.s]
      cur = { stageKey: st.key, stageIdx: f.s, stageName: st.name, subIdx: f.i, subName: st.subs[f.i].name, subTotal: st.subs.length }
    }
    const stages = STAGES.map((st, si) => ({
      key: st.key, name: st.name, subTotal: st.subs.length,
      subs: st.subs.map((n) => n.name),
      done: (stageDone && stageDone[si]) || 0,
      active: cur !== null && cur.stageIdx === si,
    }))
    return {
      status: state.status, runId: state.runId, rounds: state.rounds, round, done, total, pct,
      stages, cur,
      supervisor: supervisor ? { ...supervisor, issues: { ...supervisor.issues } } : null,
      phase: state.phase, agentLabel: state.agentLabel,
      logs: state.logs.slice(-12), files: state.files.slice(0, 80),
      error: state.error, title: state.title, wsDir: state.wsDir, problemPath: state.problemPath,
      startedAt: state.startedAt, endedAt: state.endedAt,
      vision: state.vision, visionLive: state.visionLive,
    }
  }

  async function refreshFiles() {
    if (!fs || !state.wsDir) return
    try {
      const rootT = await fs.resolve(state.wsDir)
      const rootL = await fs.listDir(rootT)
      const files = []
      for (const e of rootL) {
        if (files.length >= 80) break
        files.push({ name: e.name, type: e.type === 'directory' ? 'dir' : 'file' })
        if (e.type === 'directory') {
          try {
            const sub = await fs.listDir(e.target)
            for (const se of sub) {
              if (files.length >= 80) break
              files.push({ name: e.name + '/' + se.name, type: se.type === 'directory' ? 'dir' : 'file' })
            }
          } catch (err) { /* 子目录读取失败忽略 */ }
        }
      }
      state.files = files
    } catch (err) { /* 目录尚不存在时忽略 */ }
  }

  // ---------- 提示词构造 ----------
  function visionNote(args, sub) {
    if (!sub.vision) return null
    const line = sub.vision === 'must'
      ? '本子阶段产出含图表,【必须】按3.3两阶段流程调用视觉模块审阅;视觉模块不可用时,在产出与 _report.yaml 中标记"待人工确认"。'
      : '本子阶段若涉及图表,按3.3两阶段流程调用视觉模块审阅;视觉模块不可用时,在产出与 _report.yaml 中标记"待人工确认"。'
    let host = ''
    if (args.vision) {
      host = '宿主侧探测到识图插件(' + (args.vision.source === 'service' ? '服务 ' + args.vision.key : '工具 ' + (args.vision.tools || []).join(', ')) + '),若你的工具列表中可用,请直接调用;'
    } else {
      host = '宿主侧未探测到独立识图插件;'
    }
    return '【视觉模块】' + host + '以你自己的工具列表为准。' + line
  }

  function problemBlock(args) {
    const p = []
    if (args.problem.kind === 'file') {
      p.push('赛题原文文件: ' + args.problem.path + ' —— 先用文件工具读取全文,作为唯一赛题依据。')
    } else {
      p.push('赛题原文(已完整嵌入,请逐字精读):')
      p.push(args.problem.text)
    }
    return p
  }

  // 流水线执行Agent提示词(PROMPTS.md 2.1 系统提示词 + 2.2 用户模板 + 三、各阶段配置)
  function buildExecPrompt(args, stage, sub, si, ii, reportPath) {
    const p = []
    p.push('你正在参与「全国大学生数学建模竞赛论文」自动化撰写系统,担任本子阶段的执行Agent。')
    p.push('')
    p.push('【系统提示词】你是数学建模竞赛论文自动化流水线的【子阶段执行Agent】。')
    p.push('【职责】')
    p.push('1. 完整读取教训文件(含ACTIVE和RESOLVED)')
    p.push('2. 读取索引文件,定位上游产出物')
    p.push('3. 读取上游内容,执行任务,生成产出物')
    p.push('4. 按3.3标准对自身产出完整自检(六个维度:逻辑自洽性、模型合理性、数据敏感性、视觉合理性、规范符合性、教训对照)')
    p.push('5. 若产出物含图表,按架构3.3两阶段流程执行视觉审阅:第一阶段:调用视觉模块获取详实描述;第二阶段:Agent自行对描述进行系统性质疑,发现问题按上报流程处理;视觉模块不可用时,标记"待人工确认"')
    p.push('6. 完成自检后,在产出目录下写入 _report.yaml 文件上报结果')
    p.push('')
    p.push('【约束】')
    p.push('1. 只读 ' + INDEX_FILE + ' 和 ' + LESSONS_FILE + ',绝不自行修改')
    p.push('2. 只引用 VALIDATED / FORCED_FINAL;同阶段内可读STAGING(跨阶段禁止);FORCED_FINAL:读取其标注的瑕疵,在产出物中说明"已了解该瑕疵被系统强制接受",不作为阻断条件')
    p.push('3. 严禁自行评级或建议回滚')
    p.push('4. 执行失败(非质量问题)按重试机制处理,不计入回滚计数器')
    p.push('')
    p.push('【当前子阶段】' + stage.key + ' · ' + sub.id + ' ' + sub.name)
    p.push('【任务目标】' + sub.task)
    p.push('【产出物要求】' + sub.outputs)
    p.push('【重点提示维度】' + sub.focusDims + '(仅为该阶段重点,不豁免其他维度)')
    p.push('【重点检查项】' + sub.focusItems)
    p.push('【相关教训摘要】' + LESSONS_FILE + ' 全文(必须完整读取 ACTIVE+RESOLVED)')
    if (sub.extra) p.push('【补充要求】' + sub.extra)
    p.push('')
    p.push('【执行步骤】')
    p.push('1. 完整读取 ' + LESSONS_FILE + '(含ACTIVE和RESOLVED)')
    p.push('2. 读取 ' + INDEX_FILE + ',查找上游文件路径')
    p.push('3. 验证上游状态:VALIDATED / FORCED_FINAL 允许引用;同阶段STAGING允许;OBSOLETE禁止;FORCED_FINAL:标注"系统强制接受,不作为阻断条件"')
    p.push('4. 执行任务,生成产出物;生成最终产出物前二次确认上游状态,若变更为OBSOLETE或FORCED_FINAL,立即停止并写入 _report.yaml 上报中控台')
    p.push('5. 含图表时按3.3两阶段流程执行视觉审阅;不可用时标记"待人工确认"')
    p.push('6. 按3.3完整自检(全部六个维度)')
    p.push('7. 写入 ' + reportPath + ' 上报结果(仅事实,不评级)。无论是否有问题都必须写入')
    p.push('')
    p.push('【上报文件格式(写入 ' + reportPath + ')】')
    p.push('agent_id: "' + sub.id + '"')
    p.push('timestamp: "当前时间"')
    p.push('status: "SUCCESS | HAS_ISSUES | NEEDS_REVIEW"')
    p.push('issues:')
    p.push('  - problem: "问题描述(仅事实)"')
    p.push('    location: "发生位置"')
    p.push('    involved_files: ["FILE_ID"]')
    p.push('    impact: "影响范围"')
    p.push('(无问题时 issues 为空数组)')
    p.push('')
    p.push('【执行失败处理(非质量问题)】重试上限3次(指数退避:5s/10s/20s),全失败后暂停流水线,人工介入,不计入回滚计数器。失败日志写入 /' + TX_LOG + '。')
    p.push('')
    p.push('【注意事项】不自行修改索引或教训文件;不自行决定回滚;{重点提示维度}仅为重点提示,不豁免其他维度。')
    p.push('')
    p.push(DIM_STANDARD)
    p.push('')
    p.push(VISION_FLOW)
    const vn = visionNote(args, sub)
    if (vn) { p.push(''); p.push(vn) }
    p.push('')
    p.push('【Harness 上下文】')
    p.push('工作区(绝对路径): ' + args.wsDir + ' —— 所有读写都在该目录内,使用绝对路径或相对它的路径。')
    problemBlock(args).forEach((l) => p.push(l))
    p.push('索引文件: ' + args.wsDir + '/' + INDEX_FILE + '(只读);教训文件: ' + args.wsDir + '/' + LESSONS_FILE + '(只读,启动时必须完整读取)')
    p.push('上报文件: ' + reportPath + '(必须写入,格式见上)')
    if (si === 0 && ii === 0) {
      p.push('本子阶段(0.1 创建目录)需创建标准化目录结构: config/、raw_data/、stage_00_outputs/、stage_01_outputs/、stage_02_outputs/、stage_03_outputs/、stage_04_outputs/、' + DEPRECATED_DIR + '、code/、figures/。')
    }
    p.push('论文类文件(stage_03_outputs/ 各章节、' + FINAL_PAPER + ')不得出现流水线内部痕迹("FILE_INDEX""_report.yaml""中控台""子阶段"等),证据一律表述为"支撑材料/附录"。')
    p.push('回复第一行必须写「上报状态: SUCCESS|HAS_ISSUES|NEEDS_REVIEW」,与 ' + reportPath + ' 保持一致;回复结尾附不超过 200 字总结(完成内容、产出文件清单含路径)。')
    return p.join('\n')
  }

  // 中控台·扫描验证模块提示词(PROMPTS.md 4.1)
  function buildScanPrompt(args, stage, sub, reportPath, outputFiles) {
    const p = []
    p.push('你正在参与「全国大学生数学建模竞赛论文」自动化撰写系统,担任中控台的【扫描验证模块】。')
    p.push('')
    p.push('【系统提示词】你是中控台的【扫描验证模块】。')
    p.push('【触发时机】流水线Agent提交 _report.yaml 且 status 为 "SUCCESS" 时,由中控台启动本模块。')
    p.push('【职责】')
    p.push('1. 读取Agent的产出物(从索引中获取文件路径)')
    p.push('2. 按3.3标准对产出物执行完整扫描验证(六个维度:逻辑自洽性、模型合理性、数据敏感性、视觉合理性、规范符合性、教训对照)')
    p.push('3. 若产出物含图表,按3.3两阶段流程调用视觉模块审阅')
    p.push('4. 发现的问题按P0-P3标准评级')
    p.push('5. 发现问题时,将问题及评级结果转交【评审决策模块】处理')
    p.push('6. 未发现问题时,更新索引状态为 VALIDATED')
    p.push('')
    p.push('【约束】扫描验证模块只负责发现和评级问题,不执行修改或删除;发现问题后必须转交评审决策模块,不得自行处置;未发现问题时直接更新索引状态。')
    p.push('')
    p.push('【待扫描的Agent产出】')
    p.push('- Agent ID: ' + sub.id + ' ' + sub.name)
    p.push('- 报告文件: ' + reportPath + '(先读取)')
    p.push('- 当前阶段: ' + stage.key + ' ' + stage.name)
    p.push('- 产出物: ' + (outputFiles.length > 0 ? outputFiles.join(', ') : '从索引文件定位 ' + stage.dir + '/ 下本次产出'))
    p.push('')
    p.push('【执行步骤】')
    p.push('1. 从索引中读取产出物文件路径(若本次产出尚未登记,先按 STAGING 登记:FILE_ID、路径、摘要、DEPENDENCIES)')
    p.push('2. 按3.3标准逐个扫描验证产出物(全部六个维度)')
    p.push('3. 含图表时按3.3两阶段流程调用视觉模块')
    p.push('4. 发现问题时按3.4标准评级')
    p.push('5. 输出扫描结果')
    p.push('')
    p.push(DIM_STANDARD)
    p.push('')
    p.push(VISION_FLOW)
    p.push('')
    p.push('【Harness 上下文】')
    p.push('工作区(绝对路径): ' + args.wsDir)
    p.push('索引文件: ' + args.wsDir + '/' + INDEX_FILE + '(扫描验证模块负责维护其状态)')
    p.push('教训文件: ' + args.wsDir + '/' + LESSONS_FILE + '(只读,先完整读取)')
    p.push('索引更新前必须执行DAG环检测(架构 R-016):发现跨阶段循环依赖时,将警告写入 ' + args.wsDir + '/' + TX_LOG + ' 并阻断本次验证,提示人工介入解除循环依赖。')
    p.push('更新索引时记录时间与当前阶段(架构 R-015);未发现问题时更新索引状态为 VALIDATED;发现问题必须转交评审决策模块,不自行处置。')
    p.push('处理完成后,将本次 ' + reportPath + ' 移入 ' + args.wsDir + '/' + DEPRECATED_DIR + '(重命名加时间戳保留),避免下一子阶段误读旧报告(架构 3.10.2-4)。')
    p.push('回复第一行必须写「扫描结论: PASS|HAS_ISSUES」;随后输出 JSON:')
    p.push('{"module": "扫描验证模块", "scan_result": "PASS|HAS_ISSUES", "status_update": {"files_affected": ["FILE_ID"], "new_status": "VALIDATED"}, "issues_found": [{"file_id": "FILE_ID", "problem": "问题描述", "rating": "P0|P1|P2|P3", "location": "具体位置"}]}')
    p.push('回复结尾附不超过 200 字总结。')
    return p.join('\n')
  }

  // 中控台·评审决策模块提示词(PROMPTS.md 5.1)
  function buildReviewPrompt(args, stage, source, issueText, countsText, limit) {
    const p = []
    p.push('你正在参与「全国大学生数学建模竞赛论文」自动化撰写系统,担任中控台的【评审决策模块】。')
    p.push('')
    p.push('【系统提示词】你是中控台的【评审决策模块】。')
    p.push('【触发时机】1. 流水线Agent提交 _report.yaml 且 status 为 "HAS_ISSUES" 或 "NEEDS_REVIEW" 时;2. 扫描验证模块发现问题并转交时。')
    p.push('【职责】')
    p.push('1. 阅读问题报告,按P0-P3标准评级(唯一评级机构)')
    p.push('2. 通过DEPENDENCIES链追溯根源阶段')
    p.push('3. 做出处置决策:P0/P1/P2:执行回滚;P3:执行精确定点修改,不触发回滚;索引按规则更新状态')
    p.push('4. 回滚时:定位根源→物理删除(删除范围 = 根源阶段全部产出 ∪ 其之后所有阶段全部产出,架构 R-002)→索引OBSOLETE→计数器+1→重跑前写入教训→重跑')
    p.push('5. 回滚后递归检查未被删除文件的DEPENDENCIES,将指向OBSOLETE的依赖标记为OBSOLETE_DEPENDENCY')
    p.push('6. P3修改时:精确定点修改(≤3行代码/≤1个句子/≤3个参数),索引按规则更新状态')
    p.push('7. 维护阶段级独立回滚计数器(递增被回滚到的阶段);回滚后验证:重扫描被回滚阶段产出物,对照原问题检查')
    p.push('')
    p.push('【评级标准】P0 阻断级/结论完全错误→回滚,计数器+1;P1 严重影响质量→回滚,计数器+1;P2 局部问题,不伤核心→回滚,计数器+1;P3 润色层面→精确定点修改,继续推进。')
    p.push('')
    p.push('【P3精确定点修改】')
    p.push('1. 解析问题涉及的文件ID和具体位置')
    p.push('2. 定位到问题所在行或段落,明确修改边界')
    p.push('3. 执行修改:只改问题直接涉及的内容,不重写整段、不重构结构、不扩展范围')
    p.push('4. 修改完成后流水线继续。索引状态:修改前为 STAGING → 直接升级为 VALIDATED(无需重新扫描);修改前为 VALIDATED → 状态保持不变')
    p.push('5. 若判定无法精确定点修改(模糊/无法定位/可能引入新问题),跳过修改,标记"待人工P3修改",继续推进')
    p.push('【精确定点修改边界判定】精确定点修改:≤3行代码/≤1个句子/≤3个参数;超出边界(需重构整个段落/重新设计图表结构/修改涉及多个不连续位置)默认升级为P2(保守策略)。')
    p.push('')
    p.push('【待决策问题】')
    p.push('来源: ' + source)
    p.push(issueText || '(问题报告缺失,请读取索引与教训文件自行核对当前阶段产出)')
    p.push('')
    p.push('【当前各阶段回滚计数器】' + countsText)
    p.push('【当前阶段】' + stage.key + ' ' + stage.name)
    p.push('')
    p.push('【执行】')
    p.push('1. 按P0-P3评级')
    p.push('2. P3:执行精确定点修改(边界:≤3行代码/≤1个句子/≤3个参数);修改前为STAGING则直接升级为VALIDATED,修改前为VALIDATED则状态不变')
    p.push('3. P0/P1/P2:通过DEPENDENCIES链追溯根源阶段,裁定回滚目标')
    p.push('4. 回滚时检查目标阶段计数器:<' + limit + '次:物理删除根源阶段及之后所有阶段的全部产出→索引OBSOLETE→计数+1→写入教训(重跑前,先查重去重)→重跑;≥' + limit + '次:FORCED_FINAL')
    p.push('5. 若最终判定无需处置(NO_ACTION),同时将本次产出在索引中的状态更新为 VALIDATED')
    p.push('6. 处理完成后,将本次 _report.yaml 移入 ' + args.wsDir + '/' + DEPRECATED_DIR + '(重命名加时间戳保留),避免下一子阶段误读旧报告(架构 3.10.2-4)')
    p.push('')
    p.push('【Harness 上下文】')
    p.push('工作区(绝对路径): ' + args.wsDir)
    p.push('索引文件: ' + args.wsDir + '/' + INDEX_FILE + '(读取全文,含DEPENDENCIES链;维护 OBSOLETE/OBSOLETE_DEPENDENCY/VALIDATED 等状态)')
    p.push('教训文件: ' + args.wsDir + '/' + LESSONS_FILE + '(回滚<10次时,在重跑前写入教训;写入前检查是否已有相同根因的ACTIVE教训,若有则更新TIMESTAMP和AFFECTED_STAGES)')
    p.push('物理删除(将根源阶段及之后所有阶段的全部产出物移入 ' + args.wsDir + '/' + DEPRECATED_DIR + ',架构 R-002/R-003)由你使用文件工具执行;回滚计数器维护与重跑调度由系统(代码逻辑)执行,你只需给出评级与决策。')
    p.push('回复第一行必须写「决策: ROLLBACK|P3_FIX|NO_ACTION」;随后输出 JSON:')
    p.push('{"module": "评审决策模块", "rating": "P0|P1|P2|P3", "decision": "ROLLBACK|P3_FIX|NO_ACTION", "rollback_target": "阶段X|null", "reasoning": "...", "root_cause_stage": "阶段X|null", "affected_files": ["FILE_ID"], "p3_fix": {"fixed": true|false, "files_modified": ["FILE_ID"], "status_change": "STAGING→VALIDATED|保持不变|null", "fix_summary": "...", "deferred_to_human": false}, "lesson_written": true|false, "lesson_id": "LSN-XXX|null", "lesson_deduplicated": true|false, "stage_rollback_counts_after": {"阶段X": N}|null}')
    p.push('回复结尾附不超过 200 字总结。')
    return p.join('\n')
  }

  // 兜底定稿(防崩溃优先:不论成败都产出一版 Final_Paper.md)
  function buildFinalizePrompt(args, reason) {
    const p = []
    p.push('你正在参与「全国大学生数学建模竞赛论文」自动化撰写系统的**兜底定稿**环节。此前流水线提前结束(原因:' + reason + '),但交付要求是"不论最终结果如何,都必须产出一版完整的论文"。现在由你仅凭现有文件完成这个承诺。')
    p.push('')
    p.push('【工作区(绝对路径)】' + args.wsDir + ' —— 所有读写都在该目录内。')
    problemBlock(args).forEach((l) => p.push(l))
    p.push('')
    p.push('【现有材料(全部先读,能用的必须用)】')
    p.push('- 索引 ' + INDEX_FILE + ' 与教训文件 ' + LESSONS_FILE + '(只读,定位各阶段产出物与已知问题;以索引最新状态为准)')
    p.push('- stage_00_outputs/ ~ stage_04_outputs/ 下各子阶段产出(章节、报告、图表、清洗/变换数据)')
    p.push('- code/ 下求解代码、figures/ 与各阶段 figures 下全部图表(论文插图用相对路径引用)')
    p.push('')
    p.push('【任务(必须完成)】')
    p.push('1. 若 stage_04_outputs/ 已有完整 merged_with_figures.md 或 ' + FINAL_PAPER + ':以其为底稿做最终校对后写入 ' + FINAL_PAPER + ';否则依据上述全部材料从头撰写完整论文,写入 ' + FINAL_PAPER + '。')
    p.push('2. ' + FINAL_PAPER + ' 必须是可直接提交的完整 Markdown:标题、摘要(含关键词)、问题重述与背景、假设与符号说明、建模与求解(公式编号、图表嵌入)、结果分析与模型评价、参考文献、附录(程序清单);公式行间 $$...$$、行内 $...$,图表 ![描述](./path.png),表格 GFM,参考文献 [1](架构 6.1)。')
    p.push('3. 全文不得出现流水线内部痕迹(索引/教训/_report.yaml/中控台/子阶段等)与参赛者信息;数值只采用各阶段已验证结论,材料不足处明确标注"待补充"并给出推导,严禁编造。')
    p.push('4. 将《提交材料清单》与《遗留问题清单》(教训文件中 ACTIVE 教训、待人工P3修改、未闭环问题)写入 stage_04_outputs/ 的一节或单独文件,供使用者参考,不得进入论文正文。')
    p.push('5. 回复结尾附不超过 200 字总结。')
    return p.join('\n')
  }

  function appendRec(runId, session, type, data) {
    const rec = recording.get(runId)
    if (!rec || !rec.ok) return false
    try {
      session.append(type, data)
      return true
    } catch (err) {
      rec.ok = false
      return false
    }
  }

  function finishRun(runId, stopReason, errorMsg) {
    const rec = recording.get(runId)
    if (rec) {
      if (rec.ok) {
        try { rec.session.append('tool-workflow/run-end', { runId, stopReason }) } catch (err) { /* ignore */ }
      }
      recording.delete(runId)
    }
    if (state.runId === runId) {
      state.status = stopReason
      state.endedAt = Date.now()
      if (stopReason === 'error') state.error = errorMsg || '流水线执行出错'
      if (stopReason === 'cancelled') state.error = '已被用户中止(兜底定稿已尝试生成)'
      state.agentLabel = ''
      if (supervisor) supervisor.module = null
    }
    refreshFiles()
  }

  function doAbort(reason) {
    if (!active) return { ok: false, reason: '没有运行中的流水线' }
    try { active.controller.abort(new Error(reason || '用户在进度面板中中止')) } catch (err) { /* ignore */ }
    return { ok: true }
  }

  // 清空状态 + 重置断点续跑记录:向最近一次运行所属会话追加一条重置标记,
  // 续跑扫描遇到该标记会把之前的运行记录全部作废,下次 /loopbegin 从第 1 个子阶段全新开始。
  function resetRecords() {
    if (state.status === 'running') return { ok: false, reason: '流水线运行中,不能重置' }
    if (lastSession) {
      try { lastSession.append('tool-workflow/mcmp-reset', { ts: Date.now() }) } catch (err) { /* 会话不可追加时忽略 */ }
      lastSession = null
    }
    state = freshState()
    active = null
    stageDone = new Array(STAGES.length).fill(0)
    supervisor = null
    return { ok: true }
  }

  function doReset() {
    return resetRecords()
  }

  // 启动一个子智能体并返回 { ok, text, outcome }
  // agentOptions:可选 { provider, model } —— 强制子任务使用指定模型路由(覆盖父会话的固化选项)
  async function runChild(provider, session, agent, controller, label, promptText, onStarted, agentOptions) {
    let child = null
    try {
      const parent = (agents && agents.get(session.id)) || agent
      child = await subagents.start(provider, {
        label,
        prompt: [{ type: 'text', text: promptText }],
        parent,
        signal: controller.signal,
        ...(agentOptions && agentOptions.provider && agentOptions.model ? { agentOptions } : {}),
      })
      if (onStarted) { try { onStarted(child) } catch (err) { /* ignore */ } }
      const res = await child.result
      const text = (Array.isArray(res.output) ? res.output.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : '')
      const outcome = res.stopReason === 'completed' ? 'completed' : res.stopReason === 'cancelled' ? 'cancelled' : 'failed'
      return { ok: true, started: true, outcome, text: text || '' }
    } catch (err) {
      return { ok: false, started: false, outcome: controller.signal.aborted ? 'cancelled' : 'failed', text: '', err }
    } finally {
      if (child) { try { await child.dispose() } catch (err) { /* ignore */ } }
    }
  }

  // ---------- Host 侧编排器:五阶段 × 中控台双模块,含回滚/锁定/重试/兜底 ----------
  async function runPipeline(runId, session, agent, args, controller) {
    let cancelled = false
    let finalDone = false // 4.3 最终产出是否已成功完成(Final_Paper.md)
    let stopReason = 'completed'
    let errorMsg = undefined
    const provider = pickProvider()
    if (!provider) {
      finishRun(runId, 'error', '没有可用的子智能体提供方(当前部署未注册 subagent provider)')
      if (active && active.runId === runId) active = null
      return
    }
    const total = PER_ROUND // 单遍五阶段 22 个子阶段(线性推进 + 阶段级回滚,无外循环轮次)
    const limit = Number.isSafeInteger(args.rollbackLimit) && args.rollbackLimit >= 1 ? args.rollbackLimit : DEFAULT_ROLLBACK_LIMIT
    const stageCounts = {} // 阶段级独立回滚计数器(架构 3.7:递增被回滚到的阶段)
    const issues = { P0: 0, P1: 0, P2: 0, P3: 0 } // 累计评级(仅展示)
    supervisor = { module: null, rollbackCount: 0, rollbackLimit: limit, forcedFinal: false, issues }
    let totalRollbacks = 0
    let attemptSeq = 0

    // 启动一个子智能体并写工作流卡片;返回 { outcome, text }
    async function spawn(label, phase, promptText) {
      attemptSeq += 1
      const seq = attemptSeq
      let started = false
      const res = await runChild(provider, session, agent, controller, label, promptText, (child) => {
        started = true
        appendRec(runId, session, 'tool-workflow/agent-start', { runId, seq, label, phase, childId: String(child.id) })
      }, args.agentOptions)
      if (started) appendRec(runId, session, 'tool-workflow/agent-end', { runId, seq, outcome: res.outcome })
      return res
    }

    // 执行失败处理(架构 3.8):重试 3 次指数退避,全失败暂停人工介入,不计入回滚计数器
    async function runAgent(kindName, label, phase, promptText) {
      state.phase = phase
      state.agentLabel = label
      let last = null
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        if (controller.signal.aborted) return { outcome: 'cancelled', text: '' }
        const res = await spawn(label, phase, promptText)
        if (res.outcome === 'completed') return res
        last = res
        if (controller.signal.aborted) return { outcome: 'cancelled', text: '' }
        if (attempt < RETRY_DELAYS.length) {
          const ms = RETRY_DELAYS[attempt]
          pushLog(kindName + '执行失败,' + Math.round(ms / 1000) + 's 后重试(' + (attempt + 1) + '/' + RETRY_DELAYS.length + ')')
          await sleep(ms, controller.signal)
        }
      }
      pushLog(kindName + '重试 ' + RETRY_DELAYS.length + ' 次仍失败,流水线暂停,请人工介入(不计入回滚计数器)')
      await txLog(args, fmtTime(Date.now()) + ' [执行失败] ' + kindName + '(' + label + ') 重试' + RETRY_DELAYS.length + '次仍失败,流水线暂停,人工介入')
      return { outcome: 'failed', text: (last && last.text) || '' }
    }

    let g = args.startIndex || 0 // 全局平铺游标(已完成的子阶段数)
    while (g < total) {
      if (controller.signal.aborted) { cancelled = true; break }
      const f = FLAT[g % PER_ROUND]
      const si = f.s
      const ii = f.i
      const stage = STAGES[si]
      const sub = stage.subs[ii]
      const execLabel = stage.key + '·' + sub.id + ' ' + sub.name
      const reportPath = args.wsDir + '/' + stage.dir + '/_report.yaml'
      pushLog('开始: ' + execLabel)

      // ---- ① 流水线执行Agent ----
      const exec = await runAgent('执行Agent', execLabel, stage.key + ' ' + stage.name, buildExecPrompt(args, stage, sub, si, ii, reportPath))
      if (exec.outcome === 'cancelled') { cancelled = true; break }
      if (exec.outcome !== 'completed') {
        stopReason = 'error'
        errorMsg = '执行Agent连续失败(含重试),流水线暂停,请人工介入(架构 3.8,不计入回滚计数器)'
        break
      }

      // ---- 读取 _report.yaml 上报状态(文件优先,回复第一行兜底) ----
      let reportStatus = await readReportStatus(args, stage, sub.id)
      if (!reportStatus) {
        const m = /上报状态[:：]\s*(SUCCESS|HAS_ISSUES|NEEDS_REVIEW)/.exec(exec.text || '')
        reportStatus = m ? m[1] : null
      }
      if (reportStatus === null) pushLog('未读取到 _report.yaml 上报,按 SUCCESS 处理并交扫描验证模块复核')

      // ---- ② 中控台:SUCCESS → 扫描验证模块;HAS_ISSUES/NEEDS_REVIEW → 评审决策模块 ----
      // 上报缺失(null)按 SUCCESS 处理(扫描验证模块复核兜底),与上面的日志口径一致
      let needReview = reportStatus !== null && reportStatus !== 'SUCCESS'
      let issueText = ''
      if (needReview) {
        const repTxt = await readReportText(args, stage, sub.id)
        issueText = (repTxt || exec.text || '').slice(0, 2000)
      }
      if (!needReview) {
        supervisor.module = '扫描验证模块'
        const outputs = await listOutputs(args, stage)
        const scan = await runAgent('扫描验证模块', '中控台·扫描验证·' + sub.id, '中控台·扫描验证', buildScanPrompt(args, stage, sub, reportPath, outputs))
        if (scan.outcome === 'cancelled') { cancelled = true; break }
        if (scan.outcome !== 'completed') {
          stopReason = 'error'
          errorMsg = '扫描验证模块连续失败(含重试),流水线暂停,请人工介入(架构 3.8,不计入回滚计数器)'
          break
        }
        const mScan = /扫描结论[:：]\s*(PASS|HAS_ISSUES)/.exec(scan.text || '')
        const verdict = mScan ? mScan[1] : 'HAS_ISSUES'
        pushLog('扫描验证: ' + (verdict === 'PASS' ? '通过,索引已更新为 VALIDATED' : '发现问题,转交评审决策模块'))
        if (verdict !== 'PASS') {
          needReview = true
          issueText = '扫描验证模块发现问题(转交评审决策模块):\n' + (scan.text || '').slice(0, 2000)
        }
      }

      // ---- ③ 中控台:评审决策模块(唯一评级机构) ----
      if (needReview) {
        supervisor.module = '评审决策模块'
        const countsText = STAGES.map((st, idx) => st.key + ': ' + (stageCounts[idx] || 0) + ' 次').join(', ')
        const source = issueText.indexOf('扫描验证模块发现问题') === 0 ? '扫描验证模块转交' : 'Agent上报'
        const review = await runAgent('评审决策模块', '中控台·评审决策·' + sub.id, '中控台·评审决策', buildReviewPrompt(args, stage, source, issueText, countsText, limit))
        if (review.outcome === 'cancelled') { cancelled = true; break }
        if (review.outcome !== 'completed') {
          stopReason = 'error'
          errorMsg = '评审决策模块连续失败(含重试),流水线暂停,请人工介入(架构 3.8,不计入回滚计数器)'
          break
        }
        const txt = review.text || ''
        const rating = (/评级[:：]\s*(P[0-3])/.exec(txt) || /"rating"\s*:\s*"(P[0-3])"/.exec(txt) || [])[1]
        if (rating) issues[rating] = (issues[rating] || 0) + 1
        let decision = (/决策[:：]\s*(ROLLBACK|P3_FIX|NO_ACTION)/.exec(txt) || /"decision"\s*:\s*"(ROLLBACK|P3_FIX|NO_ACTION)"/.exec(txt) || [])[1]
        if (!decision) {
          decision = 'NO_ACTION'
          pushLog('评审决策输出未识别,按 NO_ACTION 处理(请人工复核)')
        }
        pushLog('评审决策: ' + (rating || '未评级') + ' · ' + decision + (decision === 'P3_FIX' && /"deferred_to_human"\s*:\s*true/.test(txt) ? ' · 已标记待人工P3修改' : ''))
        if (decision === 'ROLLBACK') {
          const targetKey = (/回滚目标[:：]\s*(阶段[零一二三四])/.exec(txt) || /"rollback_target"\s*:\s*"(阶段[零一二三四])"/.exec(txt) || [])[1]
          const idx = targetKey ? STAGES.findIndex((st) => st.key === targetKey) : -1
          const targetIdx = idx >= 0 ? idx : si // 无法解析时保守回滚到当前阶段
          if ((stageCounts[targetIdx] || 0) >= limit) {
            // 已 FORCED_FINAL 锁定:回滚请求降级为 P3 处理(架构 3.7),不再计数/不再回滚,继续推进
            pushLog('评审决策: 回滚目标 ' + STAGES[targetIdx].key + ' 已 FORCED_FINAL 锁定,本次降级为 P3 处理,继续推进')
          } else {
            stageCounts[targetIdx] = (stageCounts[targetIdx] || 0) + 1
            totalRollbacks += 1
            supervisor.rollbackCount = totalRollbacks
            appendRec(runId, session, 'tool-workflow/rollback', { runId, targetIdx, count: stageCounts[targetIdx], rating: rating || '', subKey: sub.id })
            if (stageCounts[targetIdx] >= limit) {
              // 防崩溃(架构 3.7):同一阶段回滚≥上限 → FORCED_FINAL 强制锁定,通知人工,问题降级为 P3 处理,继续推进
              supervisor.forcedFinal = true
              pushLog('强制锁定: ' + STAGES[targetIdx].key + ' 回滚已达 ' + limit + ' 次,状态 FORCED_FINAL,请人工介入(问题降级为 P3 处理,流水线继续推进)')
              await txLog(args, fmtTime(Date.now()) + ' [强制锁定] ' + STAGES[targetIdx].key + ' 回滚≥' + limit + ' 次,FORCED_FINAL,通知人工')
            } else {
              const rollbackTo = STAGE_OFFSETS[targetIdx]
              pushLog('阶段级回滚: 根源定位 ' + STAGES[targetIdx].key + ',删除该阶段及之后全部产出(评审决策模块已执行物理删除),从该阶段重跑(第 ' + stageCounts[targetIdx] + ' 次回滚)')
              g = rollbackTo
              // 游标回退后同步进度:已完成的子阶段 = 根源阶段之前的全部子阶段(架构 R-002 只删根源及之后)
              state.done = g
              for (let k = targetIdx; k < stageDone.length; k++) stageDone[k] = 0
              supervisor.module = null
              continue // 回滚重跑,不记子阶段完成
            }
          }
        }
      }
      supervisor.module = null
      // ---- 子阶段通过:登记完成、推进游标 ----
      appendRec(runId, session, 'tool-workflow/substage-done', { runId, subKey: sub.id, pass: 1 })
      stageDone[si] = (stageDone[si] || 0) + 1
      if (sub.id === '4.3') finalDone = true
      g += 1
      state.done = g
      refreshFiles()
      pushLog('完成: ' + execLabel)
    }

    if (cancelled) { stopReason = 'cancelled'; errorMsg = '已被用户中止' }
    // ---------- 兜底定稿:不论成败,只要 4.3 未完成,就补一次论文定稿(防崩溃优先) ----------
    if (!finalDone) {
      pushLog('正在执行兜底定稿:生成 ' + FINAL_PAPER + '(不论前序结果如何)')
      state.phase = '兜底·论文定稿'
      state.agentLabel = '兜底·论文定稿'
      const fresh = makeController()
      // 关键:把兜底定稿的控制器登记为当前活跃控制器,否则面板「中止」与 /loopabort 无法中止兜底定稿
      if (active && active.runId === runId) active.controller = fresh
      const reason = stopReason === 'cancelled' ? '用户中止' : stopReason === 'error' ? errorMsg : '正常流程已结束但最终产出未完成'
      const fres = await runChild(provider, session, agent, fresh, '兜底·论文定稿(不论成败)', buildFinalizePrompt(args, reason), undefined, args.agentOptions)
      if (fres.outcome === 'completed') {
        finalDone = true
        pushLog('兜底定稿完成: ' + FINAL_PAPER + ' 已生成')
      } else {
        pushLog('兜底定稿未能完成: ' + (fres.text || '').trim().slice(0, 80) + ' —— 请查看工作区已有成果')
        if (fres.outcome === 'cancelled') {
          stopReason = 'cancelled'
          errorMsg = '已被用户中止(兜底定稿未完成)'
        } else if (stopReason === 'completed') {
          stopReason = 'error'
          errorMsg = '流水线子阶段已完成,但兜底定稿生成失败'
        }
      }
    }
    finishRun(runId, stopReason, errorMsg)
    if (active && active.runId === runId) active = null
  }

  // 启动一次运行:创建 run 记录与工作流卡片、初始化运行状态、后台启动主循环(立即返回)
  function start({ session, agent, args, resumeCount, explicitModel }) {
    // 断点续跑:主循环从该子阶段开始(入口模块解析出的续跑计数)
    args.startIndex = resumeCount
    const runId = mintRunId()
    const rec = { session, ok: true }
    recording.set(runId, rec)
    try {
      session.append('tool-workflow/run-start', { runId, name: FLOW_NAME })
    } catch (err) {
      recording.delete(runId)
    }
    state = freshState()
    state.status = 'running'
    state.runId = runId
    state.rounds = 1
    state.total = PER_ROUND
    state.done = resumeCount
    state.round = 1
    state.startedAt = Date.now()
    state.wsDir = args.wsDir
    state.problemPath = args.problemPath
    state.title = args.title
    state.vision = args.vision
    stageDone = new Array(STAGES.length).fill(0)
    const limit = Number.isSafeInteger(args.rollbackLimit) && args.rollbackLimit >= 1 ? args.rollbackLimit : DEFAULT_ROLLBACK_LIMIT
    supervisor = { module: null, rollbackCount: 0, rollbackLimit: limit, forcedFinal: false, issues: { P0: 0, P1: 0, P2: 0, P3: 0 } }
    const controller = makeController()
    active = { runId, session, controller }
    pushLog('流水线已启动: 五阶段 ' + PER_ROUND + ' 个子阶段(中控台双重质疑:扫描验证 + 评审决策;同一阶段回滚上限 ' + limit + ' 次),输出目录 ' + args.wsDir + (resumeCount > 0 ? '(断点续跑:从第 ' + (resumeCount + 1) + ' 个子阶段继续)' : '') + '(关闭本聊天窗口不影响后台执行)')
    if (args.vision) pushLog('识图能力探测: ' + (args.vision.source === 'service' ? '检测到识图服务 ' + args.vision.key : '检测到识图工具 ' + (args.vision.tools || []).join(',')) + '(涉及图表的子阶段将自动调用)')
    else pushLog('识图能力探测:未检测到独立识图插件,涉及图表的子阶段将标记"待人工确认"')
    if (explicitModel) pushLog('子任务模型路由:强制 ' + args.agentOptions.provider + '/' + args.agentOptions.model + '(--model 显式覆盖)')
    else pushLog('子任务模型路由:跟随父对话当前选择 ' + args.agentOptions.provider + '/' + args.agentOptions.model + ' (无法读取时兜底 deepseek-official/deepseek-v4-flash)')
    refreshFiles()
    void runPipeline(runId, session, agent, args, controller).catch((err) => {
      pushLog('流水线异常: ' + String((err && err.message) || err))
      finishRun(runId, 'error', '流水线异常: ' + String((err && err.message) || err))
      if (active && active.runId === runId) active = null
    })
  }

  return {
    // 是否正在运行(供入口模块做「已有流水线正在运行」校验)
    isRunning: () => state.status === 'running',
    // 当前进度百分比(与启动校验提示的口径一致)
    progressPercent: () => (state.total > 0 ? Math.floor((state.done * 100) / state.total) : 0),
    // 断点续跑:已连续完成的子阶段数(入口模块据此决定起始子阶段)
    completedIterations,
    // 进度快照(供 /mcmp-api/state 与 /loopstatus)
    snapshot,
    // 写进度日志(供入口模块在触发失败时记录原因)
    log: pushLog,
    // 记录本次运行所属会话(供 reset 向该会话追加重置标记)
    trackSession: (session) => { lastSession = session },
    // 启动一次运行(状态初始化 + 后台启动主循环)
    start,
    // 中止运行中的流水线(reason 缺省为面板中止)
    abort: doAbort,
    // 清空状态与断点续跑记录
    reset: doReset,
  }
}
