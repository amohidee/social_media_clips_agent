---
name: islamic-media-discovery
description: "Build and operate the Islamic Media Discovery System — a React + TypeScript frontend backed by a Python/Flask server that uses Claude Code CLI (via subprocess) to discover, classify, and curate Muslim-themed media for Islamic finance research. Use this skill whenever the user asks to run, extend, debug, or redeploy any part of this system."
---

# Islamic Media Discovery System — Skill Guide

## What This System Does

Finds Muslim-themed movies, TV series, YouTube shows, and documentaries related
to Islamic finance topics (riba, sukuk, zakat, halal investing, mudarabah, etc.).
Classifies and stores them in a labeled library. Built to be extended with
transcript ingestion and vector search in Tool 2.

---

## Architecture

```
Browser (React + TypeScript)        http://localhost:5173
        ↕  fetch POST /api/discovery/run
Python Flask Backend                http://localhost:5000
        ↕  subprocess.run (temp file prompt)
Claude Code CLI                     uses Pro/Max subscription — no API cost
        ↕  returns markdown or JSON
Flask parses + returns JSON array
        ↕
React populates Media Library
```

### Why temp files?
Windows truncates long command-line arguments. All prompts are written to
`tempfile.NamedTemporaryFile` and passed as `@filepath` to Claude Code.
The temp file is deleted immediately after the subprocess returns.

### Why two Claude calls?
Claude Code defaults to markdown output even with `--output-format text`.
- **Call 1**: Ask Claude to find media and describe it (accepts markdown)
- **Call 2**: Ask Claude to convert Call 1's output into a JSON array
- A regex `\[.*\]` with `re.DOTALL` extracts the JSON from either call

---

## File Structure

```
social-media-clips/
├── src/
│   ├── App.tsx          ← entire React frontend (single file for MVP)
│   └── backend.py       ← Flask server + Claude Code subprocess logic
├── index.html           ← Google Fonts links live here
├── vite.config.ts       ← @tailwindcss/vite plugin
├── tsconfig.json        ← strict: true
├── .env                 ← VITE_ANTHROPIC_API_KEY (not used currently)
└── package.json
```

---

## Running the System

Always run these in **two separate terminals**:

**Terminal 1 — Backend**
```powershell
cd social-media-clips
python src/backend.py
```
Expected output: `* Running on http://127.0.0.1:5000`

**Terminal 2 — Frontend**
```powershell
cd social-media-clips
npm run dev
```
Expected output: `VITE ready on http://localhost:5173`

### When to restart what
| You changed...       | Restart needed?                        |
|----------------------|----------------------------------------|
| `backend.py`         | Yes — `Ctrl+C` then `python backend.py` |
| `App.tsx`            | No — Vite hot-reloads automatically    |
| `vite.config.ts`     | Yes — `Ctrl+C` then `npm run dev`      |
| `.env`               | Yes — `Ctrl+C` then `npm run dev`      |

---

## Backend API

### `POST /api/discovery/run`
Runs a two-step Claude Code discovery pipeline.

**Request body:**
```json
{ "system": "", "message": "Islamic finance in media" }
```

**Response:**
```json
{ "text": "[{\"title_en\": \"...\", ...}]" }
```

**Pipeline:**
1. Write prompt to temp file → run `claude.cmd -p @file --output-format text`
2. If response contains `[...]` → return it directly
3. Otherwise write conversion prompt to second temp file → run Claude again
4. Extract `[...]` with regex → return it

### `GET /api/library`
Returns contents of `data.json`. Returns `[]` if file does not exist.

---

## Frontend Data Flow

```
User types prompt
  → SearchTab calls callClaude()
  → callClaude() POSTs to http://localhost:5000/api/discovery/run
  → gets back { text: "[...]" }
  → runDiscovery() calls parseJsonResponse(text)
  → handles both raw array [] and wrapped { entries: [] }
  → maps raw entries to typed MediaEntry objects
  → useMediaLibrary.addEntries() deduplicates + stores in React state
  → LibraryTab renders EntryCard for each entry
```

---

## Key TypeScript Types

```typescript
type MediaType = "movie" | "tv_series" | "youtube_show" | "documentary" | "unknown"
type EntryStatus = "New" | "Reviewed" | "Approved" | "Rejected"
type IslamicFinanceRelevance = "high" | "medium" | "low" | "none"

interface MediaEntry {
  id: string
  title_en: string
  title_ar: string | null
  title_ur: string | null
  title_tr: string | null
  type: MediaType
  language: string
  year: number | null
  description: string | null
  tags: string[]
  source_urls: string[]
  islamic_finance_relevance: IslamicFinanceRelevance
  status: EntryStatus
  source_prompt: string
  notes: string | null
  discovered_at: string
  updated_at: string | null
}
```

---

## Common Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `Failed to fetch` | Backend not running | Run `python src/backend.py` |
| `FileNotFoundError: claude` | Claude Code not in PATH | Use `claude.cmd` on Windows |
| `Could not parse response` | Claude returned no JSON | Check backend terminal logs, temp file prompt may be empty |
| `Objects are not valid as React child` | Raw entry has unexpected shape | `runDiscovery` maps defensively with `?? defaults` |
| `No such file or directory: data.json` | Library never populated | `/api/library` returns `[]` if file missing — fixed with `os.path.exists` check |
| White screen in browser | React render crash | Press F12 → Console tab for the real error |
| Vite config TypeScript error on `tailwindcss()` | Two Vite versions installed | `Remove-Item -Recurse -Force node_modules` in both project and parent folder, then `npm install` |
| PowerShell `rmdir /s /q` fails | Wrong shell syntax | Use `Remove-Item -Recurse -Force node_modules` |

---

## Claude Code CLI Notes

- Installed globally: `npm install -g @anthropic-ai/claude-code`
- Auth: run `claude` once to log in with your Anthropic account
- Uses Pro/Max subscription — **no separate API credits needed**
- On Windows: always call `claude.cmd` not `claude` in subprocess
- Always pass long prompts via `@tempfile` not inline — Windows truncates CLI args
- Defaults to markdown output — use the two-call pattern to reliably get JSON

---

## Roadmap

### Tool 1 — Media Discovery ✅ (current)
- Claude-powered multilingual discovery
- Deduplicated media library
- Status workflow: New → Reviewed → Approved → Rejected

### Tool 2 — Transcript Ingestion (next)
- YouTube URL → Whisper transcript via OpenClaw
- Chunked storage with timestamps
- Link transcripts to Media Library entries

### Tool 3 — Islamic Finance Moments
- Vector search over transcript chunks
- Find timestamped moments about riba, sukuk, zakat, etc.
- Export clips with context

---

## Code Quality Rules (non-negotiable per @Tariq)

1. TypeScript strict mode — no `any`, no `@ts-ignore` without comment
2. No API calls inside React components — use hooks and services
3. All async functions must handle errors with try/catch
4. All props must have explicit TypeScript interfaces
5. Use `!= null` checks not truthy checks for nullable values
6. Meaningful function names — `deduplicateEntries()` not `dedup()`
7. PRs reviewed by CodeRabbit before merge
8. CI must pass (typecheck + lint) before any merge to main