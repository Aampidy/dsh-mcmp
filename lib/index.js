/**
 * dsh-mcmp · 数学建模论文自动化流水线 —— Host 半(持久化部署插件)
 *
 * v2.1:新增《缺陷与裁决台账》(00_缺陷与裁决台账.md):后续步骤发现前序错误时,
 *   必须在台账登记并直接修复出错文件(标注修正来源),下游以台账最新裁决为最高
 *   权威——错误在源头修掉,而不是只在下游文档里写"裁决"打补丁。
 * v2:按上一轮实战复盘重构流程:
 *   1) 新增 S5「图表视觉自检与修复」:探测到识图插件(服务/工具)则自动调用识图;
 *      没有识图能力则引导子智能体编写脚本做文本包围盒重叠/越界/乱码分析并修复。
 *   2) 新增 S8「论文定稿与提交包」:无论流水线正常完成、出错还是被中止,都会兜底
 *      生成一版完整、干净的 Markdown 论文(论文定稿.md)。
 *   3) S7 合并旧「编译合规」+「评审改进」:检查 → 修复落实(直接在论文/图表/代码中
 *      修改,禁止只写处理意见)→ 复核验证,配《问题跟踪表》闭环。
 *   4) 步骤顺序理顺:赛题分析→模型建立与求解→编程实现→图表与流程图→图表视觉
 *      自检→论文撰写→评审与修复落实→论文定稿(S4 合并旧图表+流程图两步)。
 * 流程名改为「数学建模论文流水线v2」,断点续跑只识别 v2 记录,避免与 v1 旧记录混淆。
 * 其余机制不变:质疑驱动、成果落盘、tool-workflow 会话记录(原生工作流卡片)、
 * 浮动面板 RPC(/mcmp-api/*)、消息以 /loopbegin 开头自动触发。
 */

export const name = 'mcmp'
// 硬依赖:这些服务挂载后 Cordis 才会激活本插件(避免过早激活导致 ctx.get 全部为空)
export const inject = ['commands', 'subagents', 'agents', 'webServer']

