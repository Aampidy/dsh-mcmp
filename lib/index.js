/**
 * dsh-mcmp · 数学建模论文自动化流水线 —— 程序入口模块(Host 侧)
 *
 * 职责(入口相关):
 *  - 服务装配(apply)与三个模块的接线;
 *  - 输入框内检测:斜杠命令注册(loopbegin/loopabort/loopreset/loopstatus)、
 *    session/event 消息监听(输入文本以 /loopbegin 开头即自动运行)、
 *    模型侧提示(systemPrompt:收到 /loopbegin 时不要重复执行);
 *  - 模型选择:--model/--provider 显式覆盖、父对话当前选择(resolveForcedModel,
 *    右下角模型选择器 → agent-default-model)、兜底 DeepSeek V4 Flash;
 *  - 本地题目检测:从对话历史提取赛题(extractProblem)或 --from 指定本地文件;
 *  - 识图能力探测(detectVision,宿主侧,仅供参考;以子智能体自检为准);
 *  - 启动参数解析与校验(startPipeline:--round/--fresh/--model/--from),
 *    校验通过后委托论文写作主循环模块(lib/pipeline.js)启动运行;
 *  - 面板 API 路由(/mcmp-api/*)注册——显示界面模块(lib/client.js 浮窗)的
 *    宿主侧接口,转发到主循环模块的 snapshot/abort/reset。
 *
 * 论文写作主循环见 lib/pipeline.js;小浮窗显示与交互见 lib/client.js。
 */
