import { supabase } from "@/lib/supabase";

type SessionStatus = "draft" | "confirmed";

type SessionLike = {
  id: string;
  date: string;
  hall: string;
  status: SessionStatus;
  plays: unknown[];
  transfers: unknown[];
  exchanges: unknown[];
  memo: string;
  createdAt: string;
  updatedAt: string;
};

type SessionChanges = {
  plays: unknown[];
  transfers: unknown[];
  exchanges: unknown[];
  deletedPlayIds: string[];
  deletedTransferIds: string[];
  deletedExchangeIds: string[];
};

type SessionRow = {
  id: string;
  play_date: string;
  hall: string;
  members: unknown;
  plays: unknown[];
  settlements: {
    transfers?: unknown[];
    exchanges?: unknown[];
  } | null;
  total_invest: number;
  total_exchange: number;
  total_profit: number;
  status: SessionStatus;
  memo: string | null;
  created_at: string;
  updated_at: string;
};

function calculateTotals(session: SessionLike) {
  const plays = session.plays as Array<{ investment?: number }>;
  const exchanges = session.exchanges as Array<{ yen?: number }>;

  const totalInvestment = plays.reduce(
    (sum, play) => sum + Number(play.investment ?? 0),
    0,
  );

  const totalExchange = exchanges.reduce(
    (sum, exchange) => sum + Number(exchange.yen ?? 0),
    0,
  );

  return {
    totalInvestment,
    totalExchange,
    totalProfit: totalExchange - totalInvestment,
  };
}

function toRow(session: SessionLike) {
  const totals = calculateTotals(session);

  return {
    id: session.id,
    play_date: session.date,
    hall: session.hall,
    members: ["すぎさん", "こうちさん", "こんちゃみ"],
    plays: session.plays,
    settlements: {
      transfers: session.transfers,
      exchanges: session.exchanges,
    },
    total_invest: totals.totalInvestment,
    total_exchange: totals.totalExchange,
    total_profit: totals.totalProfit,
    status: session.status,
    memo: session.memo || null,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

function fromRow<T extends SessionLike>(row: SessionRow): T {
  return {
    id: row.id,
    date: row.play_date,
    hall: row.hall ?? "",
    status: row.status,
    plays: Array.isArray(row.plays) ? row.plays : [],
    transfers: Array.isArray(row.settlements?.transfers)
      ? row.settlements!.transfers
      : [],
    exchanges: Array.isArray(row.settlements?.exchanges)
      ? row.settlements!.exchanges
      : [],
    memo: row.memo ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as T;
}

export async function fetchSessionsFromSupabase<T extends SessionLike>() {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .order("play_date", { ascending: false })
    .order("updated_at", { ascending: false });

  if (error) throw error;

  return ((data ?? []) as SessionRow[]).map((row) => fromRow<T>(row));
}

export async function saveSessionToSupabase<T extends SessionLike>(
  session: T,
  changes?: SessionChanges,
) {
  if (changes) {
    const { data, error } = await supabase
      .rpc("merge_session", {
        p_row: toRow(session),
        p_plays: changes.plays,
        p_transfers: changes.transfers,
        p_exchanges: changes.exchanges,
        p_deleted_play_ids: changes.deletedPlayIds,
        p_deleted_transfer_ids: changes.deletedTransferIds,
        p_deleted_exchange_ids: changes.deletedExchangeIds,
      })
      .single();

    if (error) throw error;

    return fromRow<T>(data as SessionRow);
  }

  const { error } = await supabase
    .from("sessions")
    .upsert(toRow(session), { onConflict: "id" });

  if (error) throw error;

  return session;
}

export async function deleteSessionFromSupabase(id: string) {
  const { error } = await supabase.from("sessions").delete().eq("id", id);

  if (error) throw error;
}

export function subscribeToSessionChanges(
  onChange: () => void,
  onStatus?: (status: "connecting" | "connected" | "error") => void,
) {
  const channel = supabase
    .channel("sessions-shared")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "sessions",
      },
      onChange,
    )
    .subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        onStatus?.("connected");
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        onStatus?.("error");
      } else {
        onStatus?.("connecting");
      }
    });

  return () => {
    void supabase.removeChannel(channel);
  };
}
