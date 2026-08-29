/**
 * dsh-mcmp 冒烟测试(v3 架构:五阶段 + 中控台双模块):
 * 用伪造的 Cordis ctx 驱动 apply(),验证启动、执行→扫描/评审路由、回滚与强制锁定、
 * P3 定点修改、执行失败重试与暂停、断点续跑、中止(含兜底阶段)、重置、_report.yaml
 * 文件路由、--from 补全、识图探测、--model 路由、API 路由等路径。
 * 运行:node tests/smoke.mjs
 */
import { apply } from '../lib/index.js'

let failures = 0
function check(name, cond, extra) {
  const ok = Boolean(cond)
  if (!ok) failures++
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra !== undefined ? ' :: ' + extra : ''))
}

const PROBLEM_EVENT = { type: 'user/message', data: { content: [{ type: 'text', text: '赛题:生产过程中的决策问题。某企业生产畅销电子产品,需要购买零配件并装配为成品,这是2024年全国大学生数学建模竞赛的B题,需要完成四个子问题的建模与求解。' }] } }

function makeHarness({ events = [], toolsSchemas = [], subagentBehavior, fsEntries = [], reportContent = null, defaultModel, retryMs = [1, 1, 1] } = {}) {
  const calls = { commands: [], routes: [], sections: [], listeners: [], appends: [], fsWrites: [] }
  const signals = [] // 每个子任务收到的 signal,用于验证中止链路
  const requests = [] // 每次 subagents.start 收到的完整请求,用于验证 agentOptions 传递
  const session = {
    id: 's-test',
    header: { cwd: 'C:\\ws\\demo', origin: 'user' },
    events,
    // 与真实 DSH 一致:append 既记录事件,也写回会话日志(续跑扫描依赖后者)
    append(type, data) { calls.appends.push({ type, data }); session.events.push({ type, data }) },
  }
  const agent = { session }
  let children = 0
  const subagents = {
    list: () => ['spawn'],
    async start(provider, req) {
      children++
      const idx = children
      signals.push(req.signal)
      requests.push(req)
      const r = typeof subagentBehavior === 'function'
        ? subagentBehavior(idx, req)
        : { text: 'ok ' + idx, stopReason: 'completed' }
      const delay = typeof r.delay === 'number' ? r.delay : 0
      return {
        id: 'c' + idx,
        result: (async () => {
          if (delay > 0) await new Promise((res) => setTimeout(res, delay))
          return { output: [{ type: 'text', text: r.text }], stopReason: r.stopReason }
        })(),
        dispose: async () => {},
      }
    },
  }
  const ctx = {
    get(name) {
      switch (name) {
        case 'commands': return { register(def) { calls.commands.push(def) } }
        case 'agents': return { get: () => agent }
        case 'subagents': return subagents
        case 'systemPrompt': return { section(s) { calls.sections.push(s) } }
        case 'webServer': return { register(route) { calls.routes.push(route) } }
        case 'fs': return {
          async resolve(p) { return { path: String(p) } },
          async listDir() { return fsEntries },
          async stat() { return { type: 'file' } },
          async readText(t) {
            if (String(t.path).includes('_report.yaml') && reportContent !== null) return reportContent
            throw new Error('ENOENT')
          },
          async writeText(t, content) {
            calls.fsWrites.push({ path: String(t.path), content })
            return { version: 'v1' }
          },
        }
        case 'agentDefaultModel': return defaultModel === undefined ? undefined : { currentSelection: () => defaultModel }
        case 'tools': return { schemas: () => toolsSchemas }
        case 'mcmpRetryBackoffMs': return retryMs
        default: return undefined
      }
    },
    on(name, fn) { calls.listeners.push({ name, fn }) },
  }
  apply(ctx)
  const byName = (n) => calls.commands.find((c) => c.name === n)
  return { calls, session, agent, byName, getChildren: () => children, signals: () => signals, requests: () => requests }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const run = (h, rawInput) => h.byName('loopbegin').handler({ agent: h.agent, rawInput })
const lastRunEnd = (h) => h.calls.appends.filter((a) => a.type === 'tool-workflow/run-end').pop()
const countType = (h, t) => h.calls.appends.filter((a) => a.type === t).length

// 子任务标签分类:执行Agent(阶段X·y.z)/ 扫描验证 / 评审决策 / 兜底定稿
const isScan = (req) => String(req.label).startsWith('中控台·扫描验证')
const isReview = (req) => String(req.label).startsWith('中控台·评审决策')
const isFinal = (req) => String(req.label).startsWith('兜底')
const isExec = (req) => !isScan(req) && !isReview(req) && !isFinal(req)
const execSub = (req) => (String(req.label).match(/·(\d+\.\d+) /) || [])[1] || ''

// 默认全通过行为:执行 SUCCESS → 扫描 PASS
const allPass = (i, req) => {
  if (isExec(req)) return { text: '上报状态: SUCCESS\n工作完成', stopReason: 'completed' }
  if (isScan(req)) return { text: '扫描结论: PASS', stopReason: 'completed' }
  if (isReview(req)) return { text: '决策: NO_ACTION\n评级: P3', stopReason: 'completed' }
  if (isFinal(req)) return { text: '兜底完成', stopReason: 'completed' }
  return { text: 'x', stopReason: 'completed' }
}

console.log('== T1 全新运行:22 个子阶段全部 SUCCESS+PASS,不触发评审/兜底 ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT], subagentBehavior: allPass })
  const r = await run(h, '/loopbegin')
  check('T1 启动成功', r && r.kind === 'success')
  await sleep(80)
  check('T1 子智能体数=44(22 执行 + 22 扫描)', h.getChildren() === 44, 'children=' + h.getChildren())
  check('T1 卡片事件(1 run-start + 44 start + 44 end + 22 substage-done + 1 run-end)',
    countType(h, 'tool-workflow/run-start') === 1 && countType(h, 'tool-workflow/agent-start') === 44
    && countType(h, 'tool-workflow/agent-end') === 44 && countType(h, 'tool-workflow/substage-done') === 22
    && countType(h, 'tool-workflow/run-end') === 1,
    'start=' + countType(h, 'tool-workflow/agent-start') + ' done=' + countType(h, 'tool-workflow/substage-done'))
  check('T1 run-end 为 completed', lastRunEnd(h).data.stopReason === 'completed')
  let body = null
  h.calls.routes[0].handler({ method: 'GET', url: '/mcmp-api/state' }, { writeHead() {}, end(b) { body = JSON.parse(b) } })
  check('T1 快照:stages=5 且全部完成', body && Array.isArray(body.stages) && body.stages.length === 5 && body.stages[4].done === 3 && body.done === 22 && body.total === 22, body && JSON.stringify({ done: body.done, total: body.total, s4: body.stages && body.stages[4].done }))
  check('T1 快照:supervisor 回滚 0/10 未锁定', body && body.supervisor && body.supervisor.rollbackCount === 0 && body.supervisor.forcedFinal === false)
}

console.log('== T2 执行失败重试(架构 3.8):失败1次后成功 ==')
{
  let execFails = 0
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    subagentBehavior: (i, req) => {
      if (isExec(req) && execSub(req) === '0.1' && execFails++ === 0) return { text: 'x', stopReason: 'failed' }
      return allPass(i, req)
    },
  })
  await run(h, '/loopbegin')
  await sleep(120)
  check('T2 重试后完成(children=44+1)', h.getChildren() === 45, 'children=' + h.getChildren())
  check('T2 run-end completed', lastRunEnd(h).data.stopReason === 'completed')
}

