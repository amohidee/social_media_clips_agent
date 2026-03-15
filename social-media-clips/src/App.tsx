/**
 * Islamic Media Discovery System
 * Architecture: Feature-based modules, typed interfaces, service layer separation
 * Stack: React + TypeScript, Tailwind, Claude API
 */

import { useState, useCallback, useMemo, useRef } from "react";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

type MediaType = "movie" | "tv_series" | "youtube_show" | "documentary" | "unknown";
type EntryStatus = "New" | "Reviewed" | "Approved" | "Rejected";
type MediaLanguage = "Arabic" | "English" | "Urdu" | "Turkish" | "Persian" | "French" | "Other";
type IslamicFinanceRelevance = "high" | "medium" | "low" | "none";
type SortKey = "discovered_at" | "title" | "relevance";

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

// Raw shape returned by Claude API
interface ClaudeResponseBody {
  content: { type: string; text: string }[];
  error?: { message: string };
}

// Raw entry shape from Claude before we normalise it
interface RawDiscoveryEntry {
  id?: string;
  title_en: string;
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

interface RawDiscoveryResponse {
  queries_used?: string[];
  entries?: RawDiscoveryEntry[];
}

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

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
  high: 0,
  medium: 1,
  low: 2,
  none: 3,
};

const EXAMPLE_PROMPTS: string[] = [
  "Islamic finance in media",
  "Movies about Islamic banking and halal investing",
  "Series discussing riba and Islamic economics",
  "Documentaries on sukuk and Islamic finance",
  "Muslim-themed financial literacy content",
];

const CLAUDE_MODEL = "claude-sonnet-4-20250514";

const FILTER_OPTIONS: Record<keyof Omit<Filters, "search">, string[]> = {
  status: ["All", "New", "Reviewed", "Approved", "Rejected"],
  type: ["All", "movie", "tv_series", "youtube_show", "documentary", "unknown"],
  relevance: ["All", "high", "medium", "low", "none"],
  language: ["All", "Arabic", "English", "Urdu", "Turkish", "Persian", "French", "Other"],
};

const TABS: { id: string; label: string; icon: string }[] = [
  { id: "search", label: "Search", icon: "🔍" },
  { id: "library", label: "Media Library", icon: "📚" },
  { id: "transcripts", label: "Transcripts", icon: "📄" },
  { id: "islamic_finance", label: "Islamic Finance", icon: "☪" },
];

// ─────────────────────────────────────────────
// SERVICES — claudeApi
// ─────────────────────────────────────────────

