/**
 * dsh-mcmp 冒烟测试:用伪造的 Cordis ctx 驱动 apply(),
 * 验证启动、触发、断点续跑(含多轮)、中止(含兜底阶段)、重置、--from 补全、
 * 迭代重试、识图探测、API 路由等路径。
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

function makeHarness({ events = [], toolsSchemas = [], subagentBehavior, fsEntries = [] } = {}) {
  const calls = { commands: [], routes: [], sections: [], listeners: [], appends: [] }
  const signals = [] // 每个子任务收到的 signal,用于验证中止链路
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
        }
        case 'tools': return { schemas: () => toolsSchemas }
        default: return undefined
      }
    },
    on(name, fn) { calls.listeners.push({ name, fn }) },
  }
  apply(ctx)
  const byName = (n) => calls.commands.find((c) => c.name === n)
  return { calls, session, agent, byName, getChildren: () => children, signals: () => signals }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// startPipeline 现在是 async;统一追加 --retry-ms=1 让重试间隔为 1ms(测试快速通过)
const run = (h, rawInput) => h.byName('loopbegin').handler({ agent: h.agent, rawInput: rawInput + ' --retry-ms=1' })

/** 生成一个工具工作流运行的事件:从 seqStart 起 count 个迭代,前 donePrefix 个完成 */
function makeRun(seqStart, count, donePrefix) {
  const evs = [{ type: 'tool-workflow/run-start', data: { runId: 'r' + seqStart, name: '数学建模论文流水线v2' } }]
  for (let k = 0; k < count; k++) {
    const seq = seqStart + k
    evs.push({ type: 'tool-workflow/agent-start', data: { runId: 'r' + seqStart, seq } })
    if (k < donePrefix) evs.push({ type: 'tool-workflow/agent-end', data: { runId: 'r' + seqStart, seq, outcome: 'completed' } })
  }
  return evs
}

const lastRunEnd = (h) => h.calls.appends.filter((a) => a.type === 'tool-workflow/run-end').pop()

console.log('== T1 全新运行:19 个迭代全部完成,不触发兜底 ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT] })
  const r = await run(h, '/loopbegin')
  check('T1 启动成功', r && r.kind === 'success')
  await sleep(60)
  check('T1 子智能体数=19(不触发兜底)', h.getChildren() === 19, 'children=' + h.getChildren())
  const t = h.calls.appends.map((a) => a.type)
  const n = (x) => t.filter((v) => v === x).length
  check('T1 卡片事件完整(1 run-start + 19 start + 19 end + 1 run-end)', n('tool-workflow/run-start') === 1 && n('tool-workflow/agent-start') === 19 && n('tool-workflow/agent-end') === 19 && n('tool-workflow/run-end') === 1, 'start=' + n('tool-workflow/agent-start') + ' end=' + n('tool-workflow/agent-end'))
  check('T1 run-end 为 completed', lastRunEnd(h).data.stopReason === 'completed')
}

console.log('== T2 最后一步(S8)失败 → 重试后仍失败 → 触发兜底定稿 ==')
{
  // child 19/20/21 = S8 的 3 次尝试(1+2 重试)都失败,然后兜底(child 22)成功
  const h = makeHarness({ events: [PROBLEM_EVENT], subagentBehavior: (i) => ({ text: 'x', stopReason: i >= 19 && i <= 21 ? 'failed' : 'completed' }) })
  const r = await run(h, '/loopbegin')
  check('T2 启动成功', r && r.kind === 'success')
  await sleep(80)
  check('T2 子智能体数=22(19 + 2 重试 + 兜底)', h.getChildren() === 22, 'children=' + h.getChildren())
  check('T2 兜底成功后 run-end 为 completed', lastRunEnd(h).data.stopReason === 'completed')
}

console.log('== T3 前 3 个迭代(各含重试)连续失败 → error 终止 + 兜底 ==')
{
  // child 1-9 = 迭代1/2/3 各 3 次尝试,全失败 → failStreak=3 → 兜底(child 10)
  const h = makeHarness({ events: [PROBLEM_EVENT], subagentBehavior: (i) => ({ text: 'x', stopReason: i <= 9 ? 'failed' : 'completed' }) })
  const r = await run(h, '/loopbegin')
  check('T3 启动成功', r && r.kind === 'success')
  await sleep(120)
  check('T3 子智能体数=10(3 迭代×3 尝试 + 兜底)', h.getChildren() === 10, 'children=' + h.getChildren())
  check('T3 run-end 为 error', lastRunEnd(h).data.stopReason === 'error')
}