import { createPipeline, PER_ROUND } from './pipeline.js'

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

  // ---------- 论文写作主循环模块(主循环流程、运行状态、中止/重置、进度快照) ----------
  const pipeline = createPipeline({ fs, subagents, agents })

  // 子任务模型路由解析:
  //   1) 显式 --model 覆盖(优先级最高)
  //   2) 父对话当前选择的模型(右下角模型选择器 → agent-default-model 设置)
  //   3) 兜底:DeepSeek V4 Flash(high 推理由 deepseek 提供商默认提供)
  // 无论哪种情况,都强制把 agentOptions 传给每个子任务,
  // 避免子任务继承父会话"创建时固化"的模型选项(聊天里切换模型不生效的老问题)。
  const FALLBACK_MODEL = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  function resolveForcedModel() {
    try {
      const adm = ctx.get('agentDefaultModel')
      if (adm && typeof adm.currentSelection === 'function') {
        const sel = adm.currentSelection()
        if (sel && typeof sel.provider === 'string' && sel.provider && typeof sel.model === 'string' && sel.model) {
          return { provider: sel.provider, model: sel.model }
        }
      }
    } catch (err) { /* ignore */ }
    return { ...FALLBACK_MODEL }
  }

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

  // ---------- 流水线启动逻辑(入口侧:解析与校验 → 委托主循环模块,同步执行,永不阻塞命令通道) ----------
  function startPipeline(agent, rawInput) {
    try {
      if (pipeline.isRunning()) {
        return { kind: 'error', text: '已有流水线正在运行(当前进度 ' + pipeline.progressPercent() + '%)。可在浮动面板点「中止」或运行 /loopabort 后再启动新流水线。' }
      }
      if (!subagents) return { kind: 'error', text: '子智能体服务不可用(当前部署未提供),无法启动流水线。' }
      const session = agent && agent.session
      const cwd = session && session.header ? session.header.cwd : undefined
      if (typeof cwd !== 'string' || cwd.length === 0) {
        return { kind: 'error', text: '无法确定当前会话的工作区目录,无法启动流水线。' }
      }
      pipeline.trackSession(session)
      const raw = rawInput || ''
      const mRound = /(?:^|\s)--round\s*[=:]?\s*(\d+)/i.exec(raw)
      let rounds = 1
      if (mRound) rounds = parseInt(mRound[1], 10)
      if (!Number.isSafeInteger(rounds) || rounds < 1) rounds = 1
      if (rounds > 10) return { kind: 'error', text: '--round 最大为 10。每轮 19 次迭代、每次迭代启动一个专家子智能体,轮数过大会非常耗时。' }
      const fresh = /(?:^|\s)--fresh\b/i.test(raw)
      // 子任务模型:默认强制跟随父对话当前选择的模型(右下角模型选择器);
      // 可选 --model 提供商/模型 显式覆盖;无法读取时兜底 DeepSeek V4 Flash。
      let explicitAgentOptions = undefined
      {
        const mProvider = /(?:^|\s)--provider\s*[=:]?\s*([A-Za-z0-9._\-]+)/i.exec(raw)
        const mModel = /(?:^|\s)--model\s*[=:]?\s*([A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-]+)?)/i.exec(raw)
        if (mModel) {
          const rawModel = mModel[1]
          const slash = rawModel.indexOf('/')
          if (slash >= 0) {
            explicitAgentOptions = { provider: rawModel.slice(0, slash), model: rawModel.slice(slash + 1) }
          } else if (mProvider) {
            explicitAgentOptions = { provider: mProvider[1], model: rawModel }
          } else {
            return { kind: 'error', text: '--model 需要指定提供商/模型,例如 --model glm-vision/glm-4.7-Flash;也可配合 --provider 提供商 --model 模型 使用。' }
          }
        } else if (mProvider) {
          return { kind: 'error', text: '--provider 必须配合 --model 使用,例如 --provider glm-vision --model glm-4.7-Flash。' }
        }
      }
      const agentOptions = explicitAgentOptions || resolveForcedModel()
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
      const args = { rounds, wsDir, problemPath, problem, title: title ? title.slice(0, 40) : '赛题', vision, agentOptions }
      // 断点续跑:扫描本会话落盘的 v2 工作流记录,跳过已完成的迭代
      const resumeCount = fresh ? 0 : pipeline.completedIterations(session)
      if (resumeCount >= rounds * PER_ROUND) {
        return { kind: 'error', text: '检测到本会话已完成 ' + resumeCount + ' 次迭代(≥ 本次请求的 ' + (rounds * PER_ROUND) + ' 次),无需重复。\n- 如需继续优化,请增大轮数,例如 /loopbegin --round=' + Math.min(rounds + 1, 10) + '\n- 如需从头重跑,请使用 /loopbegin --fresh' }
      }
      pipeline.start({ session, agent, args, resumeCount, explicitModel: !!explicitAgentOptions })
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
        input: { hint: '--round=N 外循环轮数(默认 1);--model 提供商/模型 强制子任务模型(如 --model glm-vision/glm-4.7-Flash);可选 --from 题目文件 指定赛题文件;--fresh 从头重跑' },
        handler: (invocation) => startPipeline(invocation.agent, invocation.rawInput),
      })
    } catch (err) { console.warn('dsh-mcmp: loopbegin 注册失败(可能被其他实例占用): ' + String((err && err.message) || err)) }
    try {
      commands.register({
        name: 'loopabort',
        description: '中止正在运行的数学建模论文流水线',
        handler: () => {
          const r = pipeline.abort('用户通过 /loopabort 中止')
          if (!r.ok) return { kind: 'error', text: '当前没有运行中的流水线。' }
          return { kind: 'success', text: '已发送中止请求,流水线将在当前子任务结束后停止(已产出的成果全部保留,随后会自动兜底生成 论文定稿.md)。\n- 想从断点继续:直接再次发送 /loopbegin;\n- 想从头重新开始:先运行 /loopreset(或点面板「重置(全新开始)」),再发送 /loopbegin;也可直接 /loopbegin --fresh。' }
        },
      })
    } catch (err) { console.warn('dsh-mcmp: loopabort 注册失败: ' + String((err && err.message) || err)) }
    try {
      commands.register({
        name: 'loopreset',
        description: '清空流水线状态与断点续跑记录(下次 /loopbegin 从头全新开始)',
        handler: () => {
          const r = pipeline.reset()
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
          const s = pipeline.snapshot()
          if (s.status === 'idle') return { kind: 'success', text: '流水线空闲。粘贴赛题后发送以 /loopbegin 开头的消息(可带 --round=N)即可启动。' }
          let text = '状态: ' + ({ running: '运行中', completed: '已完成', error: '出错', cancelled: '已中止' }[s.status] || s.status)
          text += '\n进度: 第 ' + s.round + '/' + s.rounds + ' 轮,已完成 ' + s.done + '/' + s.total + ' 次迭代(' + s.pct + '%)'
          if (s.cur) text += '\n当前: ' + s.cur.stepKey + ' ' + s.cur.stepName + ' · 迭代 ' + (s.cur.iterIdx + 1) + '/' + s.cur.iterTotal + ' ' + s.cur.iterName
          if (s.agentLabel) text += '\n子任务: ' + s.agentLabel
          text += '\n识图能力: ' + (s.visionLive === 'vision' ? '识图工具(视觉自检)' : s.visionLive === 'script' ? '脚本分析(无识图工具)' : s.vision ? '宿主侧已探测到' : '未探测到(由子智能体自检决定)')
          if (s.error) text += '\n错误: ' + s.error
          text += '\n输出目录: ' + (s.wsDir || '-')
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
      if (res && res.kind === 'error') pipeline.log('消息触发启动失败: ' + res.text)
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

  // ---------- 面板 API:webServer 路由(显示界面模块 lib/client.js 浮窗的宿主侧接口) ----------
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
            if (req.method === 'GET' && (path === '/' || path === '/state')) return json(200, pipeline.snapshot())
            if (req.method === 'POST' && path === '/abort') return json(200, pipeline.abort())
            if (req.method === 'POST' && path === '/reset') return json(200, pipeline.reset())
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
