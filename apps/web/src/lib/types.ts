// Shapes returned by the read-only public.lab_* database functions.

export interface CorpusStats {
  refreshed_at: string | null;
  filings: number;
  companies: number;
  min_fiscal_year: number | null;
  max_fiscal_year: number | null;
  source_bytes: number;
  canonical_documents: number;
  tokens: number;
  chars: number;
  nodes: number;
  blocks: number;
  sentences: number;
}

export interface LayoutStat {
  chunker_version_id: string;
  strategy: string;
  label: string;
  family: string;
  documents: number;
  chunks: number;
  tokens: number;
  avg_tokens: number | null;
}

export interface EmbeddingSetSummary {
  id: string;
  chunker_version_id: string;
  embedder_version_id: string;
  status: string;
  retention: string;
  unit_count: number | null;
  tokens_embedded: number | null;
  index_bytes: number | null;
}

export interface Overview {
  corpus: CorpusStats | null;
  layouts: LayoutStat[];
  embedding_sets: EmbeddingSetSummary[];
  production: { retrieval_config_id: string; activated_at: string; notes: string | null } | null;
  ingest: Record<string, number>;
  questions: { total: number; gold: number; silver: number };
}

export interface UsageRow {
  category: "bandwidth" | "embedding_compute" | "llm" | "storage";
  subject: string;
  unit: string;
  quantity: number;
  cost_usd: number | null;
  entries: number;
}

export interface IngestStage {
  stage: string;
  events: number;
  failed: number;
  skipped: number;
  wall_ms_total: number;
  wall_ms_p50: number;
  wall_ms_p95: number;
  cpu_ms_total: number | null;
  bytes_in: number | null;
  bytes_out: number | null;
}

export interface FilingRow {
  canonical_document_id: string;
  filing_id: string;
  accession_no: string;
  ticker: string;
  name: string;
  fiscal_year: number;
  period_of_report: string;
  source_url: string;
  token_count: number;
  char_count: number;
  items: string[];
}

export interface FilingList {
  total: number;
  rows: FilingRow[];
}

export interface TreeNode {
  o: number; // ordinal
  p: number | null; // parent ordinal
  d: number; // depth
  t: "document" | "item" | "section" | "paragraph" | "table" | "list";
  i: string | null; // item
  h: string | null; // heading
  s: number; // start char
  e: number; // end char
  k: number; // tokens
}

export interface DocumentLayoutInfo {
  chunker_version_id: string;
  strategy: string;
  params: Record<string, unknown>;
  chunks: number;
  tokens: number;
}

export interface DocumentDetail {
  id: string;
  accession_no: string;
  ticker: string;
  company: string;
  fiscal_year: number;
  period_of_report: string;
  source_url: string;
  source_sha256: string;
  text_sha256: string;
  char_count: number;
  token_count: number;
  items: string[];
  parser_version: string;
  normalizer_version: string;
  tokenizer_version: string;
  nodes: TreeNode[];
  layouts: DocumentLayoutInfo[];
}

export interface Layout {
  chunker_version_id: string;
  starts: number[];
  ends: number[];
  token_counts: number[];
  node_ids: number[];
}

export interface GoldSpan {
  question_id: string;
  qtype: string;
  question: string;
  tier: string;
  start: number;
  end: number;
}

export interface ChunkerConfig {
  id: string;
  name: string;
  strategy: string;
  params: Record<string, unknown>;
  label: string;
  family: string;
}

export interface Configs {
  chunkers: ChunkerConfig[];
  embedding_sets: { id: string; chunker_version_id: string; embedder_version_id: string; status: string; retention: string; unit_count: number | null }[];
  retrieval_configs: { id: string; embedding_set_id: string; budget_tokens: number; params: Record<string, unknown> }[];
  production: string | null;
  companies: { ticker: string; name: string }[];
  fiscal_years: number[];
}

export interface SearchHit {
  unit_id: number;
  canonical_document_id: string;
  node_id: number;
  start: number;
  end: number;
  tokens: number;
  score: number;
  vector_rank: number | null;
  keyword_rank: number | null;
  similarity: number | null;
  ticker: string;
  company: string;
  fiscal_year: number;
  item: string | null;
  heading: string | null;
  text: string;
}

export interface ContextSpan {
  ord: number;
  canonical_document_id: string;
  start: number;
  end: number;
  tokens: number;
  role: "hit" | "neighbor" | "parent";
  source_unit_id: number;
  hit_rank: number;
  ticker: string;
  fiscal_year: number;
  text: string;
}

export interface SweepExperiment {
  id: string;
  name: string;
  strategy: string | null;
  hypothesis: string | null;
  axes: Record<string, unknown>;
  stage: string;
  is_primary: boolean;
  status: string;
}

export interface SweepPoint {
  id: number;
  experiment_id: string;
  chunker_version_id: string;
  params: Record<string, unknown>;
  stage: string;
  recall_at_5: number | null;
  mrr: number | null;
  answer_span_containment: number | null;
  full_evidence_rate: number | null;
  answer_accuracy: number | null;
  chunks: number | null;
  tokens_embedded: number | null;
  index_bytes: number | null;
  context_tokens_mean: number | null;
  retrieval_p95_ms: number | null;
  answer_p95_ms: number | null;
  /** Optional: sample size and confidence intervals, e.g. { n: 40, ci: { recall_at_5: [0.71, 0.89] } } */
  extra?: { n?: number; ci?: Record<string, [number, number]>; fixture?: boolean } | null;
}

export interface Benchmarks {
  experiments: SweepExperiment[];
  points: SweepPoint[];
  runs: { id: string; kind: string; environment: string; created_at: string; status: string; summary: unknown }[];
}

export interface RetrieveRequest {
  query: string;
  embeddingSetId: string;
  mode: "keyword" | "vector" | "hybrid";
  k: number;
  policy: "static" | "expand";
  budget: number;
  neighbor: number;
  parent: number;
  tickers: string[];
  fiscalYears: number[];
  items: string[];
  exact: boolean;
}

export interface RetrieveResponse {
  hits: SearchHit[];
  context: ContextSpan[];
  timings: { embed_ms: number | null; search_ms: number; context_ms: number; total_ms: number };
  fixture: boolean;
}
