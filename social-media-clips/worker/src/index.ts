import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { YoutubeTranscript } from 'youtube-transcript'

interface Env {
  DB: D1Database
  ANTHROPIC_API_KEY: string
  YOUTUBE_API_KEY: string
}

const app = new Hono<{ Bindings: Env }>()

app.use('/api/*', cors())

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractJsonArray(text: string): unknown[] | null {
  const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
  try {
    const result = JSON.parse(cleaned)
    if (Array.isArray(result)) return result
  } catch { /* fall through */ }

  const start = cleaned.indexOf('[')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i]
    if (escape) { escape = false; continue }
    if (c === '\\') { escape = true; continue }
    if (c === '"') { inString = !inString; continue }
    if (inString) continue
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)) }
        catch { return null }
      }
    }
  }
  return null
}

async function callClaude(apiKey: string, prompt: string, useWebSearch = false): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }
  if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05'

  const body: Record<string, unknown> = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  }
  if (useWebSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }]

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Anthropic API ${response.status}: ${err.slice(0, 300)}`)
  }

  const data = await response.json() as { content: Array<{ type: string; text?: string }> }
  return data.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
}

// Runs D1 batch statements in chunks of 99 to stay under the D1 batch limit.
async function batchRun(db: D1Database, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += 99) {
    await db.batch(stmts.slice(i, i + 99))
  }
}

// ── Embedding helpers (ported from backend.py) ────────────────────────────────

const VOCAB = [
  'riba', 'interest', 'usury', 'halal', 'haram', 'sharia', 'islamic',
  'finance', 'banking', 'investment', 'investing', 'sukuk', 'bond',
  'zakat', 'charity', 'waqf', 'endowment', 'mudarabah', 'musharakah',
  'partnership', 'profit', 'sharing', 'loss', 'equity', 'debt',
  'mortgage', 'loan', 'credit', 'money', 'wealth', 'economy',
  'economic', 'financial', 'capital', 'market', 'trade', 'commerce',
  'business', 'entrepreneur', 'startup', 'fund', 'asset', 'property',
  'gold', 'silver', 'currency', 'exchange', 'tax', 'government',
  'regulation', 'compliance', 'audit', 'accounting', 'ethics',
  'moral', 'justice', 'fair', 'exploitation', 'poor', 'rich',
  'poverty', 'inequality', 'distribution', 'community', 'ummah',
  'quran', 'hadith', 'fiqh', 'fatwa', 'scholar', 'ijtihad',
  'malaysia', 'dubai', 'saudi', 'gulf', 'middle east', 'pakistan',
  'indonesia', 'turkey', 'documentary', 'film', 'series', 'show',
]

function getEmbedding(text: string): number[] {
  const lower = text.toLowerCase()
  const wordCount = Math.max(lower.split(/\s+/).length, 1)
  const vector = VOCAB.map(term => (lower.split(term).length - 1) / wordCount)
  const norm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0))
  return norm === 0 ? vector : vector.map(x => x / norm)
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0
  const dot = a.reduce((s, x, i) => s + x * b[i], 0)
  const normA = Math.sqrt(a.reduce((s, x) => s + x * x, 0))
  const normB = Math.sqrt(b.reduce((s, x) => s + x * x, 0))
  return normA && normB ? dot / (normA * normB) : 0
}

function chunkTranscript(
  segments: Array<{ text: string; start: number; duration: number }>,
  chunkSize = 300,
) {
  const chunks: Array<{ text: string; start_time: number; end_time: number; word_count: number }> = []
  let words: string[] = []
  let startTime = 0
  let endTime = 0

  for (const seg of segments) {
    if (!words.length) startTime = seg.start
    words.push(...seg.text.split(/\s+/))
    endTime = seg.start + seg.duration
    if (words.length >= chunkSize) {
      chunks.push({ text: words.join(' '), start_time: startTime, end_time: endTime, word_count: words.length })
      words = []
      startTime = endTime
    }
  }
  if (words.length) {
    chunks.push({ text: words.join(' '), start_time: startTime, end_time: endTime, word_count: words.length })
  }
  return chunks
}

function extractYouTubeId(url: string): string | null {
  for (const pattern of [/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/, /embed\/([A-Za-z0-9_-]{11})/]) {
    const m = url.match(pattern)
    if (m) return m[1]
  }
  return null
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Media Discovery — replaces run_claude subprocess with Anthropic API + built-in web search
app.post('/api/discovery/run', async (c) => {
  const apiKey = c.env.ANTHROPIC_API_KEY
  if (!apiKey) return c.json({ error: 'ANTHROPIC_API_KEY not configured. Set it with: wrangler secret put ANTHROPIC_API_KEY' }, 500)

  const { message = 'historical Muslim TV shows and movies' } = await c.req.json<{ message?: string }>()
  const year = new Date().getFullYear()

  const prompt = `You are a research agent. Find REAL Muslim-themed movies, TV series, YouTube shows and documentaries related to: ${message}

