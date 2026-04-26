"""
backend.py — Islamic Media Discovery System
Tool 1: Media Discovery (Anthropic API direct)
Tool 2: Transcript Acquisition (youtube-transcript-api) + Vector Search (numpy cosine similarity)

Dependencies:
    pip install flask flask-cors youtube-transcript-api numpy requests anthropic python-dotenv
"""

import os
import re
import json
import math
from typing import Optional

import numpy as np
from flask import Flask, jsonify, request
from flask_cors import CORS
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound

app = Flask(__name__)
CORS(app)

# ─────────────────────────────────────────────
# FILE PATHS (acts as a simple file-based database for MVP)
# ─────────────────────────────────────────────

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
os.makedirs(DATA_DIR, exist_ok=True)

DATA_FILE = os.path.join(DATA_DIR, "data.json")
TRANSCRIPTS_FILE = os.path.join(DATA_DIR, "transcripts.json")
CHUNKS_FILE = os.path.join(DATA_DIR, "chunks.json")
EMBEDDINGS_FILE = os.path.join(DATA_DIR, "embeddings.json")


# ─────────────────────────────────────────────
# HELPERS — file-based storage
# ─────────────────────────────────────────────

def read_json(path: str, default):
    """Read a JSON file, returning default if missing or malformed."""
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return default


