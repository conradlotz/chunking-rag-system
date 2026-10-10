import { cache } from "react";
import { fixtureMode } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type {
  Benchmarks,
  Configs,
  GoldSpan,
  ContextSpan,
  DocumentDetail,
  FilingList,
  IngestStage,
  Layout,
  Overview,
  SearchHit,
  UsageRow,
} from "@/lib/types";

export class NotAuthorised extends Error {
  constructor(message = "not authorised") {
    super(message);
  }
}

export interface Session {
  user: { id: string; email: string } | null;
  fixture: boolean;
  accessToken: string | null;
  rpc: <T>(fn: string, args?: Record<string, unknown>) => Promise<T>;
}

/** The caller's session plus an `rpc` bound to their identity. Every data call goes through public.lab_* functions. */
export const getSession = cache(async (): Promise<Session> => {
  if (fixtureMode()) {
    const { fixtureRpc, fixtureUser } = await import("./pg-fixture");
    return { user: fixtureUser(), fixture: true, accessToken: null, rpc: fixtureRpc };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const rpc = async <T>(fn: string, args: Record<string, unknown> = {}): Promise<T> => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      if (error.code === "42501") throw new NotAuthorised();
      throw new Error(`${fn}: ${error.message}`);
    }
    return data as T;
  };
  return {
    user: user ? { id: user.id, email: user.email ?? "" } : null,
    fixture: false,
    accessToken: session?.access_token ?? null,
    rpc,
  };
});

export const api = (s: Session) => ({
  isAllowed: () => s.rpc<boolean>("lab_is_allowed"),
  overview: () => s.rpc<Overview>("lab_overview"),
  usage: () => s.rpc<UsageRow[]>("lab_resource_usage"),
  ingestStats: () => s.rpc<IngestStage[]>("lab_ingest_stats"),
  filings: (query: string | null, limit = 60, offset = 0) =>
    s.rpc<FilingList>("lab_filings", { p_query: query, p_limit: limit, p_offset: offset }),
  document: (id: string) => s.rpc<DocumentDetail | null>("lab_document", { p_doc: id }),
  documentText: (id: string, start = 0, len = 600_000) =>
    s.rpc<string>("lab_document_text", { p_doc: id, p_start: start, p_len: len }),
  layout: (id: string, chunker: string) => s.rpc<Layout | null>("lab_layout", { p_doc: id, p_chunker: chunker }),
  goldSpans: (id: string) => s.rpc<GoldSpan[]>("lab_gold_spans", { p_doc: id }),
  configs: () => s.rpc<Configs>("lab_configs"),
  benchmarks: () => s.rpc<Benchmarks>("lab_benchmarks"),
  search: (a: {
    embedding: string | null;
    text: string;
    setId: string;
    mode: string;
    k: number;
    tickers: string[] | null;
    years: number[] | null;
    items: string[] | null;
    exact: boolean;
  }) =>
    s.rpc<SearchHit[]>("lab_search", {
      p_query_embedding: a.embedding,
      p_query_text: a.text,
      p_embedding_set_id: a.setId,
      p_mode: a.mode,
      p_k: a.k,
      p_tickers: a.tickers,
      p_fiscal_years: a.years,
      p_items: a.items,
      p_exact: a.exact,
    }),
  context: (a: { unitIds: number[]; budget: number; policy: string; neighbor: number; parent: number }) =>
    s.rpc<ContextSpan[]>("lab_context", {
      p_unit_ids: a.unitIds,
      p_budget: a.budget,
      p_policy: a.policy,
      p_neighbor: a.neighbor,
      p_parent: a.parent,
    }),
});
