/**
 * Islamic Media Discovery System
 * Tool 1: Media Discovery
 * Tool 2: Transcript Acquisition + Vector Search (Islamic Finance Moments)
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

type MediaType = "movie" | "tv_series" | "youtube_show" | "documentary" | "unknown";
type EntryStatus = "New" | "Reviewed" | "Approved" | "Rejected";
type MediaLanguage = "Arabic" | "English" | "Urdu" | "Turkish" | "Persian" | "French" | "Other";
type IslamicFinanceRelevance = "high" | "medium" | "low" | "none";
type SortKey = "discovered_at" | "title" | "relevance";
type TranscriptStatus = "Queued" | "Transcribed" | "Failed";
type MomentConfidence = "high" | "medium" | "low";
type MomentReviewStatus = "New" | "Approved" | "Rejected";

interface MediaEntry {
  id: string;
  title_en: string;
  title_ar: string | null;
  title_ur: string | null;
  title_tr: string | null;
  title_translation: string | null;
  type: MediaType;
  language: MediaLanguage;
  year: number | null;
  description: string | null;
  tags: string[];
  source_urls: string[];
  islamic_finance_relevance: IslamicFinanceRelevance;
  status: EntryStatus;
  source_prompt: string;
  notes: string | null;
  discovered_at: string;
  updated_at: string | null;
  youtube_url?: string;
}

interface TranscriptRecord {
  id: string;
  media_id: string;
  title: string;
  source_type: "YouTube" | "Other";
  source_url: string;
  video_id: string;
  transcript_text: string;
  transcript_source: string;
  segment_count: number;
  chunk_count: number;
  has_timestamps: boolean;
  status: TranscriptStatus;
  notes: string;
  created_at: string;
}

interface Moment {
  chunk_id: string;
  transcript_id: string;
  media_id: string;
  title: string;
  text: string;
  start_time: number | null;
  end_time: number | null;
  similarity_score: number;
  confidence: MomentConfidence;
  explanation?: string;
  review_status: MomentReviewStatus;
}

interface SearchResult {
  moments: Moment[];
  query: string;
  total_chunks_searched: number;
  matches_found: number;
}

interface LibraryStats {
  total: number;
  byStatus: Record<EntryStatus, number>;
  byType: Record<MediaType, number>;
  highRelevance: number;
}

interface Filters {
  status: EntryStatus | "All";
  type: MediaType | "All";
  relevance: IslamicFinanceRelevance | "All";
  language: MediaLanguage | "All";
  search: string;
}

interface DiscoveryProgress {
  stage: "start" | "queries" | "discovery" | "done" | "error";
  message: string;
  queries?: string[];
}

interface DiscoveryResult {
  entries: MediaEntry[];
  queries: string[];
}

interface ClaudeResponseBody {
  text?: string;
  error?: string;
}

interface RawDiscoveryEntry {
  id?: string;
  title_en?: string;
  title?: string;
  title_ar?: string | null;
  title_ur?: string | null;
  title_tr?: string | null;
  title_translation?: string | null;
  type?: MediaType;
  language?: MediaLanguage;
  year?: number | null;
  description?: string | null;
  tags?: string[];
  source_urls?: string[];
  islamic_finance_relevance?: IslamicFinanceRelevance;
  notes?: string | null;
}

interface SystemStatus {
  ok: boolean;
  library_count: number;
  transcript_count: number;
  chunk_count: number;
  embedded_chunk_count: number;
  approved_count: number;
  transcribed_count: number;
}

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const API_BASE = "http://localhost:5000";

const STATUS_COLORS: Record<EntryStatus, string> = {
  New: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  Reviewed: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  Approved: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  Rejected: "bg-red-500/20 text-red-300 border-red-500/40",
};

const STATUS_FLOW: Record<EntryStatus, EntryStatus[]> = {
  New: ["Reviewed", "Rejected"],
  Reviewed: ["Approved", "Rejected"],
  Approved: ["Rejected"],
  Rejected: ["New"],
};

const TYPE_ICONS: Record<MediaType, string> = {
  movie: "🎬",
  tv_series: "📺",
  youtube_show: "▶️",
  documentary: "🎥",
  unknown: "❓",
};

const TYPE_LABELS: Record<MediaType, string> = {
  movie: "Movie",
  tv_series: "TV Series",
  youtube_show: "YouTube Show",
  documentary: "Documentary",
  unknown: "Unknown",
};

const RELEVANCE_ORDER: Record<IslamicFinanceRelevance, number> = {
  high: 0, medium: 1, low: 2, none: 3,
};

const TRANSCRIPT_STATUS_COLORS: Record<TranscriptStatus, string> = {
  Queued: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  Transcribed: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  Failed: "bg-red-500/20 text-red-300 border-red-500/40",
};

const CONFIDENCE_COLORS: Record<MomentConfidence, string> = {
  high: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  medium: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  low: "bg-zinc-500/20 text-zinc-400 border-zinc-500/40",
};

const EXAMPLE_PROMPTS: string[] = [
  "Islamic finance in media",
  "Movies about Islamic banking and halal investing",
  "Series discussing riba and Islamic economics",
  "Documentaries on sukuk and Islamic finance",
  "Muslim-themed financial literacy content",
];

const IF_SEARCH_PROMPTS: string[] = [
  "riba and interest prohibition",
  "halal investing and stock screening",
  "sukuk Islamic bonds",
  "zakat wealth distribution",
  "mudarabah profit sharing",
  "Islamic banking alternatives",
];

const FILTER_OPTIONS: Record<keyof Omit<Filters, "search">, string[]> = {
  status: ["All", "New", "Reviewed", "Approved", "Rejected"],
  type: ["All", "movie", "tv_series", "youtube_show", "documentary", "unknown"],
  relevance: ["All", "high", "medium", "low", "none"],
  language: ["All", "Arabic", "English", "Urdu", "Turkish", "Persian", "French", "Other"],
};

const TABS = [
  { id: "search", label: "Search", icon: "🔍" },
  { id: "library", label: "Media Library", icon: "📚" },
  { id: "transcripts", label: "Transcripts", icon: "📄" },
  { id: "islamic_finance", label: "Islamic Finance", icon: "☪" },
];

// ─────────────────────────────────────────────
// SERVICES
// ─────────────────────────────────────────────

async function callBackend(path: string, body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json() as ClaudeResponseBody;

  if (!response.ok || data.error) {
    throw new Error(data.error ?? `Backend error ${response.status}`);
  }

  if (!data.text) throw new Error("Empty response from backend");
  return data.text;
}

function parseJsonResponse(raw: string): unknown {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  return JSON.parse(cleaned);
}

async function runDiscovery(
  prompt: string,
  onProgress: (p: DiscoveryProgress) => void
): Promise<DiscoveryResult> {
  onProgress({ stage: "discovery", message: "Asking Claude to find media…" });

  const text = await callBackend("/api/discovery/run", {
    system: "",
    message: prompt,
  });

  const parsed = parseJsonResponse(text);
  const rawEntries: RawDiscoveryEntry[] = Array.isArray(parsed) ? parsed : [];

  const entries: MediaEntry[] = rawEntries.map((e) => ({
    id: e.id ?? crypto.randomUUID(),
    title_en: e.title_en ?? e.title ?? "Untitled",
    title_ar: e.title_ar ?? null,
    title_ur: e.title_ur ?? null,
    title_tr: e.title_tr ?? null,
    title_translation: e.title_translation ?? null,
    type: e.type ?? "unknown",
    language: e.language ?? "Other",
    year: e.year ?? null,
    description: e.description ?? null,
    tags: Array.isArray(e.tags) ? e.tags : [],
    source_urls: Array.isArray(e.source_urls) ? e.source_urls : [],
    islamic_finance_relevance: e.islamic_finance_relevance ?? "none",
    notes: e.notes ?? null,
    status: "New",
    source_prompt: prompt,
    discovered_at: new Date().toISOString(),
    updated_at: null,
    youtube_url: "",
  }));

  // Auto-search YouTube for each entry
  for (let i = 0; i < entries.length; i++) {
    onProgress({ stage: "discovery", message: `Searching YouTube (${i + 1}/${entries.length}): ${entries[i].title_en}` });
    try {
      const yt = await searchYouTube(entries[i].title_en, entries[i].type);
      if (yt.url) entries[i].youtube_url = yt.url;
    } catch {
      // Skip — user can add URL manually
    }
  }

  return { entries, queries: [] };
}

async function fetchTranscript(
  mediaId: string,
  youtubeUrl: string,
  title: string
): Promise<TranscriptRecord> {
  const response = await fetch(`${API_BASE}/api/transcripts/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ media_id: mediaId, youtube_url: youtubeUrl, title }),
  });
  const data = await response.json() as { ok: boolean; transcript: TranscriptRecord; error?: string };
  if (!data.transcript) throw new Error(data.error ?? "No transcript returned");
  return data.transcript;
}

async function computeEmbeddings(): Promise<{ chunks_embedded: number }> {
  const response = await fetch(`${API_BASE}/api/embeddings/compute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return response.json() as Promise<{ chunks_embedded: number }>;
}

async function searchYouTube(title: string, type: string): Promise<{ url: string; title: string; video_id: string }> {
  const response = await fetch(`${API_BASE}/api/youtube/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, type }),
  });
  const data = await response.json() as { url: string; title: string; video_id: string; error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? "YouTube search failed");
  return data;
}

async function searchMoments(query: string, topK = 20): Promise<SearchResult> {
  const response = await fetch(`${API_BASE}/api/search/moments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, top_k: topK, min_score: 0.05 }),
  });
  return response.json() as Promise<SearchResult>;
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────

function normalizeTitle(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function deduplicateEntries(existing: MediaEntry[], incoming: MediaEntry[]): MediaEntry[] {
  const byKey = new Map<string, MediaEntry>(existing.map((e) => [normalizeTitle(e.title_en), e]));
  for (const entry of incoming) {
    const key = normalizeTitle(entry.title_en);
    if (!byKey.has(key)) {
      byKey.set(key, entry);
    } else {
      const prev = byKey.get(key) as MediaEntry;
      byKey.set(key, {
        ...prev,
        tags: [...new Set([...prev.tags, ...entry.tags])],
        source_urls: [...new Set([...prev.source_urls, ...entry.source_urls])],
        notes: prev.notes ?? entry.notes,
      });
    }
  }
  return Array.from(byKey.values());
}

function formatTime(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─────────────────────────────────────────────
// HOOKS
// ─────────────────────────────────────────────

function useMediaLibrary() {
  const [entries, setEntries] = useState<MediaEntry[]>([]);

  const addEntries = useCallback((newEntries: MediaEntry[]) => {
    setEntries((prev) => deduplicateEntries(prev, newEntries));
  }, []);

  const updateStatus = useCallback((id: string, status: EntryStatus) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status, updated_at: new Date().toISOString() } : e))
    );
  }, []);

  const updateNotes = useCallback((id: string, notes: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, notes } : e)));
  }, []);

  const updateYoutubeUrl = useCallback((id: string, youtube_url: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, youtube_url } : e)));
  }, []);

  const stats = useMemo<LibraryStats>(() => ({
    total: entries.length,
    byStatus: {
      New: entries.filter((e) => e.status === "New").length,
      Reviewed: entries.filter((e) => e.status === "Reviewed").length,
      Approved: entries.filter((e) => e.status === "Approved").length,
      Rejected: entries.filter((e) => e.status === "Rejected").length,
    },
    byType: {
      movie: entries.filter((e) => e.type === "movie").length,
      tv_series: entries.filter((e) => e.type === "tv_series").length,
      youtube_show: entries.filter((e) => e.type === "youtube_show").length,
      documentary: entries.filter((e) => e.type === "documentary").length,
      unknown: entries.filter((e) => e.type === "unknown").length,
    },
    highRelevance: entries.filter((e) => e.islamic_finance_relevance === "high").length,
  }), [entries]);

  return { entries, addEntries, updateStatus, updateNotes, updateYoutubeUrl, stats };
}

function useDiscovery(onEntriesFound: (entries: MediaEntry[]) => void) {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<DiscoveryProgress | null>(null);
  const [lastResult, setLastResult] = useState<DiscoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(false);

  const run = useCallback(async (prompt: string) => {
    if (!prompt.trim()) return;
    abortRef.current = false;
    setIsRunning(true);
    setError(null);
    setProgress({ stage: "start", message: "Initializing discovery…" });

    try {
      const result = await runDiscovery(prompt.trim(), (p) => {
        if (!abortRef.current) setProgress(p);
      });
      if (!abortRef.current) {
        setLastResult(result);
        onEntriesFound(result.entries);
        setProgress({ stage: "done", message: `Found ${result.entries.length} entries.` });
      }
    } catch (err) {
      if (!abortRef.current) setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (!abortRef.current) setIsRunning(false);
    }
  }, [onEntriesFound]);

  const cancel = useCallback(() => {
    abortRef.current = true;
    setIsRunning(false);
    setProgress(null);
  }, []);

  return { run, cancel, isRunning, progress, lastResult, error };
}

// ─────────────────────────────────────────────
// SHARED UI PRIMITIVES
// ─────────────────────────────────────────────

function GeometricBackground() {
  return (
    <svg className="fixed inset-0 w-full h-full pointer-events-none opacity-[0.04]" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="islamic-geo" x="0" y="0" width="80" height="80" patternUnits="userSpaceOnUse">
          <polygon points="40,4 76,22 76,58 40,76 4,58 4,22" fill="none" stroke="#C9A227" strokeWidth="0.8" />
          <polygon points="40,14 66,28 66,52 40,66 14,52 14,28" fill="none" stroke="#C9A227" strokeWidth="0.5" />
          <line x1="40" y1="4" x2="40" y2="76" stroke="#C9A227" strokeWidth="0.3" />
          <line x1="4" y1="22" x2="76" y2="58" stroke="#C9A227" strokeWidth="0.3" />
          <line x1="76" y1="22" x2="4" y2="58" stroke="#C9A227" strokeWidth="0.3" />
          <circle cx="40" cy="40" r="3" fill="none" stroke="#C9A227" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#islamic-geo)" />
    </svg>
  );
}

function StatusBadge({ status }: { status: EntryStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${STATUS_COLORS[status]}`}>
      {status}
    </span>
  );
}

function RelevanceDot({ level }: { level: IslamicFinanceRelevance }) {
  const colors: Record<IslamicFinanceRelevance, string> = { high: "bg-emerald-400", medium: "bg-amber-400", low: "bg-zinc-400", none: "bg-zinc-600" };
  const labels: Record<IslamicFinanceRelevance, string> = { high: "High IF relevance", medium: "Medium", low: "Low", none: "Not relevant" };
  return (
    <span className="flex items-center gap-1.5 text-xs text-zinc-400">
      <span className={`w-2 h-2 rounded-full ${colors[level]}`} />
      {labels[level]}
    </span>
  );
}

function Spinner() {
  return (
    <span className="relative flex h-3 w-3">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
    </span>
  );
}

// ─────────────────────────────────────────────
// ENTRY CARD (Library)
// ─────────────────────────────────────────────

interface EntryCardProps {
  entry: MediaEntry;
  onStatusChange: (id: string, status: EntryStatus) => void;
  onNotesChange: (id: string, notes: string) => void;
  onYoutubeUrlChange: (id: string, url: string) => void;
}

function EntryCard({ entry, onStatusChange, onNotesChange, onYoutubeUrlChange }: EntryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [noteDraft, setNoteDraft] = useState(entry.notes ?? "");
  const [urlDraft, setUrlDraft] = useState(entry.youtube_url ?? "");
  const nextStatuses = STATUS_FLOW[entry.status] ?? [];

  return (
    <div className="group rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] transition-all duration-200 overflow-hidden" style={{ backdropFilter: "blur(8px)" }}>
      <div className="p-4 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <span className="text-2xl mt-0.5 shrink-0">{TYPE_ICONS[entry.type]}</span>
            <div className="min-w-0">
              <h3 className="font-semibold text-[#F5F0E8] leading-tight truncate" style={{ fontFamily: "'Cormorant Garamond', serif" }}>
                {entry.title_en || "Untitled"}
                {entry.year != null ? <span className="text-zinc-400 font-normal ml-2 text-sm">({entry.year})</span> : null}
              </h3>
              {entry.title_ar != null && (
                <p className="text-amber-200/70 text-sm mt-0.5" style={{ fontFamily: "'Scheherazade New', serif", direction: "rtl" }}>{entry.title_ar}</p>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className="text-xs text-zinc-400 bg-white/[0.05] px-2 py-0.5 rounded-full border border-white/[0.08]">{TYPE_LABELS[entry.type]}</span>
                <span className="text-xs text-zinc-400 bg-white/[0.05] px-2 py-0.5 rounded-full border border-white/[0.08]">{entry.language}</span>
                <RelevanceDot level={entry.islamic_finance_relevance} />
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <StatusBadge status={entry.status} />
            <span className="text-zinc-600 group-hover:text-zinc-400 transition-colors text-xs">{expanded ? "▲ less" : "▼ more"}</span>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-white/[0.06] pt-3 space-y-3">
          {entry.description != null && <p className="text-sm text-zinc-300 leading-relaxed">{entry.description}</p>}

          {/* YouTube URL input */}
          <div>
            <span className="text-xs text-zinc-500 block mb-1">YouTube URL (for transcription)</span>
            <div className="flex gap-2">
              <input
                type="url"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="https://youtube.com/watch?v=..."
                className="flex-1 text-xs bg-white/[0.05] border border-white/[0.1] rounded px-2 py-1.5 text-zinc-300 focus:outline-none focus:border-amber-500/40"
              />
              <button
                onClick={(e) => { e.stopPropagation(); onYoutubeUrlChange(entry.id, urlDraft); }}
                className="text-xs px-3 py-1.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 transition-all"
              >
                Save
              </button>
            </div>
            {entry.youtube_url && <p className="text-xs text-emerald-400/70 mt-1">✓ URL saved</p>}
          </div>

          {entry.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {entry.tags.map((tag) => (
                <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300/70 border border-amber-500/20">#{tag}</span>
              ))}
            </div>
          )}

          {/* Notes */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-500">Notes</span>
              <button onClick={(e) => { e.stopPropagation(); setEditingNotes((v) => !v); }} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                {editingNotes ? "✓ done" : "✏ edit"}
              </button>
            </div>
            {editingNotes ? (
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onBlur={() => { onNotesChange(entry.id, noteDraft); setEditingNotes(false); }}
                onClick={(e) => e.stopPropagation()}
                rows={2}
                className="w-full text-xs bg-white/[0.05] border border-white/[0.1] rounded px-2 py-1.5 text-zinc-300 resize-none focus:outline-none focus:border-amber-500/40"
                placeholder="Add reviewer notes…"
              />
            ) : (
              <p className="text-xs text-zinc-400 italic">{noteDraft || "No notes."}</p>
            )}
          </div>

          {nextStatuses.length > 0 && (
            <div className="flex gap-2 pt-1">
              {nextStatuses.map((s) => (
                <button key={s} onClick={(e) => { e.stopPropagation(); onStatusChange(entry.id, s); }} className={`text-xs px-3 py-1 rounded-full border transition-all hover:scale-105 ${STATUS_COLORS[s]}`}>
                  Mark as {s}
                </button>
              ))}
            </div>
          )}

          <p className="text-xs text-zinc-600">Discovered: {new Date(entry.discovered_at).toLocaleString()}</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// SEARCH TAB
// ─────────────────────────────────────────────

function SearchTab({ onEntriesFound }: { onEntriesFound: (entries: MediaEntry[]) => void }) {
  const [prompt, setPrompt] = useState("");
  const { run, cancel, isRunning, progress, lastResult, error } = useDiscovery(onEntriesFound);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold text-[#F5F0E8]" style={{ fontFamily: "'Cormorant Garamond', serif" }}>Media Discovery</h2>
        <p className="text-zinc-400 text-sm">Claude will find Muslim-themed media related to your prompt</p>
      </div>

      <div className="relative">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) run(prompt); }}
          placeholder={`Enter a discovery prompt, e.g. "Islamic finance in media"…`}
          rows={3}
          className="w-full bg-white/[0.04] border border-white/[0.1] rounded-xl px-4 py-3 text-[#F5F0E8] placeholder-zinc-600 text-sm resize-none focus:outline-none focus:border-amber-500/50 transition-colors"
          style={{ backdropFilter: "blur(8px)" }}
        />
        <div className="absolute bottom-3 right-3 flex gap-2">
          {isRunning ? (
            <button onClick={cancel} className="px-4 py-1.5 rounded-lg bg-red-500/20 border border-red-500/30 text-red-400 text-xs font-medium hover:bg-red-500/30 transition-all">Cancel</button>
          ) : (
            <button onClick={() => { if (prompt.trim()) run(prompt); }} disabled={!prompt.trim()} className="px-4 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-medium hover:bg-amber-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
              Run Discovery ⌘↵
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {EXAMPLE_PROMPTS.map((p) => (
          <button key={p} onClick={() => setPrompt(p)} className="text-xs px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:border-amber-500/30 transition-all">{p}</button>
        ))}
      </div>

      {isRunning && progress != null && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 flex items-center gap-3">
          <Spinner />
          <span className="text-amber-300 text-sm">{progress.message}</span>
        </div>
      )}

      {error != null && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-red-400 text-sm font-medium">Discovery failed</p>
          <p className="text-red-300/70 text-xs mt-1">{error}</p>
        </div>
      )}

      {lastResult != null && !isRunning && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-1">
          <p className="text-emerald-400 text-sm font-medium">✓ Discovery complete — {lastResult.entries.length} entries added to library</p>
          <p className="text-zinc-400 text-xs">Go to the Media Library tab to review and approve items for transcription.</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// LIBRARY TAB
// ─────────────────────────────────────────────

interface LibraryTabProps {
  entries: MediaEntry[];
  stats: LibraryStats;
  onStatusChange: (id: string, status: EntryStatus) => void;
  onNotesChange: (id: string, notes: string) => void;
  onYoutubeUrlChange: (id: string, url: string) => void;
}

function LibraryTab({ entries, stats, onStatusChange, onNotesChange, onYoutubeUrlChange }: LibraryTabProps) {
  const [filters, setFilters] = useState<Filters>({ status: "All", type: "All", relevance: "All", language: "All", search: "" });
  const [sortBy, setSortBy] = useState<SortKey>("discovered_at");

  const setFilter = (key: keyof Filters, val: string) => setFilters((f) => ({ ...f, [key]: val }));

  const filtered = useMemo<MediaEntry[]>(() => {
    return entries
      .filter((e) => {
        if (filters.status !== "All" && e.status !== filters.status) return false;
        if (filters.type !== "All" && e.type !== filters.type) return false;
        if (filters.relevance !== "All" && e.islamic_finance_relevance !== filters.relevance) return false;
        if (filters.language !== "All" && e.language !== filters.language) return false;
        if (filters.search) {
          const q = filters.search.toLowerCase();
          return e.title_en?.toLowerCase().includes(q) || e.title_ar?.includes(filters.search) || e.description?.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q));
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "discovered_at") return new Date(b.discovered_at).getTime() - new Date(a.discovered_at).getTime();
        if (sortBy === "title") return (a.title_en ?? "").localeCompare(b.title_en ?? "");
        if (sortBy === "relevance") return (RELEVANCE_ORDER[a.islamic_finance_relevance] ?? 4) - (RELEVANCE_ORDER[b.islamic_finance_relevance] ?? 4);
        return 0;
      });
  }, [entries, filters, sortBy]);

  if (entries.length === 0) {
    return (
      <div className="text-center py-24 space-y-4">
        <p className="text-6xl">🕌</p>
        <p className="text-zinc-400">Your library is empty. Run a discovery search to populate it.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {([
          { label: "Total", value: stats.total, color: "text-[#F5F0E8]" },
          { label: "Approved", value: stats.byStatus.Approved, color: "text-emerald-400" },
          { label: "High IF Relevance", value: stats.highRelevance, color: "text-amber-400" },
          { label: "Pending Review", value: stats.byStatus.New, color: "text-blue-400" },
        ] as const).map(({ label, value, color }) => (
          <div key={label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-center">
            <p className={`text-2xl font-bold ${color}`} style={{ fontFamily: "'Cormorant Garamond', serif" }}>{value}</p>
            <p className="text-zinc-500 text-xs mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <input type="text" placeholder="Search titles, tags, descriptions…" value={filters.search} onChange={(e) => setFilter("search", e.target.value)} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-[#F5F0E8] placeholder-zinc-600 focus:outline-none focus:border-amber-500/40 transition-colors" />
        <div className="flex flex-wrap gap-2">
          {(Object.entries(FILTER_OPTIONS) as [keyof typeof FILTER_OPTIONS, string[]][]).map(([key, opts]) => (
            <select key={key} value={filters[key]} onChange={(e) => setFilter(key, e.target.value)} className="text-xs bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-zinc-300 focus:outline-none focus:border-amber-500/40 transition-colors cursor-pointer capitalize">
              {opts.map((o) => <option key={o} value={o} className="bg-[#0D2B1E]">{key === "type" ? (TYPE_LABELS[o as MediaType] ?? o) : o}</option>)}
            </select>
          ))}
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)} className="text-xs bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-zinc-300 focus:outline-none focus:border-amber-500/40 transition-colors cursor-pointer ml-auto">
            <option value="discovered_at" className="bg-[#0D2B1E]">Sort: Newest</option>
            <option value="title" className="bg-[#0D2B1E]">Sort: Title A–Z</option>
            <option value="relevance" className="bg-[#0D2B1E]">Sort: IF Relevance</option>
          </select>
        </div>
        <p className="text-xs text-zinc-600">Showing {filtered.length} of {entries.length} entries</p>
      </div>

      <div className="space-y-2">
        {filtered.map((entry) => (
          <EntryCard key={entry.id} entry={entry} onStatusChange={onStatusChange} onNotesChange={onNotesChange} onYoutubeUrlChange={onYoutubeUrlChange} />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// TRANSCRIPTS TAB
// ─────────────────────────────────────────────

function TranscriptsTab({ entries }: { entries: MediaEntry[] }) {
  const [transcripts, setTranscripts] = useState<TranscriptRecord[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [embeddingStatus, setEmbeddingStatus] = useState<string | null>(null);
  const [isEmbedding, setIsEmbedding] = useState(false);

  const approvedEntries = useMemo(
    () => entries.filter((e) => e.status === "Approved"),
    [entries]
  );

  useEffect(() => {
    fetch(`${API_BASE}/api/transcripts`)
      .then((r) => r.json())
      .then((data) => setTranscripts(data as TranscriptRecord[]))
      .catch(() => {});
  }, []);

  const getTranscriptFor = (mediaId: string) =>
    transcripts.find((t) => t.media_id === mediaId);

  const handleFetch = async (entry: MediaEntry) => {
    if (!entry.youtube_url) return;
    setLoading((prev) => ({ ...prev, [entry.id]: true }));
    try {
      const record = await fetchTranscript(entry.id, entry.youtube_url, entry.title_en);
      setTranscripts((prev) => {
        const filtered = prev.filter((t) => t.media_id !== entry.id);
        return [...filtered, record];
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to fetch transcript");
    } finally {
      setLoading((prev) => ({ ...prev, [entry.id]: false }));
    }
  };

  const handleComputeEmbeddings = async () => {
    setIsEmbedding(true);
    setEmbeddingStatus(null);
    try {
      const result = await computeEmbeddings();
      setEmbeddingStatus(`✓ Computed embeddings for ${result.chunks_embedded} chunks`);
    } catch {
      setEmbeddingStatus("Failed to compute embeddings");
    } finally {
      setIsEmbedding(false);
    }
  };

  const transcribedCount = transcripts.filter((t) => t.status === "Transcribed").length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-[#F5F0E8]" style={{ fontFamily: "'Cormorant Garamond', serif" }}>Transcripts</h2>
          <p className="text-zinc-400 text-sm mt-1">Fetch YouTube captions for Approved entries, then compute embeddings for vector search.</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-emerald-400" style={{ fontFamily: "'Cormorant Garamond', serif" }}>{transcribedCount}</p>
          <p className="text-zinc-500 text-xs">transcribed</p>
        </div>
      </div>

      {/* Compute embeddings action */}
      {transcribedCount > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-amber-300 text-sm font-medium">Step 2 — Compute Embeddings</p>
            <p className="text-zinc-400 text-xs mt-0.5">After fetching transcripts, compute embeddings to enable Islamic Finance vector search.</p>
            {embeddingStatus != null && <p className="text-emerald-400 text-xs mt-1">{embeddingStatus}</p>}
          </div>
          <button
            onClick={handleComputeEmbeddings}
            disabled={isEmbedding}
            className="shrink-0 px-4 py-2 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-medium hover:bg-amber-500/30 disabled:opacity-50 transition-all"
          >
            {isEmbedding ? "Computing…" : "Compute Embeddings"}
          </button>
        </div>
      )}

      {approvedEntries.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <p className="text-4xl">📋</p>
          <p className="text-zinc-400 text-sm">No approved entries yet.</p>
          <p className="text-zinc-600 text-xs">Go to Media Library → mark entries as Approved to queue them here.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {approvedEntries.map((entry) => {
            const transcript = getTranscriptFor(entry.id);
            const isLoading = loading[entry.id] ?? false;
            const hasUrl = Boolean(entry.youtube_url);

            return (
              <div key={entry.id} className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium text-[#F5F0E8] text-sm truncate" style={{ fontFamily: "'Cormorant Garamond', serif" }}>
                      {TYPE_ICONS[entry.type]} {entry.title_en}
                    </p>
                    {entry.youtube_url ? (
                      <a href={entry.youtube_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400/70 hover:text-blue-400 truncate block mt-0.5">
                        {entry.youtube_url}
                      </a>
                    ) : (
                      <p className="text-xs text-zinc-600 mt-0.5">No YouTube URL — add one in the Library tab</p>
                    )}
                    {transcript != null && (
                      <div className="flex items-center gap-3 mt-2">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${TRANSCRIPT_STATUS_COLORS[transcript.status]}`}>
                          {transcript.status}
                        </span>
                        {transcript.status === "Transcribed" && (
                          <span className="text-xs text-zinc-500">
                            {transcript.chunk_count} chunks · {transcript.has_timestamps ? "timestamps ✓" : "no timestamps"}
                          </span>
                        )}
                        {transcript.notes && <span className="text-xs text-red-400/70">{transcript.notes}</span>}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleFetch(entry)}
                    disabled={!hasUrl || isLoading}
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-medium hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    {isLoading ? "Fetching…" : transcript?.status === "Transcribed" ? "Re-fetch" : "Fetch Transcript"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// ISLAMIC FINANCE TAB — Vector Search
// ─────────────────────────────────────────────

function MomentCard({ moment, onReviewChange }: { moment: Moment; onReviewChange: (id: string, status: MomentReviewStatus) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] overflow-hidden">
      <div className="p-4 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${CONFIDENCE_COLORS[moment.confidence]}`}>
                {Math.round(moment.similarity_score * 100)}% match
              </span>
              <span className="text-xs text-zinc-500">{moment.title}</span>
              {moment.start_time != null && (
                <span className="text-xs text-zinc-600">{formatTime(moment.start_time)} – {formatTime(moment.end_time)}</span>
              )}
            </div>
            <p className="text-sm text-zinc-300 leading-relaxed line-clamp-2">{moment.text}</p>
            {moment.explanation && (
              <p className="text-xs text-amber-300/70 mt-1 italic">"{moment.explanation}"</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
              moment.review_status === "Approved" ? STATUS_COLORS.Approved :
              moment.review_status === "Rejected" ? STATUS_COLORS.Rejected :
              STATUS_COLORS.New
            }`}>{moment.review_status}</span>
            <span className="text-zinc-600 text-xs">{expanded ? "▲" : "▼"}</span>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-white/[0.06] pt-3 space-y-3">
          <p className="text-sm text-zinc-300 leading-relaxed">{moment.text}</p>
          <div className="flex gap-2">
            <button onClick={() => onReviewChange(moment.chunk_id, "Approved")} className={`text-xs px-3 py-1 rounded-full border transition-all ${STATUS_COLORS.Approved}`}>
              Approve
            </button>
            <button onClick={() => onReviewChange(moment.chunk_id, "Rejected")} className={`text-xs px-3 py-1 rounded-full border transition-all ${STATUS_COLORS.Rejected}`}>
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function IslamicFinanceTab() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setIsSearching(true);
    setError(null);
    try {
      const result = await searchMoments(query.trim());
      setResults(result);
      setMoments(result.moments);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setIsSearching(false);
    }
  };

  const handleReviewChange = (chunkId: string, status: MomentReviewStatus) => {
    setMoments((prev) => prev.map((m) => m.chunk_id === chunkId ? { ...m, review_status: status } : m));
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-[#F5F0E8]" style={{ fontFamily: "'Cormorant Garamond', serif" }}>Islamic Finance Moments</h2>
        <p className="text-zinc-400 text-sm mt-1">Semantic search across transcripts to find moments related to Islamic finance concepts.</p>
      </div>

      {/* Search input */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            placeholder={`e.g. "riba and interest prohibition"`}
            className="flex-1 bg-white/[0.04] border border-white/[0.1] rounded-xl px-4 py-3 text-[#F5F0E8] placeholder-zinc-600 text-sm focus:outline-none focus:border-amber-500/50 transition-colors"
          />
          <button
            onClick={handleSearch}
            disabled={!query.trim() || isSearching}
            className="px-5 py-3 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-300 text-sm font-medium hover:bg-amber-500/30 disabled:opacity-40 transition-all"
          >
            {isSearching ? "Searching…" : "Search"}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {IF_SEARCH_PROMPTS.map((p) => (
            <button key={p} onClick={() => setQuery(p)} className="text-xs px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:border-amber-500/30 transition-all">{p}</button>
          ))}
        </div>
      </div>

      {isSearching && (
        <div className="flex items-center gap-3 p-4 rounded-xl border border-amber-500/20 bg-amber-500/5">
          <Spinner />
          <span className="text-amber-300 text-sm">Searching {results?.total_chunks_searched ?? "…"} transcript chunks…</span>
        </div>
      )}

      {error != null && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-red-400 text-sm">{error}</p>
          <p className="text-red-300/50 text-xs mt-1">Make sure transcripts have been fetched and embeddings computed (Transcripts tab).</p>
        </div>
      )}

      {results != null && !isSearching && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-400">
              <span className="text-[#F5F0E8] font-medium">{results.matches_found}</span> matches found in <span className="text-[#F5F0E8] font-medium">{results.total_chunks_searched}</span> chunks
            </p>
            <div className="flex gap-3 text-xs text-zinc-500">
              <span>✓ Approved: {moments.filter((m) => m.review_status === "Approved").length}</span>
              <span>✗ Rejected: {moments.filter((m) => m.review_status === "Rejected").length}</span>
            </div>
          </div>

          {moments.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-zinc-500 text-sm">No matches found for "{results.query}"</p>
              <p className="text-zinc-600 text-xs mt-1">Try a different query or fetch more transcripts.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {moments.map((moment) => (
                <MomentCard key={moment.chunk_id} moment={moment} onReviewChange={handleReviewChange} />
              ))}
            </div>
          )}
        </div>
      )}

      {results == null && !isSearching && (
        <div className="text-center py-16 space-y-4">
          <p className="text-5xl">☪</p>
          <p className="text-zinc-400 text-sm">Enter a concept to search across all transcripts.</p>
          <p className="text-zinc-600 text-xs">Uses semantic similarity — finds relevant moments even without exact keyword matches.</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState("search");
  const { entries, addEntries, updateStatus, updateNotes, updateYoutubeUrl, stats } = useMediaLibrary();

  return (
    <div className="min-h-screen text-[#F5F0E8]" style={{ background: "linear-gradient(135deg, #071A11 0%, #0D2B1E 50%, #091612 100%)" }}>
      <GeometricBackground />
      <div className="relative z-10 max-w-4xl mx-auto px-4 pb-12">
        <header className="py-8 text-center space-y-2">
          <div className="flex justify-center items-center gap-3">
            <span className="text-3xl">☪</span>
            <h1 className="text-4xl font-bold tracking-tight" style={{ fontFamily: "'Cormorant Garamond', serif", background: "linear-gradient(90deg, #C9A227, #F5E6B0, #C9A227)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              Islamic Media Discovery
            </h1>
          </div>
          <p className="text-zinc-500 text-sm">Find · Transcribe · Search Muslim-themed media</p>
        </header>

        <nav className="flex gap-1 mb-8 p-1 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
          {TABS.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${activeTab === tab.id ? "bg-amber-500/15 text-amber-300 border border-amber-500/30 shadow-lg" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"}`}>
              <span>{tab.icon}</span>
              <span className="hidden sm:inline">{tab.label}</span>
              {tab.id === "library" && entries.length > 0 && (
                <span className="ml-1 text-xs bg-amber-500/30 text-amber-300 px-1.5 py-0.5 rounded-full">{entries.length}</span>
              )}
              {tab.id === "transcripts" && stats.byStatus.Approved > 0 && (
                <span className="ml-1 text-xs bg-emerald-500/30 text-emerald-300 px-1.5 py-0.5 rounded-full">{stats.byStatus.Approved}</span>
              )}
            </button>
          ))}
        </nav>

        <main>
          {activeTab === "search" && <SearchTab onEntriesFound={addEntries} />}
          {activeTab === "library" && <LibraryTab entries={entries} stats={stats} onStatusChange={updateStatus} onNotesChange={updateNotes} onYoutubeUrlChange={updateYoutubeUrl} />}
          {activeTab === "transcripts" && <TranscriptsTab entries={entries} />}
          {activeTab === "islamic_finance" && <IslamicFinanceTab />}
        </main>

        <footer className="mt-16 text-center text-xs text-zinc-700 space-y-1">
          <p>Islamic Media Discovery System · Tool 1 + Tool 2</p>
          <p>React · TypeScript · Python Flask · Claude Code CLI</p>
        </footer>
      </div>
    </div>
  );
}