Search the web for: "${message} list", "best Muslim movies ${year}", "Islamic historical drama recommendations", "${message} documentary", "${message} YouTube channel".

Only include titles you actually found in search results. Do NOT fabricate titles.

Return ONLY a JSON array (no markdown, no explanation) in this format:
[{"title_en":"...","title_ar":null,"title_ur":null,"title_tr":null,"title_translation":null,"type":"movie|tv_series|youtube_show|documentary|unknown","language":"Arabic|English|Urdu|Turkish|Persian|French|Other","year":2024,"description":"...","tags":["tag1"],"source_urls":["https://..."],"islamic_finance_relevance":"high|medium|low|none","notes":""}]`

  try {
    const raw = await callClaude(apiKey, prompt, true)
    const result = extractJsonArray(raw)
    if (result) return c.json({ text: JSON.stringify(result) })

    // Fallback: reformat as JSON
    const raw2 = await callClaude(apiKey, `Convert this to a JSON array. Return ONLY the raw JSON array starting with [ and ending with ]:\n\n${raw}`, false)
    const result2 = extractJsonArray(raw2)
    if (!result2) return c.json({ error: `Could not parse response. Preview: ${raw.slice(0, 300)}` }, 500)

    return c.json({ text: JSON.stringify(result2) })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// Library — GET
app.get('/api/library', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM media_library ORDER BY discovered_at DESC').all()
  return c.json(results.map(r => ({
    ...r,
    tags: JSON.parse((r.tags as string) || '[]'),
    source_urls: JSON.parse((r.source_urls as string) || '[]'),
  })))
})

// Library — POST (replace all)
app.post('/api/library', async (c) => {
  const entries = await c.req.json<Record<string, unknown>[]>()

  const insertStmts = entries.map(e =>
    c.env.DB.prepare(
      `INSERT INTO media_library (id, title_en, title_ar, title_ur, title_tr, title_translation, type, language, year,
        description, tags, source_urls, islamic_finance_relevance, status, source_prompt, notes, youtube_url, discovered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      e.id, e.title_en, e.title_ar ?? null, e.title_ur ?? null, e.title_tr ?? null, e.title_translation ?? null,
      e.type, e.language, e.year ?? null, e.description ?? null,
      JSON.stringify(e.tags ?? []), JSON.stringify(e.source_urls ?? []),
      e.islamic_finance_relevance, e.status, e.source_prompt ?? null,
      e.notes ?? null, e.youtube_url ?? null, e.discovered_at, e.updated_at ?? null,
    )
  )

  await batchRun(c.env.DB, [c.env.DB.prepare('DELETE FROM media_library'), ...insertStmts])
  return c.json({ ok: true })
})