console.log('== T3 执行失败 4 次(含3重试)→ 暂停 + transactions.log + 兜底 ==')
{
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    subagentBehavior: (i, req) => {
      if (isExec(req) && execSub(req) === '0.1') return { text: 'x', stopReason: 'failed' }
      return allPass(i, req)
    },
  })
  await run(h, '/loopbegin')
  await sleep(150)
  check('T3 子智能体数=5(0.1 执行4次 + 兜底1次)', h.getChildren() === 5, 'children=' + h.getChildren())
  check('T3 run-end 为 error(暂停人工介入)', lastRunEnd(h).data.stopReason === 'error', JSON.stringify(lastRunEnd(h).data))
  check('T3 失败写入 transactions.log', h.calls.fsWrites.some((w) => w.path.includes('transactions.log')), JSON.stringify(h.calls.fsWrites.map((w) => w.path)))
}

console.log('== T4 执行Agent上报 HAS_ISSUES → 评审决策 ROLLBACK → 阶段级回滚重跑 ==')
{
  let t2_3 = 0
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    subagentBehavior: (i, req) => {
      if (isExec(req) && execSub(req) === '2.3') {
        t2_3++
        if (t2_3 === 1) return { text: '上报状态: HAS_ISSUES\n问题:求解结果为负', stopReason: 'completed' }
      }
      if (isReview(req)) return { text: '决策: ROLLBACK\n评级: P2\n回滚目标: 阶段二', stopReason: 'completed' }
      return allPass(i, req)
    },
  })
  await run(h, '/loopbegin')
  await sleep(150)
  check('T4 回滚事件已记录(1次)', countType(h, 'tool-workflow/rollback') === 1, 'rollback=' + countType(h, 'tool-workflow/rollback'))
  check('T4 回滚后重跑:2.1 执行两次', h.requests().filter((r) => isExec(r) && execSub(r) === '2.1').length === 2, '2.1次数=' + h.requests().filter((r) => isExec(r) && execSub(r) === '2.1').length)
  check('T4 最终 run-end completed', lastRunEnd(h).data.stopReason === 'completed')
  let body = null
  h.calls.routes[0].handler({ method: 'GET', url: '/mcmp-api/state' }, { writeHead() {}, end(b) { body = JSON.parse(b) } })
  check('T4 快照:supervisor.rollbackCount=1 且 issues.P2=1', body && body.supervisor.rollbackCount === 1 && body.supervisor.issues.P2 === 1, body && JSON.stringify(body.supervisor))
}