console.log('== T4 运行中中止 → cancelled + 兜底 ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT] })
  const r = await run(h, '/loopbegin')
  check('T4 启动成功', r && r.kind === 'success')
  const route = h.calls.routes[0].handler
  route({ method: 'POST', url: '/mcmp-api/abort' }, { writeHead() {}, end() {} })
  await sleep(80)
  check('T4 run-end 为 cancelled', lastRunEnd(h).data.stopReason === 'cancelled', JSON.stringify(lastRunEnd(h) && lastRunEnd(h).data))
  check('T4 兜底执行(至少 2 个子任务)', h.getChildren() >= 2, 'children=' + h.getChildren())
}

console.log('== T5 多轮断点续跑计数 ==')
{
  const eventsA = [PROBLEM_EVENT, ...makeRun(1, 19, 19), ...makeRun(20, 19, 19)]
  const hA = makeHarness({ events: eventsA })
  const rA = await run(hA, '/loopbegin --round=2')
  check('T5A 两轮完成 → 提示无需重复(38)', rA && rA.kind === 'error' && /已完成 38/.test(rA.text), rA && rA.text)
  const eventsB = [PROBLEM_EVENT, ...makeRun(1, 19, 19), ...makeRun(20, 19, 5)]
  const hB = makeHarness({ events: eventsB })
  const rB = await run(hB, '/loopbegin --round=2')
  check('T5B 第二轮部分完成 → 断点续跑 24→25', rB && rB.kind === 'success' && /跳过此前完成的 24 次迭代/.test(rB.text), rB && rB.text)
  if (rB && rB.kind === 'success') {
    await sleep(80)
    check('T5B 实际子任务数=38-24=14', hB.getChildren() === 14, 'children=' + hB.getChildren())
  }
  const eventsC = [PROBLEM_EVENT, ...makeRun(1, 19, 7)]
  const hC = makeHarness({ events: eventsC })
  const rC = await run(hC, '/loopbegin')
  check('T5C 首轮部分完成 → 断点续跑 7→8', rC && rC.kind === 'success' && /跳过此前完成的 7 次迭代/.test(rC.text), rC && rC.text)
}

console.log('== T6 --from 路径解析(后面带其他参数) ==')
{
  let firstPrompt = ''
  const h = makeHarness({
    subagentBehavior: (i, req) => { if (i === 1) firstPrompt = req.prompt[0].text; return { text: 'x', stopReason: 'completed' } },
  })
  const r = await run(h, '/loopbegin --from C:\\problems\\题目 b.md --round=2')
  check('T6 启动成功(路径含空格且后跟 --round)', r && r.kind === 'success')
  await sleep(80)
  const fileLine = firstPrompt.match(/【赛题原文文件】([^\n]+)/)
  check('T6 赛题文件路径未被 --round 污染', fileLine && fileLine[1].indexOf('--round') === -1 && fileLine[1].indexOf('题目 b.md') >= 0, fileLine && fileLine[1])
}

console.log('== T15 --from 自动查找根目录 MD 文档 ==')
{
  const MD = ['2024 年高教社杯全国大学生数学建模竞赛题目.md', '2023 年国赛A题.md', '说明.md', 'data.xlsx']
  const h = makeHarness({ fsEntries: MD.map((name) => ({ name, type: 'file' })) })
  // 部分匹配
  let r = await run(h, '/loopbegin --from 2024')
  check('T15 部分匹配 2024 → 启动成功', r && r.kind === 'success', r && r.text)
  await sleep(100) // 等流水线跑完,再测后续场景
  // 只写 --from → 列出所有 MD
  r = await run(h, '/loopbegin --from')
  check('T15 仅 --from → 列出根目录 MD 文档', r && r.kind === 'error' && r.text.indexOf('2024 年高教社杯') >= 0 && r.text.indexOf('说明.md') >= 0 && r.text.indexOf('data.xlsx') === -1, r && r.text)
  // 不存在的文件
  r = await run(h, '/loopbegin --from 不存在的文件')
  check('T15 未找到 → 报错并提示现有文档', r && r.kind === 'error' && /未找到匹配/.test(r.text), r && r.text)
  // 歧义匹配
  const h2 = makeHarness({ fsEntries: ['AAA 题.md', 'AAB 题.md'].map((name) => ({ name, type: 'file' })) })
  r = await run(h2, '/loopbegin --from AA')
  check('T15 歧义 → 列出候选', r && r.kind === 'error' && r.text.indexOf('AAA 题.md') >= 0 && r.text.indexOf('AAB 题.md') >= 0, r && r.text)
  // 匹配成功后,首个子任务提示包含正确文件路径
  let firstPrompt = ''
  const h3 = makeHarness({
    fsEntries: ['2024 年高教社杯全国大学生数学建模竞赛题目.md'].map((name) => ({ name, type: 'file' })),
    subagentBehavior: (i, req) => { if (i === 1) firstPrompt = req.prompt[0].text; return { text: 'x', stopReason: 'completed' } },
  })
  r = await run(h3, '/loopbegin --from 2024')
  check('T15 启动成功(匹配到唯一文件)', r && r.kind === 'success')
  await sleep(80)
  check('T15 子任务读取的路径为匹配到的文件', firstPrompt.indexOf('2024 年高教社杯全国大学生数学建模竞赛题目.md') >= 0, (firstPrompt.match(/【赛题原文文件】([^\n]+)/) || [''])[0])
}

