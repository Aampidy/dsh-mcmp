/**
 * dsh-mcmp · 数学建模论文自动化流水线 —— Host 半(持久化部署插件)
 *
 * 挂载于用户配置层($DSH_HOME/profiles/web/cordis.patch.yml),重启不丢。
 * 与动态版本的区别:
 *   - 面板 RPC 由 harness.handle 改为 webServer 路由(/mcmp-api/*)
 *   - 命令/提示注册全部防御化(与动态插件共存期间冲突时静默降级)
 * 其余编排逻辑与动态版 v6 完全一致:断点续跑、Host 侧子智能体编排、
 * 质疑驱动、成果落盘、tool-workflow/* 会话记录(原生工作流卡片)。
 */

export const name = 'mcmp'
// 硬依赖:这些服务挂载后 Cordis 才会激活本插件(避免过早激活导致 ctx.get 全部为空)
export const inject = ['commands', 'subagents', 'agents', 'webServer']

import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function diag(msg) {
  try {
    appendFileSync(fileURLToPath(new URL('../apply-diagnostic.log', import.meta.url)), new Date().toISOString() + ' ' + msg + '\n')
  } catch (err) { /* 诊断日志失败不影响运行 */ }
}

export function apply(ctx) {
  diag('apply begin')
  try {
  const fs = ctx.get('fs')
  const commands = ctx.get('commands')
  const agents = ctx.get('agents')
  const subagents = ctx.get('subagents')
  const systemPrompt = ctx.get('systemPrompt')
  const webServer = ctx.get('webServer')
  console.log('dsh-mcmp: services available -> commands=' + !!commands + ' fs=' + !!fs + ' agents=' + !!agents + ' subagents=' + !!subagents + ' systemPrompt=' + !!systemPrompt + ' webServer=' + !!webServer)

  // ---------- 步骤元数据(含每个迭代的任务提示词) ----------
  const STEPS = [
    { key: 'S1', name: '赛题分析', phase: 'S1 赛题分析', file: '01_赛题分析.md', iters: [
      { name: '初步拆解', task: '通读赛题,完成初步拆解:(1) 确认所选题目(如 A/B/C 题)与全部子问题;(2) 列出问题背景、已知条件、数据(附件)说明、待求目标;(3) 明确提交要求(论文页数、程序、结果表等);(4) 判断问题类型(预测、优化、评价、机理、决策等);(5) 圈出关键词与易误解之处,给出你的理解与疑问。' },
      { name: '深度分析', task: '对每个子问题深入分析:(1) 明确评价指标或目标函数;(2) 列出约束条件;(3) 分析数据特征(缺失、异常、量纲、规模),给出预处理方案;(4) 提出合理假设,逐条编号并说明理由;(5) 列出 2-3 种候选建模思路,逐一分析优劣与可行性;(6) 指出主要难点与风险。' },
      { name: '最终定调', task: '在前两轮成果基础上质疑并定稿:(1) 给出总体建模框架(问题→数据→假设→模型→求解→验证→结论);(2) 为每个子问题敲定选用的模型与方法,并说明选择理由;(3) 列出所需的编程实现清单与图表清单;(4) 给出论文结构大纲;(5) 输出《建模方案定稿》,作为后续所有步骤的权威依据。' },
    ] },
    { key: 'S2', name: '模型求解', phase: 'S2 模型求解', file: '02_模型求解.md', iters: [
      { name: '模型建立', task: '依据 01_赛题分析.md 的《建模方案定稿》:(1) 建立统一的符号体系(符号表,含含义与单位);(2) 逐条给出模型假设(编号);(3) 对每个子问题建立数学模型:目标函数、约束条件或方程,并给出推导过程;(4) 说明模型与赛题要求的对应关系;(5) 指出模型的适用范围。' },
      { name: '模型求解', task: '对每个已建立的模型给出求解:(1) 能解析求解的给出完整推导;(2) 需要数值求解的给出算法原理、步骤与伪代码(如最优化、微分方程数值解、统计方法、启发式算法);(3) 说明复杂度、收敛性与可行性;(4) 明确哪些结果将在步骤3中用程序实现。' },
      { name: '模型验证', task: '验证模型的正确性与可靠性:(1) 用特殊情形、退化情形或手算小例子验证解析结果;(2) 若数据可用,做数据驱动的验证(拟合优度、误差分析、残差检验);(3) 设计灵敏度分析方案(参数扰动范围与观察指标);(4) 总结模型的优点、不足与假设的合理性;(5) 明确哪些假设可以放宽、放宽后模型如何修正。' },
    ] },
    { key: 'S3', name: '编程实现', phase: 'S3 编程实现', file: '03_编程实现.md', iters: [
      { name: '核心代码', task: '依据 01、02 两步成果,用 Python 实现每个模型的核心算法:(1) 代码写入 代码/ 目录,文件名体现步骤与版本(如 s2_model_v1.py),配中文注释;(2) 处理数据读取与预处理;(3) 确保代码可直接运行,运行并把关键输出(数值结果、评价指标)记录到 03_编程实现.md;(4) 若环境缺少依赖,先安装(pip)再运行;(5) 旧代码一律保留。' },
      { name: '完善调试', task: '对已有代码严格调试:(1) 用手算小例子与极端参数做对照测试,验证正确性;(2) 修复所有 bug,处理数据缺失与异常;(3) 补充边界情形测试;(4) 补充中文注释与文档字符串;(5) 重新运行并与 02_模型求解.md 的推导核对一致;(6) 新版本用 _v2、_v3 后缀另存,绝不删除旧版本。' },
      { name: '优化封装', task: '将代码工程化:(1) 整理为函数/类,参数化关键量;(2) 统一输出:数值结果写入 代码/results/ 下的 CSV/JSON;(3) 提供 main 入口脚本一键复现全部结果;(4) 规范命名与注释;(5) 在 03_编程实现.md 记录运行环境(语言版本、依赖库及版本)与复现步骤;(6) 最终完整运行一次并保存全部输出。' },
    ] },
    { key: 'S4', name: '图表生成', phase: 'S4 图表生成', file: '04_图表生成.md', iters: [
      { name: '基础图表', task: '依据 03_编程实现.md 的结果数据生成论文所需的基础图表:(1) 至少包括:结果曲线、对比柱状图、误差或收敛图、数据散点与拟合对比等(按实际需要);(2) 图片保存为 PNG 到 图表/ 目录,文件名语义化;(3) 每张图配中文标题、轴标签、图例与单位;(4) 在 04_图表生成.md 记录每张图的含义、数据来源与生成代码位置;(5) 绘图代码保存到 代码/ 下。' },
      { name: '美化优化', task: '统一美化全部图表:(1) 统一字体大小、配色、线型风格;(2) 修复中文乱码(配置中文字体,如 SimHei 或 Microsoft YaHei);(3) 分辨率不低于 300dpi;(4) 补充关键标注(重要数值、结论性说明);(5) 确保每张图脱离正文也能看懂;(6) 更新 04_图表生成.md 中的说明。' },
      { name: '精选定稿', task: '对图表做最终取舍:(1) 从全部图表中精选论文真正需要的图,宁缺毋滥;(2) 确定编号(图1、图2…)与插入位置;(3) 冗余图移入 图表/归档/ 保留,不物理删除;(4) 导出最终版本;(5) 在 04_图表生成.md 输出《图表清单》:编号、文件路径、插入章节、一句话说明。' },
    ] },
    { key: 'S5', name: '流程与架构图', phase: 'S5 流程与架构图', file: '05_流程与架构图.md', iters: [
      { name: '结构设计', task: '设计论文所需的两类图:(1) 总体技术路线/流程图:问题分析→数据预处理→模型建立→求解→验证→结果→论文,体现完整流程;(2) 系统/模型架构图:模块划分与数据流。要求:节点、层次、连线语义明确。可用 graphviz(dot)、matplotlib/networkx 或 mermaid 生成;源文件保存到 代码/,图片输出到 图表/。' },
      { name: '细节完善', task: '检查并完善流程图与架构图:(1) 逻辑完整:每个节点有输入输出、无孤立节点、方向一致;(2) 命名与论文符号统一;(3) 补充关键公式或参数标注;(4) 调整布局避免重叠;(5) 生成修订版,并在 05_流程与架构图.md 说明每张图的结构与用途。' },
      { name: '美化定稿', task: '最终美化:(1) 统一配色与字体(支持中文);(2) 导出高清 PNG 或 SVG;(3) 确定图编号(如“图0 技术路线”)与插入位置;(4) 在 05_流程与架构图.md 输出最终文件清单;(5) 中间版本归档保留。' },
    ] },
    { key: 'S6', name: '论文撰写', phase: 'S6 论文撰写', file: '06_论文.md', iters: [
      { name: '初稿', task: '依据前 5 步全部成果撰写论文初稿,写入 06_论文.md(如有 LaTeX 环境,同时输出 tex 源文件到 论文/ 目录)。标准结构:(1) 摘要(单独成页、含关键词,突出方法、结果与创新);(2) 一、问题重述与分析;(3) 二、模型假设与符号说明;(4) 三、模型建立与求解(分问题撰写、公式编号);(5) 四、模型验证与灵敏度分析;(6) 五、模型评价与推广;(7) 六、参考文献;(8) 附录(程序清单)。要求:正文所有结论必须引用前序成果(图表、代码输出),不得凭空捏造数据;语言规范、逻辑严密、图表引用齐全。' },
      { name: '深化润色', task: '以评审专家视角逐节质疑并润色初稿:(1) 摘要是否突出方法、结果与创新,是否控制在一页;(2) 公式与符号是否前后一致、编号连续;(3) 图表引用是否齐全、编号是否正确;(4) 表述是否严谨,删除“显然”“容易得到”等无依据表述;(5) 补充灵敏度分析的量化结论;(6) 检查参考文献格式;(7) 逐段润色语言,输出终稿(在 06_论文.md 中新增“终稿”小节,保留初稿)。' },
    ] },
    { key: 'S7', name: '编译与合规检查', phase: 'S7 编译与合规检查', file: '07_编译与合规检查.md', iters: [
      { name: '编译与合规检查', task: '按国赛要求逐项检查并输出报告:(1) 摘要单独成页、含关键词;(2) 论文不含任何学校、队员、指导教师信息;(3) 正文页数符合当年要求(以赛题要求为准);(4) 图表编号与正文引用一一对应;(5) 公式编号连续;(6) 参考文献格式规范;(7) 附录含程序清单;(8) 结果表格完整、数值与程序输出一致;(9) 提交文件命名符合赛方要求(如 论文.pdf、支撑材料.zip)。若环境存在 pdflatex/xelatex,尝试编译论文为 PDF 并记录编译日志;若无 LaTeX 环境,明确说明并给出“提交前手工检查清单”。全部结论写入 07_编译与合规检查.md,并输出《合规检查报告》与《待修改清单》。' },
    ] },
    { key: 'S8', name: '评审改进循环', phase: 'S8 评审改进循环', file: '08_评审改进.md', iters: [
      { name: '评审改进', task: '以竞赛评审专家身份,按国赛评审标准(摘要约10%、假设合理性、建模科学性、求解正确性、验证充分性、写作规范性、创新性)对 06_论文.md 打分并写评语:(1) 列出必须修改的高优先级问题与建议改进项;(2) 针对高优先级问题,直接在 06_论文.md 中给出修改后的关键段落(全文修订亦可),确保论文达到可提交水准;(3) 输出《评审报告》到 08_评审改进.md;(4) 最后给出整条流水线的总结:方法、主要结果、亮点与遗留问题。' },
    ] },
  ]
  const PER_ROUND = 19
  const FLAT = []
  STEPS.forEach((st, si) => { st.iters.forEach((nm, ii) => { FLAT.push({ s: si, i: ii, name: nm.name }) }) })

  // ---------- 运行状态 ----------
  function freshState() {
    return {
      status: 'idle', runId: '', rounds: 0, round: 0, total: 0, done: 0,
      phase: '', agentLabel: '', logs: [], files: [], error: '',
      title: '', wsDir: '', problemPath: '', startedAt: 0, endedAt: 0,
    }
  }
  let state = freshState()
  let active = null
  const recording = new Map()

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

  // ---------- 断点续跑:从会话日志(落盘)恢复已完成迭代数 ----------
  function completedIterations(session) {
    if (!session || !Array.isArray(session.events)) return 0
    const runs = []
    let current = null
    for (const ev of session.events) {
      try {
        if (ev.type === 'tool-workflow/run-start') {
          const d = ev.data || {}
          if (d.name === '数学建模论文流水线') {
            current = { started: [], ended: [] }
            runs.push(current)
          } else {
            current = null
          }
        } else if (ev.type === 'tool-workflow/agent-start' && current) {
          const d = ev.data || {}
          if (Number.isSafeInteger(d.seq) && d.seq >= 1) current.started[d.seq - 1] = true
        } else if (ev.type === 'tool-workflow/agent-end' && current) {
          const d = ev.data || {}
          if (Number.isSafeInteger(d.seq) && d.seq >= 1) current.ended[d.seq - 1] = d.outcome === 'completed'
        }
      } catch (err) { /* 单条事件解析失败忽略 */ }
    }
    const prefix = (run) => {
      let n = 0
      for (let i = 0; i < run.started.length; i++) {
        if (run.started[i] === true && run.ended[i] === true) n = i + 1
        else break
      }
      return n
    }
    const last = runs[runs.length - 1]
    let n = last ? prefix(last) : 0
    if (n === 0) {
      let m = 0
      for (const run of runs) m = Math.max(m, prefix(run))
      n = m
    }
    return n
  }

  function snapshot() {
    const done = state.done
    const total = state.total
    const pct = total > 0 ? Math.min(100, Math.floor((done * 100) / total)) : 0
    const round = state.rounds > 0 ? Math.min(Math.floor(done / PER_ROUND) + 1, state.rounds) : 0
    const roundStart = (round - 1) * PER_ROUND
    const inRound = Math.max(0, Math.min(done - roundStart, PER_ROUND))
    let cur = null
    if (state.status === 'running' && total > 0 && done < total) {
      const f = FLAT[done % PER_ROUND]
      cur = { stepKey: STEPS[f.s].key, stepName: STEPS[f.s].name, stepIdx: f.s, iterIdx: f.i, iterName: f.name, iterTotal: STEPS[f.s].iters.length }
    }
    const counts = {}
    for (let k = 0; k < inRound && k < FLAT.length; k++) {
      const f = FLAT[k]
      counts[f.s] = (counts[f.s] || 0) + 1
    }
    const steps = STEPS.map((st, si) => ({
      key: st.key, name: st.name, file: st.file, phase: st.phase,
      iterTotal: st.iters.length, iters: st.iters.map((n) => n.name),
      done: counts[si] || 0, active: cur !== null && cur.stepIdx === si,
    }))
    return {
      status: state.status, runId: state.runId, rounds: state.rounds, round, done, total, pct,
      cur, steps, phase: state.phase, agentLabel: state.agentLabel,
      logs: state.logs.slice(-12), files: state.files.slice(0, 80),
      error: state.error, title: state.title, wsDir: state.wsDir, problemPath: state.problemPath,
      startedAt: state.startedAt, endedAt: state.endedAt,
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

  function messageText(data) {
    let m = null
    if (data && Array.isArray(data.content)) m = data
    else if (data && data.message && Array.isArray(data.message.content)) m = data.message
    if (!m) return ''
    let text = ''
    for (const block of m.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
    }
    return text
  }

  function extractProblem(session) {
    if (!session || !Array.isArray(session.events)) return ''
    const parts = []
    const recent = session.events.slice(-80)
    for (const ev of recent) {
      if (ev.type !== 'user/message') continue
      const text = messageText(ev.data)
      if (text) parts.push(text)
    }
    const joined = parts.join('\n')
    const filtered = joined.split(/\r?\n/).filter((l) => !/^\s*\/[a-z][a-z0-9_-]*\b/i.test(l)).join('\n')
    return filtered.trim()
  }

  function buildPrompt(round, si, ii, s, it, args) {
    const p = []
    p.push('你正在参与「全国大学生数学建模竞赛论文」的多轮自动化撰写流水线,担任本轮「' + s.name + ' · ' + it.name + '」的执行专家。你的目标不是"写完",而是产出**可直接放进竞赛论文、经得起评审质疑**的内容。')
    p.push('')
    p.push('【流水线位置】第 ' + round + '/' + args.rounds + ' 轮 · 步骤 ' + (si + 1) + '/' + STEPS.length + ' ' + s.name + ' · 迭代 ' + (ii + 1) + '/' + s.iters.length + '「' + it.name + '」')
    p.push('【工作区(绝对路径)】' + args.wsDir + ' —— 所有读写都在该目录内,使用绝对路径或相对它的路径。')
    if (args.problem.kind === 'file') {
      p.push('【赛题原文文件】' + args.problem.path + ' —— 先用你的文件工具读取该文件全文,作为唯一赛题依据。')
    } else {
      p.push('【赛题原文(已完整嵌入,请逐字精读)】')
      p.push(args.problem.text)
      if (si === 0 && ii === 0) p.push('【先存档】请先把嵌入的赛题原文完整保存为 ' + args.problemPath + ' 文件,供后续所有步骤读取。')
    }
    p.push('')
    p.push('【必读文件(先全部读完再动手,禁止跳过)】')
    p.push('- ' + s.file + ' (本步骤历次迭代成果,本次在其基础上改进)')
    for (let q = 0; q < si; q++) p.push('- ' + STEPS[q].file + ' (前序步骤的权威成果,必须严格遵守其结论与符号体系)')
    if (round > 1) {
      p.push('上一轮(第 ' + (round - 1) + ' 轮)成果已保存在上述文件中(标题形如「## 第' + (round - 1) + '轮…」)。先阅读上一轮对应内容,本轮必须在其基础上优化,质量不得低于上一轮。')
    }
    if (ii === 0) {
      p.push('若本步骤文件尚不存在或为空,从零建立本步骤成果。')
    } else {
      p.push('若文件中缺失上一迭代(「第' + round + '轮·迭代' + ii + ' ' + s.iters[ii - 1].name + '」)成果,说明其失败:先补齐该迭代成果,再完成本次迭代。')
    }
    p.push('')
    p.push('【工作纪律】')
    p.push('1. 质疑先行:开工前对既有成果提出至少 3 条具体质疑(假设是否成立、是否偏离赛题、推导有无漏洞、数据与结论是否一致、格式是否规范),并逐条给出处理决定(采纳并改进 / 否决并说明理由)。质疑清单必须放在回复最前面。')
    p.push('2. 只改有据之处:经得起质疑的既有内容必须保留,不做无谓重写。')
    p.push('3. 禁止编造:所有数值与结论必须来自赛题、实际计算或前序成果;信息不足时明确写出你的假设并说明理由,不得假装已知。')
    p.push('4. 符号与术语一致:沿用前序步骤的符号体系,新增符号必须先定义。')
    p.push('5. 论文级表达:推导完整、步骤清晰、结论可复现,杜绝"显然""易得"式跳步。')
    p.push('')
    p.push('【本轮任务】' + it.task)
    p.push('')
    p.push('【交付要求(强制)】')
    p.push('1. 完整成果追加写入 ' + s.file + ',标题「## 第' + round + '轮·迭代' + (ii + 1) + ' ' + it.name + '」;内容完整可复现,不得缩写,严禁删除或覆盖已有内容。')
    p.push('2. 代码保存到 ' + args.wsDir + '/代码/,新版本用 _vN 后缀,旧版本一律保留;图片保存到 ' + args.wsDir + '/图表/,旧图保留。')
    p.push('')
    p.push('【回复结构】开头为「质疑清单:」;随后是本次工作与成果;结尾附不超过 200 字总结:完成内容、关键改进、产出文件清单(含路径)。')
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
      if (stopReason === 'cancelled') state.error = '已被用户中止'
      state.agentLabel = ''
    }
    refreshFiles()
  }

  function doAbort() {
    if (!active) return { ok: false, reason: '没有运行中的流水线' }
    try { active.controller.abort(new Error('用户在进度面板中中止')) } catch (err) { /* ignore */ }
    return { ok: true }
  }

  function doReset() {
    if (state.status === 'running') return { ok: false, reason: '流水线运行中,不能重置' }
    state = freshState()
    active = null
    return { ok: true }
  }

  // ---------- Host 侧编排器:从断点继续(不依赖聊天 Agent 存活) ----------
  async function runPipeline(runId, session, agent, args, controller) {
    let failStreak = 0
    let cancelled = false
    const provider = pickProvider()
    if (!provider) {
      finishRun(runId, 'error', '没有可用的子智能体提供方(当前部署未注册 subagent provider)')
      if (active && active.runId === runId) active = null
      return
    }
    const total = args.rounds * PER_ROUND
    for (let g = args.startIndex; g < total; g++) {
      if (controller.signal.aborted) { cancelled = true; break }
      const r = Math.floor(g / PER_ROUND) + 1
      const f = FLAT[g % PER_ROUND]
      const s = STEPS[f.s]
      const it = s.iters[f.i]
      if (g % PER_ROUND === 0) pushLog('【第 ' + r + '/' + args.rounds + ' 轮开始】')
      const label = 'R' + r + '·S' + (f.s + 1) + ' ' + s.name + ' ' + (f.i + 1) + '/' + s.iters.length + ' ' + it.name
      state.phase = s.phase
      state.agentLabel = label
      pushLog('开始: ' + label)
      let child = null
      let started = false
      let outcome = 'failed'
      let note = ''
      try {
        // 每次启动子任务前重新解析父 Agent(关闭聊天后 Agent 可能被重建)
        const parent = (agents && agents.get(session.id)) || agent
        child = await subagents.start(provider, {
          label,
          prompt: [{ type: 'text', text: buildPrompt(r, f.s, f.i, s, it, args) }],
          parent,
          signal: controller.signal,
        })
        appendRec(runId, session, 'tool-workflow/agent-start', { runId, seq: g + 1, label, phase: s.phase, childId: String(child.id) })
        started = true
        const res = await child.result
        const text = (Array.isArray(res.output) ? res.output.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : '')
        outcome = res.stopReason === 'completed' ? 'completed' : res.stopReason === 'cancelled' ? 'cancelled' : 'failed'
        note = (text || '').trim().slice(0, 300)
      } catch (err) {
        outcome = controller.signal.aborted ? 'cancelled' : 'failed'
        note = '执行异常: ' + String((err && err.message) || err).slice(0, 200)
      } finally {
        if (child) { try { await child.dispose() } catch (err) { /* ignore */ } }
      }
      if (started) appendRec(runId, session, 'tool-workflow/agent-end', { runId, seq: g + 1, outcome })
      state.done = Math.min(g + 1, state.total)
      refreshFiles()
      if (outcome === 'completed') {
        failStreak = 0
        pushLog('完成: ' + label)
      } else {
        failStreak += 1
        pushLog(outcome === 'cancelled' ? '中止: ' : '失败: ' + label + (note ? '(' + note.slice(0, 80) + ')' : ''))
      }
      if ((g + 1) % PER_ROUND === 0 && !controller.signal.aborted) pushLog('【第 ' + r + '/' + args.rounds + ' 轮完成】')
      if (controller.signal.aborted) { cancelled = true; break }
      if (failStreak >= 3) {
        finishRun(runId, 'error', '连续 3 个子任务失败,流水线提前终止(已有成果全部保留,可重新 /loopbegin 续跑)')
        if (active && active.runId === runId) active = null
        return
      }
    }
    finishRun(runId, cancelled ? 'cancelled' : 'completed', cancelled ? '已被用户中止' : undefined)
    if (active && active.runId === runId) active = null
  }

  // ---------- 共享的流水线启动逻辑(同步执行,永不阻塞命令通道) ----------
  function startPipeline(agent, rawInput) {
    try {
      if (state.status === 'running') {
        return { kind: 'error', text: '已有流水线正在运行(当前进度 ' + (state.total > 0 ? Math.floor((state.done * 100) / state.total) : 0) + '%)。可在浮动面板点「中止」或运行 /loopabort 后再启动新流水线。' }
      }
      if (!subagents) return { kind: 'error', text: '子智能体服务不可用(当前部署未提供),无法启动流水线。' }
      const session = agent && agent.session
      const cwd = session && session.header ? session.header.cwd : undefined
      if (typeof cwd !== 'string' || cwd.length === 0) {
        return { kind: 'error', text: '无法确定当前会话的工作区目录,无法启动流水线。' }
      }
      const raw = rawInput || ''
      const mRound = /(?:^|\s)--round\s*[=:]?\s*(\d+)/i.exec(raw)
      let rounds = 1
      if (mRound) rounds = parseInt(mRound[1], 10)
      if (!Number.isSafeInteger(rounds) || rounds < 1) rounds = 1
      if (rounds > 10) return { kind: 'error', text: '--round 最大为 10。每轮 19 次迭代、每次迭代启动一个专家子智能体,轮数过大会非常耗时。' }
      const fresh = /(?:^|\s)--fresh\b/i.test(raw)
      const mFrom = /(?:^|\s)--from(?:=)?\s*([^\r\n]+)$/i.exec(raw)
      let problem = null
      if (mFrom) {
        let p = mFrom[1].trim().replace(/^["']|["']$/g, '')
        if (p.length === 0) return { kind: 'error', text: '--from 需要指定赛题文件路径。' }
        const abs = /^[A-Za-z]:[\\/]/.test(p) || p.indexOf('/') === 0 || p.indexOf('\\') === 0
          ? p
          : cwd.replace(/[\\/]+$/, '') + '/' + p
        problem = { kind: 'file', path: abs }
      } else {
        const text = extractProblem(session)
        if (text.trim().length < 40) {
          return { kind: 'error', text: '未能从对话中提取到赛题。请先把完整赛题粘贴到对话框并发送,再发送以 /loopbegin 开头的消息;或使用 /loopbegin --from 题目.txt 指定赛题文件。' }
        }
        problem = { kind: 'text', text: text.length > 6000 ? text.slice(0, 6000) + '\n…(原文过长,已截断)' : text }
      }
      const wsDir = cwd.replace(/[\\/]+$/, '') + '/数学建模流水线'
      const problemPath = problem.kind === 'file' ? problem.path : wsDir + '/00_赛题原文.md'
      const title = problem.kind === 'text' ? problem.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)[0] : problem.path
      const args = { rounds, wsDir, problemPath, problem, title: title ? title.slice(0, 40) : '赛题' }
      // 断点续跑:扫描本会话落盘的工作流记录,跳过已完成的迭代
      const resumeCount = fresh ? 0 : completedIterations(session)
      args.startIndex = resumeCount
      if (resumeCount >= rounds * PER_ROUND) {
        return { kind: 'error', text: '检测到本会话已完成 ' + resumeCount + ' 次迭代(≥ 本次请求的 ' + (rounds * PER_ROUND) + ' 次),无需重复。\n- 如需继续优化,请增大轮数,例如 /loopbegin --round=' + Math.min(rounds + 1, 10) + '\n- 如需从头重跑,请使用 /loopbegin --fresh' }
      }
      const runId = mintRunId()
      const rec = { session, ok: true }
      recording.set(runId, rec)
      try {
        session.append('tool-workflow/run-start', { runId, name: '数学建模论文流水线' })
      } catch (err) {
        recording.delete(runId)
      }
      state = freshState()
      state.status = 'running'
      state.runId = runId
      state.rounds = rounds
      state.total = rounds * PER_ROUND
      state.done = resumeCount
      state.round = Math.min(Math.floor(resumeCount / PER_ROUND) + 1, rounds)
      state.startedAt = Date.now()
      state.wsDir = wsDir
      state.problemPath = problemPath
      state.title = args.title
      const controller = makeController()
      active = { runId, session, controller }
      pushLog('流水线已启动: ' + rounds + ' 轮 × 19 次迭代,输出目录 ' + wsDir + (resumeCount > 0 ? '(断点续跑:跳过已完成的 ' + resumeCount + ' 次迭代)' : '') + '(关闭本聊天窗口不影响后台执行)')
      refreshFiles()
      void runPipeline(runId, session, agent, args, controller).catch((err) => {
        pushLog('流水线异常: ' + String((err && err.message) || err))
        finishRun(runId, 'error', '流水线异常: ' + String((err && err.message) || err))
        if (active && active.runId === runId) active = null
      })
      return {
        kind: 'success',
        text: '数学建模论文自动化流水线已启动:' + rounds + ' 轮 × 19 次迭代 = ' + (rounds * PER_ROUND) + ' 个子任务。\n输出目录: ' + wsDir
          + (resumeCount > 0 ? '\n断点续跑:已跳过此前完成的 ' + resumeCount + ' 次迭代,从第 ' + (resumeCount + 1) + ' 次继续。' : '\n全新运行。')
          + '\n每个子任务由专家子智能体执行,先对已有成果质疑、再迭代优化,并把完整成果追加保存到对应步骤文件(旧内容绝不删除)。\n进度请在右下角浮动面板实时查看(含百分比),聊天区也会出现流水线运行卡片。\n提示:中断或关闭聊天窗口都不会丢进度,再次发送 /loopbegin 即从断点续跑;如要重头开始请加 --fresh。',
      }
    } catch (err) {
      return { kind: 'error', text: '启动失败: ' + String((err && err.message) || err) }
    }
  }

  // ---------- 触发路径一:斜杠命令注册(防御化:与动态插件共存时冲突静默降级) ----------
  if (commands) {
    try {
      commands.register({
        name: 'loopbegin',
        description: '启动数学建模论文自动化流水线(8 步骤、每步多迭代、多轮外循环,自动质疑与优化,成果全部落盘)',
        input: { hint: '--round=N 外循环轮数(默认 1);可选 --from 题目文件 指定赛题文件;--fresh 从头重跑' },
        handler: (invocation) => startPipeline(invocation.agent, invocation.rawInput),
      })
    } catch (err) { console.warn('dsh-mcmp: loopbegin 注册失败(可能被其他实例占用): ' + String((err && err.message) || err)) }
    try {
      commands.register({
        name: 'loopabort',
        description: '中止正在运行的数学建模论文流水线',
        handler: () => {
          if (!active) return { kind: 'error', text: '当前没有运行中的流水线。' }
          try { active.controller.abort(new Error('用户通过 /loopabort 中止')) } catch (err) { /* ignore */ }
          return { kind: 'success', text: '已发送中止请求,流水线将在当前子任务结束后停止(已产出的成果全部保留,重新 /loopbegin 可从断点续跑)。' }
        },
      })
    } catch (err) { console.warn('dsh-mcmp: loopabort 注册失败: ' + String((err && err.message) || err)) }
    try {
      commands.register({
        name: 'loopstatus',
        description: '查看数学建模论文流水线的当前进度',
        handler: () => {
          if (state.status === 'idle') return { kind: 'success', text: '流水线空闲。粘贴赛题后发送以 /loopbegin 开头的消息(可带 --round=N)即可启动。' }
          const s = snapshot()
          let text = '状态: ' + ({ running: '运行中', completed: '已完成', error: '出错', cancelled: '已中止' }[state.status] || state.status)
          text += '\n进度: 第 ' + s.round + '/' + s.rounds + ' 轮,已完成 ' + s.done + '/' + s.total + ' 次迭代(' + s.pct + '%)'
          if (s.cur) text += '\n当前: ' + s.cur.stepKey + ' ' + s.cur.stepName + ' · 迭代 ' + (s.cur.iterIdx + 1) + '/' + s.cur.iterTotal + ' ' + s.cur.iterName
          if (s.agentLabel) text += '\n子任务: ' + s.agentLabel
          if (state.error) text += '\n错误: ' + state.error
          text += '\n输出目录: ' + (state.wsDir || '-')
          return { kind: 'success', text }
        },
      })
    } catch (err) { console.warn('dsh-mcmp: loopstatus 注册失败: ' + String((err && err.message) || err)) }
  }

  // ---------- 触发路径二:消息内容检测(输入文本以 /loopbegin 开头即自动运行) ----------
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event || event.type !== 'user/message') return
      if (session.header && (session.header.origin === 'subagent' || session.header.delegationDepth !== undefined)) return
      const text = messageText(event.data)
      if (!text) return
      const firstLine = text.split(/\r?\n/, 1)[0] || ''
      if (!/^\s*\/loopbegin(?=$|\s)/i.test(firstLine)) return
      const agent = agents && agents.get(session.id)
      if (!agent) return
      console.log('dsh-mcmp: 检测到以 /loopbegin 开头的用户消息,自动启动流水线')
      const res = startPipeline(agent, firstLine)
      if (res && res.kind === 'error') pushLog('消息触发启动失败: ' + res.text)
    } catch (err) { /* 触发器自身异常忽略,不影响消息流 */ }
  }, { global: true })

  // ---------- 模型侧提示:收到 /loopbegin 消息时不要重复执行 ----------
  if (systemPrompt) {
    try {
      systemPrompt.section({
        name: 'mcmp-pipeline',
        order: 130,
        text: '数学建模流水线说明:当用户消息以 /loopbegin 开头(可带 --round=N、--from 文件或 --fresh 参数)时,插件已自动在后台启动「数学建模论文自动化流水线」(8 步骤、每轮 19 次迭代,由工作流子智能体执行)。此时你只需用一两句话确认已启动,并提示用户查看右下角进度面板与聊天区的工作流运行卡片;绝对不要自己去编写或执行该流水线的任何步骤,不要重复启动。若用户消息包含赛题但未以 /loopbegin 开头,说明尚未启动流水线,不要擅自运行。辅助命令 /loopstatus、/loopabort 由系统处理,你无需执行。',
      })
    } catch (err) { console.warn('dsh-mcmp: systemPrompt 注册失败: ' + String((err && err.message) || err)) }
  }

  // ---------- 面板 API:webServer 路由(替代动态插件的 harness RPC) ----------
  if (webServer && typeof webServer.register === 'function') {
    try {
      webServer.register({
        kind: 'prefix',
        path: '/mcmp-api',
        handler: (req, res) => {
          try {
            // prefix 路由会把完整 URL 交给处理器,先剥离 /mcmp-api 前缀
            const raw = (req.url || '/').split('?')[0] || '/'
            const path = raw === '/mcmp-api' ? '/' : raw.startsWith('/mcmp-api/') ? raw.slice('/mcmp-api'.length) : raw
            const json = (code, body) => {
              res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end(JSON.stringify(body))
            }
            if (req.method === 'GET' && (path === '/' || path === '/state')) return json(200, snapshot())
            if (req.method === 'POST' && path === '/abort') return json(200, doAbort())
            if (req.method === 'POST' && path === '/reset') return json(200, doReset())
            res.writeHead(404)
            res.end('not found')
          } catch (err) {
            try { res.writeHead(500); res.end(String((err && err.message) || err)) } catch (err2) { /* ignore */ }
          }
        },
      })
      console.log('dsh-mcmp: /mcmp-api 面板路由已注册')
    } catch (err) { console.warn('dsh-mcmp: webServer 路由注册失败: ' + String((err && err.message) || err)) }
  }
  diag('apply ok; route=' + (webServer && typeof webServer.register === 'function'))
  } catch (err) {
    diag('APPLY THREW: ' + String((err && err.stack) || err))
    console.error('dsh-mcmp apply failed:', err)
  }
}