console.log('== T5 评审决策 P3 → 精确定点修改,继续推进(不回滚) ==')
{
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    subagentBehavior: (i, req) => {
      if (isExec(req) && execSub(req) === '1.1') return { text: '上报状态: HAS_ISSUES\n小问题', stopReason: 'completed' }
      if (isReview(req)) return { text: '决策: P3_FIX\n评级: P3\n{"p3_fix":{"fixed":true}}', stopReason: 'completed' }
      return allPass(i, req)
    },
  })
  await run(h, '/loopbegin')
  await sleep(120)
  check('T5 无回滚事件', countType(h, 'tool-workflow/rollback') === 0)
  check('T5 run-end completed', lastRunEnd(h).data.stopReason === 'completed')
  let body = null
  h.calls.routes[0].handler({ method: 'GET', url: '/mcmp-api/state' }, { writeHead() {}, end(b) { body = JSON.parse(b) } })
  check('T5 快照:issues.P3=1', body && body.supervisor.issues.P3 === 1, body && JSON.stringify(body.supervisor && body.supervisor.issues))
}

console.log('== T6 扫描验证发现问题 → 转交评审决策 P3 → 继续 ==')
{
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    subagentBehavior: (i, req) => {
      if (isExec(req) && execSub(req) === '2.2') return { text: '上报状态: SUCCESS\n完成', stopReason: 'completed' }
      if (isScan(req) && req.label.includes('2.2')) return { text: '扫描结论: HAS_ISSUES\n{"issues_found":[{"rating":"P3"}]}', stopReason: 'completed' }
      if (isReview(req)) return { text: '决策: P3_FIX\n评级: P3', stopReason: 'completed' }
      return allPass(i, req)
    },
  })
  await run(h, '/loopbegin')
  await sleep(120)
  check('T6 评审决策被触发(扫描转交)', h.requests().some((r) => isReview(r)), 'review=' + h.requests().filter((r) => isReview(r)).length)
  check('T6 run-end completed', lastRunEnd(h).data.stopReason === 'completed')
}

console.log('== T7 同一阶段回滚 10 次 → FORCED_FINAL 强制锁定;锁定后再回滚 → 降级 P3 继续推进 ==')
{
  // 1.1 每次上报 HAS_ISSUES,评审每次都裁定回滚到阶段一;第10次触发锁定;
  // 锁定后 1.2 再次触发回滚请求(目标仍是阶段一)→ 应降级为 P3 处理,计数器不再增长
  let reviews = 0
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    subagentBehavior: (i, req) => {
      if (isExec(req) && (execSub(req) === '1.1' || execSub(req) === '1.2')) return { text: '上报状态: HAS_ISSUES\n持续问题', stopReason: 'completed' }
      if (isReview(req)) { reviews++; return { text: '决策: ROLLBACK\n评级: P1\n回滚目标: 阶段一', stopReason: 'completed' } }
      return allPass(i, req)
    },
  })
  await run(h, '/loopbegin')
  await sleep(250)
  check('T7 评审决策执行 11 次(10 次回滚 + 1 次锁定后降级)', reviews === 11, 'reviews=' + reviews)
  check('T7 回滚事件 10 次(锁定后不再计数)', countType(h, 'tool-workflow/rollback') === 10, 'rollback=' + countType(h, 'tool-workflow/rollback'))
  check('T7 锁定后继续推进并完成', lastRunEnd(h).data.stopReason === 'completed', JSON.stringify(lastRunEnd(h).data))
  let body = null
  h.calls.routes[0].handler({ method: 'GET', url: '/mcmp-api/state' }, { writeHead() {}, end(b) { body = JSON.parse(b) } })
  check('T7 快照:supervisor.forcedFinal=true 且 rollbackCount=10(不超限)', body && body.supervisor.forcedFinal === true && body.supervisor.rollbackCount === 10, body && JSON.stringify(body.supervisor))
  check('T7 锁定写入 transactions.log', h.calls.fsWrites.some((w) => w.content.includes('FORCED_FINAL')), 'writes=' + h.calls.fsWrites.length)
}