export function apply(ctx) {
  const fs = ctx.get('fs')
  const commands = ctx.get('commands')
  const agents = ctx.get('agents')
  const subagents = ctx.get('subagents')
  const systemPrompt = ctx.get('systemPrompt')
  const webServer = ctx.get('webServer')
  console.log('dsh-mcmp: services available -> commands=' + !!commands + ' fs=' + !!fs + ' agents=' + !!agents + ' subagents=' + !!subagents + ' systemPrompt=' + !!systemPrompt + ' webServer=' + !!webServer)

  const FLOW_NAME = '数学建模论文流水线v2'
  // 全流水线缺陷台账:跨步骤错误登记、裁决与向上修复的唯一权威文件
  const LEDGER = '00_缺陷与裁决台账.md'

  // ---------- 识图能力探测(宿主侧,仅供参考;以子智能体自检为准) ----------
  function detectVision() {
    // 1) 宿主服务:常见的识图服务键
    const keys = ['visionRouter', 'vision', 'imageVision', 'visionService', 'imageAnalysis', 'imageRecognition']
    for (const k of keys) {
      try { if (ctx.get(k) !== undefined) return { source: 'service', key: k } } catch (err) { /* ignore */ }
    }
    // 2) 工具注册表:扫描识图类工具名
    try {
      const tools = ctx.get('tools')
      if (tools && typeof tools.schemas === 'function') {
        let schemas = null
        try { schemas = tools.schemas() } catch (err) { /* 某些实现要求 scope,忽略 */ }
        if (Array.isArray(schemas)) {
          const names = schemas.map((s) => (s && s.name) || '').filter(Boolean)
          const hits = ['vision_describe', 'vision_bootstrap', 'vision_ocr', 'vision_ground', 'vision_crop', 'vision_detect', 'read_image']
            .filter((n) => names.indexOf(n) >= 0)
          if (hits.length > 0) return { source: 'tools', tools: hits }
        }
      }
    } catch (err) { /* ignore */ }
    return null
  }

  // ---------- 步骤元数据(8 步骤 × 19 迭代/轮) ----------
  const STEPS = [
    { key: 'S1', name: '赛题分析与建模方案', phase: 'S1 赛题分析与建模方案', file: '01_赛题分析.md', iters: [
      { name: '赛题精读与拆解', task: '(1) 环境清理:若工作区根目录已存在且含有 00_赛题原文.md 或 01_赛题分析.md(属于上一次运行),先用 shell 命令把整个「数学建模流水线」目录改名为 数学建模流水线_历史归档_YYYYMMDD_HHMMSS(只改名、绝不删除,完整保留历史成果),再重建空目录结构;(2) 通读赛题全文(含附件、表格、图),确认所选题目与全部子问题;(3) 列出问题背景、已知条件、数据说明、待求目标与提交要求(页数、格式、支撑材料);(4) 判断每个子问题的类型(预测/优化/评价/机理/决策等);(5) 圈出关键词与易误解之处(尤其题目附录中的条件定义),给出你的理解与疑问;(6) 将赛题原文完整保存为 00_赛题原文.md;(7) 建立目录结构:代码/、代码/results/、图表/;(8) 创建《缺陷与裁决台账》00_缺陷与裁决台账.md:表头为「编号|发现步骤|出错文件与位置|问题描述|证据|修复方案|状态(待修复/已修复/已否决)|修复人(轮次·步骤)|备注」,并在文件开头写入使用规则:①任何步骤发现前序步骤(或本步骤既往迭代)的错误,必须登记本台账,并**直接修复出错文件**(用编辑工具、在修改处标注「第R轮·Sx修正:D#编号」),不得只在下游文件里绕开;②修复后检查下游引用处,能同步的立即同步,不能同步的追加台账条目;③全流水线所有步骤以本台账最新裁决为最高权威,冲突时以台账为准;④状态由修复人维护,闭环后保留记录不删除。' },
      { name: '建模方案定稿', task: '(1) 数据特征分析(缺失、异常、量纲、规模)与预处理方案;(2) 逐条编号的合理假设(初版)并说明理由;(3) 每个子问题列出 2-3 种候选建模思路,逐一分析优劣与可行性;(4) 为每个子问题敲定选用的模型与方法并说明理由;(5) 给出总体建模框架(问题→数据→假设→模型→求解→验证→结论);(6) 输出《建模方案定稿》,作为后续所有步骤的权威依据;(7) 列出编程实现清单、图表清单(含技术路线图/架构图)与论文结构大纲。' },
    ] },
    { key: 'S2', name: '模型建立与求解', phase: 'S2 模型建立与求解', file: '02_模型建立与求解.md', iters: [
      { name: '模型建立', task: '(1) 建立全题统一的符号体系(符号表:含义+单位),后续步骤必须沿用;(2) 逐条编号模型假设(在 S1 基础上完善);(3) 对每个子问题建立数学模型:决策变量/目标函数/约束或方程,给出推导过程;(4) 说明模型与赛题要求的对应关系(尤其回应赛题附录中的条件定义);(5) 指出模型适用范围与前提。' },
      { name: '模型求解', task: '(1) 可解析求解的给出完整推导与闭式解;(2) 需数值求解的给出算法原理、步骤与伪代码(最优化/微分方程/统计/启发式),说明复杂度、收敛性与可行性;(3) 对关键公式用手算小例子验证;(4) 明确哪些结果将在 S3 用程序实现,给出期望输出的数值口径(精度、单位)。' },
      { name: '模型验证设计', task: '(1) 设计验证方案:特殊/退化情形、手算对照、交叉验证、独立仿真等;(2) 设计灵敏度分析方案(扰动参数、观察指标、扰动范围);(3) 检查模型假设的合理性,列出可放宽的假设及放宽后的修正方式;(4) 总结模型优点、不足与风险;(5) 把本轮形成的符号、公式、结论固化为 S3 的权威依据;若与 S1 定稿冲突,显式裁决:在《缺陷与裁决台账》登记,并直接修复出错文件(标注修正来源),不得只在本文件写裁决。' },
    ] },
    { key: 'S3', name: '编程实现与数值验证', phase: 'S3 编程实现与数值验证', file: '03_编程实现.md', iters: [
      { name: '核心代码', task: '(1) 按 01/02 权威成果用 Python 实现每个子问题的核心算法,代码写入 代码/ 目录,文件名含步骤与版本(如 s3_model_v1.py),配中文注释;(2) 数据读取与预处理;(3) 确保可直接运行;运行并把关键输出记录到 03_编程实现.md;(4) 若缺依赖先 pip 安装(设 3 分钟时限,失败则改用纯标准库实现);(5) 旧代码一律保留。' },
      { name: '调试与数值验证', task: '(1) 用手算小例子与极端参数对照测试;(2) 修复所有 bug,处理数据缺失/异常;(3) 边界情形测试;(4) 与 02 公式逐项核对,数值不一致必须定位原因并裁决(以程序实测为准):在《缺陷与裁决台账》登记,并直接修复出错的 02/01 文件(标注修正来源);(5) 数值结果落盘到 代码/results/ 的 CSV/JSON;(6) 新版本用 _v2/_v3 后缀另存,绝不删除旧版。' },
      { name: '封装与自测', task: '(1) 整理为函数/类,参数化关键量;(2) 统一输出 代码/results/ 结构化数据(CSV/JSON + 结果索引);(3) 提供 main 入口一键复现全部结果;(4) 编写自测套件(断言:数值口径、概率范围、收支非负、退化情形),全部通过并保留报告;(5) 记录运行环境(语言版本、依赖及版本)与复现步骤;(6) 输出《数值验证报告》:权威数值清单,供图表与论文引用。' },
    ] },
    { key: 'S4', name: '图表与流程图生成', phase: 'S4 图表与流程图生成', file: '04_图表生成.md', iters: [
      { name: '基础图表与结构图', task: '(1) 依据 03 权威 results/ 生成论文所需全部图:结果曲线、对比柱状图、散点+拟合、成本/误差分解图等;(2) 同时生成总体技术路线图与系统/模型架构图(graphviz/mermaid/matplotlib/networkx 或自建引擎,源文件保存 代码/,图片输出 图表/);(3) 优先尝试 pip 安装 matplotlib/PIL(3 分钟时限,失败则沿用/自建纯标准库 PNG 引擎);(4) 每张图:中文标题、轴标签、图例、单位,分辨率不低于 300dpi(或 1800×1200 + pHYs);(5) 布局防重叠:图例自动避让、长标签截断或换行、结论框/副标题预留空间、文本框之间留足间隙;(6) 绘图数据与 results/ 交叉核对(脚本断言),不符即退出;(7) 绘图代码保存 代码/。' },
      { name: '美化统一', task: '(1) 统一字号、配色、线型风格(集中式 STYLE 常量);(2) 修复中文乱码(字体字形探测/回退),禁用易乱码字符(如下标数字、组合音标),统一 U+2212 为 "-";(3) 每张图加副标题(参数/口径说明)、结论框(关键数值+结论)、数据来源行;(4) 补充关键标注(重要数值、结论性说明);(5) 图内符号与论文符号体系一致;(6) 保证每张图脱离正文也能看懂。' },
      { name: '精选定稿', task: '(1) 从全部图中精选论文真正需要的图(结果图+技术路线图+架构图),宁缺毋滥;(2) 确定编号(图1、图2…)与插入章节;(3) 冗余图移入 图表/归档/,不物理删除;(4) 定稿图统一导出到 图表/定稿/;(5) 输出《图表清单》(编号/路径/插入章节/一句话说明)与《程序化自检报告》(尺寸/墨量/数据断言);(6) 为 S5 视觉自检做好准备:列出每张定稿图对应的绘图代码与重渲染命令。' },
    ] },
    { key: 'S5', name: '图表视觉自检与修复', phase: 'S5 图表视觉自检与修复', file: '05_图表自检.md', iters: [
      { name: '视觉自检与问题清单', vision: true, task: '(1) 逐张检查 图表/定稿/ 的全部图片,重点:①文字重叠/相互遮挡;②乱码、豆腐块、缺字;③文字被裁切/越出画布;④标题、轴标签、图例缺失或不完整;⑤标注数值与 代码/results/ 权威数据不一致;⑥曲线/柱体被文字遮挡。若你具备识图能力(视觉能力:可用):用识图工具逐张查看(必要时裁剪放大局部),列出每张图的问题清单(问题描述+图内位置+严重级:A=必须修复/B=应当修复)。若不具备识图能力(视觉能力:不可用):编写并运行 Python 分析脚本——在绘图代码中记录每个文本的包围盒(x,y,w,h)并计算两两交叠面积、文本框越界检测、字形回退(豆腐块)探测、墨量/空白检测,输出每图问题 JSON 报告。(2) 汇总为《图表视觉自检报告》写入 05_图表自检.md:每图问题清单+分级+修复建议;(3) 分析脚本保存 代码/。' },
      { name: '修复与复检', vision: true, task: '(1) 对《图表视觉自检报告》中全部 A/B 级问题逐条实际修复:修改绘图代码(调整布局/字号/标签/图例位置/增加间距/换行/去重),重渲染出新版 PNG(定稿目录覆盖同名或 _v2 另存,旧版移入 归档/);(2) 每条修复登记到《修复验证表》:问题→修复方式(代码改动描述)→复检证据(视觉复核结论或脚本输出:重叠数=0);(3) 修复后再次自检(识图工具或脚本),A 级问题必须清零;若仍保留 B 级,给出取舍理由;(4) 更新 04_图表生成.md 的《图表清单》,注明每张图已通过视觉自检;(5) 禁止只记录不修复:每个问题必须有"修复+复检证据"或"显式弃修理由"。' },
    ] },
    { key: 'S6', name: '论文撰写', phase: 'S6 论文撰写', file: '06_论文.md', iters: [
      { name: '初稿', task: '(1) 依据前 5 步权威成果撰写论文初稿,写入 06_论文.md 新的一节;(2) 标准结构:摘要(单独成页、含关键词,突出方法/结果/创新)、一 问题重述与分析、二 模型假设与符号说明、三 模型建立与求解(分问题、公式编号)、四 模型验证与灵敏度分析、五 模型评价与推广、六 参考文献、附录(程序清单);(3) 正文全部结论必须引用前序成果(图表、代码输出),不得凭空捏造数据;(4) 图表用相对路径引用 图表/定稿/ 的图,编号与《图表清单》一致;(5) 严禁流水线内部痕迹:不得出现"01_赛题分析.md""02 迭代3""03 步骤""流水线"等字样,证据一律表述为"支撑材料/附录";(6) 公式编号连续、符号与 02 一致。' },
      { name: '润色终稿', task: '(1) 以评审视角逐节质疑:摘要是否一页内?公式与符号前后一致、编号连续?图表引用齐全、编号正确?有无"显然/易得"式跳步?灵敏度结论是否量化?参考文献格式规范?(2) 修订后重写一份完整、连续的终稿,写入新的一节(标题注明「终稿」),全文完整、可直接提交——不允许用"修订段落清单"代替完整终稿;(3) 保留初稿内容不删;(4) 全文检索流水线痕迹与内部文档名并清零;(5) 结尾附《终稿质检清单》(逐项 ✓/✗)。' },
    ] },
    { key: 'S7', name: '评审与修复落实', phase: 'S7 评审与修复落实', file: '07_评审修复.md', iters: [
      { name: '合规检查与评审', task: '(1) 按国赛要求逐项检查 06 终稿:摘要单独成页含关键词、无学校/队员/指导教师信息、页数符合要求、图表编号与引用一一对应、公式编号连续、参考文献格式、附录程序清单、结果表数值与 results/ 一致、提交文件命名;(2) 以竞赛评审专家身份按国赛评审标准(摘要约10%、假设合理性、建模科学性、求解正确性、验证充分性、写作规范性、创新性)打分并写评语;(3) 汇总输出《合规检查报告》+《评审报告》+《问题清单》(每项含:级别 A=必须修复/B=应当修复/C=建议、位置、证据、修复建议);(4) 建立《问题跟踪表》(编号/描述/级别/状态=待修复),写入 07_评审修复.md;(5) 《问题清单》与《问题跟踪表》中凡涉及前序步骤文件的条目(模型/公式/数值/图表源头错误),同时登记到《缺陷与裁决台账》(若尚未登记),避免只在 06 论文层面打补丁。' },
      { name: '修复落实', task: '(1) 对《问题清单》中全部 A/B 级问题逐一实际修复,而不是只写处理意见:论文问题 → 直接用编辑工具修改 06_论文.md 终稿正文(修改后终稿仍是完整连续的全文,禁止再追加"修订段落");图表问题 → 修改绘图代码并重渲染、复检;数值问题 → 修改代码重跑,与 results/ 复核一致后再更新论文;源头在 01~05 的问题 → 直接修复源头文件并在《缺陷与裁决台账》登记(标注修正来源),再同步下游引用;(2) 每条修复在《问题跟踪表》中登记:修复方式(文件+改动描述)、证据(命令/复检输出/断言结果)、状态(已修复);无法修复的写明阻塞原因与后续建议(状态:受阻);(3) 修复不得破坏既有正确内容;(4) 同步更新论文中受影响的图表引用与编号。' },
      { name: '修复复核', task: '(1) 重新逐项核验《问题跟踪表》:每项重新检查(重跑自测/断言/视觉复检/文本检索),确认修复真实生效,状态更新为"已验证";(2) 对未闭环项继续修复;(3) 输出《修复验证报告》:问题→状态→验证证据,给出闭环率(A 级必须 100%);(4) 更新评审打分(修复后预估);(5) 为 S8 定稿列出移交清单:论文终稿路径、图表清单、代码入口、复现命令。' },
    ] },
    { key: 'S8', name: '论文定稿与提交包', phase: 'S8 论文定稿与提交包', file: '08_论文定稿.md', iters: [
      { name: '论文定稿与提交包', task: '(1) 无论前序步骤是否全部成功,本步骤必须产出一版完整论文:检查 06_论文.md 是否有干净完整的终稿;若有,以其为底稿做最终校对后写入 论文定稿.md;若终稿缺失/混乱/不完整,则依据 00_赛题原文.md、01~07 全部成果与 代码/results/、图表/定稿/ 从头撰写完整论文,写入 论文定稿.md;(2) 论文定稿.md 必须是可直接提交的完整 Markdown:标题、摘要(含关键词)、问题重述与分析、模型假设与符号说明、模型建立与求解(公式编号)、模型验证与灵敏度分析、模型评价与推广、参考文献、附录,图表用相对路径引用;(3) 全文检索并清除流水线内部痕迹与参赛者信息;(4) 数值只采用 results/ 权威数据或前序已验证结论,缺失时明确标注"待补充"并给出推导,不得编造;(5) 输出《提交材料清单》(论文定稿.md、图表、代码、results/、复现说明)与《最后校对报告》;(6) 本步骤工作记录写入 08_论文定稿.md,最终论文全文写入 工作区根目录的 论文定稿.md;(7) 终检《缺陷与裁决台账》:凡状态仍为「待修复」且影响论文结论的条目,在本步骤内尽量闭环;确实无法闭环的,整理为「遗留缺陷清单」写入 08_论文定稿.md(供使用者参考,不得进入论文正文)。' },
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
      vision: null, visionLive: '',
    }
  }
  let state = freshState()
  let active = null
  let lastSession = null // 最近一次运行所属会话,供「清空状态」追加重置标记
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

  // ---------- 断点续跑:从会话日志(落盘)恢复已完成迭代数(仅识别 v2 流程名) ----------
  function completedIterations(session) {
    if (!session || !Array.isArray(session.events)) return 0
    const runs = []
    let current = null
    for (const ev of session.events) {
      try {
        if (ev.type === 'tool-workflow/mcmp-reset') {
          // 用户点过「清空状态/重置」:此前的所有运行记录作废,只从标记之后开始计数
          runs.length = 0
          current = null
          continue
        }
        if (ev.type === 'tool-workflow/run-start') {
          const d = ev.data || {}
          if (d.name === FLOW_NAME) {
            current = { done: new Set() }
            runs.push(current)
          } else {
            current = null
          }
        } else if (ev.type === 'tool-workflow/agent-end' && current) {
          const d = ev.data || {}
          if (Number.isSafeInteger(d.seq) && d.seq >= 1 && d.outcome === 'completed') current.done.add(d.seq)
        }
      } catch (err) { /* 单条事件解析失败忽略 */ }
    }
    // 一次运行从最小序号 S 起连续完成 C 个迭代,则该运行贡献 = (S-1) + C。
    // 这样多轮/续跑运行(seq 从 20、39…继续编号)也能正确累计,而不是只数 1..19。
    const contribution = (run) => {
      if (!run || run.done.size === 0) return 0
      let S = Infinity
      for (const seq of run.done) if (seq < S) S = seq
      let c = 0
      while (run.done.has(S + c)) c++
      return (S - 1) + c
    }
    const last = runs[runs.length - 1]
    let n = last ? contribution(last) : 0
    if (n === 0) {
      let m = 0
      for (const run of runs) m = Math.max(m, contribution(run))
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
    }
    p.push('')
    p.push('【必读文件(先全部读完再动手,禁止跳过)】')
    p.push('- ' + LEDGER + ' (全流水线《缺陷与裁决台账》:最高权威。先检查是否有与本步骤相关的「待修复」条目:有则在本迭代内先修复(直接修改出错文件并更新台账状态),再完成本轮任务)')
    p.push('- ' + s.file + ' (本步骤历次迭代成果,本次在其基础上改进)')
    for (let q = 0; q < si; q++) p.push('- ' + STEPS[q].file + ' (前序步骤的权威成果;若其内容与台账最新裁决冲突,以台账为准,并在自己的产出中采用台账裁决后的版本)')
    if (round > 1) {
      p.push('上一轮(第 ' + (round - 1) + ' 轮)成果已保存在上述文件中(标题形如「## 第' + (round - 1) + '轮…」)。先阅读上一轮对应内容,本轮必须在其基础上优化,质量不得低于上一轮。')
    }
    if (ii === 0) {
      p.push('若本步骤文件尚不存在或为空,从零建立本步骤成果。')
    } else {
      p.push('若文件中缺失上一迭代(「第' + round + '轮·迭代' + ii + ' ' + s.iters[ii - 1].name + '」)成果,说明其失败:先补齐该迭代成果,再完成本次迭代。')
    }
    if (it.vision) {
      p.push('')
      p.push('【识图能力自检(强制,回复第一行)】检查你自己的工具列表:若含有 vision_describe / read_image / vision_ocr / vision_ground / vision_crop / vision_detect 等识图工具,回复第一行写「视觉能力:可用(工具:xxx)」并优先用识图工具检查图片;若没有任何识图工具,回复第一行写「视觉能力:不可用」,改走脚本分析路径。')
      if (args.vision) {
        p.push('【宿主侧探测(仅供参考)】系统检测到识图插件: ' + (args.vision.source === 'service' ? '服务 ' + args.vision.key : '工具 ' + (args.vision.tools || []).join(', ')) + '。若你的工具列表中确有其对应的调用方式,请直接调用它完成图片检查。')
      } else {
        p.push('【宿主侧探测(仅供参考)】未检测到独立识图插件;如果你装了识图插件但此处未检出,以你自己的工具列表为准,仍然按"视觉能力:可用"路径执行。')
      }
    }
    p.push('')
    p.push('【工作纪律】')
    p.push('1. 质疑先行:开工前对既有成果提出至少 3 条具体质疑(假设是否成立、是否偏离赛题、推导有无漏洞、数据与结论是否一致、格式是否规范),并逐条给出处理决定(采纳并改进 / 否决并说明理由)。质疑清单必须放在回复最前面。')
    p.push('2. 只改有据之处:经得起质疑的既有内容必须保留,不做无谓重写。')
    p.push('3. 禁止编造:所有数值与结论必须来自赛题、实际计算或前序成果;信息不足时明确写出你的假设并说明理由,不得假装已知。')
    p.push('4. 符号与术语一致:沿用前序步骤的符号体系,新增符号必须先定义。')
    p.push('5. 论文级表达:推导完整、步骤清晰、结论可复现,杜绝"显然""易得"式跳步。')
    p.push('6. 修复闭环:发现的每个问题要么在本迭代内真正修复并给出证据(修改后的文件/复检输出/断言结果),要么明确记录阻塞原因与后续建议;禁止"只把问题写进文档而不修复"。')
    p.push('7. 无流水线痕迹:论文类文件(06_论文.md、08_论文定稿.md、论文定稿.md)不得出现内部文档引用("01_赛题分析.md""02 迭代3""03 步骤""流水线"等),证据一律表述为"支撑材料/附录"。')
    p.push('8. 缺陷闭环(跨步骤):发现前序步骤(或本步骤既往迭代)的错误时,必须:①登记《缺陷与裁决台账》(编号 D#、证据、修复方案);②用编辑工具**直接修复出错文件**,在修改处标注「第R轮·Sx修正:D#编号」;③同步受影响的全部下游引用(论文/图表/代码/结果文件),做不到同步的追加台账条目。禁止只在自己文件里写"前序有误"后绕开。')
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

  function buildFinalizePrompt(args, reason) {
    const p = []
    p.push('你正在参与「全国大学生数学建模竞赛论文」自动化流水线的**兜底定稿**环节。此前流水线提前结束(原因:' + reason + '),但交付要求是"不论最终结果如何,都必须产出一版完整的论文"。现在由你仅凭现有文件完成这个承诺。')
    p.push('')
    p.push('【工作区(绝对路径)】' + args.wsDir + ' —— 所有读写都在该目录内。')
    if (args.problem.kind === 'file') {
      p.push('【赛题原文文件】' + args.problem.path + ' —— 先用文件工具读取全文。')
    } else {
      p.push('【赛题原文(已完整嵌入)】')
      p.push(args.problem.text)
    }
    p.push('')
    p.push('【现有材料(全部先读,能用的必须用)】')
    p.push('- 00_赛题原文.md、00_缺陷与裁决台账.md(全流水线裁决,最高权威)、01_赛题分析.md、02_模型建立与求解.md、03_编程实现.md、04_图表生成.md、05_图表自检.md、06_论文.md、07_评审修复.md、08_论文定稿.md(存在即读)')
    p.push('- 代码/ 与 代码/results/ 下的全部代码与结构化结果(权威数值只从这里取)')
    p.push('- 图表/定稿/ 下的全部图片(论文插图用相对路径引用)')
    p.push('')
    p.push('【任务(必须完成)】')
    p.push('1. 判断 06_论文.md 中是否已有干净完整的终稿:有 → 以其为底稿做最终校对后写入 论文定稿.md;缺失/混乱/不完整 → 依据上述全部材料从头撰写完整论文,写入 论文定稿.md。')
    p.push('2. 论文定稿.md 必须是可直接提交的完整 Markdown:标题、摘要(单独成页、含关键词)、问题重述与分析、模型假设与符号说明、模型建立与求解(公式编号)、模型验证与灵敏度分析、模型评价与推广、参考文献、附录(程序清单);图表用相对路径引用。')
    p.push('3. 全文不得出现流水线内部痕迹与参赛者信息;数值只采用 results/ 权威数据或前序已验证结论,材料不足处明确标注"待补充"并给出推导,严禁编造。若台账中存在对前序结论的修正裁决,以台账为准。')
    p.push('4. 在 08_论文定稿.md 追加一节「## 兜底定稿」,记录:定稿来源(06 终稿 / 重写)、完整度自评、遗留问题清单(把《缺陷与裁决台账》中仍未闭环的条目列入)。')
    p.push('5. 输出《提交材料清单》与《最后校对报告》(写入 08_论文定稿.md 该节)。')
    p.push('')
    p.push('【工作纪律】质疑先行、禁止编造、无流水线痕迹、论文级表达。回复结尾附不超过 200 字总结。')
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
    }
    refreshFiles()
  }

  function doAbort() {
    if (!active) return { ok: false, reason: '没有运行中的流水线' }
    try { active.controller.abort(new Error('用户在进度面板中中止')) } catch (err) { /* ignore */ }
    return { ok: true }
  }

  // 清空状态 + 重置断点续跑记录:向最近一次运行所属会话追加一条重置标记,
  // 续跑扫描遇到该标记会把之前的运行记录全部作废,下次 /loopbegin 从第 1 个迭代全新开始。
  function resetRecords() {
    if (state.status === 'running') return { ok: false, reason: '流水线运行中,不能重置' }
    if (lastSession) {
      try { lastSession.append('tool-workflow/mcmp-reset', { ts: Date.now() }) } catch (err) { /* 会话不可追加时忽略 */ }
      lastSession = null
    }
    state = freshState()
    active = null
    return { ok: true }
  }

  function doReset() {
    return resetRecords()
  }

  // 启动一个子智能体并返回 { ok, text, outcome }
  async function runChild(provider, session, agent, controller, label, promptText, onStarted) {
    let child = null
    try {
      const parent = (agents && agents.get(session.id)) || agent
      child = await subagents.start(provider, {
        label,
        prompt: [{ type: 'text', text: promptText }],
        parent,
        signal: controller.signal,
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

  // ---------- Host 侧编排器:从断点继续(不依赖聊天 Agent 存活) ----------
  async function runPipeline(runId, session, agent, args, controller) {
    let failStreak = 0
    let cancelled = false
    let finalDone = false // S8(定稿)是否已成功完成
    let stopReason = 'completed'
    let errorMsg = undefined
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
      let started = false
      let outcome = 'failed'
      let note = ''
      const res = await runChild(provider, session, agent, controller, label, buildPrompt(r, f.s, f.i, s, it, args), (child) => {
        started = true
        appendRec(runId, session, 'tool-workflow/agent-start', { runId, seq: g + 1, label, phase: s.phase, childId: String(child.id) })
      })
      outcome = res.outcome
      note = (res.text || '').trim().slice(0, 300)
      if (res.err) note = '执行异常: ' + String((res.err && res.err.message) || res.err).slice(0, 200)
      state.done = Math.min(g + 1, state.total)
      refreshFiles()
      if (outcome === 'completed') {
        failStreak = 0
        pushLog('完成: ' + label)
        if (s.key === 'S8' && (g + 1) === total) finalDone = true
        // 解析 S5 迭代1 的识图能力自报
        if (s.key === 'S5' && f.i === 0) {
          const m = /视觉能力[:：]\s*(可用|不可用)/.exec(res.text || '')
          if (m) {
            state.visionLive = m[1] === '可用' ? 'vision' : 'script'
            pushLog('图表自检路径: ' + (m[1] === '可用' ? '识图工具(视觉自检)' : '脚本分析(无识图工具)'))
          }
        }
      } else {
        failStreak += 1
        pushLog(outcome === 'cancelled' ? '中止: ' : '失败: ' + label + (note ? '(' + note.slice(0, 80) + ')' : ''))
      }
      if (started) appendRec(runId, session, 'tool-workflow/agent-end', { runId, seq: g + 1, outcome })
      if ((g + 1) % PER_ROUND === 0 && !controller.signal.aborted) pushLog('【第 ' + r + '/' + args.rounds + ' 轮完成】')
      if (controller.signal.aborted) { cancelled = true; break }
      if (failStreak >= 3) {
        stopReason = 'error'
        errorMsg = '连续 3 个子任务失败,流水线提前终止(已有成果全部保留,可重新 /loopbegin 续跑)'
        break
      }
    }
    if (cancelled) { stopReason = 'cancelled'; errorMsg = '已被用户中止' }
    // ---------- 兜底定稿:不论成败,只要 S8 未完成,就补一次论文定稿 ----------
    if (!finalDone) {
      pushLog('正在执行兜底定稿:生成 论文定稿.md(不论前序结果如何)')
      state.phase = 'S8 兜底·论文定稿'
      state.agentLabel = 'S8 兜底·论文定稿'
      const fresh = makeController()
      // 关键:把兜底定稿的控制器登记为当前活跃控制器,
      // 否则面板「中止」与 /loopabort 只会 abort 已失效的主控制器,兜底定稿无法被中止
      if (active && active.runId === runId) active.controller = fresh
      const reason = stopReason === 'cancelled' ? '用户中止' : stopReason === 'error' ? errorMsg : '正常流程已结束但定稿步骤未完成'
      const fres = await runChild(provider, session, agent, fresh, '兜底·论文定稿(不论成败)', buildFinalizePrompt(args, reason))
      if (fres.outcome === 'completed') {
        finalDone = true
        pushLog('兜底定稿完成: 论文定稿.md 已生成')
      } else {
        pushLog('兜底定稿未能完成: ' + (fres.text || '').trim().slice(0, 80) + ' —— 请查看工作区已有成果')
        if (fres.outcome === 'cancelled') {
          stopReason = 'cancelled'
          errorMsg = '已被用户中止(兜底定稿未完成)'
        } else if (stopReason === 'completed') {
          stopReason = 'error'
          errorMsg = '流水线迭代已完成,但兜底定稿生成失败'
        }
      }
    }
    finishRun(runId, stopReason, errorMsg)
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
      lastSession = session
      const raw = rawInput || ''
      const mRound = /(?:^|\s)--round\s*[=:]?\s*(\d+)/i.exec(raw)
      let rounds = 1
      if (mRound) rounds = parseInt(mRound[1], 10)
      if (!Number.isSafeInteger(rounds) || rounds < 1) rounds = 1
      if (rounds > 10) return { kind: 'error', text: '--round 最大为 10。每轮 19 次迭代、每次迭代启动一个专家子智能体,轮数过大会非常耗时。' }
      const fresh = /(?:^|\s)--fresh\b/i.test(raw)
      // --from 路径:允许含空格,遇到下一个 -- 标志或行尾即结束,避免吞掉后面的 --round/--fresh
      const mFrom = /(?:^|\s)--from(?:=)?\s*([^\r\n]+?)(?=\s+--|\r?$)/i.exec(raw)
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
      const vision = detectVision()
      const args = { rounds, wsDir, problemPath, problem, title: title ? title.slice(0, 40) : '赛题', vision }
      // 断点续跑:扫描本会话落盘的 v2 工作流记录,跳过已完成的迭代
      const resumeCount = fresh ? 0 : completedIterations(session)
      args.startIndex = resumeCount
      if (resumeCount >= rounds * PER_ROUND) {
        return { kind: 'error', text: '检测到本会话已完成 ' + resumeCount + ' 次迭代(≥ 本次请求的 ' + (rounds * PER_ROUND) + ' 次),无需重复。\n- 如需继续优化,请增大轮数,例如 /loopbegin --round=' + Math.min(rounds + 1, 10) + '\n- 如需从头重跑,请使用 /loopbegin --fresh' }
      }
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
      state.rounds = rounds
      state.total = rounds * PER_ROUND
      state.done = resumeCount
      state.round = Math.min(Math.floor(resumeCount / PER_ROUND) + 1, rounds)
      state.startedAt = Date.now()
      state.wsDir = wsDir
      state.problemPath = problemPath
      state.title = args.title
      state.vision = vision
      const controller = makeController()
      active = { runId, session, controller }
      pushLog('流水线已启动: ' + rounds + ' 轮 × 19 次迭代,输出目录 ' + wsDir + (resumeCount > 0 ? '(断点续跑:跳过已完成的 ' + resumeCount + ' 次迭代)' : '') + '(关闭本聊天窗口不影响后台执行)')
      if (vision) pushLog('识图能力探测: ' + (vision.source === 'service' ? '检测到识图服务 ' + vision.key : '检测到识图工具 ' + (vision.tools || []).join(',')) + '(S5 将自动调用)')
      else pushLog('识图能力探测:未检测到独立识图插件,S5 将让子智能体自检(无识图则走脚本分析)')
      refreshFiles()
      void runPipeline(runId, session, agent, args, controller).catch((err) => {
        pushLog('流水线异常: ' + String((err && err.message) || err))
        finishRun(runId, 'error', '流水线异常: ' + String((err && err.message) || err))
        if (active && active.runId === runId) active = null
      })
      return {
        kind: 'success',
        text: '数学建模论文自动化流水线(v2)已启动:' + rounds + ' 轮 × 19 次迭代 = ' + (rounds * PER_ROUND) + ' 个子任务。\n输出目录: ' + wsDir
          + (resumeCount > 0 ? '\n断点续跑:已跳过此前完成的 ' + resumeCount + ' 次迭代,从第 ' + (resumeCount + 1) + ' 次继续。' : '\n全新运行(若输出目录有旧成果,第一步会自动归档为 数学建模流水线_历史归档_*)。')
          + '\n新流程:赛题分析 → 模型建立与求解 → 编程实现 → 图表与流程图 → 图表视觉自检与修复(有识图插件自动调用,无则脚本分析)→ 论文撰写 → 评审与修复落实(问题必须真正修复)→ 论文定稿。\n无论成败,最终都会生成完整论文 数学建模流水线/论文定稿.md。\n进度请在右下角浮动面板实时查看(含百分比),聊天区也会出现流水线运行卡片。\n提示:中断或关闭聊天窗口都不会丢进度,再次发送 /loopbegin 即从断点续跑;如要重头开始,点面板「重置(全新开始)」、运行 /loopreset 或加 --fresh。',
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
        description: '启动数学建模论文自动化流水线 v2(8 步骤:含图表视觉自检、评审修复闭环、论文定稿;每轮 19 次迭代、多轮外循环,成果全部落盘)',
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
          return { kind: 'success', text: '已发送中止请求,流水线将在当前子任务结束后停止(已产出的成果全部保留,随后会自动兜底生成 论文定稿.md)。\n- 想从断点继续:直接再次发送 /loopbegin;\n- 想从头重新开始:先运行 /loopreset(或点面板「重置(全新开始)」),再发送 /loopbegin;也可直接 /loopbegin --fresh。' }
        },
      })
    } catch (err) { console.warn('dsh-mcmp: loopabort 注册失败: ' + String((err && err.message) || err)) }
    try {
      commands.register({
        name: 'loopreset',
        description: '清空流水线状态与断点续跑记录(下次 /loopbegin 从头全新开始)',
        handler: () => {
          const r = resetRecords()
          if (!r.ok) return { kind: 'error', text: r.reason }
          return { kind: 'success', text: '已清空流水线状态与断点续跑记录。下次发送 /loopbegin 将从第 1 个迭代全新开始(工作区旧成果不删除,首步会自动归档为 数学建模流水线_历史归档_*)。' }
        },
      })
    } catch (err) { console.warn('dsh-mcmp: loopreset 注册失败: ' + String((err && err.message) || err)) }
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
          text += '\n识图能力: ' + (s.visionLive === 'vision' ? '识图工具(视觉自检)' : s.visionLive === 'script' ? '脚本分析(无识图工具)' : s.vision ? '宿主侧已探测到' : '未探测到(由子智能体自检决定)')
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
        text: '数学建模流水线说明:当用户消息以 /loopbegin 开头(可带 --round=N、--from 文件或 --fresh 参数)时,插件已自动在后台启动「数学建模论文自动化流水线」(8 步骤、每轮 19 次迭代,由工作流子智能体执行:赛题分析→模型建立与求解→编程实现→图表与流程图→图表视觉自检与修复→论文撰写→评审与修复落实→论文定稿)。此时你只需用一两句话确认已启动,并提示用户查看右下角进度面板与聊天区的工作流运行卡片;绝对不要自己去编写或执行该流水线的任何步骤,不要重复启动。流水线无论成败都会在 数学建模流水线/论文定稿.md 生成一版完整论文。若用户消息包含赛题但未以 /loopbegin 开头,说明尚未启动流水线,不要擅自运行。辅助命令 /loopstatus、/loopabort、/loopreset(清空续跑记录,下次从头开始)由系统处理,你无需执行。',
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
}