console.log('== T16 迭代失败自动重试,瞬时故障不终止流水线 ==')
{
  // child 5 失败(如 429 瞬时),child 6 重试成功 → 迭代完成,流水线继续
  const h = makeHarness({ events: [PROBLEM_EVENT], subagentBehavior: (i) => ({ text: 'x', stopReason: i === 5 ? 'failed' : 'completed' }) })
  const r = await run(h, '/loopbegin')
  check('T16 启动成功', r && r.kind === 'success')
  await sleep(120)
  check('T16 子智能体数=20(19 + 1 次重试)', h.getChildren() === 20, 'children=' + h.getChildren())
  check('T16 run-end 为 completed(未被 3 连败终止)', lastRunEnd(h).data.stopReason === 'completed', JSON.stringify(lastRunEnd(h) && lastRunEnd(h).data))
  const starts = h.calls.appends.filter((a) => a.type === 'tool-workflow/agent-start').length
  check('T16 卡片成员数仍为 19(重试不重复入卡)', starts === 19, 'starts=' + starts)
}

console.log('== T7 识图能力探测(S5 提示携带探测结果) ==')
{
  let s5Prompt = ''
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    toolsSchemas: [{ name: 'vision_describe' }, { name: 'read_image' }],
    subagentBehavior: (i, req) => { if (i === 12) s5Prompt = req.prompt[0].text; return { text: i === 12 ? '视觉能力:可用(工具:vision_describe)' : 'x', stopReason: 'completed' } },
  })
  const r = await run(h, '/loopbegin')
  check('T7 启动成功', r && r.kind === 'success')
  await sleep(80)
  check('T7 S5 提示包含宿主侧探测到的工具', s5Prompt.indexOf('vision_describe') >= 0 && s5Prompt.indexOf('宿主侧探测') >= 0, (s5Prompt.match(/【流水线位置】[^\n]*/) || [''])[0])
}

console.log('== T8 API 路由 ==')
{
  const h = makeHarness({})
  const route = h.calls.routes[0].handler
  let status = 0, body = null
  route({ method: 'GET', url: '/mcmp-api/state' }, { writeHead(c) { status = c }, end(b) { body = JSON.parse(b) } })
  check('T8 GET /state 返回 200 + 状态字段', status === 200 && body && body.status === 'idle', 'status=' + status)
  route({ method: 'POST', url: '/mcmp-api/reset' }, { writeHead(c) { status = c }, end(b) { body = JSON.parse(b) } })
  check('T8 POST /reset 空闲时返回 ok', status === 200 && body && body.ok === true, JSON.stringify(body))
}

console.log('== T9 loopabort 无运行中任务 ==')
{
  const h = makeHarness({})
  const r = h.byName('loopabort').handler()
  check('T9 返回错误提示', r && r.kind === 'error' && /没有运行中的流水线/.test(r.text))
}