def write_json(path: str, data) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def run_claude(prompt: str) -> tuple[bool, str]:
    """
    Call Claude via CLI from a neutral temp directory to avoid project context.
    Always writes prompt to a temp file and pipes it in to avoid Windows arg limits.
    Returns (success, output_text).
    """
    import tempfile, subprocess
    tmp = os.path.join(tempfile.gettempdir(), "claude_prompt.txt")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(prompt)
        result = subprocess.run(
            f'type "{tmp}" | claude.cmd -p --output-format text --allowedTools "WebSearch,WebFetch"',
            shell=True,
            capture_output=True,
            timeout=600,
            cwd=tempfile.gettempdir(),
        )
        stdout = result.stdout.decode("utf-8", errors="replace")
        stderr = result.stderr.decode("utf-8", errors="replace")
        if result.returncode != 0:
            print(f"[Claude CLI] stderr: {stderr[:500]}")
        return result.returncode == 0, stdout
    except Exception as e:
        print(f"[Claude CLI] error: {e}")
        return False, str(e)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def extract_json_array(text: Optional[str]) -> Optional[list]:
    """Extract the first JSON array from a string, tolerating surrounding text."""
    if not text:
        return None
    # Strip markdown code fences first
    cleaned = re.sub(r"```(?:json)?\s*", "", text).strip()

    # Try direct parse first
    try:
        result = json.loads(cleaned)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        pass

    # Find the outermost balanced [ ... ] by tracking bracket depth
    start = cleaned.find("[")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(cleaned)):
        c = cleaned[i]
        if escape:
            escape = False
            continue
        if c == "\\":
            escape = True
            continue
        if c == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                candidate = cleaned[start : i + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError:
                    return None
    return None


# ─────────────────────────────────────────────
# TOOL 1 — Media Discovery
# ─────────────────────────────────────────────

@app.route("/api/discovery/run", methods=["POST"])
def run_discovery():
    body = request.get_json()
    user_topic = body.get("message", "historical Muslim TV shows and movies")

    # Call 1: Multi-query web research (PAI ClaudeResearch pattern)
    # Decompose the topic into targeted sub-queries for comprehensive coverage
    current_year = 2026
    prompt1 = f"""You are a research agent. Your task is to find REAL Muslim-themed movies, TV series, YouTube shows and documentaries related to: {user_topic}

## STEP 1: Execute these WebSearch queries (you MUST call WebSearch for each one)

1. WebSearch: "{user_topic} list"
2. WebSearch: "best Muslim movies TV shows {current_year}"
3. WebSearch: "Islamic historical drama series recommendations"
4. WebSearch: "{user_topic} documentary film"
5. WebSearch: "{user_topic} YouTube channel"
6. WebSearch: "Muslim themed movies IMDB list"

## STEP 2: Compile findings

After searching, compile a list of 10-15 REAL titles that appeared in your search results.

CRITICAL RULES:
- ONLY include titles you actually found in search results
- Do NOT fabricate or hallucinate any titles
- Include the source URL where you found each title
- If a search returns no useful results, skip it and move on

## STEP 3: Format output

For each title found, include:
- Title (English and original language if different)
- Type: movie / tv_series / youtube_show / documentary
- Year
- Language
- Brief description (from search results)
- Source URL where you found it
- Relevance to the topic (high/medium/low)"""

    success, raw = run_claude(prompt1)
    if not success:
        return jsonify({"error": f"Claude CLI error on discovery: {raw[:300]}"}), 500

    if not raw.strip():
        return jsonify({"error": "Claude CLI returned empty output"}), 500

    # Try JSON directly in case Claude returned it
    direct = extract_json_array(raw)
    if direct is not None:
        return jsonify({"text": json.dumps(direct)})

    # Call 2: Convert markdown to JSON
    prompt2 = f"""Convert the following text into a JSON array. Return ONLY the raw JSON array. No markdown, no code fences, no explanation. Start with [ and end with ].

Example format for one entry:
[{{"title_en": "Example Title", "title_ar": null, "title_ur": null, "title_tr": null, "type": "documentary", "language": "English", "year": 2019, "description": "A short description.", "tags": ["tag1"], "source_urls": [], "islamic_finance_relevance": "high", "notes": ""}}]

Here is the text to convert:

{raw}"""

    success2, raw2 = run_claude(prompt2)
    if not success2:
        return jsonify({"error": f"Claude CLI error on conversion: {raw2[:300]}"}), 500

    result = extract_json_array(raw2)
    if result is None:
        print(f"[Parse fail] raw2 starts with: {raw2[:500]}")
        return jsonify({"error": f"Could not parse JSON. First 300 chars: {raw2[:300]}"}), 500

    return jsonify({"text": json.dumps(result)})


@app.route("/api/library", methods=["GET"])
def get_library():
    return jsonify(read_json(DATA_FILE, []))


@app.route("/api/library", methods=["POST"])
def save_library():
    """Persist the full library from the frontend."""
    entries = request.get_json()
    write_json(DATA_FILE, entries)
    return jsonify({"ok": True})


# ─────────────────────────────────────────────
# TOOL 2a — YouTube Transcript Acquisition
# ─────────────────────────────────────────────

def extract_youtube_id(url: str) -> Optional[str]:
    """Extract YouTube video ID from various URL formats."""
    patterns = [
        r"(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})",
        r"(?:embed/)([A-Za-z0-9_-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def chunk_transcript(segments: list, chunk_size: int = 300) -> list:
    """
    Chunk transcript segments into ~chunk_size word blocks with timestamps.
    Returns list of { text, start_time, end_time, word_count }.
    """
    chunks = []
    current_words = []
    current_start = 0.0
    current_end = 0.0

    for seg in segments:
        words = seg.get("text", "").split()
        if not current_words:
            current_start = seg.get("start", 0.0)

        current_words.extend(words)
        current_end = seg.get("start", 0.0) + seg.get("duration", 0.0)

        if len(current_words) >= chunk_size:
            chunks.append({
                "text": " ".join(current_words),
                "start_time": current_start,
                "end_time": current_end,
                "word_count": len(current_words),
            })
            current_words = []
            current_start = current_end

    # Flush remaining words
    if current_words:
        chunks.append({
            "text": " ".join(current_words),
            "start_time": current_start,
            "end_time": current_end,
            "word_count": len(current_words),
        })

    return chunks


@app.route("/api/transcripts/fetch", methods=["POST"])
def fetch_transcript():
    """
    Fetch a YouTube transcript for a media library entry.

    Request body:
    {
      "media_id": "abc123",
      "youtube_url": "https://youtube.com/watch?v=...",
      "title": "Entry title for reference"
    }
    """
    body = request.get_json()
    media_id = body.get("media_id")
    youtube_url = body.get("youtube_url", "")
    title = body.get("title", "")

    if not media_id or not youtube_url:
        return jsonify({"error": "media_id and youtube_url are required"}), 400

    video_id = extract_youtube_id(youtube_url)
    if not video_id:
        return jsonify({"error": "Could not extract YouTube video ID from URL"}), 400

    transcripts = read_json(TRANSCRIPTS_FILE, [])
    chunks_store = read_json(CHUNKS_FILE, [])

    # Check if already transcribed
    existing = next((t for t in transcripts if t["media_id"] == media_id), None)
    if existing and existing["status"] == "Transcribed":
        return jsonify({"ok": True, "transcript": existing, "cached": True})

    # Attempt to fetch captions via youtube-transcript-api (v1.x instance API)
    ytt = YouTubeTranscriptApi()
    try:
        # Try English first, then any available language
        try:
            transcript_data = ytt.fetch(video_id, languages=["en", "en-US", "en-GB"])
            segments = [{"text": s.text, "start": s.start, "duration": s.duration} for s in transcript_data]
            transcript_source = "captions_en"
        except NoTranscriptFound:
            transcript_list = ytt.list(video_id)
            # Try auto-generated captions
            transcript = transcript_list.find_generated_transcript(
                ["en", "ar", "ur", "tr", "fr"]
            )
            fetched = transcript.fetch()
            segments = [{"text": s.text, "start": s.start, "duration": s.duration} for s in fetched]
            transcript_source = f"auto_{transcript.language_code}"

        full_text = " ".join(seg.get("text", "") for seg in segments)
        chunks = chunk_transcript(segments)

        transcript_record = {
            "id": f"tr_{media_id}",
            "media_id": media_id,
            "title": title,
            "source_type": "YouTube",
            "source_url": youtube_url,
            "video_id": video_id,
            "transcript_text": full_text,
            "transcript_source": transcript_source,
            "segment_count": len(segments),
            "chunk_count": len(chunks),
            "has_timestamps": True,
            "status": "Transcribed",
            "notes": "",
            "created_at": __import__("datetime").datetime.utcnow().isoformat(),
        }

        # Remove any older chunks for this media entry before writing fresh ones.
        chunks_store = [chunk for chunk in chunks_store if chunk.get("media_id") != media_id]

        # Store chunk records with reference to transcript
        for i, chunk in enumerate(chunks):
            chunks_store.append({
                "id": f"chunk_{media_id}_{i}",
                "transcript_id": f"tr_{media_id}",
                "media_id": media_id,
                "title": title,
                "chunk_index": i,
                "text": chunk["text"],
                "start_time": chunk["start_time"],
                "end_time": chunk["end_time"],
                "word_count": chunk["word_count"],
                "embedding": None,  # populated by /api/embeddings/compute
            })

        # Remove old record if exists, add new
        transcripts = [t for t in transcripts if t["media_id"] != media_id]
        transcripts.append(transcript_record)

        write_json(TRANSCRIPTS_FILE, transcripts)
        write_json(CHUNKS_FILE, chunks_store)

        return jsonify({"ok": True, "transcript": transcript_record, "chunk_count": len(chunks)})

    except TranscriptsDisabled:
        record = {
            "id": f"tr_{media_id}",
            "media_id": media_id,
            "title": title,
            "source_type": "YouTube",
            "source_url": youtube_url,
            "video_id": video_id,
            "transcript_text": "",
            "transcript_source": "none",
            "segment_count": 0,
            "chunk_count": 0,
            "has_timestamps": False,
            "status": "Failed",
            "notes": "Transcripts are disabled for this video",
            "created_at": __import__("datetime").datetime.utcnow().isoformat(),
        }
        transcripts = [t for t in transcripts if t["media_id"] != media_id]
        transcripts.append(record)
        write_json(TRANSCRIPTS_FILE, transcripts)
        return jsonify({"ok": False, "error": "Transcripts disabled", "transcript": record})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/transcripts", methods=["GET"])
def get_transcripts():
    return jsonify(read_json(TRANSCRIPTS_FILE, []))


# ─────────────────────────────────────────────
# TOOL 2b — Embeddings + Vector Search
# ─────────────────────────────────────────────

def get_embedding(text: str) -> Optional[list]:
    """
    Get an embedding for a text using Claude to generate a semantic
    representation via a keyword extraction + TF-IDF-style vector.

    For MVP we use a lightweight approach:
    - Ask Claude to extract 20 key semantic concepts from the text
    - Build a sparse vector over a fixed vocabulary of Islamic finance terms
    - This avoids needing an external embeddings API

    In production, replace with:
    - OpenAI text-embedding-3-small (cheap, fast)
    - Cohere embed
    - sentence-transformers local model
    """
    # Islamic finance + media concept vocabulary (fixed dimension = len of this list)
    VOCAB = [
        "riba", "interest", "usury", "halal", "haram", "sharia", "islamic",
        "finance", "banking", "investment", "investing", "sukuk", "bond",
        "zakat", "charity", "waqf", "endowment", "mudarabah", "musharakah",
        "partnership", "profit", "sharing", "loss", "equity", "debt",
        "mortgage", "loan", "credit", "money", "wealth", "economy",
        "economic", "financial", "capital", "market", "trade", "commerce",
        "business", "entrepreneur", "startup", "fund", "asset", "property",
        "gold", "silver", "currency", "exchange", "tax", "government",
        "regulation", "compliance", "audit", "accounting", "ethics",
        "moral", "justice", "fair", "exploitation", "poor", "rich",
        "poverty", "inequality", "distribution", "community", "ummah",
        "quran", "hadith", "fiqh", "fatwa", "scholar", "ijtihad",
        "malaysia", "dubai", "saudi", "gulf", "middle east", "pakistan",
        "indonesia", "turkey", "documentary", "film", "series", "show",
    ]

    text_lower = text.lower()
    vector = []
    for term in VOCAB:
        # Count occurrences, normalize by text length
        count = text_lower.count(term)
        tf = count / max(len(text_lower.split()), 1)
        vector.append(tf)

    # L2 normalize
    norm = math.sqrt(sum(x * x for x in vector))
    if norm == 0:
        return vector
    return [x / norm for x in vector]


def cosine_similarity(a: list, b: list) -> float:
    """Compute cosine similarity between two vectors."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


@app.route("/api/embeddings/compute", methods=["POST"])
def compute_embeddings():
    """
    Compute and store embeddings for all chunks that don't have one yet.
    This should be called after transcripts are fetched.
    """
    chunks = read_json(CHUNKS_FILE, [])
    updated = 0

    for chunk in chunks:
        if chunk.get("embedding") is None and chunk.get("text"):
            chunk["embedding"] = get_embedding(chunk["text"])
            updated += 1

    write_json(CHUNKS_FILE, chunks)
    return jsonify({"ok": True, "chunks_embedded": updated, "total_chunks": len(chunks)})


@app.route("/api/search/moments", methods=["POST"])
def search_moments():
    """
    Vector search over transcript chunks for Islamic finance moments.

    Request body:
    {
      "query": "riba and interest prohibition",
      "top_k": 20,
      "min_score": 0.1
    }

    Returns top matching chunks with similarity scores and context.
    """
    body = request.get_json()
    query = body.get("query", "Islamic finance")
    top_k = body.get("top_k", 20)
    min_score = body.get("min_score", 0.05)

    chunks = read_json(CHUNKS_FILE, [])

    # Filter to only embedded chunks
    embedded_chunks = [c for c in chunks if c.get("embedding") is not None]

    if not embedded_chunks:
        return jsonify({
            "moments": [],
            "message": "No embedded chunks found. Run /api/embeddings/compute first."
        })

    # Compute query embedding
    query_embedding = get_embedding(query)

    # Score all chunks
    scored = []
    for chunk in embedded_chunks:
        score = cosine_similarity(query_embedding, chunk["embedding"])
        if score >= min_score:
            scored.append({
                "chunk_id": chunk["id"],
                "transcript_id": chunk["transcript_id"],
                "media_id": chunk["media_id"],
                "title": chunk.get("title", ""),
                "text": chunk["text"],
                "start_time": chunk.get("start_time"),
                "end_time": chunk.get("end_time"),
                "similarity_score": round(score, 4),
                "confidence": "high" if score > 0.4 else "medium" if score > 0.2 else "low",
                "review_status": "New",
            })

    # Sort by score descending, take top_k
    scored.sort(key=lambda x: x["similarity_score"], reverse=True)
    top_results = scored[:top_k]

    # Use Claude to generate "why this matches" explanation for top 5
    if top_results:
        explain_prompt = f"""For each of these transcript excerpts, write a single sentence explaining why it is relevant to: "{query}"

Return ONLY a JSON array of strings (one explanation per excerpt), in the same order.

Excerpts:
{json.dumps([r["text"][:300] for r in top_results[:5]])}"""

        success, explain_raw = run_claude(explain_prompt)
        if success:
            explanations = extract_json_array(explain_raw)
            if explanations:
                for i, explanation in enumerate(explanations[:5]):
                    top_results[i]["explanation"] = explanation

    return jsonify({
        "moments": top_results,
        "query": query,
        "total_chunks_searched": len(embedded_chunks),
        "matches_found": len(scored),
    })


# ─────────────────────────────────────────────
# YouTube Search (via yt-dlp, no API key needed)
# ─────────────────────────────────────────────

@app.route("/api/youtube/search", methods=["POST"])
def youtube_search():
    """Search YouTube for a title and return the top result URL."""
    import subprocess as sp

    body = request.get_json()
    title = body.get("title", "").strip()
    media_type = body.get("type", "")
    if not title:
        return jsonify({"error": "title is required"}), 400

    query = f"{title} {media_type}".strip()
    try:
        result = sp.run(
            ["yt-dlp", f"ytsearch1:{query}", "--dump-json", "--no-download", "--flat-playlist"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return jsonify({"error": "yt-dlp search failed", "details": result.stderr[:300]}), 500

        data = json.loads(result.stdout)
        video_id = data.get("id", "")
        video_url = f"https://www.youtube.com/watch?v={video_id}" if video_id else ""
        return jsonify({
            "url": video_url,
            "title": data.get("title", ""),
            "video_id": video_id,
        })
    except sp.TimeoutExpired:
        return jsonify({"error": "YouTube search timed out"}), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────
# UTILITY ROUTES
# ─────────────────────────────────────────────

@app.route("/api/status", methods=["GET"])
def get_status():
    """Health check + counts for all databases."""
    library = read_json(DATA_FILE, [])
    transcripts = read_json(TRANSCRIPTS_FILE, [])
    chunks = read_json(CHUNKS_FILE, [])

    return jsonify({
        "ok": True,
        "library_count": len(library),
        "transcript_count": len(transcripts),
        "chunk_count": len(chunks),
        "embedded_chunk_count": sum(1 for c in chunks if c.get("embedding") is not None),
        "approved_count": sum(1 for e in library if e.get("status") == "Approved"),
        "transcribed_count": sum(1 for t in transcripts if t.get("status") == "Transcribed"),
    })


if __name__ == "__main__":
    app.run(port=5000, debug=True)