console.log('== T8 运行中中止 → cancelled + 兜底定稿 ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT], subagentBehavior: allPass })
  await run(h, '/loopbegin')
  const route = h.calls.routes[0].handler
  route({ method: 'POST', url: '/mcmp-api/abort' }, { writeHead() {}, end() {} })
  await sleep(80)
  check('T8 run-end 为 cancelled', lastRunEnd(h).data.stopReason === 'cancelled', JSON.stringify(lastRunEnd(h).data))
  check('T8 兜底定稿执行(至少 2 个子任务)', h.getChildren() >= 2, 'children=' + h.getChildren())
}

console.log('== T9 _report.yaml 文件路由(文件优先于回复) ==')
{
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    reportContent: 'status: "NEEDS_REVIEW"\nissues:\n  - problem: "不确定"\n',
    subagentBehavior: (i, req) => {
      if (isExec(req)) return { text: '上报状态: SUCCESS\n回复说成功', stopReason: 'completed' }
      if (isReview(req)) return { text: '决策: NO_ACTION\n评级: P3', stopReason: 'completed' }
      return allPass(i, req)
    },
  })
  await run(h, '/loopbegin')
  await sleep(120)
  check('T9 文件 status=NEEDS_REVIEW → 走评审(而非扫描)', h.requests().filter((r) => isReview(r)).length === 22, 'reviews=' + h.requests().filter((r) => isReview(r)).length)
  check('T9 run-end completed', lastRunEnd(h).data.stopReason === 'completed')
}

console.log('== T10 断点续跑:已完成 5 个子阶段 → 从第 6 个继续 ==')
{
  const doneEvents = ['0.1', '0.2', '0.3', '0.4', '1.1'].map((k) => ({ type: 'tool-workflow/substage-done', data: { runId: 'r0', subKey: k, pass: 1 } }))
  const h = makeHarness({
    events: [PROBLEM_EVENT, { type: 'tool-workflow/run-start', data: { runId: 'r0', name: '数学建模竞赛自动化论文撰写系统v3' } }, ...doneEvents],
    subagentBehavior: allPass,
  })
  const r = await run(h, '/loopbegin')
  check('T10 启动提示含跳过 5 个子阶段', r && r.kind === 'success' && /跳过此前完成的 5 个子阶段/.test(r.text), r && r.text.split('\n')[1])
  await sleep(120)
  check('T10 实际子任务数=(22-5)*2=34', h.getChildren() === 34, 'children=' + h.getChildren())
}

console.log('== T11 完成后再启动 → 提示无需重复;重置后 → 全新开始 ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT], subagentBehavior: allPass })
  await run(h, '/loopbegin')
  await sleep(120)
  const r2 = await run(h, '/loopbegin')
  check('T11 不重置时提示无需重复(22)', r2 && r2.kind === 'error' && /已完成 22/.test(r2.text), r2 && r2.text)
  let body = null
  h.calls.routes[0].handler({ method: 'POST', url: '/mcmp-api/reset' }, { writeHead() {}, end(b) { body = JSON.parse(b) } })
  check('T11 POST /reset 成功', body && body.ok === true)
  check('T11 会话追加了重置标记', h.calls.appends.some((a) => a.type === 'tool-workflow/mcmp-reset'))
  const r3 = await run(h, '/loopbegin')
  check('T11 重置后为全新运行', r3 && r3.kind === 'success' && /全新运行/.test(r3.text) && !/断点续跑:已跳过/.test(r3.text), r3 && r3.text.split('\n')[1])
  await sleep(120)
  check('T11 重置后再跑 44 个子任务', h.getChildren() === 88, 'children=' + h.getChildren())
}