console.log('== T10 触发器:以 /loopbegin 开头的用户消息自动启动 ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT] })
  const listener = h.calls.listeners.find((l) => l.name === 'session/event')
  const fakeSession = { id: 's-x', header: { cwd: 'C:\\ws\\demo', origin: 'user' }, events: [PROBLEM_EVENT] }
  const fakeEvent = { type: 'user/message', data: { content: [{ type: 'text', text: '/loopbegin\n' + PROBLEM_EVENT.data.content[0].text }] } }
  listener.fn(fakeSession, fakeEvent)
  await sleep(80)
  check('T10 触发器自动启动并执行 19 个迭代', h.getChildren() === 19, 'children=' + h.getChildren())
}

console.log('== T11 重置记录:完成后重置 → 下次全新开始 ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT] })
  const r1 = await run(h, '/loopbegin')
  check('T11 首次运行启动成功', r1 && r1.kind === 'success')
  await sleep(80)
  check('T11 首次运行完成 19 个迭代', h.getChildren() === 19, 'children=' + h.getChildren())
  const r2 = await run(h, '/loopbegin')
  check('T11 不重置时提示无需重复', r2 && r2.kind === 'error' && /已完成 19/.test(r2.text), r2 && r2.text)
  let status = 0, body = null
  h.calls.routes[0].handler({ method: 'POST', url: '/mcmp-api/reset' }, { writeHead(c) { status = c }, end(b) { body = JSON.parse(b) } })
  check('T11 POST /reset 成功', status === 200 && body && body.ok === true)
  check('T11 会话中追加了重置标记', h.calls.appends.some((a) => a.type === 'tool-workflow/mcmp-reset'))
  const r3 = await run(h, '/loopbegin')
  check('T11 重置后再启动为全新运行', r3 && r3.kind === 'success' && /全新运行/.test(r3.text) && !/断点续跑:已跳过/.test(r3.text), r3 && r3.text)
  await sleep(80)
  check('T11 重置后再次执行 19 个迭代', h.getChildren() === 38, 'children=' + h.getChildren())
}

console.log('== T12 /loopreset 命令 ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT] })
  const cmd = h.byName('loopreset')
  check('T12 /loopreset 已注册', Boolean(cmd))
  const r0 = cmd.handler()
  check('T12 空闲时可重置', r0 && r0.kind === 'success' && /从头|全新开始/.test(r0.text), r0 && r0.text)
}

console.log('== T13 中止部分进度 → 重置 → 全新开始(不续跑) ==')
{
  const h = makeHarness({ events: [PROBLEM_EVENT] })
  await run(h, '/loopbegin')
  h.calls.routes[0].handler({ method: 'POST', url: '/mcmp-api/abort' }, { writeHead() {}, end() {} })
  await sleep(80)
  check('T13 中止生效', lastRunEnd(h).data.stopReason === 'cancelled')
  h.calls.routes[0].handler({ method: 'POST', url: '/mcmp-api/reset' }, { writeHead() {}, end() {} })
  const r = await run(h, '/loopbegin')
  check('T13 重置后再启动为全新运行', r && r.kind === 'success' && /全新运行/.test(r.text) && !/断点续跑:已跳过/.test(r.text), r && r.text)
}

console.log('== T14 中止在兜底定稿阶段也能生效(控制器登记) ==')
{
  const h = makeHarness({
    events: [PROBLEM_EVENT],
    subagentBehavior: (i) => (i === 2 ? { text: 'paper', stopReason: 'completed', delay: 150 } : { text: 'x', stopReason: 'completed' }),
  })
  await run(h, '/loopbegin')
  h.calls.routes[0].handler({ method: 'POST', url: '/mcmp-api/abort' }, { writeHead() {}, end() {} })
  await sleep(80)
  const sigs = h.signals()
  check('T14 兜底定稿子任务已启动(第 2 个 signal)', sigs.length >= 2, 'signals=' + sigs.length)
  check('T14 兜底定稿使用独立的新控制器', sigs[1] !== sigs[0])
  h.calls.routes[0].handler({ method: 'POST', url: '/mcmp-api/abort' }, { writeHead() {}, end() {} })
  check('T14 第二次中止能 abort 兜底定稿的 signal', sigs[1] && sigs[1].aborted === true, 'sig2.aborted=' + (sigs[1] && sigs[1].aborted))
  await sleep(250)
  check('T14 run-end 为 cancelled', lastRunEnd(h).data.stopReason === 'cancelled', JSON.stringify(lastRunEnd(h) && lastRunEnd(h).data))
}

console.log(failures === 0 ? '\n全部通过 ✓' : '\n' + failures + ' 项失败 ✗')
process.exit(failures === 0 ? 0 : 1)