// Transcript fetch — replaces youtube-transcript-api Python + file writes with D1
app.post('/api/transcripts/fetch', async (c) => {
  const { media_id, youtube_url, title = '' } = await c.req.json<{ media_id?: string; youtube_url?: string; title?: string }>()
  if (!media_id || !youtube_url) return c.json({ error: 'media_id and youtube_url are required' }, 400)

  const videoId = extractYouTubeId(youtube_url)
  if (!videoId) return c.json({ error: 'Could not extract YouTube video ID' }, 400)

  const cached = await c.env.DB.prepare('SELECT * FROM transcripts WHERE media_id = ?').bind(media_id).first()
  if (cached?.status === 'Transcribed') {
    return c.json({ ok: true, transcript: { ...cached, has_timestamps: Boolean(cached.has_timestamps) }, cached: true })
  }

  const createdAt = new Date().toISOString()
  const transcriptId = `tr_${media_id}`

  try {
    let segments: Array<{ text: string; start: number; duration: number }> = []
    let source = 'captions_en'

    try {
      const data = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' })
      // YoutubeTranscript returns offset/duration in seconds (from YouTube's timedtext XML)
      segments = data.map(s => ({ text: s.text, start: s.offset, duration: s.duration }))
    } catch {
      const data = await YoutubeTranscript.fetchTranscript(videoId)
      segments = data.map(s => ({ text: s.text, start: s.offset, duration: s.duration }))
      source = 'auto'
    }

    const fullText = segments.map(s => s.text).join(' ')
    const chunks = chunkTranscript(segments)
    const record = {
      id: transcriptId, media_id, title, source_type: 'YouTube', source_url: youtube_url,
      video_id: videoId, transcript_text: fullText, transcript_source: source,
      segment_count: segments.length, chunk_count: chunks.length,
      has_timestamps: true, status: 'Transcribed', notes: '', created_at: createdAt,
    }

    const chunkStmts = chunks.map((chunk, i) =>
      c.env.DB.prepare(
        `INSERT INTO chunks (id, transcript_id, media_id, title, chunk_index, text, start_time, end_time, word_count, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      ).bind(`chunk_${media_id}_${i}`, transcriptId, media_id, title, i, chunk.text, chunk.start_time, chunk.end_time, chunk.word_count)
    )

    await batchRun(c.env.DB, [
      c.env.DB.prepare('DELETE FROM transcripts WHERE media_id = ?').bind(media_id),
      c.env.DB.prepare(
        `INSERT INTO transcripts (id, media_id, title, source_type, source_url, video_id, transcript_text, transcript_source,
          segment_count, chunk_count, has_timestamps, status, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(transcriptId, media_id, title, 'YouTube', youtube_url, videoId, fullText, source,
        segments.length, chunks.length, 1, 'Transcribed', '', createdAt),
      c.env.DB.prepare('DELETE FROM chunks WHERE media_id = ?').bind(media_id),
      ...chunkStmts,
    ])

    return c.json({ ok: true, transcript: record, chunk_count: chunks.length })
  } catch (e) {
    const notes = String(e).slice(0, 200)
    await batchRun(c.env.DB, [
      c.env.DB.prepare('DELETE FROM transcripts WHERE media_id = ?').bind(media_id),
      c.env.DB.prepare(
        `INSERT INTO transcripts (id, media_id, title, source_type, source_url, video_id, transcript_text, transcript_source,
          segment_count, chunk_count, has_timestamps, status, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', 'none', 0, 0, 0, 'Failed', ?, ?)`
      ).bind(transcriptId, media_id, title, 'YouTube', youtube_url, videoId, notes, createdAt),
    ])
    return c.json({ ok: false, error: notes, transcript: { id: transcriptId, media_id, status: 'Failed', notes, has_timestamps: false } })
  }
})

// Transcripts — list
app.get('/api/transcripts', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM transcripts ORDER BY created_at DESC').all()
  return c.json(results.map(r => ({ ...r, has_timestamps: Boolean(r.has_timestamps) })))
})

// Embeddings — compute for all un-embedded chunks
app.post('/api/embeddings/compute', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, text FROM chunks WHERE embedding IS NULL').all()

  for (const row of results) {
    const embedding = getEmbedding(row.text as string)
    await c.env.DB.prepare('UPDATE chunks SET embedding = ? WHERE id = ?')
      .bind(JSON.stringify(embedding), row.id)
      .run()
  }

  return c.json({ ok: true, chunks_embedded: results.length })
})

