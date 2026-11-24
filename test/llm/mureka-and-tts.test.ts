import assert from 'node:assert/strict'
import test from 'node:test'
import { createTtsAdapter } from '../../src/llm/tts.ts'
import { cloneMurekaVocal, createMurekaAdapter } from '../../src/llm/mureka.ts'
import { tagStickerImage } from '../../src/llm/sticker-tagger.ts'
import type { ChatModel } from '../../src/shared/ports.ts'

test('Volcano Doubao SSE TTS concatenates base64 chunks and sends required headers', async () => {
  let capturedHeaders: Record<string, string> = {}
  const chunk1 = Buffer.from('ID3-part1').toString('base64')
  const chunk2 = Buffer.from('-part2').toString('base64')
  const sseBody = [
    `data: ${JSON.stringify({ code: 0, data: chunk1 })}`,
    `data: ${JSON.stringify({ code: 20000000, data: chunk2 })}`,
    '',
  ].join('\n')

  const tts = createTtsAdapter(
    {
      provider: 'volc',
      apiKey: 'volc-secret',
      speaker: 'nahida-v2',
      resourceId: 'seed-icl-2.0',
      baseUrl: 'https://openspeech.example.test',
      format: 'mp3',
      sampleRate: 24000,
      speechRate: -15,
    },
    {
      fetchImpl: async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>
        return new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      },
    },
  )

  const res = await tts.synth({ text: '早安呀，树叶上还有露水呢。' })
  assert.equal(capturedHeaders['X-Api-Key'], 'volc-secret')
  assert.equal(capturedHeaders['X-Api-Resource-Id'], 'seed-icl-2.0')
  assert.equal(res.mimeType, 'audio/mpeg')
  assert.equal(Buffer.from(res.bytes).toString('utf8'), 'ID3-part1-part2')
})

test('OpenAI-compatible TTS hits /audio/speech and returns audio bytes', async () => {
  const tts = createTtsAdapter(
    {
      provider: 'openai',
      baseUrl: 'https://tts.example.test/v1',
      apiKey: 'sk-test',
      model: 'tts-1',
      voice: 'nova',
      format: 'mp3',
      speed: 1,
    },
    {
      fetchImpl: async (url) => {
        assert.equal(String(url), 'https://tts.example.test/v1/audio/speech')
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      },
    },
  )
  const out = await tts.synth({ text: '你好' })
  assert.equal(out.mimeType, 'audio/mpeg')
  assert.deepEqual([...out.bytes], [1, 2, 3, 4])
})

test('Mureka SingingPort supports createSong, pollSong lifecycle, and vocal cloning', async () => {
  let pollCalls = 0
  let capturedBody: Record<string, unknown> = {}

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/song/generate')) {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'mk_task_001' }), { status: 200 })
    }
    if (url.includes('/v1/song/query/mk_task_001')) {
      pollCalls++
      if (pollCalls === 1) {
        return new Response(JSON.stringify({ id: 'mk_task_001', status: 'running' }), { status: 200 })
      }
      return new Response(JSON.stringify({
        id: 'mk_task_001',
        status: 'succeeded',
        choices: [{ url: 'https://cdn.mureka.test/song.mp3', duration: 48_000 }],
      }), { status: 200 })
    }
    if (url.endsWith('/v1/song/vocal-clone')) {
      return new Response(JSON.stringify({ vocal_id: 'vocal_nahida_01' }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }

  const mureka = createMurekaAdapter({
    apiKey: 'mk-key',
    baseUrl: 'https://api.mureka.test',
    vocalId: 'vocal_nahida_01',
    model: 'mureka-8',
    fetchImpl: fakeFetch,
  })

  const { taskId } = await mureka.createSong({
    title: '月莲摇篮曲',
    lyrics: '[Verse]\n静谧的月光落在树梢\n[Chorus]\n晚安，世界树会守着你的梦',
    style: 'gentle kalimba lullaby',
  })
  assert.equal(taskId, 'mk_task_001')
  assert.equal(capturedBody.vocal_id, 'vocal_nahida_01')
  assert.equal(capturedBody.model, 'mureka-8')

  const p1 = await mureka.pollSong(taskId)
  assert.equal(p1.status, 'processing')

  const p2 = await mureka.pollSong(taskId)
  assert.equal(p2.status, 'succeeded')
  assert.equal(p2.audioUrl, 'https://cdn.mureka.test/song.mp3')
  assert.equal(p2.durationSec, 48)

  const cloned = await cloneMurekaVocal({
    apiKey: 'mk-key',
    baseUrl: 'https://api.mureka.test',
    audioBytes: new Uint8Array([9, 8, 7]),
    filename: 'sample.mp3',
    fetchImpl: fakeFetch,
  })
  assert.equal(cloned.vocalId, 'vocal_nahida_01')
})

test('tagStickerImage parses VLM emotion tags via Zod', async () => {
  const fakeModel: ChatModel = {
    id: 'fake-vlm',
    model: 'fake',
    async complete(req) {
      assert.equal(req.messages[1]?.images?.length, 1)
      return {
        content: '{"emotions":["humor","curiosity"],"tags":["歪头","笑"],"description":"纳西妲歪头微笑"}',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 },
        model: 'fake',
      }
    },
  }
  const tagged = await tagStickerImage(fakeModel, { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' })
  assert.deepEqual(tagged.emotions, ['humor', 'curiosity'])
  assert.equal(tagged.description, '纳西妲歪头微笑')
})