console.log('== T12 触发器:以 /loopbegin 开头的用户消息自动启动 ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT], subagentBehavior: allPass })
  const listener = h.calls.listeners.find((l) => l.name === 'session/event')
  const fakeSession = { id: 's-x', header: { cwd: 'C:\\ws\\demo', origin: 'user' }, events: [PROBLEM_EVENT] }
  const fakeEvent = { type: 'user/message', data: { content: [{ type: 'text', text: '/loopbegin\n' + PROBLEM_EVENT.data.content[0].text }] } }
  listener.fn(fakeSession, fakeEvent)
  await sleep(120)
  check('T12 触发器自动启动并执行 44 个子任务', h.getChildren() === 44, 'children=' + h.getChildren())
}

console.log('== T13 --from 路径解析(后面带其他参数) ==')
{
  let firstPrompt = ''
  const h = makeHarness({
    subagentBehavior: (i, req) => { if (i === 1) firstPrompt = req.prompt[0].text; return allPass(i, req) },
  })
  const r = await run(h, '/loopbegin --from C:\\problems\\题目 b.md --round=2')
  check('T13 启动成功(路径含空格且后跟 --round)', r && r.kind === 'success')
  await sleep(80)
  const fileLine = firstPrompt.match(/赛题原文文件: ([^\n]+)/)
  check('T13 赛题文件路径未被 --round 污染', fileLine && fileLine[1].indexOf('--round') === -1 && fileLine[1].indexOf('题目 b.md') >= 0, fileLine && fileLine[1])
}

console.log('== T14 识图能力探测与五阶段提示词内容 ==')
{
  let s13Prompt = ''
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    toolsSchemas: [{ name: 'vision_describe' }, { name: 'read_image' }],
    subagentBehavior: (i, req) => { if (isExec(req) && execSub(req) === '1.3' && !s13Prompt) s13Prompt = req.prompt[0].text; return allPass(i, req) },
  })
  const r = await run(h, '/loopbegin')
  check('T14 启动成功', r && r.kind === 'success')
  await sleep(80)
  check('T14 1.3 执行提示词含统一质疑标准六维度', s13Prompt.indexOf('教训对照') >= 0 && s13Prompt.indexOf('视觉合理性') >= 0)
  check('T14 1.3 执行提示词含教训/索引必读', s13Prompt.indexOf('ROLLBACK_LESSONS.yaml') >= 0 && s13Prompt.indexOf('FILE_INDEX.yaml') >= 0)
  check('T14 1.3 执行提示词含宿主侧探测的识图工具', s13Prompt.indexOf('vision_describe') >= 0)
  check('T14 1.3 执行提示词要求必须调用视觉模块', s13Prompt.indexOf('【必须】按3.3两阶段流程调用视觉模块审阅') >= 0)
  check('T14 执行提示词要求上报 _report.yaml 与首行上报状态', s13Prompt.indexOf('_report.yaml') >= 0 && s13Prompt.indexOf('上报状态: SUCCESS|HAS_ISSUES|NEEDS_REVIEW') >= 0)
}

console.log('== T15 API 路由与命令 ==')
{
  const h = makeHarness({})
  const route = h.calls.routes[0].handler
  let status = 0, body = null
  route({ method: 'GET', url: '/mcmp-api/state' }, { writeHead(c) { status = c }, end(b) { body = JSON.parse(b) } })
  check('T15 GET /state 返回 200 + 空闲状态', status === 200 && body && body.status === 'idle', 'status=' + status)
  route({ method: 'POST', url: '/mcmp-api/reset' }, { writeHead(c) { status = c }, end(b) { body = JSON.parse(b) } })
  check('T15 POST /reset 空闲时返回 ok', status === 200 && body && body.ok === true, JSON.stringify(body))
  const rAbort = h.byName('loopabort').handler()
  check('T15 loopabort 无任务时提示', rAbort && rAbort.kind === 'error' && /没有运行中的流水线/.test(rAbort.text))
  const rReset = h.byName('loopreset').handler()
  check('T15 /loopreset 空闲可重置', rReset && rReset.kind === 'success' && /从头全新开始/.test(rReset.text), rReset && rReset.text)
}