// Vector search — replaces numpy cosine similarity
app.post('/api/search/moments', async (c) => {
  const { query = 'Islamic finance', top_k = 20, min_score = 0.05 } =
    await c.req.json<{ query?: string; top_k?: number; min_score?: number }>()

  const { results } = await c.env.DB.prepare('SELECT * FROM chunks WHERE embedding IS NOT NULL').all()
  if (!results.length) {
    return c.json({ moments: [], message: 'No embedded chunks. Run /api/embeddings/compute first.' })
  }

  const queryEmbedding = getEmbedding(query)

  const scored = results
    .map(chunk => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, JSON.parse(chunk.embedding as string) as number[]),
    }))
    .filter(({ score }) => score >= min_score)
    .sort((a, b) => b.score - a.score)
    .slice(0, top_k)
    .map(({ chunk, score }) => ({
      chunk_id: chunk.id as string,
      transcript_id: chunk.transcript_id as string,
      media_id: chunk.media_id as string,
      title: chunk.title as string,
      text: chunk.text as string,
      start_time: chunk.start_time as number | null,
      end_time: chunk.end_time as number | null,
      similarity_score: Math.round(score * 10000) / 10000,
      confidence: score > 0.4 ? 'high' : score > 0.2 ? 'medium' : 'low',
      review_status: 'New',
    }))

  // Claude explanations for top 5 (skipped gracefully if no API key)
  const apiKey = c.env.ANTHROPIC_API_KEY
  if (apiKey && scored.length) {
    try {
      const excerpts = scored.slice(0, 5).map(m => m.text.slice(0, 300))
      const raw = await callClaude(
        apiKey,
        `For each excerpt, write one sentence explaining why it's relevant to: "${query}"\nReturn ONLY a JSON array of strings in the same order.\nExcerpts:\n${JSON.stringify(excerpts)}`,
        false,
      )
      const explanations = extractJsonArray(raw)
      if (explanations) {
        explanations.slice(0, 5).forEach((exp, i) => {
          (scored[i] as Record<string, unknown>).explanation = exp
        })
      }
    } catch { /* explanations are optional */ }
  }

  return c.json({ moments: scored, query, total_chunks_searched: results.length, matches_found: scored.length })
})

// YouTube search — replaces yt-dlp subprocess with YouTube Data API v3
app.post('/api/youtube/search', async (c) => {
  const ytKey = c.env.YOUTUBE_API_KEY
  if (!ytKey) return c.json({ error: 'YOUTUBE_API_KEY not configured. Set it with: wrangler secret put YOUTUBE_API_KEY' }, 500)

  const { title = '', type = '' } = await c.req.json<{ title?: string; type?: string }>()
  if (!title) return c.json({ error: 'title is required' }, 400)

  const q = encodeURIComponent(`${title} ${type}`.trim())
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&maxResults=1&key=${ytKey}`)

  if (!res.ok) {
    const err = await res.text()
    return c.json({ error: `YouTube API error: ${err.slice(0, 200)}` }, 500)
  }

  type YTItem = { id: { videoId: string }; snippet: { title: string } }
  const data = await res.json() as { items?: YTItem[] }
  const item = data.items?.[0]
  if (!item) return c.json({ url: '', title: '', video_id: '' })

  return c.json({
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    title: item.snippet.title,
    video_id: item.id.videoId,
  })
})

// Status / health check
app.get('/api/status', async (c) => {
  const [lib, tr, ch, approved, transcribed, embedded] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as n FROM media_library').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM transcripts').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM chunks').first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as n FROM media_library WHERE status='Approved'").first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as n FROM transcripts WHERE status='Transcribed'").first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM chunks WHERE embedding IS NOT NULL').first<{ n: number }>(),
  ])
  return c.json({
    ok: true,
    library_count: lib?.n ?? 0,
    transcript_count: tr?.n ?? 0,
    chunk_count: ch?.n ?? 0,
    embedded_chunk_count: embedded?.n ?? 0,
    approved_count: approved?.n ?? 0,
    transcribed_count: transcribed?.n ?? 0,
  })
})

export default app
