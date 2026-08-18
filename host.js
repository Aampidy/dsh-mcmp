/**
 * mcmp-1 · 数学建模论文自动化流水线 —— Host 半(Dynamic Cordis Plugin 源码)
 *
 * 本文件内容即 cordis_define 的 code.host 参数:一个纯 JavaScript 函数体,
 * 返回 Cordis Plugin 对象。运行时依赖(全部通过 ctx.get 可选获取):
 *   - commands      注册 /loopbegin、/loopabort、/loopstatus 命令
 *   - workflowEngine 工作流引擎:先取 Host 上下文,缺失时三级回退到 Agent 上下文
 *                    (agentPresets.serviceFor / agent.ctx.get)
 *   - agents        消息触发时按 session 定位 Agent
 *   - systemPrompt  注册模型提示(避免模型重复执行流水线)
 *   - fs            仅用于进度面板的文件列表(非关键路径)
 * 工作流事件(workflow/*)与 session/event 全部使用全局监听({ global: true }),
 * 因为引擎可能挂在 Agent 作用域。监听后维护进度状态,并通过 harness.handle
 * 向 Client 面板提供 get-state / abort / reset 三个 RPC。
 */
return {
  name: 'mcmp',
  apply(ctx) {
    const fs = ctx.get('fs')
    const commands = ctx.get('commands')
    const agentPresets = ctx.get('agentPresets')
    const agents = ctx.get('agents')
    const systemPrompt = ctx.get('systemPrompt')
    console.log('mcmp: services available -> commands=' + !!commands + ' fs=' + !!fs + ' agents=' + !!agents + ' agentPresets=' + !!agentPresets + ' systemPrompt=' + !!systemPrompt + ' hostWorkflowEngine=' + !!ctx.get('workflowEngine'))

    // 工作流引擎可能挂在 Agent 上下文(不在 Host 上下文),按三级回退获取
    function getEngine(agent) {
      const direct = ctx.get('workflowEngine')
      if (direct) return direct
      if (agentPresets && typeof agentPresets.serviceFor === 'function' && agent) {
        try { const e = agentPresets.serviceFor(agent, 'workflowEngine'); if (e) return e } catch (err) { /* ignore */ }
      }
      if (agent && agent.ctx && typeof agent.ctx.get === 'function') {
        try { const e = agent.ctx.get('workflowEngine'); if (e) return e } catch (err) { /* ignore */ }
      }
      return undefined
    }

    // ---------- 步骤元数据(Host 面板进度计算用) ----------
    const STEPS = [
      { key: 'S1', name: '赛题分析', phase: 'S1 赛题分析', file: '01_赛题分析.md', iters: ['初步拆解', '深度分析', '最终定调'] },
      { key: 'S2', name: '模型求解', phase: 'S2 模型求解', file: '02_模型求解.md', iters: ['模型建立', '模型求解', '模型验证'] },
      { key: 'S3', name: '编程实现', phase: 'S3 编程实现', file: '03_编程实现.md', iters: ['核心代码', '完善调试', '优化封装'] },
      { key: 'S4', name: '图表生成', phase: 'S4 图表生成', file: '04_图表生成.md', iters: ['基础图表', '美化优化', '精选定稿'] },
      { key: 'S5', name: '流程与架构图', phase: 'S5 流程与架构图', file: '05_流程与架构图.md', iters: ['结构设计', '细节完善', '美化定稿'] },
      { key: 'S6', name: '论文撰写', phase: 'S6 论文撰写', file: '06_论文.md', iters: ['初稿', '深化润色'] },
      { key: 'S7', name: '编译与合规检查', phase: 'S7 编译与合规检查', file: '07_编译与合规检查.md', iters: ['编译与合规检查'] },
      { key: 'S8', name: '评审改进循环', phase: 'S8 评审改进循环', file: '08_评审改进.md', iters: ['评审改进'] },
    ]
    const PER_ROUND = 19
    const FLAT = []
    STEPS.forEach((st, si) => { st.iters.forEach((nm, ii) => { FLAT.push({ s: si, i: ii, name: nm }) }) })

    // ---------- 工作流编排脚本(在 workflowEngine 的 worker 中运行) ----------
    const SCRIPT_LINES = [
      "const STEPS = [",
      "  { phase: 'S1 赛题分析', name: '赛题分析', file: '01_赛题分析.md', iters: [",
      "    { name: '初步拆解', task: '通读赛题,完成初步拆解:(1) 确认所选题目(如 A/B/C 题)与全部子问题;(2) 列出问题背景、已知条件、数据(附件)说明、待求目标;(3) 明确提交要求(论文页数、程序、结果表等);(4) 判断问题类型(预测、优化、评价、机理、决策等);(5) 圈出关键词与易误解之处,给出你的理解与疑问。' },",
      "    { name: '深度分析', task: '对每个子问题深入分析:(1) 明确评价指标或目标函数;(2) 列出约束条件;(3) 分析数据特征(缺失、异常、量纲、规模),给出预处理方案;(4) 提出合理假设,逐条编号并说明理由;(5) 列出 2-3 种候选建模思路,逐一分析优劣与可行性;(6) 指出主要难点与风险。' },",
      "    { name: '最终定调', task: '在前两轮成果基础上质疑并定稿:(1) 给出总体建模框架(问题→数据→假设→模型→求解→验证→结论);(2) 为每个子问题敲定选用的模型与方法,并说明选择理由;(3) 列出所需的编程实现清单与图表清单;(4) 给出论文结构大纲;(5) 输出《建模方案定稿》,作为后续所有步骤的权威依据。' },",
      "  ] },",
      "  { phase: 'S2 模型求解', name: '模型求解', file: '02_模型求解.md', iters: [",
      "    { name: '模型建立', task: '依据 01_赛题分析.md 的《建模方案定稿》:(1) 建立统一的符号体系(符号表,含含义与单位);(2) 逐条给出模型假设(编号);(3) 对每个子问题建立数学模型:目标函数、约束条件或方程,并给出推导过程;(4) 说明模型与赛题要求的对应关系;(5) 指出模型的适用范围。' },",
      "    { name: '模型求解', task: '对每个已建立的模型给出求解:(1) 能解析求解的给出完整推导;(2) 需要数值求解的给出算法原理、步骤与伪代码(如最优化、微分方程数值解、统计方法、启发式算法);(3) 说明复杂度、收敛性与可行性;(4) 明确哪些结果将在步骤3中用程序实现。' },",
      "    { name: '模型验证', task: '验证模型的正确性与可靠性:(1) 用特殊情形、退化情形或手算小例子验证解析结果;(2) 若数据可用,做数据驱动的验证(拟合优度、误差分析、残差检验);(3) 设计灵敏度分析方案(参数扰动范围与观察指标);(4) 总结模型的优点、不足与假设的合理性;(5) 明确哪些假设可以放宽、放宽后模型如何修正。' },",
      "  ] },",
      "  { phase: 'S3 编程实现', name: '编程实现', file: '03_编程实现.md', iters: [",
      "    { name: '核心代码', task: '依据 01、02 两步成果,用 Python 实现每个模型的核心算法:(1) 代码写入 代码/ 目录,文件名体现步骤与版本(如 s2_model_v1.py),配中文注释;(2) 处理数据读取与预处理;(3) 确保代码可直接运行,运行并把关键输出(数值结果、评价指标)记录到 03_编程实现.md;(4) 若环境缺少依赖,先安装(pip)再运行;(5) 旧代码一律保留。' },",
      "    { name: '完善调试', task: '对已有代码严格调试:(1) 用手算小例子与极端参数做对照测试,验证正确性;(2) 修复所有 bug,处理数据缺失与异常;(3) 补充边界情形测试;(4) 补充中文注释与文档字符串;(5) 重新运行并与 02_模型求解.md 的推导核对一致;(6) 新版本用 _v2、_v3 后缀另存,绝不删除旧版本。' },",
      "    { name: '优化封装', task: '将代码工程化:(1) 整理为函数/类,参数化关键量;(2) 统一输出:数值结果写入 代码/results/ 下的 CSV/JSON;(3) 提供 main 入口脚本一键复现全部结果;(4) 规范命名与注释;(5) 在 03_编程实现.md 记录运行环境(语言版本、依赖库及版本)与复现步骤;(6) 最终完整运行一次并保存全部输出。' },",
      "  ] },",
      "  { phase: 'S4 图表生成', name: '图表生成', file: '04_图表生成.md', iters: [",
      "    { name: '基础图表', task: '依据 03_编程实现.md 的结果数据生成论文所需的基础图表:(1) 至少包括:结果曲线、对比柱状图、误差或收敛图、数据散点与拟合对比等(按实际需要);(2) 图片保存为 PNG 到 图表/ 目录,文件名语义化;(3) 每张图配中文标题、轴标签、图例与单位;(4) 在 04_图表生成.md 记录每张图的含义、数据来源与生成代码位置;(5) 绘图代码保存到 代码/ 下。' },",
      "    { name: '美化优化', task: '统一美化全部图表:(1) 统一字体大小、配色、线型风格;(2) 修复中文乱码(配置中文字体,如 SimHei 或 Microsoft YaHei);(3) 分辨率不低于 300dpi;(4) 补充关键标注(重要数值、结论性说明);(5) 确保每张图脱离正文也能看懂;(6) 更新 04_图表生成.md 中的说明。' },",
      "    { name: '精选定稿', task: '对图表做最终取舍:(1) 从全部图表中精选论文真正需要的图,宁缺毋滥;(2) 确定编号(图1、图2…)与插入位置;(3) 冗余图移入 图表/归档/ 保留,不物理删除;(4) 导出最终版本;(5) 在 04_图表生成.md 输出《图表清单》:编号、文件路径、插入章节、一句话说明。' },",
      "  ] },",
      "  { phase: 'S5 流程与架构图', name: '流程与架构图', file: '05_流程与架构图.md', iters: [",
      "    { name: '结构设计', task: '设计论文所需的两类图:(1) 总体技术路线/流程图:问题分析→数据预处理→模型建立→求解→验证→结果→论文,体现完整流程;(2) 系统/模型架构图:模块划分与数据流。要求:节点、层次、连线语义明确。可用 graphviz(dot)、matplotlib/networkx 或 mermaid 生成;源文件保存到 代码/,图片输出到 图表/。' },",
      "    { name: '细节完善', task: '检查并完善流程图与架构图:(1) 逻辑完整:每个节点有输入输出、无孤立节点、方向一致;(2) 命名与论文符号统一;(3) 补充关键公式或参数标注;(4) 调整布局避免重叠;(5) 生成修订版,并在 05_流程与架构图.md 说明每张图的结构与用途。' },",
      "    { name: '美化定稿', task: '最终美化:(1) 统一配色与字体(支持中文);(2) 导出高清 PNG 或 SVG;(3) 确定图编号(如“图0 技术路线”)与插入位置;(4) 在 05_流程与架构图.md 输出最终文件清单;(5) 中间版本归档保留。' },",
      "  ] },",
      "  { phase: 'S6 论文撰写', name: '论文撰写', file: '06_论文.md', iters: [",
      "    { name: '初稿', task: '依据前 5 步全部成果撰写论文初稿,写入 06_论文.md(如有 LaTeX 环境,同时输出 tex 源文件到 论文/ 目录)。标准结构:(1) 摘要(单独成页、含关键词,突出方法、结果与创新);(2) 一、问题重述与分析;(3) 二、模型假设与符号说明;(4) 三、模型建立与求解(分问题撰写、公式编号);(5) 四、模型验证与灵敏度分析;(6) 五、模型评价与推广;(7) 六、参考文献;(8) 附录(程序清单)。要求:正文所有结论必须引用前序成果(图表、代码输出),不得凭空捏造数据;语言规范、逻辑严密、图表引用齐全。' },",
      "    { name: '深化润色', task: '以评审专家视角逐节质疑并润色初稿:(1) 摘要是否突出方法、结果与创新,是否控制在一页;(2) 公式与符号是否前后一致、编号连续;(3) 图表引用是否齐全、编号是否正确;(4) 表述是否严谨,删除“显然”“容易得到”等无依据表述;(5) 补充灵敏度分析的量化结论;(6) 检查参考文献格式;(7) 逐段润色语言,输出终稿(在 06_论文.md 中新增“终稿”小节,保留初稿)。' },",
      "  ] },",
      "  { phase: 'S7 编译与合规检查', name: '编译与合规检查', file: '07_编译与合规检查.md', iters: [",
      "    { name: '编译与合规检查', task: '按国赛要求逐项检查并输出报告:(1) 摘要单独成页、含关键词;(2) 论文不含任何学校、队员、指导教师信息;(3) 正文页数符合当年要求(以赛题要求为准);(4) 图表编号与正文引用一一对应;(5) 公式编号连续;(6) 参考文献格式规范;(7) 附录含程序清单;(8) 结果表格完整、数值与程序输出一致;(9) 提交文件命名符合赛方要求(如 论文.pdf、支撑材料.zip)。若环境存在 pdflatex/xelatex,尝试编译论文为 PDF 并记录编译日志;若无 LaTeX 环境,明确说明并给出“提交前手工检查清单”。全部结论写入 07_编译与合规检查.md,并输出《合规检查报告》与《待修改清单》。' },",
      "  ] },",
      "  { phase: 'S8 评审改进循环', name: '评审改进循环', file: '08_评审改进.md', iters: [",
      "    { name: '评审改进', task: '以竞赛评审专家身份,按国赛评审标准(摘要约10%、假设合理性、建模科学性、求解正确性、验证充分性、写作规范性、创新性)对 06_论文.md 打分并写评语:(1) 列出必须修改的高优先级问题与建议改进项;(2) 针对高优先级问题,直接在 06_论文.md 中给出修改后的关键段落(全文修订亦可),确保论文达到可提交水准;(3) 输出《评审报告》到 08_评审改进.md;(4) 最后给出整条流水线的总结:方法、主要结果、亮点与遗留问题。' },",
      "  ] },",
      "]",
      "",
      "function prevFiles(si) {",
      "  var out = []",
      "  for (var k = 0; k < si; k++) out.push(STEPS[k].file)",
      "  return out",
      "}",
      "",
      "function promptOf(r, si, ii, s, it) {",
      "  var p = []",
      "  p.push('你正在参与一个「全国大学生数学建模竞赛论文」的多轮自动化撰写流水线。你是本步骤的执行专家,兼具资深建模教练与严格评审者双重身份。')",
      "  p.push('')",
      "  p.push('【流水线位置】第 ' + r + '/' + args.rounds + ' 轮 · 步骤 ' + (si + 1) + '/' + STEPS.length + ' ' + s.name + ' · 迭代 ' + (ii + 1) + '/' + s.iters.length + '「' + it.name + '」')",
      "  p.push('【工作区(绝对路径)】' + args.wsDir + ' —— 所有读写都使用绝对路径或相对该目录的路径,不要写到工作区之外。')",
      "  if (args.problem.kind === 'file') {",
      "    p.push('【赛题原文文件】' + args.problem.path + ' —— 请先用你的文件工具读取该文件全文,作为唯一的赛题依据。')",
      "  } else {",
      "    p.push('【赛题原文(已完整嵌入下方,请逐字精读)】')",
      "    p.push(args.problem.text)",
      "    if (si === 0 && ii === 0) {",
      "      p.push('【先存档】请先把上面嵌入的赛题原文完整保存为 ' + args.problemPath + ' 文件,供后续所有步骤读取。')",
      "    }",
      "  }",
      "  p.push('【必读文件】')",
      "  p.push('- ' + s.file + ' (本步骤历次迭代的成果,本次要在此基础上改进)')",
      "  var prev = prevFiles(si)",
      "  for (var q = 0; q < prev.length; q++) p.push('- ' + prev[q] + ' (前序步骤的权威成果,必须严格遵守其结论与符号体系)')",
      "  if (r > 1) {",
      "    p.push('上一轮(第 ' + (r - 1) + ' 轮)的全部成果都已保存在上述文件中(标题形如「## 第' + (r - 1) + '轮…」)。你必须先定位并阅读上一轮对应内容,本轮产出必须在上一轮基础上持续优化,质量不得低于上一轮。')",
      "  }",
      "  if (ii === 0) {",
      "    p.push('若本步骤文件尚不存在或为空,从零开始建立该步骤的成果。')",
      "  } else {",
      "    p.push('若文件中缺失上一迭代(「第' + r + '轮·迭代' + ii + ' ' + s.iters[ii - 1].name + '」)的成果,说明上一迭代失败:请先补齐该迭代的成果,再完成本次迭代。')",
      "  }",
      "  p.push('')",
      "  p.push('【第一要务:质疑】在开始本次工作之前,必须先对已有成果提出至少 3 条具体质疑(例如:假设是否成立、与赛题要求是否偏离、推导是否有漏洞、数据与结论是否一致、图表是否规范、结论是否有充分支撑),并在你的回复开头以「质疑清单:」列出。只有经得起质疑的成果才允许保留。')",
      "  p.push('')",
      "  p.push('【本轮任务】' + it.task)",
      "  p.push('')",
      "  p.push('【成果保存(强制)】')",
      "  p.push('1. 将本次迭代的完整成果(包括质疑清单与全部推导、公式、数据、表格、代码、图表说明)追加写入 ' + s.file + ',以标题「## 第' + r + '轮·迭代' + (ii + 1) + ' ' + it.name + '」开头。内容必须完整、可直接复现,不得用「同上」「略」等缩写。')",
      "  p.push('2. 严禁删除或覆盖文件中已有的任何内容,只能在文件末尾追加。')",
      "  p.push('3. 代码一律保存到 ' + args.wsDir + '/代码/ 下(按步骤分子目录,新版本用 _vN 后缀区分),旧版本代码一律保留、绝不删除,以便验证与参考。')",
      "  p.push('4. 图片一律保存到 ' + args.wsDir + '/图表/ 下,旧图保留。')",
      "  p.push('')",
      "  p.push('【收尾】全部完成后,回复一段不超过 200 字的中文总结:本次完成的工作、对上一版本的关键改进、产出文件清单(含路径)。')",
      "  return p.join('\\n')",
      "}",
      "",
      "const results = []",
      "for (let r = 1; r <= args.rounds; r++) {",
      "  log('【第 ' + r + '/' + args.rounds + ' 轮开始】')",
      "  for (let si = 0; si < STEPS.length; si++) {",
      "    const s = STEPS[si]",
      "    phase(s.phase)",
      "    for (let ii = 0; ii < s.iters.length; ii++) {",
      "      const it = s.iters[ii]",
      "      const label = 'R' + r + '·S' + (si + 1) + ' ' + s.name + ' ' + (ii + 1) + '/' + s.iters.length + ' ' + it.name",
      "      log('开始: ' + label)",
      "      const out = await agent(promptOf(r, si, ii, s, it), { label })",
      "      const ok = out !== null && out !== undefined",
      "      results.push({ round: r, step: si + 1, iter: ii + 1, name: it.name, ok, note: ok ? out.slice(0, 300) : '执行失败' })",
      "      log((ok ? '完成: ' : '失败: ') + label)",
      "    }",
      "  }",
      "  log('【第 ' + r + '/' + args.rounds + ' 轮完成】')",
      "}",
      "return { rounds: args.rounds, total: results.length, completed: results.filter(function (x) { return x.ok }).length, failed: results.filter(function (x) { return !x.ok }).length, results }",
    ]
    const SCRIPT = SCRIPT_LINES.join('\n')

    const META = {
      name: 'mathmodel-paper-pipeline',
      description: '全国大学生数学建模竞赛论文自动化流水线:赛题分析→模型求解→编程→图表→流程图→论文→合规检查→评审改进,外循环多轮,每步先质疑再迭代优化,成果全部落盘',
      whenToUse: '用户粘贴数学建模竞赛赛题后,发送以 /loopbegin 开头的消息(可带 --round=N 或 --from 文件)即可启动',
      phases: STEPS.map((s) => ({ title: s.phase, detail: s.name })),
    }

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
        iterTotal: st.iters.length, iters: st.iters.map((n) => n),
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

    // ---------- 共享的流水线启动逻辑(命令路径与消息触发路径共用) ----------
    async function startPipeline(agent, rawInput) {
      try {
        if (state.status === 'running') {
          return { kind: 'error', text: '已有流水线正在运行(当前进度 ' + (state.total > 0 ? Math.floor((state.done * 100) / state.total) : 0) + '%)。可在浮动面板点「中止」或运行 /loopabort 后再启动新流水线。' }
        }
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
        // --from 容错:支持 --from 文件、--from=文件,以及文件名含空格/中文
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
        const engine = getEngine(agent)
        if (!engine) return { kind: 'error', text: '工作流引擎不可用(当前部署未提供),无法启动流水线。' }
        const title = problem.kind === 'text' ? problem.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)[0] : problem.path
        const run = engine.start({
          script: SCRIPT,
          meta: META,
          args: { rounds, wsDir, problemPath, problem, title: title ? title.slice(0, 40) : '赛题' },
          parent: agent,
        })
        const runId = String(run.id)
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
        state.round = 1
        state.startedAt = Date.now()
        state.wsDir = wsDir
        state.problemPath = problemPath
        state.title = title ? title.slice(0, 40) : '赛题'
        active = { run, runId, session }
        pushLog('流水线已启动: ' + rounds + ' 轮 × 19 次迭代,输出目录 ' + wsDir)
        refreshFiles()
        return {
          kind: 'success',
          text: '数学建模论文自动化流水线已启动:' + rounds + ' 轮 × 19 次迭代 = ' + (rounds * PER_ROUND) + ' 个子任务。\n输出目录: ' + wsDir + '\n每个子任务由专家子智能体执行,先对已有成果质疑、再迭代优化,并把完整成果追加保存到对应步骤文件(旧内容绝不删除)。\n进度请在右下角浮动面板实时查看(含百分比),聊天区也会出现流水线运行卡片。',
        }
      } catch (err) {
        return { kind: 'error', text: '启动失败: ' + String((err && err.message) || err) }
      }
    }

    // ---------- 触发路径一:斜杠命令注册(兼容 UI 直接执行命令的环境) ----------
    if (commands) {
      commands.register({
        name: 'loopbegin',
        description: '启动数学建模论文自动化流水线(8 步骤、每步多迭代、多轮外循环,自动质疑与优化,成果全部落盘)',
        input: { hint: '--round=N 外循环轮数(默认 1);可选 --from 题目文件 指定赛题文件' },
        handler: (invocation) => startPipeline(invocation.agent, invocation.rawInput),
      })

      commands.register({
        name: 'loopabort',
        description: '中止正在运行的数学建模论文流水线',
        handler: () => {
          if (!active) return { kind: 'error', text: '当前没有运行中的流水线。' }
          try { active.run.cancel('用户通过 /loopabort 中止') } catch (err) { /* ignore */ }
          return { kind: 'success', text: '已发送中止请求,流水线将在当前子任务结束后停止(已产出的成果全部保留)。' }
        },
      })

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
        console.log('mcmp: 检测到以 /loopbegin 开头的用户消息,自动启动流水线')
        void startPipeline(agent, firstLine).then((res) => {
          if (res && res.kind === 'error') pushLog('消息触发启动失败: ' + res.text)
        }).catch((err) => {
          pushLog('消息触发启动异常: ' + String((err && err.message) || err))
        })
      } catch (err) { /* 触发器自身异常忽略,不影响消息流 */ }
    }, { global: true })

    // ---------- 模型侧提示:收到 /loopbegin 消息时不要重复执行 ----------
    if (systemPrompt) {
      systemPrompt.section({
        name: 'mcmp-trigger',
        order: 130,
        text: '数学建模流水线说明:当用户消息以 /loopbegin 开头(可带 --round=N 或 --from 文件参数)时,插件已自动在后台启动「数学建模论文自动化流水线」(8 步骤、每轮 19 次迭代,由工作流子智能体执行)。此时你只需用一两句话确认已启动,并提示用户查看右下角进度面板与聊天区的工作流运行卡片;绝对不要自己去编写或执行该流水线的任何步骤,不要重复启动。若用户消息包含赛题但未以 /loopbegin 开头,说明尚未启动流水线,不要擅自运行。辅助命令 /loopstatus、/loopabort 由系统处理,你无需执行。',
      })
    }

    // ---------- 工作流事件监听 + 会话记录(驱动聊天区原生工作流卡片) ----------
    // 引擎可能挂在 Agent 上下文,事件在对应作用域发出,因此全部使用全局监听
    ctx.on('workflow/agent-start', (info, a) => {
      const rec = recording.get(String(info.id))
      if (!rec || !rec.ok) return
      try {
        const data = { runId: info.id, seq: a.seq, label: a.label, childId: a.childId }
        if (a.phase !== undefined) data.phase = a.phase
        rec.session.append('tool-workflow/agent-start', data)
      } catch (err) { rec.ok = false }
      if (active && String(info.id) === active.runId) {
        state.agentLabel = a.label
        if (a.phase) state.phase = a.phase
      }
    }, { global: true })

    ctx.on('workflow/agent-end', (info, a) => {
      const rec = recording.get(String(info.id))
      if (rec && rec.ok) {
        try {
          rec.session.append('tool-workflow/agent-end', { runId: info.id, seq: a.seq, outcome: a.outcome })
        } catch (err) { rec.ok = false }
      }
      if (active && String(info.id) === active.runId) {
        state.done = Math.min(state.done + 1, state.total)
        refreshFiles()
      }
    }, { global: true })

    ctx.on('workflow/end', (info, result) => {
      const rec = recording.get(String(info.id))
      if (rec) {
        if (rec.ok) {
          try { rec.session.append('tool-workflow/run-end', { runId: info.id, stopReason: result.stopReason }) } catch (err) { /* ignore */ }
        }
        recording.delete(String(info.id))
      }
      if (active && String(info.id) === active.runId) {
        state.status = result.stopReason
        state.endedAt = Date.now()
        if (result.stopReason === 'error') state.error = result.error || '流水线执行出错'
        if (result.stopReason === 'cancelled') state.error = '已被用户中止'
        state.agentLabel = ''
        const run = active.run
        active = null
        refreshFiles()
        Promise.resolve(run.result).then(() => run.dispose()).catch(() => run.dispose())
      }
    }, { global: true })

    ctx.on('workflow/phase', (info, title) => {
      if (active && String(info.id) === active.runId) state.phase = title
    }, { global: true })

    ctx.on('workflow/log', (info, message) => {
      if (active && String(info.id) === active.runId) pushLog(message)
    }, { global: true })

    // ---------- 面板 RPC ----------
    harness.handle('get-state', () => snapshot())
    harness.handle('abort', () => {
      if (!active) return { ok: false, reason: '没有运行中的流水线' }
      try { active.run.cancel('用户在进度面板中中止') } catch (err) { /* ignore */ }
      return { ok: true }
    })
    harness.handle('reset', () => {
      if (state.status === 'running') return { ok: false, reason: '流水线运行中,不能重置' }
      state = freshState()
      active = null
      return { ok: true }
    })
  },
}
