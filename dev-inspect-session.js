const fs = require('fs')
const { zstdDecompressSync } = require('node:zlib')

const ZSTD_MAGIC = 0xFD2FB528
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid frame magic at byte ' + offset)
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

const path = process.argv[2]
const buf = fs.readFileSync(path)
const frames = scanZstdFrames(buf)
console.log('frames:', frames.length)
let full = ''
for (const f of frames) {
  try { full += zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8') } catch (e) { console.log('frame decode fail at', f.start, e.message) }
}
const lines = full.split('\n').filter(Boolean)
const evs = []
for (const line of lines) {
  try { evs.push(JSON.parse(line)) } catch (e) {}
}
console.log('total events:', evs.length)

function msgText(data) {
  const m = data && Array.isArray(data.content) ? data : (data && data.message && Array.isArray(data.message.content) ? data.message : null)
  if (!m) return ''
  return m.content.map(b => (b && b.type === 'text' ? b.text : '')).join('')
}

const counts = {}
for (const ev of evs) counts[ev.type] = (counts[ev.type] || 0) + 1
console.log('type counts:', JSON.stringify(counts))
console.log('---- key events ----')
const interesting = new Set(['user/message', 'command/run', 'command/done', 'subagent/descriptor', 'session/end-seed'])
for (const ev of evs) {
  const t = ev.type
  if (!interesting.has(t) && !(t && t.indexOf('tool-workflow/') === 0)) continue
  let extra = ''
  try {
    if (t === 'user/message') extra = ' :: ' + msgText(ev.data).slice(0, 400).replace(/\n/g, '\\n')
    else extra = ' :: ' + JSON.stringify(ev.data).slice(0, 400)
  } catch (e) {}
  console.log(String(ev.seq) + ' ' + t + extra)
}
console.log('---- tail ----')
const show = evs.slice(-60)
for (const ev of show) {
  const t = ev.type
  let extra = ''
  try {
    if (t === 'user/message') extra = ' :: ' + msgText(ev.data).slice(0, 250).replace(/\n/g, '\\n')
    else if (t === 'command/run' || t === 'command/done') extra = ' :: ' + JSON.stringify(ev.data).slice(0, 300)
    else if (t === 'turn/start' || t === 'turn/end' || t === 'step/start' || t === 'step/end') extra = ' :: ' + JSON.stringify(ev.data).slice(0, 150)
    else if (t === 'assistant/message') extra = ' :: ' + msgText(ev.data).slice(0, 250).replace(/\n/g, '\\n')
    else if (t && t.indexOf('tool-workflow/') === 0) extra = ' :: ' + JSON.stringify(ev.data).slice(0, 300)
    else if (t === 'subagent/descriptor') extra = ' :: ' + JSON.stringify(ev.data).slice(0, 200)
    else if (t === 'tool/call') extra = ' :: ' + JSON.stringify(ev.data).slice(0, 120)
  } catch (e) {}
  console.log(String(ev.seq) + ' ' + t + extra)
}