console.log('== T16 --model 强制子任务模型路由 ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT], subagentBehavior: allPass })
  const r = await run(h, '/loopbegin --model glm-vision/glm-4.7-Flash')
  check('T16 启动成功', r && r.kind === 'success')
  await sleep(80)
  const ao1 = h.requests()[0] && h.requests()[0].agentOptions
  check('T16 子任务 agentOptions=glm-vision/glm-4.7-Flash', ao1 && ao1.provider === 'glm-vision' && ao1.model === 'glm-4.7-Flash', JSON.stringify(ao1))
  const h4 = makeHarness({ events: [PROBLEM_EVENT], subagentBehavior: allPass })
  await run(h4, '/loopbegin')
  await sleep(80)
  const ao4 = h4.requests()[0] && h4.requests()[0].agentOptions
  check('T16 无父模型选择时兜底 deepseek-v4-flash', ao4 && ao4.provider === 'deepseek-official' && ao4.model === 'deepseek-v4-flash', JSON.stringify(ao4))
}

console.log('== T17 中止在兜底定稿阶段也能生效(控制器登记) ==')
{
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    subagentBehavior: (i, req) => (i === 2 ? { text: 'paper', stopReason: 'completed', delay: 150 } : allPass(i, req)),
  })
  await run(h, '/loopbegin')
  h.calls.routes[0].handler({ method: 'POST', url: '/mcmp-api/abort' }, { writeHead() {}, end() {} })
  await sleep(80)
  const sigs = h.signals()
  check('T17 兜底定稿子任务已启动(第 2 个 signal)', sigs.length >= 2, 'signals=' + sigs.length)
  check('T17 兜底定稿使用独立的新控制器', sigs[1] !== sigs[0])
  h.calls.routes[0].handler({ method: 'POST', url: '/mcmp-api/abort' }, { writeHead() {}, end() {} })
  check('T17 第二次中止能 abort 兜底定稿的 signal', sigs[1] && sigs[1].aborted === true, 'sig2.aborted=' + (sigs[1] && sigs[1].aborted))
  await sleep(250)
  check('T17 run-end 为 cancelled', lastRunEnd(h).data.stopReason === 'cancelled', JSON.stringify(lastRunEnd(h).data))
}

console.log('== T18 上报完全缺失(无文件无状态行)→ 按 SUCCESS 交扫描复核 ==')
{
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    reportContent: null,
    subagentBehavior: (i, req) => {
      if (isExec(req)) return { text: '工作完成(无状态行)', stopReason: 'completed' }
      if (isReview(req)) return { text: '决策: NO_ACTION', stopReason: 'completed' }
      return allPass(i, req)
    },
  })
  await run(h, '/loopbegin')
  await sleep(120)
  check('T18 评审决策 0 次(走扫描)', h.requests().filter((r) => isReview(r)).length === 0, 'reviews=' + h.requests().filter((r) => isReview(r)).length)
  check('T18 扫描 22 次', h.requests().filter((r) => isScan(r)).length === 22, 'scans=' + h.requests().filter((r) => isScan(r)).length)
  check('T18 run-end completed', lastRunEnd(h).data.stopReason === 'completed')
}

console.log('== T19 旧报告残留(agent_id 不匹配)→ 视为缺失,回退回复状态 ==')
{
  // 报告恒为 0.1 的 NEEDS_REVIEW:仅 0.1 匹配走评审;其余子阶段 agent_id 不符 → 回退回复 SUCCESS → 扫描
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    reportContent: 'agent_id: "0.1"\nstatus: "NEEDS_REVIEW"\nissues: []\n',
    subagentBehavior: (i, req) => {
      if (isExec(req)) return { text: '上报状态: SUCCESS\n完成', stopReason: 'completed' }
      if (isReview(req)) return { text: '决策: NO_ACTION\n评级: P3', stopReason: 'completed' }
      return allPass(i, req)
    },
  })
  await run(h, '/loopbegin')
  await sleep(120)
  check('T19 仅 0.1 走评审(1 次)', h.requests().filter((r) => isReview(r)).length === 1, 'reviews=' + h.requests().filter((r) => isReview(r)).length)
  check('T19 其余 21 个子阶段走扫描', h.requests().filter((r) => isScan(r)).length === 21, 'scans=' + h.requests().filter((r) => isScan(r)).length)
  check('T19 run-end completed', lastRunEnd(h).data.stopReason === 'completed')
}

console.log(failures === 0 ? '\n全部通过 ✓' : '\n' + failures + ' 项失败 ✗')
process.exit(failures === 0 ? 0 : 1)