async function callClaude({
  systemPrompt,
  userMessage,
  maxTokens = 4096,
}: {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}): Promise<string> {
  const response = await fetch("http://localhost:5000/api/discovery/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      system: systemPrompt,
      message: userMessage,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(err?.error ?? `API error ${response.status}`);
  }

  const data = await response.json() as { text: string };

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

// ─────────────────────────────────────────────
// SERVICES — discoveryService
// ─────────────────────────────────────────────

const DISCOVERY_SYSTEM = `You are an expert researcher specializing in Islamic media, film, television, and digital content.
Your task is to discover Muslim-themed movies, TV series, YouTube shows, and documentaries — with a focus on content related to Islamic finance, economics, and ethics.

CRITICAL: Your response MUST be valid JSON only. No preamble, no explanation, no markdown outside the JSON block.`;

const DISCOVERY_SCHEMA = `Return a JSON object with this exact schema:
{
  "queries_used": ["string"],
  "entries": [
    {
      "id": "unique_slug",
      "title_en": "English Title",
      "title_ar": "Arabic title or null",
      "title_ur": "Urdu title or null",
      "title_tr": "Turkish title or null",
      "title_translation": "Translation note if not English-origin",
      "type": "movie|tv_series|youtube_show|documentary|unknown",
      "language": "Arabic|English|Urdu|Turkish|Persian|French|Other",
      "year": 2020,
      "description": "1-2 sentence description",
      "tags": ["islamic_finance","documentary","arabic"],
      "source_urls": ["https://..."],
      "islamic_finance_relevance": "high|medium|low|none",
      "notes": "Any relevant notes"
    }
  ]
}`;

async function runDiscovery(
  prompt: string,
  onProgress: (p: DiscoveryProgress) => void
): Promise<DiscoveryResult> {
  onProgress({ stage: "queries", message: "Generating multilingual search queries…" });
  onProgress({ stage: "discovery", message: "Running discovery…", queries: [] });

  const discoveryRaw = await callClaude({
    systemPrompt: "",
    userMessage: prompt,
    maxTokens: 4096,
  });

  const parsed = parseJsonResponse(discoveryRaw);

  // Handle both a raw array [ ] and a wrapped object { entries: [ ] }
  const rawEntries: RawDiscoveryEntry[] = Array.isArray(parsed)
    ? parsed
    : (parsed as RawDiscoveryResponse).entries ?? [];

  const entries: MediaEntry[] = rawEntries.map((e) => ({
    id: e.id ?? crypto.randomUUID(),
    title_en: e.title_en ?? "Untitled",
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
  }));

  return { entries, queries: [] };
}

// ─────────────────────────────────────────────
// UTILS — dedup
// ─────────────────────────────────────────────

function normalizeTitle(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function deduplicateEntries(existing: MediaEntry[], incoming: MediaEntry[]): MediaEntry[] {
  const byKey = new Map<string, MediaEntry>(
    existing.map((e) => [normalizeTitle(e.title_en), e])
  );

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

  return { entries, addEntries, updateStatus, updateNotes, stats };
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
// UI COMPONENTS
// ─────────────────────────────────────────────

function GeometricBackground() {
  return (
    <svg
      className="fixed inset-0 w-full h-full pointer-events-none opacity-[0.04]"
      xmlns="http://www.w3.org/2000/svg"
    >
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
  const colors: Record<IslamicFinanceRelevance, string> = {
    high: "bg-emerald-400",
    medium: "bg-amber-400",
    low: "bg-zinc-400",
    none: "bg-zinc-600",
  };
  const labels: Record<IslamicFinanceRelevance, string> = {
    high: "High relevance",
    medium: "Medium",
    low: "Low",
    none: "Not relevant",
  };
  return (
    <span className="flex items-center gap-1.5 text-xs text-zinc-400">
      <span className={`w-2 h-2 rounded-full ${colors[level]}`} />
      {labels[level]}
    </span>
  );
}

interface EntryCardProps {
  entry: MediaEntry;
  onStatusChange: (id: string, status: EntryStatus) => void;
  onNotesChange: (id: string, notes: string) => void;
}

function EntryCard({ entry, onStatusChange, onNotesChange }: EntryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [noteDraft, setNoteDraft] = useState(entry.notes ?? "");

  const nextStatuses = STATUS_FLOW[entry.status] ?? [];

  return (
    <div
      className="group rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] transition-all duration-200 overflow-hidden"
      style={{ backdropFilter: "blur(8px)" }}
    >
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
                <p className="text-amber-200/70 text-sm mt-0.5" style={{ fontFamily: "'Scheherazade New', serif", direction: "rtl" }}>
                  {entry.title_ar}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className="text-xs text-zinc-400 bg-white/[0.05] px-2 py-0.5 rounded-full border border-white/[0.08]">
                  {TYPE_LABELS[entry.type]}
                </span>
                <span className="text-xs text-zinc-400 bg-white/[0.05] px-2 py-0.5 rounded-full border border-white/[0.08]">
                  {entry.language}
                </span>
                <RelevanceDot level={entry.islamic_finance_relevance} />
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <StatusBadge status={entry.status} />
            <span className="text-zinc-600 group-hover:text-zinc-400 transition-colors text-xs">
              {expanded ? "▲ less" : "▼ more"}
            </span>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-white/[0.06] pt-3 space-y-3">
          {entry.description != null && (
            <p className="text-sm text-zinc-300 leading-relaxed">{entry.description}</p>
          )}

          {(entry.title_ur != null || entry.title_tr != null || entry.title_translation != null) && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {entry.title_ur != null && (
                <div>
                  <span className="text-zinc-500 block">Urdu</span>
                  <span className="text-zinc-300" style={{ fontFamily: "'Noto Nastaliq Urdu', serif" }}>{entry.title_ur}</span>
                </div>
              )}
              {entry.title_tr != null && (
                <div>
                  <span className="text-zinc-500 block">Turkish</span>
                  <span className="text-zinc-300">{entry.title_tr}</span>
                </div>
              )}
              {entry.title_translation != null && (
                <div className="col-span-2">
                  <span className="text-zinc-500 block">Translation note</span>
                  <span className="text-zinc-300 italic">{entry.title_translation}</span>
                </div>
              )}
            </div>
          )}

          {entry.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {entry.tags.map((tag) => (
                <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300/70 border border-amber-500/20">
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {entry.source_urls.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs text-zinc-500">Sources</span>
              {entry.source_urls.map((url, i) => (
                <a
                  key={i}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-xs text-blue-400/70 hover:text-blue-400 truncate transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  {url}
                </a>
              ))}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-500">Notes</span>
              <button
                onClick={(e) => { e.stopPropagation(); setEditingNotes((v) => !v); }}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
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
                <button
                  key={s}
                  onClick={(e) => { e.stopPropagation(); onStatusChange(entry.id, s); }}
                  className={`text-xs px-3 py-1 rounded-full border transition-all hover:scale-105 ${STATUS_COLORS[s]}`}
                >
                  Mark as {s}
                </button>
              ))}
            </div>
          )}

          <p className="text-xs text-zinc-600">
            Discovered: {new Date(entry.discovered_at).toLocaleString()} · Prompt: "{entry.source_prompt}"
          </p>
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

  const handleSubmit = () => { if (prompt.trim()) run(prompt); };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold text-[#F5F0E8]" style={{ fontFamily: "'Cormorant Garamond', serif" }}>
          Media Discovery
        </h2>
        <p className="text-zinc-400 text-sm">
          Claude will generate multilingual queries (EN/AR/UR/TR) and search for Muslim-themed media
        </p>
      </div>

      <div className="relative">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
          placeholder={`Enter a discovery prompt, e.g. "Islamic finance in media"…`}
          rows={3}
          className="w-full bg-white/[0.04] border border-white/[0.1] rounded-xl px-4 py-3 text-[#F5F0E8] placeholder-zinc-600 text-sm resize-none focus:outline-none focus:border-amber-500/50 transition-colors"
          style={{ backdropFilter: "blur(8px)" }}
        />
        <div className="absolute bottom-3 right-3 flex gap-2">
          {isRunning ? (
            <button onClick={cancel} className="px-4 py-1.5 rounded-lg bg-red-500/20 border border-red-500/30 text-red-400 text-xs font-medium hover:bg-red-500/30 transition-all">
              Cancel
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={!prompt.trim()} className="px-4 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-medium hover:bg-amber-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
              Run Discovery ⌘↵
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-zinc-500 uppercase tracking-widest">Example prompts</p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_PROMPTS.map((p) => (
            <button key={p} onClick={() => setPrompt(p)} className="text-xs px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:border-amber-500/30 transition-all">
              {p}
            </button>
          ))}
        </div>
      </div>

      {isRunning && progress != null && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
            </span>
            <span className="text-amber-300 text-sm font-medium">{progress.message}</span>
          </div>
          {(progress.queries?.length ?? 0) > 0 && (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {progress.queries?.map((q, i) => (
                <div key={i} className="text-xs text-zinc-400 flex items-start gap-2">
                  <span className="text-zinc-600 shrink-0">{i + 1}.</span>
                  <span>{q}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error != null && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-red-400 text-sm font-medium">Discovery failed</p>
          <p className="text-red-300/70 text-xs mt-1">{error}</p>
        </div>
      )}

      {lastResult != null && !isRunning && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-2">
          <p className="text-emerald-400 text-sm font-medium">
            ✓ Discovery complete — {lastResult.entries.length} entries added to library
          </p>
          <p className="text-zinc-400 text-xs">
            {lastResult.queries.length} search queries used (EN + AR + UR + TR variants)
          </p>
          <div className="flex gap-2 flex-wrap mt-1">
            {Object.entries(
              lastResult.entries.reduce<Record<string, number>>((acc, e) => {
                acc[e.type] = (acc[e.type] ?? 0) + 1;
                return acc;
              }, {})
            ).map(([type, count]) => (
              <span key={type} className="text-xs text-zinc-400">
                {TYPE_ICONS[type as MediaType]} {count} {TYPE_LABELS[type as MediaType]}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/[0.06] p-4 space-y-3">
        <p className="text-xs text-zinc-500 uppercase tracking-widest">Discovery Pipeline</p>
        <div className="flex items-center gap-2 flex-wrap text-xs">
          {["Your Prompt", "→", "Multilingual Queries (EN/AR/UR/TR)", "→", "Claude Web Search", "→", "Classify + Deduplicate", "→", "Media Library"].map((step, i) => (
            <span key={i} className={step === "→" ? "text-zinc-600" : "px-2 py-1 rounded-md bg-white/[0.04] text-zinc-300 border border-white/[0.06]"}>
              {step}
            </span>
          ))}
        </div>
      </div>
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
}

function LibraryTab({ entries, stats, onStatusChange, onNotesChange }: LibraryTabProps) {
  const [filters, setFilters] = useState<Filters>({
    status: "All",
    type: "All",
    relevance: "All",
    language: "All",
    search: "",
  });
  const [sortBy, setSortBy] = useState<SortKey>("discovered_at");

  const setFilter = (key: keyof Filters, val: string) =>
    setFilters((f) => ({ ...f, [key]: val }));

  const filtered = useMemo<MediaEntry[]>(() => {
    return entries
      .filter((e) => {
        if (filters.status !== "All" && e.status !== filters.status) return false;
        if (filters.type !== "All" && e.type !== filters.type) return false;
        if (filters.relevance !== "All" && e.islamic_finance_relevance !== filters.relevance) return false;
        if (filters.language !== "All" && e.language !== filters.language) return false;
        if (filters.search) {
          const q = filters.search.toLowerCase();
          return (
            e.title_en?.toLowerCase().includes(q) ||
            e.title_ar?.includes(filters.search) ||
            e.description?.toLowerCase().includes(q) ||
            e.tags.some((t) => t.toLowerCase().includes(q))
          );
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "discovered_at") {
          return new Date(b.discovered_at).getTime() - new Date(a.discovered_at).getTime();
        }
        if (sortBy === "title") return (a.title_en ?? "").localeCompare(b.title_en ?? "");
        if (sortBy === "relevance") {
          return (RELEVANCE_ORDER[a.islamic_finance_relevance] ?? 4) - (RELEVANCE_ORDER[b.islamic_finance_relevance] ?? 4);
        }
        return 0;
      });
  }, [entries, filters, sortBy]);

  if (entries.length === 0) {
    return (
      <div className="text-center py-24 space-y-4">
        <p className="text-6xl">🕌</p>
        <p className="text-zinc-400">Your library is empty.</p>
        <p className="text-zinc-600 text-sm">Run a discovery search to populate it.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(
          [
            { label: "Total", value: stats.total, color: "text-[#F5F0E8]" },
            { label: "Approved", value: stats.byStatus.Approved, color: "text-emerald-400" },
            { label: "High IF Relevance", value: stats.highRelevance, color: "text-amber-400" },
            { label: "Pending Review", value: stats.byStatus.New, color: "text-blue-400" },
          ] as const
        ).map(({ label, value, color }) => (
          <div key={label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-center">
            <p className={`text-2xl font-bold ${color}`} style={{ fontFamily: "'Cormorant Garamond', serif" }}>{value}</p>
            <p className="text-zinc-500 text-xs mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <input
          type="text"
          placeholder="Search titles, tags, descriptions…"
          value={filters.search}
          onChange={(e) => setFilter("search", e.target.value)}
          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-[#F5F0E8] placeholder-zinc-600 focus:outline-none focus:border-amber-500/40 transition-colors"
        />
        <div className="flex flex-wrap gap-2">
          {(Object.entries(FILTER_OPTIONS) as [keyof typeof FILTER_OPTIONS, string[]][]).map(([key, opts]) => (
            <select
              key={key}
              value={filters[key]}
              onChange={(e) => setFilter(key, e.target.value)}
              className="text-xs bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-zinc-300 focus:outline-none focus:border-amber-500/40 transition-colors cursor-pointer capitalize"
            >
              {opts.map((o) => (
                <option key={o} value={o} className="bg-[#0D2B1E]">
                  {key === "type" ? (TYPE_LABELS[o as MediaType] ?? o) : o}
                </option>
              ))}
            </select>
          ))}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className="text-xs bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-zinc-300 focus:outline-none focus:border-amber-500/40 transition-colors cursor-pointer ml-auto"
          >
            <option value="discovered_at" className="bg-[#0D2B1E]">Sort: Newest</option>
            <option value="title" className="bg-[#0D2B1E]">Sort: Title A–Z</option>
            <option value="relevance" className="bg-[#0D2B1E]">Sort: IF Relevance</option>
          </select>
        </div>
        <p className="text-xs text-zinc-600">Showing {filtered.length} of {entries.length} entries</p>
      </div>

      <div className="space-y-2">
        {filtered.map((entry) => (
          <EntryCard key={entry.id} entry={entry} onStatusChange={onStatusChange} onNotesChange={onNotesChange} />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12">
          <p className="text-zinc-500 text-sm">No entries match your filters.</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// COMING SOON TABS
// ─────────────────────────────────────────────

interface ComingSoonTabProps {
  icon: string;
  title: string;
  description: string;
  features: string[];
}

function ComingSoonTab({ icon, title, description, features }: ComingSoonTabProps) {
  return (
    <div className="max-w-lg mx-auto text-center py-20 space-y-6">
      <p className="text-5xl">{icon}</p>
      <h2 className="text-2xl font-bold text-[#F5F0E8]" style={{ fontFamily: "'Cormorant Garamond', serif" }}>
        {title}
      </h2>
      <p className="text-zinc-400 text-sm leading-relaxed">{description}</p>
      <div className="text-left space-y-2">
        {features.map((f) => (
          <div key={f} className="flex items-center gap-2 text-sm text-zinc-400">
            <span className="text-amber-500">◆</span> {f}
          </div>
        ))}
      </div>
      <span className="inline-block text-xs px-3 py-1 rounded-full border border-amber-500/30 text-amber-400/70">
        Roadmap — Tool 2
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState("search");
  const { entries, addEntries, updateStatus, updateNotes, stats } = useMediaLibrary();

  return (
    <div
      className="min-h-screen text-[#F5F0E8]"
      style={{ background: "linear-gradient(135deg, #071A11 0%, #0D2B1E 50%, #091612 100%)" }}
    >
      <GeometricBackground />

      <div className="relative z-10 max-w-4xl mx-auto px-4 pb-12">
        <header className="py-8 text-center space-y-2">
          <div className="flex justify-center items-center gap-3">
            <span className="text-3xl">☪</span>
            <h1
              className="text-4xl font-bold tracking-tight"
              style={{
                fontFamily: "'Cormorant Garamond', serif",
                background: "linear-gradient(90deg, #C9A227, #F5E6B0, #C9A227)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              Islamic Media Discovery
            </h1>
          </div>
          <p className="text-zinc-500 text-sm">
            Find · Classify · Curate Muslim-themed media for Islamic finance research
          </p>
        </header>

        <nav className="flex gap-1 mb-8 p-1 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                activeTab === tab.id
                  ? "bg-amber-500/15 text-amber-300 border border-amber-500/30 shadow-lg"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
              }`}
            >
              <span>{tab.icon}</span>
              <span className="hidden sm:inline">{tab.label}</span>
              {tab.id === "library" && entries.length > 0 && (
                <span className="ml-1 text-xs bg-amber-500/30 text-amber-300 px-1.5 py-0.5 rounded-full">
                  {entries.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        <main>
          {activeTab === "search" && <SearchTab onEntriesFound={addEntries} />}
          {activeTab === "library" && (
            <LibraryTab entries={entries} stats={stats} onStatusChange={updateStatus} onNotesChange={updateNotes} />
          )}
          {activeTab === "transcripts" && (
            <ComingSoonTab
              icon="📄"
              title="Transcript Ingestion"
              description="Upload video files or paste YouTube URLs to auto-generate timestamped transcripts with multilingual support."
              features={[
                "YouTube URL → Whisper transcription via OpenClaw",
                "Arabic / Urdu / English multi-language ASR",
                "Chunked storage with timestamps",
                "Link transcripts back to Media Library entries",
              ]}
            />
          )}
          {activeTab === "islamic_finance" && (
            <ComingSoonTab
              icon="☪"
              title="Islamic Finance Moments"
              description="Vector-search across all transcripts to find specific moments related to riba, sukuk, zakat, halal investing, and other Islamic finance topics."
              features={[
                "Semantic vector search over transcript chunks",
                "Highlight timestamped moments in video",
                "Export moment clips with context",
                "Custom prompt search: any Islamic finance topic",
              ]}
            />
          )}
        </main>

        <footer className="mt-16 text-center text-xs text-zinc-700 space-y-1">
          <p>Islamic Media Discovery System · Built for @Anees & @Tariq</p>
          <p>TypeScript · React · Claude API · Cloudflare Workers (backend)</p>
        </footer>
      </div>
    </div>
  );
}
