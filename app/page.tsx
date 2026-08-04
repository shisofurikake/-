"use client";

// 最新版 2026-08-05：ランキング分離・ホール別分析・ホール候補検索対応

import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteSessionFromSupabase,
  fetchSessionsFromSupabase,
  mergeDraftSessionsInSupabase,
  saveSessionToSupabase,
  subscribeToSessionChanges,
} from "@/lib/sessionApi";
import { FUKUOKA_HALLS } from "@/lib/fukuokaHalls";

const MEMBERS = ["すぎさん", "こうちさん", "こんちゃみ"] as const;
type MemberName = (typeof MEMBERS)[number];
type PageName =
  | "home"
  | "register"
  | "drafts"
  | "history"
  | "detail"
  | "ranking"
  | "analysis";
type SessionStatus = "draft" | "confirmed";
type PlayType = "slot" | "pachinko";
type AnalysisPeriod = "month" | "year";

type PlayEntry = {
  id: string;
  type: PlayType;
  member: MemberName;
  machine: string;
  investment: number;
  finalUnits: number;
  usesPreviousUnits?: boolean;
  lendRate: number;
  memo: string;
};

type Transfer = {
  id: string;
  from: MemberName;
  to: MemberName;
  type: PlayType;
  units: number;
};

type ExchangeEntry = {
  id: string;
  members: MemberName[];
  type: PlayType;
  units: number;
  yen: number;
  memo: string;
};

type NoriuchiSession = {
  id: string;
  date: string;
  hall: string;
  status: SessionStatus;
  plays: PlayEntry[];
  transfers: Transfer[];
  exchanges: ExchangeEntry[];
  memo: string;
  createdAt: string;
  updatedAt: string;
};

type SessionField = "date" | "hall" | "memo";
type DirtyFieldMap = Map<string, Set<string>>;

type OldRecord = {
  id?: string;
  date?: string;
  hall?: string;
  machine?: string;
  lendRate?: number;
  totalExchangeCoins?: number;
  totalExchangeYen?: number;
  members?: Record<
    MemberName,
    {
      investment?: number;
      finalCoins?: number;
    }
  >;
  transfers?: Array<{
    id?: string;
    from?: MemberName;
    to?: MemberName;
    coins?: number;
  }>;
  memo?: string;
  createdAt?: string;
};

const STORAGE_KEY = "noriuchi-note-sessions";
const OLD_STORAGE_KEY = "samai-note-records";

function newId() {
  return crypto.randomUUID();
}

function todayString() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function yen(value: number) {
  return `${Math.round(value).toLocaleString()}円`;
}

function signedYen(value: number) {
  return `${value >= 0 ? "+" : ""}${yen(value)}`;
}

function units(value: number, type: PlayType) {
  const rounded = Math.round(value);
  const suffix = type === "slot" ? "枚" : "玉";
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString()}${suffix}`;
}

function typeLabel(type: PlayType) {
  return type === "slot" ? "スロット" : "パチンコ";
}

function unitLabel(type: PlayType) {
  return type === "slot" ? "枚" : "玉";
}

function monthLabel(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${year}年${monthNumber}月`;
}

function shiftMonth(month: string, amount: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(year, monthNumber - 1 + amount, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(
    2,
    "0",
  )}`;
}

function calendarDates(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();
  const lastDate = new Date(year, monthNumber, 0).getDate();
  const dates: Array<string | null> = Array(firstWeekday).fill(null);

  for (let day = 1; day <= lastDate; day += 1) {
    dates.push(`${month}-${String(day).padStart(2, "0")}`);
  }

  while (dates.length % 7 !== 0) {
    dates.push(null);
  }

  return dates;
}

function compactSignedYen(value: number) {
  const rounded = Math.round(value);
  const sign = rounded >= 0 ? "+" : "-";
  const absolute = Math.abs(rounded);

  if (absolute >= 10_000) {
    const tenThousands = absolute / 10_000;
    const display = Number.isInteger(tenThousands)
      ? tenThousands.toString()
      : tenThousands.toFixed(1);
    return `${sign}${display}万`;
  }

  return `${sign}${absolute.toLocaleString()}`;
}

function normalizeHallSearch(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/メガフェイス/g, "megaface")
    .replace(/フェイス/g, "face")
    .replace(/スーパー[\s　]*ディーステーション/g, "superdstation")
    .replace(/ディーステーション/g, "dstation")
    .replace(/クィ/g, "クイ")
    .replace(/[’'`・･.\s　\-_☆]/g, "")
    .replace(/店$/, "");
}

const HALL_MASTER_BY_KEY = new Map(
  FUKUOKA_HALLS.flatMap((hall) =>
    [hall.name, ...(hall.aliases ?? [])].map(
      (name) => [normalizeHallSearch(name), hall] as const,
    ),
  ),
);

function canonicalHallName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "ホール未入力";

  return HALL_MASTER_BY_KEY.get(normalizeHallSearch(trimmed))?.name ?? trimmed;
}

function createEmptySession(): NoriuchiSession {
  const now = new Date().toISOString();

  return {
    id: newId(),
    date: todayString(),
    hall: "",
    status: "draft",
    plays: [],
    transfers: [],
    exchanges: [],
    memo: "",
    createdAt: now,
    updatedAt: now,
  };
}

function migrateOldRecords(oldRecords: OldRecord[]): NoriuchiSession[] {
  return oldRecords.map((record) => {
    const createdAt = record.createdAt ?? new Date().toISOString();
    const plays: PlayEntry[] = MEMBERS.map((member) => ({
      id: newId(),
      type: "slot",
      member,
      machine: record.machine ?? "",
      investment: Number(record.members?.[member]?.investment ?? 0),
      finalUnits: Number(record.members?.[member]?.finalCoins ?? 0),
      lendRate: Number(record.lendRate ?? 46),
      memo: "",
    }));

    const transfers: Transfer[] = (record.transfers ?? []).map((transfer) => ({
      id: transfer.id ?? newId(),
      from: transfer.from ?? "すぎさん",
      to: transfer.to ?? "こうちさん",
      type: "slot",
      units: Number(transfer.coins ?? 0),
    }));

    const exchanges: ExchangeEntry[] =
      Number(record.totalExchangeYen ?? 0) > 0 ||
      Number(record.totalExchangeCoins ?? 0) > 0
        ? [
            {
              id: newId(),
              members: [...MEMBERS],
              type: "slot",
              units: Number(record.totalExchangeCoins ?? 0),
              yen: Number(record.totalExchangeYen ?? 0),
              memo: "旧データから移行",
            },
          ]
        : [];

    return {
      id: record.id ?? newId(),
      date: record.date ?? todayString(),
      hall: record.hall ?? "",
      status: "confirmed",
      plays,
      transfers,
      exchanges,
      memo: record.memo ?? "",
      createdAt,
      updatedAt: createdAt,
    };
  });
}

function memberInvestment(session: NoriuchiSession, member: MemberName) {
  return session.plays
    .filter((play) => play.member === member)
    .reduce((sum, play) => sum + Number(play.investment ?? 0), 0);
}

function memberPurchasedUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  return session.plays
    .filter((play) => play.member === member && play.type === type)
    .reduce((sum, play) => {
      if (play.investment <= 0 || play.lendRate <= 0) return sum;
      return sum + (play.investment / 1000) * play.lendRate;
    }, 0);
}

function memberFinalUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  const memberPlays = session.plays.filter(
    (play) => play.member === member && play.type === type,
  );

  return memberPlays.reduce((sum, play, index) => {
    const nextPlayUsesTheseUnits =
      memberPlays[index + 1]?.usesPreviousUnits ?? false;

    return sum + (nextPlayUsesTheseUnits ? 0 : play.finalUnits);
  }, 0);
}

function hasPreviousSameTypePlay(plays: PlayEntry[], currentIndex: number) {
  const currentPlay = plays[currentIndex];

  return plays
    .slice(0, currentIndex)
    .some(
      (play) =>
        play.member === currentPlay.member && play.type === currentPlay.type,
    );
}

function memberSentUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  return session.transfers
    .filter((transfer) => transfer.from === member && transfer.type === type)
    .reduce((sum, transfer) => sum + transfer.units, 0);
}

function memberReceivedUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  return session.transfers
    .filter((transfer) => transfer.to === member && transfer.type === type)
    .reduce((sum, transfer) => sum + transfer.units, 0);
}

function memberNetUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  return (
    memberFinalUnits(session, member, type) +
    memberSentUnits(session, member, type) -
    memberReceivedUnits(session, member, type) -
    memberPurchasedUnits(session, member, type)
  );
}

function memberRecoveredUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  return (
    memberFinalUnits(session, member, type) +
    memberSentUnits(session, member, type) -
    memberReceivedUnits(session, member, type)
  );
}

function memberFixedRateNetUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  const fixedRate = type === "slot" ? 50 : 250;
  const investedUnits = session.plays
    .filter((play) => play.member === member && play.type === type)
    .reduce(
      (sum, play) => sum + (Number(play.investment ?? 0) / 1000) * fixedRate,
      0,
    );

  return memberRecoveredUnits(session, member, type) - investedUnits;
}

function memberPersonalProfit(session: NoriuchiSession, member: MemberName) {
  const slotValue = (memberRecoveredUnits(session, member, "slot") / 50) * 1000;
  const pachinkoValue =
    (memberRecoveredUnits(session, member, "pachinko") / 250) * 1000;

  return slotValue + pachinkoValue - memberInvestment(session, member);
}

function calculateSession(session: NoriuchiSession) {
  const totalInvestment = MEMBERS.reduce(
    (sum, member) => sum + memberInvestment(session, member),
    0,
  );

  const totalExchangeYen = session.exchanges.reduce(
    (sum, exchange) => sum + exchange.yen,
    0,
  );

  const totalProfit = totalExchangeYen - totalInvestment;
  const equalProfit = Math.trunc(totalProfit / MEMBERS.length / 1000) * 1000;

  const memberResults = MEMBERS.map((member) => {
    const investment = memberInvestment(session, member);
    const rawReceipt = investment + equalProfit;
    const receipt = Math.trunc(rawReceipt / 1000) * 1000;
    const personalProfit = memberPersonalProfit(session, member);

    return {
      member,
      investment,
      receipt,
      balance: receipt - investment,
      personalProfit,
      netCoins: memberNetUnits(session, member, "slot"),
      netBalls: memberNetUnits(session, member, "pachinko"),
      sentCoins: memberSentUnits(session, member, "slot"),
      receivedCoins: memberReceivedUnits(session, member, "slot"),
      sentBalls: memberSentUnits(session, member, "pachinko"),
      receivedBalls: memberReceivedUnits(session, member, "pachinko"),
    };
  });

  return {
    totalInvestment,
    totalExchangeYen,
    totalProfit,
    equalProfit,
    remainder: totalProfit - equalProfit * MEMBERS.length,
    memberResults,
  };
}

function validateSession(session: NoriuchiSession, confirmMode: boolean) {
  if (!session.date) return "日付を入力してね";

  if (session.transfers.some((transfer) => transfer.from === transfer.to)) {
    return "同じ人同士の受け渡しは登録できません";
  }

  if (confirmMode && session.exchanges.length === 0) {
    return "確定するには交換内容を1件以上入力してね";
  }

  return "";
}

function mergeRealtimeItems<T extends { id: string }>(
  remoteItems: T[],
  localItems: T[],
  dirtyIds: Set<string>,
  dirtyFields: DirtyFieldMap,
  deletedIds: Set<string>,
) {
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const remoteIds = new Set(remoteItems.map((item) => item.id));

  const merged = remoteItems
    .filter((item) => !deletedIds.has(item.id))
    .map((remoteItem) => {
      if (!dirtyIds.has(remoteItem.id)) return remoteItem;

      const localItem = localById.get(remoteItem.id);
      if (!localItem) return remoteItem;

      const fields = dirtyFields.get(remoteItem.id);
      if (!fields || fields.has("*")) return localItem;

      const nextItem = { ...remoteItem } as Record<string, unknown>;
      const localRecord = localItem as unknown as Record<string, unknown>;
      fields.forEach((field) => {
        nextItem[field] = localRecord[field];
      });
      return nextItem as T;
    });

  localItems.forEach((localItem) => {
    if (
      dirtyIds.has(localItem.id) &&
      !deletedIds.has(localItem.id) &&
      !remoteIds.has(localItem.id)
    ) {
      merged.push(localItem);
    }
  });

  return merged;
}

function mergeRealtimeSession(
  remote: NoriuchiSession,
  local: NoriuchiSession,
  dirtySessionFields: Set<SessionField>,
  dirtyPlayIds: Set<string>,
  dirtyPlayFields: DirtyFieldMap,
  deletedPlayIds: Set<string>,
  dirtyTransferIds: Set<string>,
  dirtyTransferFields: DirtyFieldMap,
  deletedTransferIds: Set<string>,
  dirtyExchangeIds: Set<string>,
  dirtyExchangeFields: DirtyFieldMap,
  deletedExchangeIds: Set<string>,
) {
  return {
    ...remote,
    date: dirtySessionFields.has("date") ? local.date : remote.date,
    hall: dirtySessionFields.has("hall") ? local.hall : remote.hall,
    memo: dirtySessionFields.has("memo") ? local.memo : remote.memo,
    plays: mergeRealtimeItems(
      remote.plays,
      local.plays,
      dirtyPlayIds,
      dirtyPlayFields,
      deletedPlayIds,
    ),
    transfers: mergeRealtimeItems(
      remote.transfers,
      local.transfers,
      dirtyTransferIds,
      dirtyTransferFields,
      deletedTransferIds,
    ),
    exchanges: mergeRealtimeItems(
      remote.exchanges,
      local.exchanges,
      dirtyExchangeIds,
      dirtyExchangeFields,
      deletedExchangeIds,
    ),
  };
}

export default function Home() {
  const pendingPlayScrollId = useRef<string | null>(null);
  const [page, setPage] = useState<PageName>("home");
  const [sessions, setSessions] = useState<NoriuchiSession[]>([]);
  const [form, setForm] = useState<NoriuchiSession>(createEmptySession);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [forceSeparateSession, setForceSeparateSession] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [historyMonth, setHistoryMonth] = useState(todayString().slice(0, 7));
  const [analysisPeriod, setAnalysisPeriod] = useState<AnalysisPeriod>("month");
  const [analysisMonth, setAnalysisMonth] = useState(todayString().slice(0, 7));
  const [analysisYear, setAnalysisYear] = useState(todayString().slice(0, 4));
  const [selectedHistoryDate, setSelectedHistoryDate] = useState<string | null>(
    null,
  );
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null);
  const [dirtyPlayIds, setDirtyPlayIds] = useState<Set<string>>(new Set());
  const [dirtyPlayFields, setDirtyPlayFields] = useState<DirtyFieldMap>(
    new Map(),
  );
  const [dirtyTransferIds, setDirtyTransferIds] = useState<Set<string>>(
    new Set(),
  );
  const [dirtyTransferFields, setDirtyTransferFields] = useState<DirtyFieldMap>(
    new Map(),
  );
  const [dirtyExchangeIds, setDirtyExchangeIds] = useState<Set<string>>(
    new Set(),
  );
  const [dirtyExchangeFields, setDirtyExchangeFields] = useState<DirtyFieldMap>(
    new Map(),
  );
  const [dirtySessionFields, setDirtySessionFields] = useState<
    Set<SessionField>
  >(new Set());
  const [deletedPlayIds, setDeletedPlayIds] = useState<Set<string>>(new Set());
  const [deletedTransferIds, setDeletedTransferIds] = useState<Set<string>>(
    new Set(),
  );
  const [deletedExchangeIds, setDeletedExchangeIds] = useState<Set<string>>(
    new Set(),
  );
  const [realtimeStatus, setRealtimeStatus] = useState<
    "connecting" | "connected" | "error"
  >("connecting");
  const [syncMessage, setSyncMessage] = useState("");
  const [draftMergeIds, setDraftMergeIds] = useState<string[]>([]);
  const [isMergingDrafts, setIsMergingDrafts] = useState(false);
  const [hallSuggestionsOpen, setHallSuggestionsOpen] = useState(false);

  const liveEditRef = useRef({
    page,
    editingId,
    forceSeparateSession,
    form,
    dirtySessionFields,
    dirtyPlayIds,
    dirtyPlayFields,
    deletedPlayIds,
    dirtyTransferIds,
    dirtyTransferFields,
    deletedTransferIds,
    dirtyExchangeIds,
    dirtyExchangeFields,
    deletedExchangeIds,
  });
  liveEditRef.current = {
    page,
    editingId,
    forceSeparateSession,
    form,
    dirtySessionFields,
    dirtyPlayIds,
    dirtyPlayFields,
    deletedPlayIds,
    dirtyTransferIds,
    dirtyTransferFields,
    deletedTransferIds,
    dirtyExchangeIds,
    dirtyExchangeFields,
    deletedExchangeIds,
  };

  useEffect(() => {
    const playId = pendingPlayScrollId.current;
    if (!playId) return;

    const frameId = requestAnimationFrame(() => {
      document.getElementById(`play-${playId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      pendingPlayScrollId.current = null;
    });

    return () => cancelAnimationFrame(frameId);
  }, [form.plays.length]);

  useEffect(() => {
    if (!syncMessage) return;

    const timeoutId = window.setTimeout(() => setSyncMessage(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [syncMessage]);

  useEffect(() => {
    setDraftMergeIds((current) =>
      current.filter((id) =>
        sessions.some(
          (session) => session.id === id && session.status === "draft",
        ),
      ),
    );
  }, [sessions]);

  useEffect(() => {
    setDraftMergeIds([]);
  }, [selectedHistoryDate]);

  useEffect(() => {
    let active = true;

    async function loadSessions() {
      try {
        const remoteSessions =
          await fetchSessionsFromSupabase<NoriuchiSession>();

        if (!active) return;

        if (remoteSessions.length > 0) {
          setSessions(remoteSessions);
          setLoaded(true);
          return;
        }

        const saved = localStorage.getItem(STORAGE_KEY);
        const oldSaved = localStorage.getItem(OLD_STORAGE_KEY);
        let migrated: NoriuchiSession[] = [];

        if (saved) {
          try {
            migrated = JSON.parse(saved);
          } catch {
            localStorage.removeItem(STORAGE_KEY);
          }
        } else if (oldSaved) {
          try {
            migrated = migrateOldRecords(JSON.parse(oldSaved));
          } catch {
            localStorage.removeItem(OLD_STORAGE_KEY);
          }
        }

        if (migrated.length > 0) {
          await Promise.all(
            migrated.map((session) => saveSessionToSupabase(session)),
          );
          setSessions(migrated);
        }

        setLoaded(true);
      } catch (error) {
        console.error(error);
        if (active) {
          alert("共有データの読み込みに失敗しました");
          setLoaded(true);
        }
      }
    }

    void loadSessions();

    const unsubscribe = subscribeToSessionChanges(() => {
      void fetchSessionsFromSupabase<NoriuchiSession>()
        .then((latest) => {
          if (!active) return;

          setSessions(latest);

          const snapshot = liveEditRef.current;
          const remoteEditingSession = snapshot.editingId
            ? latest.find((session) => session.id === snapshot.editingId)
            : snapshot.page === "register" && !snapshot.forceSeparateSession
              ? latest.find(
                  (session) =>
                    session.status === "draft" &&
                    session.date === snapshot.form.date,
                )
              : undefined;

          if (!remoteEditingSession) return;

          if (!snapshot.editingId) {
            setEditingId(remoteEditingSession.id);
          }

          setForm((current) =>
            mergeRealtimeSession(
              remoteEditingSession,
              current,
              snapshot.dirtySessionFields,
              snapshot.dirtyPlayIds,
              snapshot.dirtyPlayFields,
              snapshot.deletedPlayIds,
              snapshot.dirtyTransferIds,
              snapshot.dirtyTransferFields,
              snapshot.deletedTransferIds,
              snapshot.dirtyExchangeIds,
              snapshot.dirtyExchangeFields,
              snapshot.deletedExchangeIds,
            ),
          );
          setSyncMessage("ほかのメンバーの保存内容を反映しました");
        })
        .catch(console.error);
    }, setRealtimeStatus);

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const confirmedSessions = useMemo(
    () => sessions.filter((session) => session.status === "confirmed"),
    [sessions],
  );

  const currentMonth = todayString().slice(0, 7);
  const monthlySessions = confirmedSessions.filter((session) =>
    session.date.startsWith(currentMonth),
  );

  const monthlyProfit = monthlySessions.reduce(
    (sum, session) => sum + calculateSession(session).totalProfit,
    0,
  );

  const historyMonthSessions = sessions.filter((session) =>
    session.date.startsWith(historyMonth),
  );
  const historyMonthConfirmedSessions = historyMonthSessions.filter(
    (session) => session.status === "confirmed",
  );
  const historyMonthProfit = historyMonthConfirmedSessions.reduce(
    (sum, session) => sum + calculateSession(session).totalProfit,
    0,
  );
  const selectedDateSessions = selectedHistoryDate
    ? sessions.filter((session) => session.date === selectedHistoryDate)
    : [];
  const detailSession =
    sessions.find((session) => session.id === detailSessionId) ?? null;
  const detailResult = detailSession ? calculateSession(detailSession) : null;

  const draftSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.status === "draft")
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
    [sessions],
  );
  const draftCount = draftSessions.length;

  const hallCandidates = useMemo(() => {
    const candidates = new Map<
      string,
      {
        name: string;
        area: string;
        aliases?: string[];
        source: "履歴" | "福岡県";
      }
    >();

    sessions.forEach((session) => {
      const name = session.hall.trim();
      if (!name) return;

      const key = normalizeHallSearch(name);
      const master = HALL_MASTER_BY_KEY.get(key);
      candidates.set(key, {
        name: master?.name ?? name,
        area: master?.area ?? "過去の入力",
        aliases: master?.aliases,
        source: "履歴",
      });
    });

    FUKUOKA_HALLS.forEach((hall) => {
      const key = normalizeHallSearch(hall.name);
      if (candidates.has(key)) return;

      candidates.set(key, { ...hall, source: "福岡県" });
    });

    return [...candidates.values()];
  }, [sessions]);

  const hallSuggestions = useMemo(() => {
    if (!hallSuggestionsOpen) return [];

    const query = normalizeHallSearch(form.hall);
    if (!query) return [];

    return hallCandidates
      .filter((hall) => {
        const name = normalizeHallSearch(hall.name);
        const area = normalizeHallSearch(hall.area);
        const aliasMatches = hall.aliases?.some((alias) =>
          normalizeHallSearch(alias).includes(query),
        );
        return (
          name !== query &&
          (name.includes(query) || area.includes(query) || aliasMatches)
        );
      })
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === "履歴" ? -1 : 1;
        return a.name.localeCompare(b.name, "ja");
      })
      .slice(0, 8);
  }, [form.hall, hallCandidates, hallSuggestionsOpen]);

  const analysisSessions = confirmedSessions.filter((session) =>
    analysisPeriod === "month"
      ? session.date.startsWith(analysisMonth)
      : session.date.startsWith(analysisYear),
  );
  const analysisProfit = analysisSessions.reduce(
    (sum, session) => sum + calculateSession(session).totalProfit,
    0,
  );
  const analysisPeriodLabel =
    analysisPeriod === "month"
      ? monthLabel(analysisMonth)
      : `${Number(analysisYear)}年`;

  const analysis = MEMBERS.map((member) => {
    const investment = analysisSessions.reduce(
      (sum, session) => sum + memberInvestment(session, member),
      0,
    );
    const netCoins = analysisSessions.reduce(
      (sum, session) => sum + memberFixedRateNetUnits(session, member, "slot"),
      0,
    );
    const netBalls = analysisSessions.reduce(
      (sum, session) =>
        sum + memberFixedRateNetUnits(session, member, "pachinko"),
      0,
    );
    const sentCoins = analysisSessions.reduce(
      (sum, session) => sum + memberSentUnits(session, member, "slot"),
      0,
    );
    const receivedCoins = analysisSessions.reduce(
      (sum, session) => sum + memberReceivedUnits(session, member, "slot"),
      0,
    );
    const sentBalls = analysisSessions.reduce(
      (sum, session) => sum + memberSentUnits(session, member, "pachinko"),
      0,
    );
    const receivedBalls = analysisSessions.reduce(
      (sum, session) => sum + memberReceivedUnits(session, member, "pachinko"),
      0,
    );

    return {
      member,
      investment,
      netCoins,
      netBalls,
      rankingValue: netCoins * 20 + netBalls * 4,
      sentCoins,
      receivedCoins,
      sentBalls,
      receivedBalls,
    };
  }).sort((a, b) => b.rankingValue - a.rankingValue);

  const hallAnalysis = Array.from(
    analysisSessions
      .reduce(
        (map, session) => {
          const result = calculateSession(session);
          const name = canonicalHallName(session.hall);
          const key = normalizeHallSearch(name) || "__empty__";
          const current = map.get(key) ?? {
            name,
            visits: 0,
            wins: 0,
            losses: 0,
            draws: 0,
            totalInvestment: 0,
            totalExchange: 0,
            totalProfit: 0,
            bestProfit: Number.NEGATIVE_INFINITY,
            worstProfit: Number.POSITIVE_INFINITY,
          };

          current.visits += 1;
          current.totalInvestment += result.totalInvestment;
          current.totalExchange += result.totalExchangeYen;
          current.totalProfit += result.totalProfit;
          current.bestProfit = Math.max(current.bestProfit, result.totalProfit);
          current.worstProfit = Math.min(
            current.worstProfit,
            result.totalProfit,
          );

          if (result.totalProfit > 0) current.wins += 1;
          else if (result.totalProfit < 0) current.losses += 1;
          else current.draws += 1;

          map.set(key, current);
          return map;
        },
        new Map<
          string,
          {
            name: string;
            visits: number;
            wins: number;
            losses: number;
            draws: number;
            totalInvestment: number;
            totalExchange: number;
            totalProfit: number;
            bestProfit: number;
            worstProfit: number;
          }
        >(),
      )
      .values(),
  ).sort((a, b) => {
    if (a.name === "ホール未入力") return 1;
    if (b.name === "ホール未入力") return -1;
    return b.totalProfit - a.totalProfit;
  });

  function resetChangeTracking() {
    setDirtySessionFields(new Set());
    setDirtyPlayIds(new Set());
    setDirtyPlayFields(new Map());
    setDirtyTransferIds(new Set());
    setDirtyTransferFields(new Map());
    setDirtyExchangeIds(new Set());
    setDirtyExchangeFields(new Map());
    setDeletedPlayIds(new Set());
    setDeletedTransferIds(new Set());
    setDeletedExchangeIds(new Set());
  }

  function markDirtyField(
    setter: React.Dispatch<React.SetStateAction<DirtyFieldMap>>,
    id: string,
    field: string,
  ) {
    setter((current) => {
      const next = new Map(current);
      const fields = new Set(next.get(id) ?? []);
      fields.add(field);
      next.set(id, fields);
      return next;
    });
  }

  function updateSessionField(field: SessionField, value: string) {
    setDirtySessionFields((current) => new Set(current).add(field));
    setForm((current) => ({ ...current, [field]: value }));
  }

  function createNewSession() {
    resetChangeTracking();
    setForm(createEmptySession());
    setEditingId(null);
    setForceSeparateSession(false);
    setPage("register");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function createSeparateSession() {
    resetChangeTracking();
    setForm(createEmptySession());
    setEditingId(null);
    setForceSeparateSession(true);
    setPage("register");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openDrafts() {
    if (draftSessions.length === 1) {
      editSession(draftSessions[0]);
      return;
    }

    setPage("drafts");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startNew() {
    if (draftSessions.length > 0) {
      setPage("drafts");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    createNewSession();
  }

  function editSession(session: NoriuchiSession) {
    resetChangeTracking();
    setForm(JSON.parse(JSON.stringify(session)));
    setEditingId(session.id);
    setForceSeparateSession(false);
    setPage("register");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveSession(status: SessionStatus) {
    const message = validateSession(form, status === "confirmed");

    if (message) {
      alert(message);
      return;
    }

    const now = new Date().toISOString();
    let next: NoriuchiSession = {
      ...form,
      status,
      updatedAt: now,
      createdAt: editingId ? form.createdAt : now,
    };
    let mergedIntoExistingDraft = false;

    try {
      if (!editingId && !forceSeparateSession) {
        const latestSessions =
          await fetchSessionsFromSupabase<NoriuchiSession>();
        const existingDraft = latestSessions
          .filter(
            (session) =>
              session.status === "draft" &&
              session.id !== form.id &&
              session.date === form.date,
          )
          .sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          )[0];

        if (existingDraft) {
          next = {
            ...next,
            id: existingDraft.id,
            createdAt: existingDraft.createdAt,
          };
          mergedIntoExistingDraft = true;
        }
      }

      const saved = await saveSessionToSupabase<NoriuchiSession>(next, {
        plays: next.plays.filter((play) => dirtyPlayIds.has(play.id)),
        transfers: next.transfers.filter((transfer) =>
          dirtyTransferIds.has(transfer.id),
        ),
        exchanges: next.exchanges.filter((exchange) =>
          dirtyExchangeIds.has(exchange.id),
        ),
        deletedPlayIds: [...deletedPlayIds],
        deletedTransferIds: [...deletedTransferIds],
        deletedExchangeIds: [...deletedExchangeIds],
      });

      setSessions((current) => {
        if (current.some((session) => session.id === saved.id)) {
          return current.map((session) =>
            session.id === saved.id ? saved : session,
          );
        }

        return [saved, ...current];
      });

      resetChangeTracking();
      setForm(createEmptySession());
      setEditingId(null);
      setForceSeparateSession(false);
      setPage("history");

      if (mergedIntoExistingDraft) {
        alert("先に保存された未確定の記録へ、入力内容を合体しました");
      }
    } catch (error) {
      console.error(error);
      alert("保存に失敗しました。通信状態を確認してね");
    }
  }

  function toggleDraftMerge(sessionId: string) {
    setDraftMergeIds((current) =>
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId],
    );
  }

  async function mergeSelectedDrafts() {
    const selectedDrafts = sessions.filter(
      (session) =>
        session.status === "draft" && draftMergeIds.includes(session.id),
    );

    if (selectedDrafts.length < 2) {
      alert("統合する未確定記録を2件以上選んでね");
      return;
    }

    if (new Set(selectedDrafts.map((session) => session.date)).size !== 1) {
      alert("同じ日付の未確定記録だけを選んでね");
      return;
    }

    const playCount = selectedDrafts.reduce(
      (sum, session) => sum + session.plays.length,
      0,
    );
    const totalInvestment = selectedDrafts.reduce(
      (sum, session) => sum + calculateSession(session).totalInvestment,
      0,
    );

    if (
      !confirm(
        `${selectedDrafts.length}件を1件に統合する？\n遊技 ${playCount}件・総投資 ${yen(totalInvestment)}`,
      )
    ) {
      return;
    }

    setIsMergingDrafts(true);

    try {
      const merged = await mergeDraftSessionsInSupabase<NoriuchiSession>(
        selectedDrafts.map((session) => session.id),
      );
      const latest = await fetchSessionsFromSupabase<NoriuchiSession>();

      setSessions(latest);
      setDraftMergeIds([]);
      setSelectedHistoryDate(merged.date);
      setPage("history");
      window.scrollTo({ top: 0, behavior: "smooth" });
      alert(
        `未確定記録を1件に統合しました\n遊技 ${merged.plays.length}件・総投資 ${yen(calculateSession(merged).totalInvestment)}`,
      );
    } catch (error) {
      console.error(error);
      alert("統合に失敗しました。記録は変更されていません");
    } finally {
      setIsMergingDrafts(false);
    }
  }

  async function deleteSession(id: string) {
    if (!confirm("この記録を削除する？")) return;

    try {
      await deleteSessionFromSupabase(id);
      setSessions((current) => current.filter((session) => session.id !== id));
    } catch (error) {
      console.error(error);
      alert("削除に失敗しました");
    }
  }

  function updatePlay(
    id: string,
    field: keyof Omit<PlayEntry, "id">,
    value: string | number | boolean,
  ) {
    setDirtyPlayIds((current) => new Set(current).add(id));
    markDirtyField(setDirtyPlayFields, id, field);
    setForm((current) => ({
      ...current,
      plays: current.plays.map((play) =>
        play.id === id ? { ...play, [field]: value } : play,
      ),
    }));
  }

  function addPlay(type: PlayType) {
    const id = newId();
    pendingPlayScrollId.current = id;
    setDirtyPlayIds((current) => new Set(current).add(id));
    markDirtyField(setDirtyPlayFields, id, "*");
    setForm((current) => ({
      ...current,
      plays: [
        ...current.plays,
        {
          id,
          type,
          member: "すぎさん",
          machine: "",
          investment: 0,
          finalUnits: 0,
          usesPreviousUnits: false,
          lendRate: type === "slot" ? 46 : 250,
          memo: "",
        },
      ],
    }));
  }

  function removePlay(id: string) {
    setDirtyPlayIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setDirtyPlayFields((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    setDeletedPlayIds((current) => new Set(current).add(id));
    setForm((current) => ({
      ...current,
      plays: current.plays.filter((play) => play.id !== id),
    }));
  }

  function addTransfer(type: PlayType) {
    const id = newId();
    setDirtyTransferIds((current) => new Set(current).add(id));
    markDirtyField(setDirtyTransferFields, id, "*");
    setForm((current) => ({
      ...current,
      transfers: [
        ...current.transfers,
        {
          id,
          from: "すぎさん",
          to: "こうちさん",
          type,
          units: 0,
        },
      ],
    }));
  }

  function updateTransfer(
    id: string,
    field: keyof Omit<Transfer, "id">,
    value: string | number,
  ) {
    setDirtyTransferIds((current) => new Set(current).add(id));
    markDirtyField(setDirtyTransferFields, id, field);
    setForm((current) => ({
      ...current,
      transfers: current.transfers.map((transfer) =>
        transfer.id === id ? { ...transfer, [field]: value } : transfer,
      ),
    }));
  }

  function removeTransfer(id: string) {
    setDirtyTransferIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setDirtyTransferFields((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    setDeletedTransferIds((current) => new Set(current).add(id));
    setForm((current) => ({
      ...current,
      transfers: current.transfers.filter((transfer) => transfer.id !== id),
    }));
  }

  function addExchange(type: PlayType) {
    const id = newId();
    setDirtyExchangeIds((current) => new Set(current).add(id));
    markDirtyField(setDirtyExchangeFields, id, "*");
    setForm((current) => ({
      ...current,
      exchanges: [
        ...current.exchanges,
        {
          id,
          members: [...MEMBERS],
          type,
          units: 0,
          yen: 0,
          memo: "",
        },
      ],
    }));
  }

  function updateExchange(
    id: string,
    field: "type" | "units" | "yen" | "memo",
    value: string | number,
  ) {
    setDirtyExchangeIds((current) => new Set(current).add(id));
    markDirtyField(setDirtyExchangeFields, id, field);
    setForm((current) => ({
      ...current,
      exchanges: current.exchanges.map((exchange) =>
        exchange.id === id ? { ...exchange, [field]: value } : exchange,
      ),
    }));
  }

  function toggleExchangeMember(id: string, member: MemberName) {
    setDirtyExchangeIds((current) => new Set(current).add(id));
    markDirtyField(setDirtyExchangeFields, id, "members");
    setForm((current) => ({
      ...current,
      exchanges: current.exchanges.map((exchange) => {
        if (exchange.id !== id) return exchange;

        const selected = exchange.members.includes(member);
        return {
          ...exchange,
          members: selected
            ? exchange.members.filter((name) => name !== member)
            : [...exchange.members, member],
        };
      }),
    }));
  }

  function removeExchange(id: string) {
    setDirtyExchangeIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setDirtyExchangeFields((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    setDeletedExchangeIds((current) => new Set(current).add(id));
    setForm((current) => ({
      ...current,
      exchanges: current.exchanges.filter((exchange) => exchange.id !== id),
    }));
  }

  const preview = calculateSession(form);

  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto min-h-screen max-w-md px-5 pb-28 pt-7">
        <header className="mb-7">
          <button
            type="button"
            onClick={() => setPage("home")}
            className="text-left"
          >
            <h1 className="text-3xl font-black tracking-tight text-amber-400">
              🎰 ノリ打ちノート
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              3人専用 ノリ打ち精算・収支管理
            </p>
            <p
              className={`mt-2 text-xs font-bold ${
                realtimeStatus === "connected"
                  ? "text-emerald-400"
                  : realtimeStatus === "error"
                    ? "text-rose-400"
                    : "text-zinc-500"
              }`}
            >
              {realtimeStatus === "connected"
                ? "● リアルタイム同期 接続済み"
                : realtimeStatus === "error"
                  ? "● 同期エラー"
                  : "● 同期に接続中"}
            </p>
          </button>
        </header>

        {syncMessage && (
          <div className="fixed left-1/2 top-4 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-2xl bg-emerald-500 px-4 py-3 text-center text-sm font-black text-black shadow-xl">
            {syncMessage}
          </div>
        )}

        {page === "home" && (
          <section className="space-y-4">
            <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
              <p className="text-sm text-zinc-400">今月の収支</p>
              <p
                className={`mt-1 text-4xl font-black ${
                  monthlyProfit >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {signedYen(monthlyProfit)}
              </p>
              <p className="mt-2 text-sm text-zinc-500">
                確定済み {monthlySessions.length}件
              </p>
            </div>

            <button
              type="button"
              onClick={openDrafts}
              className="flex w-full items-center justify-between rounded-3xl border border-zinc-800 bg-zinc-900 p-5 text-left"
            >
              <div>
                <p className="text-sm text-zinc-400">未確定の記録</p>
                <p className="mt-1 text-2xl font-black">{draftCount}件</p>
              </div>
              <span className="text-2xl">›</span>
            </button>

            {sessions[0] && (
              <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-zinc-400">最新の記録</p>
                    <p className="mt-1 font-black">
                      {sessions[0].hall || "ホール未入力"}
                    </p>
                    <p className="text-sm text-zinc-500">{sessions[0].date}</p>
                  </div>
                  <StatusBadge status={sessions[0].status} />
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={startNew}
              className="w-full rounded-2xl bg-amber-400 py-4 text-lg font-black text-black"
            >
              ＋ 新しいノリ打ち
            </button>
          </section>
        )}

        {page === "drafts" && (
          <section className="space-y-5">
            <button
              type="button"
              onClick={() => setPage("home")}
              className="font-bold text-amber-300"
            >
              ← ホームに戻る
            </button>

            <div>
              <h2 className="text-2xl font-black">未確定の記録</h2>
              <p className="mt-1 text-sm text-zinc-400">
                編集するか、複数選んで1件に統合できます
              </p>
            </div>

            {draftSessions.length >= 2 && (
              <div className="rounded-3xl border border-amber-400/40 bg-amber-400/10 p-4">
                <p className="text-sm text-zinc-300">
                  同じ日付の記録を2件以上選んでね
                </p>
                <button
                  type="button"
                  disabled={draftMergeIds.length < 2 || isMergingDrafts}
                  onClick={() => void mergeSelectedDrafts()}
                  className="mt-3 w-full rounded-2xl bg-amber-400 py-3 font-black text-black disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isMergingDrafts
                    ? "統合しています…"
                    : `選んだ記録を統合（${draftMergeIds.length}件）`}
                </button>
              </div>
            )}

            {draftSessions.length === 0 ? (
              <EmptyState text="未確定の記録はありません" />
            ) : (
              <div className="space-y-3">
                {draftSessions.map((session) => {
                  const selected = draftMergeIds.includes(session.id);

                  return (
                    <div
                      key={session.id}
                      className={`rounded-3xl border p-4 ${
                        selected
                          ? "border-amber-300 bg-amber-400/20"
                          : "border-amber-400/40 bg-amber-400/10"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleDraftMerge(session.id)}
                        className="flex w-full items-center gap-3 rounded-2xl bg-zinc-950/60 px-4 py-3 text-left"
                      >
                        <span
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border font-black ${
                            selected
                              ? "border-amber-300 bg-amber-400 text-black"
                              : "border-zinc-600 text-transparent"
                          }`}
                        >
                          ✓
                        </span>
                        <span className="font-bold">
                          {selected ? "統合対象に選択中" : "統合対象に選ぶ"}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => editSession(session)}
                        className="mt-3 flex w-full items-center justify-between gap-4 px-1 text-left"
                      >
                        <div>
                          <p className="font-black">
                            {session.hall || "ホール未入力"}
                          </p>
                          <p className="mt-1 text-sm text-zinc-400">
                            {session.date}・遊技 {session.plays.length}
                            件・総投資{" "}
                            {yen(calculateSession(session).totalInvestment)}
                          </p>
                        </div>
                        <span className="shrink-0 font-black text-amber-300">
                          編集する ›
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={createSeparateSession}
              className="w-full rounded-2xl border border-zinc-700 py-4 font-black text-zinc-200"
            >
              ＋ 別のノリ打ちを始める
            </button>
          </section>
        )}

        {page === "register" && (
          <section className="space-y-5">
            <div>
              <h2 className="text-2xl font-black">
                {editingId ? "記録を編集" : "新しいノリ打ち"}
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                実戦中は一時保存、交換後に確定できます
              </p>
            </div>

            <Card>
              <Input
                label="日付"
                type="date"
                value={form.date}
                onChange={(value) => updateSessionField("date", value)}
              />
              <div className="relative">
                <label className="block">
                  <span className="mb-2 block text-sm text-zinc-400">
                    ホール
                  </span>
                  <input
                    type="text"
                    value={form.hall}
                    placeholder="例：フェイス"
                    autoComplete="off"
                    onFocus={() => setHallSuggestionsOpen(true)}
                    onChange={(event) => {
                      updateSessionField("hall", event.target.value);
                      setHallSuggestionsOpen(true);
                    }}
                    onBlur={() => {
                      window.setTimeout(
                        () => setHallSuggestionsOpen(false),
                        150,
                      );
                    }}
                    className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 outline-none focus:border-amber-400"
                  />
                </label>

                {hallSuggestions.length > 0 && (
                  <div className="absolute inset-x-0 top-full z-30 mt-2 max-h-72 overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-2 shadow-2xl">
                    {hallSuggestions.map((hall) => (
                      <button
                        key={`${hall.name}-${hall.area}`}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          updateSessionField("hall", hall.name);
                          setHallSuggestionsOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left hover:bg-zinc-800"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-bold">
                            {hall.name}
                          </span>
                          <span className="mt-1 block text-xs text-zinc-500">
                            {hall.area}
                          </span>
                        </span>
                        {hall.source === "履歴" && (
                          <span className="shrink-0 rounded-full bg-amber-400/10 px-2 py-1 text-[10px] font-bold text-amber-300">
                            履歴
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                <p className="mt-2 text-xs text-zinc-500">
                  1文字以上入力すると福岡県内の候補が表示されます
                </p>
              </div>
            </Card>

            <Card>
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-black">遊技内容</h3>
                  <p className="text-sm text-zinc-400">台移動するたびに追加</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <AddButton
                  label="＋ スロット"
                  onClick={() => addPlay("slot")}
                />
                <AddButton
                  label="＋ パチンコ"
                  onClick={() => addPlay("pachinko")}
                />
              </div>

              {form.plays.length === 0 ? (
                <EmptyMini text="まだ遊技がありません" />
              ) : (
                <div className="mt-4 space-y-4">
                  {form.plays.map((play, index) => (
                    <div
                      id={`play-${play.id}`}
                      key={play.id}
                      className="scroll-mt-4 rounded-2xl bg-zinc-950 p-4"
                    >
                      <div className="mb-4 flex items-center justify-between">
                        <p className="font-black">
                          {index + 1}. {typeLabel(play.type)}
                        </p>
                        <button
                          type="button"
                          onClick={() => removePlay(play.id)}
                          className="text-sm font-bold text-rose-300"
                        >
                          削除
                        </button>
                      </div>

                      <div className="space-y-4">
                        <Select
                          label="遊技者"
                          value={play.member}
                          options={MEMBERS.map((member) => ({
                            value: member,
                            label: member,
                          }))}
                          onChange={(value) =>
                            updatePlay(play.id, "member", value as MemberName)
                          }
                        />

                        <Input
                          label="機種"
                          value={play.machine}
                          placeholder="例：東京喰種、エヴァ15"
                          onChange={(value) =>
                            updatePlay(play.id, "machine", value)
                          }
                        />

                        <NumberInput
                          label="投資金額"
                          value={play.investment}
                          suffix="円"
                          onChange={(value) =>
                            updatePlay(play.id, "investment", value)
                          }
                        />

                        <NumberInput
                          label={`その遊技で残った${unitLabel(play.type)}数`}
                          value={play.finalUnits}
                          suffix={unitLabel(play.type)}
                          onChange={(value) =>
                            updatePlay(play.id, "finalUnits", value)
                          }
                        />

                        <label
                          className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm font-bold ${
                            play.usesPreviousUnits
                              ? "border-amber-400 bg-amber-400/20 text-amber-200"
                              : hasPreviousSameTypePlay(form.plays, index)
                                ? "border-zinc-700 bg-zinc-900 text-zinc-200"
                                : "cursor-not-allowed border-zinc-800 bg-zinc-900/50 text-zinc-600"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={play.usesPreviousUnits ?? false}
                            disabled={
                              !hasPreviousSameTypePlay(form.plays, index)
                            }
                            onChange={(event) =>
                              updatePlay(
                                play.id,
                                "usesPreviousUnits",
                                event.target.checked,
                              )
                            }
                            className="sr-only"
                          />
                          <span
                            aria-hidden="true"
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-sm font-black ${
                              play.usesPreviousUnits
                                ? "border-amber-300 bg-amber-400 text-black"
                                : "border-zinc-500 bg-zinc-950 text-transparent"
                            }`}
                          >
                            ✓
                          </span>
                          <span>
                            前の台の持ち
                            {play.type === "slot" ? "メダル" : "玉"}を使用
                          </span>
                        </label>

                        <NumberInput
                          label={`1,000円あたりの貸出${unitLabel(play.type)}数`}
                          value={play.lendRate}
                          suffix={unitLabel(play.type)}
                          onChange={(value) =>
                            updatePlay(play.id, "lendRate", value)
                          }
                        />

                        <Input
                          label="メモ"
                          value={play.memo}
                          placeholder="任意"
                          onChange={(value) =>
                            updatePlay(play.id, "memo", value)
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <h3 className="text-xl font-black">受け渡し</h3>
              <p className="text-sm text-zinc-400">誰から誰へ渡したかを記録</p>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <AddButton
                  label="＋ メダル"
                  onClick={() => addTransfer("slot")}
                />
                <AddButton
                  label="＋ 持ち玉"
                  onClick={() => addTransfer("pachinko")}
                />
              </div>

              {form.transfers.length === 0 ? (
                <EmptyMini text="受け渡しがなければ、このままでOK" />
              ) : (
                <div className="mt-4 space-y-4">
                  {form.transfers.map((transfer) => (
                    <div
                      key={transfer.id}
                      className="rounded-2xl bg-zinc-950 p-4"
                    >
                      <div className="mb-3 flex items-center justify-between">
                        <p className="font-bold">{typeLabel(transfer.type)}</p>
                        <button
                          type="button"
                          onClick={() => removeTransfer(transfer.id)}
                          className="text-sm font-bold text-rose-300"
                        >
                          削除
                        </button>
                      </div>

                      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                        <Select
                          label="渡した人"
                          value={transfer.from}
                          options={MEMBERS.map((member) => ({
                            value: member,
                            label: member,
                          }))}
                          onChange={(value) =>
                            updateTransfer(
                              transfer.id,
                              "from",
                              value as MemberName,
                            )
                          }
                        />
                        <span className="pb-3">→</span>
                        <Select
                          label="受け取った人"
                          value={transfer.to}
                          options={MEMBERS.map((member) => ({
                            value: member,
                            label: member,
                          }))}
                          onChange={(value) =>
                            updateTransfer(
                              transfer.id,
                              "to",
                              value as MemberName,
                            )
                          }
                        />
                      </div>

                      <div className="mt-4">
                        <NumberInput
                          label="数量"
                          value={transfer.units}
                          suffix={unitLabel(transfer.type)}
                          onChange={(value) =>
                            updateTransfer(transfer.id, "units", value)
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <h3 className="text-xl font-black">交換</h3>
              <p className="text-sm text-zinc-400">
                まとめ交換・個別交換どちらも追加できます
              </p>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <AddButton
                  label="＋ スロット交換"
                  onClick={() => addExchange("slot")}
                />
                <AddButton
                  label="＋ パチンコ交換"
                  onClick={() => addExchange("pachinko")}
                />
              </div>

              {form.exchanges.length === 0 ? (
                <EmptyMini text="交換前なら空欄のまま一時保存できます" />
              ) : (
                <div className="mt-4 space-y-4">
                  {form.exchanges.map((exchange) => (
                    <div
                      key={exchange.id}
                      className="rounded-2xl bg-zinc-950 p-4"
                    >
                      <div className="mb-4 flex items-center justify-between">
                        <p className="font-black">
                          {typeLabel(exchange.type)}交換
                        </p>
                        <button
                          type="button"
                          onClick={() => removeExchange(exchange.id)}
                          className="text-sm font-bold text-rose-300"
                        >
                          削除
                        </button>
                      </div>

                      <p className="mb-2 text-sm text-zinc-400">
                        この交換に含まれる人
                      </p>
                      <div className="grid grid-cols-3 gap-2">
                        {MEMBERS.map((member) => {
                          const active = exchange.members.includes(member);
                          return (
                            <button
                              key={member}
                              type="button"
                              onClick={() =>
                                toggleExchangeMember(exchange.id, member)
                              }
                              className={`rounded-xl px-2 py-3 text-xs font-bold ${
                                active
                                  ? "bg-amber-400 text-black"
                                  : "bg-zinc-800 text-zinc-400"
                              }`}
                            >
                              {member}
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-4 space-y-4">
                        <NumberInput
                          label={`交換した${unitLabel(exchange.type)}数`}
                          value={exchange.units}
                          suffix={unitLabel(exchange.type)}
                          showZero
                          onChange={(value) =>
                            updateExchange(exchange.id, "units", value)
                          }
                        />
                        <NumberInput
                          label="交換金額"
                          value={exchange.yen}
                          suffix="円"
                          showZero
                          onChange={(value) =>
                            updateExchange(exchange.id, "yen", value)
                          }
                        />
                        <Input
                          label="交換メモ"
                          value={exchange.memo}
                          placeholder="任意"
                          onChange={(value) =>
                            updateExchange(exchange.id, "memo", value)
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <label className="block">
                <span className="mb-2 block text-sm text-zinc-400">
                  全体メモ
                </span>
                <textarea
                  value={form.memo}
                  onChange={(event) =>
                    updateSessionField("memo", event.target.value)
                  }
                  placeholder="今日の出来事、設定示唆など"
                  rows={3}
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 outline-none focus:border-amber-400"
                />
              </label>
            </Card>

            <div className="rounded-3xl border border-amber-500/40 bg-amber-400/10 p-5">
              <h3 className="text-xl font-black text-amber-300">
                精算プレビュー
              </h3>

              <div className="mt-4 space-y-2">
                <ResultRow
                  label="総投資"
                  value={yen(preview.totalInvestment)}
                />
                <ResultRow
                  label="交換金額"
                  value={yen(preview.totalExchangeYen)}
                />
                <ResultRow
                  label="全体収支"
                  value={signedYen(preview.totalProfit)}
                  positive={preview.totalProfit >= 0}
                />
                <ResultRow
                  label="1人あたりの収支"
                  value={signedYen(preview.equalProfit)}
                  positive={preview.equalProfit >= 0}
                />
                <ResultRow label="端数" value={yen(preview.remainder)} />
              </div>

              <div className="mt-5 space-y-3 border-t border-amber-500/20 pt-5">
                {preview.memberResults.map((result) => (
                  <div
                    key={result.member}
                    className="rounded-2xl bg-zinc-950/70 p-4"
                  >
                    <div className="flex items-center justify-between font-black">
                      <span>{result.member}</span>
                      <span>{yen(result.receipt)}</span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-400">受け取り予定</p>
                    <p className="mt-3 text-sm text-zinc-400">
                      総投資{" "}
                      <span className="font-black text-white">
                        {yen(result.investment)}
                      </span>
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-xl bg-zinc-900 p-2">
                        差枚 {units(result.netCoins, "slot")}
                      </div>
                      <div className="rounded-xl bg-zinc-900 p-2">
                        差玉 {units(result.netBalls, "pachinko")}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => saveSession("draft")}
                className="rounded-2xl bg-zinc-800 py-4 font-black"
              >
                一時保存
              </button>
              <button
                type="button"
                onClick={() => saveSession("confirmed")}
                className="rounded-2xl bg-amber-400 py-4 font-black text-black"
              >
                確定する
              </button>
            </div>
          </section>
        )}

        {page === "history" && (
          <section className="space-y-5">
            <div className="mb-5">
              <h2 className="text-2xl font-black">履歴</h2>
              <p className="mt-1 text-sm text-zinc-400">
                日付を選ぶと、その日の詳しい記録を確認できます
              </p>
            </div>

            {sessions.length === 0 ? (
              <EmptyState text="まだ記録がありません" />
            ) : (
              <>
                <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      aria-label="前の月"
                      onClick={() => {
                        setHistoryMonth((current) => shiftMonth(current, -1));
                        setSelectedHistoryDate(null);
                      }}
                      className="rounded-xl bg-zinc-800 px-4 py-2 text-xl font-black"
                    >
                      ‹
                    </button>
                    <h3 className="text-lg font-black">
                      {monthLabel(historyMonth)}
                    </h3>
                    <button
                      type="button"
                      aria-label="次の月"
                      onClick={() => {
                        setHistoryMonth((current) => shiftMonth(current, 1));
                        setSelectedHistoryDate(null);
                      }}
                      className="rounded-xl bg-zinc-800 px-4 py-2 text-xl font-black"
                    >
                      ›
                    </button>
                  </div>

                  <div className="mt-5 rounded-2xl bg-zinc-950 p-4">
                    <p className="text-sm text-zinc-400">当月の累計収支</p>
                    <p
                      className={`mt-1 text-3xl font-black ${
                        historyMonthProfit >= 0
                          ? "text-emerald-400"
                          : "text-rose-400"
                      }`}
                    >
                      {signedYen(historyMonthProfit)}
                    </p>
                    <p className="mt-2 text-xs text-zinc-500">
                      確定済み {historyMonthConfirmedSessions.length}件
                      {historyMonthSessions.length >
                        historyMonthConfirmedSessions.length &&
                        `・編集中 ${
                          historyMonthSessions.length -
                          historyMonthConfirmedSessions.length
                        }件`}
                    </p>
                  </div>

                  <div className="mt-5 grid grid-cols-7 gap-1 text-center text-xs font-bold text-zinc-500">
                    {["日", "月", "火", "水", "木", "金", "土"].map(
                      (weekday) => (
                        <div key={weekday} className="py-1">
                          {weekday}
                        </div>
                      ),
                    )}
                  </div>

                  <div className="mt-1 grid grid-cols-7 gap-1">
                    {calendarDates(historyMonth).map((date, index) => {
                      if (!date) {
                        return <div key={`empty-${index}`} />;
                      }

                      const daySessions = historyMonthSessions.filter(
                        (session) => session.date === date,
                      );
                      const confirmedDaySessions = daySessions.filter(
                        (session) => session.status === "confirmed",
                      );
                      const dayProfit = confirmedDaySessions.reduce(
                        (sum, session) =>
                          sum + calculateSession(session).totalProfit,
                        0,
                      );
                      const hasDraft = daySessions.some(
                        (session) => session.status === "draft",
                      );
                      const selected = selectedHistoryDate === date;

                      return (
                        <button
                          key={date}
                          type="button"
                          disabled={daySessions.length === 0}
                          onClick={() => setSelectedHistoryDate(date)}
                          className={`flex min-h-16 min-w-0 flex-col items-center rounded-xl border px-0.5 py-2 ${
                            selected
                              ? "border-amber-400 bg-amber-400/15"
                              : daySessions.length > 0
                                ? "border-zinc-700 bg-zinc-950"
                                : "border-transparent text-zinc-600"
                          }`}
                        >
                          <span className="text-xs font-bold">
                            {Number(date.slice(-2))}
                          </span>
                          {confirmedDaySessions.length > 0 && (
                            <span
                              className={`mt-1 max-w-full text-[10px] font-black tracking-tight ${
                                dayProfit >= 0
                                  ? "text-emerald-400"
                                  : "text-rose-400"
                              }`}
                            >
                              {compactSignedYen(dayProfit)}
                            </span>
                          )}
                          {hasDraft && (
                            <span className="mt-1 text-[9px] font-bold text-amber-300">
                              編集中
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {selectedHistoryDate ? (
                  <div className="space-y-4">
                    <h3 className="text-lg font-black">
                      {Number(selectedHistoryDate.slice(5, 7))}月
                      {Number(selectedHistoryDate.slice(8, 10))}日の記録
                    </h3>

                    {selectedDateSessions.filter(
                      (session) => session.status === "draft",
                    ).length >= 2 && (
                      <div className="rounded-3xl border border-amber-400/40 bg-amber-400/10 p-4">
                        <p className="text-sm text-zinc-300">
                          統合したい未確定記録を選んでね
                        </p>
                        <button
                          type="button"
                          disabled={draftMergeIds.length < 2 || isMergingDrafts}
                          onClick={() => void mergeSelectedDrafts()}
                          className="mt-3 w-full rounded-2xl bg-amber-400 py-3 font-black text-black disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {isMergingDrafts
                            ? "統合しています…"
                            : `選んだ記録を統合（${draftMergeIds.length}件）`}
                        </button>
                      </div>
                    )}

                    {selectedDateSessions.map((session) => {
                      const result = calculateSession(session);

                      return (
                        <details
                          key={session.id}
                          open
                          className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5"
                        >
                          <summary className="cursor-pointer list-none">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="flex items-center gap-2">
                                  <p className="font-black">
                                    {session.hall || "ホール未入力"}
                                  </p>
                                  <StatusBadge status={session.status} />
                                </div>
                                <p className="mt-1 text-sm text-zinc-400">
                                  遊技 {session.plays.length}件
                                </p>
                              </div>

                              {session.status === "confirmed" ? (
                                <p
                                  className={`font-black ${
                                    result.totalProfit >= 0
                                      ? "text-emerald-400"
                                      : "text-rose-400"
                                  }`}
                                >
                                  {signedYen(result.totalProfit)}
                                </p>
                              ) : (
                                <p className="font-bold text-amber-300">
                                  編集中
                                </p>
                              )}
                            </div>
                          </summary>

                          <div className="mt-5 border-t border-zinc-800 pt-5">
                            <div className="space-y-2">
                              <ResultRow
                                label="総投資"
                                value={yen(result.totalInvestment)}
                              />
                              <ResultRow
                                label="交換金額"
                                value={yen(result.totalExchangeYen)}
                              />
                              <ResultRow
                                label="全体収支"
                                value={signedYen(result.totalProfit)}
                                positive={result.totalProfit >= 0}
                              />
                              <ResultRow
                                label="1人あたりの収支"
                                value={signedYen(result.equalProfit)}
                                positive={result.equalProfit >= 0}
                              />
                              <ResultRow
                                label="端数"
                                value={yen(result.remainder)}
                              />
                            </div>

                            {session.status === "confirmed" && (
                              <div className="mt-5 space-y-3">
                                {result.memberResults.map((memberResult) => (
                                  <div
                                    key={memberResult.member}
                                    className="rounded-2xl bg-zinc-950 p-4"
                                  >
                                    <div className="flex justify-between font-black">
                                      <span>{memberResult.member}</span>
                                      <span>{yen(memberResult.receipt)}</span>
                                    </div>
                                    <p className="mt-1 text-xs text-zinc-400">
                                      受け取り
                                    </p>
                                    <p className="mt-3 text-sm text-zinc-400">
                                      総投資{" "}
                                      <span className="font-black text-white">
                                        {yen(memberResult.investment)}
                                      </span>
                                    </p>
                                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                                      <div className="rounded-xl bg-zinc-900 p-2">
                                        差枚{" "}
                                        {units(memberResult.netCoins, "slot")}
                                      </div>
                                      <div className="rounded-xl bg-zinc-900 p-2">
                                        差玉{" "}
                                        {units(
                                          memberResult.netBalls,
                                          "pachinko",
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {session.memo && (
                              <p className="mt-4 rounded-2xl bg-zinc-950 p-4 text-sm text-zinc-300">
                                {session.memo}
                              </p>
                            )}

                            {session.status === "draft" && (
                              <button
                                type="button"
                                onClick={() => toggleDraftMerge(session.id)}
                                className={`mt-5 flex w-full items-center justify-center gap-3 rounded-xl border py-3 font-black ${
                                  draftMergeIds.includes(session.id)
                                    ? "border-amber-300 bg-amber-400 text-black"
                                    : "border-amber-400/50 bg-amber-400/10 text-amber-300"
                                }`}
                              >
                                <span>
                                  {draftMergeIds.includes(session.id)
                                    ? "✓"
                                    : "□"}
                                </span>
                                {draftMergeIds.includes(session.id)
                                  ? "統合対象に選択中"
                                  : "統合対象に選ぶ"}
                              </button>
                            )}

                            {session.status === "confirmed" && (
                              <button
                                type="button"
                                onClick={() => {
                                  setDetailSessionId(session.id);
                                  setPage("detail");
                                  window.scrollTo({
                                    top: 0,
                                    behavior: "smooth",
                                  });
                                }}
                                className="mt-5 w-full rounded-xl border border-amber-400/50 bg-amber-400/10 py-3 font-black text-amber-300"
                              >
                                さらに詳しく見る
                              </button>
                            )}

                            <div className="mt-5 grid grid-cols-2 gap-3">
                              <button
                                type="button"
                                onClick={() => editSession(session)}
                                className="rounded-xl bg-amber-400 py-3 font-black text-black"
                              >
                                編集
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteSession(session.id)}
                                className="rounded-xl bg-rose-500/10 py-3 font-bold text-rose-300"
                              >
                                削除
                              </button>
                            </div>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-2xl border border-dashed border-zinc-700 p-5 text-center text-sm text-zinc-500">
                    金額または「編集中」がある日をタップすると詳細が表示されます
                  </p>
                )}
              </>
            )}
          </section>
        )}

        {page === "detail" && (
          <section className="space-y-5">
            <button
              type="button"
              onClick={() => setPage("history")}
              className="font-bold text-amber-300"
            >
              ← 履歴に戻る
            </button>

            {detailSession && detailResult ? (
              <>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-black">記録の詳細</h2>
                    <StatusBadge status={detailSession.status} />
                  </div>
                  <p className="mt-2 text-zinc-400">
                    {detailSession.date}・{detailSession.hall || "ホール未入力"}
                  </p>
                </div>

                <Card>
                  <h3 className="text-xl font-black">遊技内容</h3>
                  <div className="space-y-3">
                    {detailSession.plays.map((play, index) => (
                      <div
                        key={play.id}
                        className="rounded-2xl bg-zinc-950 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-black">
                              {index + 1}. {typeLabel(play.type)}
                            </p>
                            <p className="mt-1 text-sm text-zinc-400">
                              {play.machine || "機種未入力"}
                            </p>
                          </div>
                          <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs font-bold">
                            {play.member}
                          </span>
                        </div>

                        {play.usesPreviousUnits && (
                          <p className="mt-3 rounded-xl bg-amber-400/10 px-3 py-2 text-xs font-bold text-amber-300">
                            前の台の持ち
                            {play.type === "slot" ? "メダル" : "玉"}を使用
                          </p>
                        )}

                        <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                          <Stat label="投資金額" value={yen(play.investment)} />
                          <Stat
                            label={`残った${unitLabel(play.type)}数`}
                            value={`${Math.round(
                              play.finalUnits,
                            ).toLocaleString()}${unitLabel(play.type)}`}
                          />
                          <Stat
                            label="貸出レート"
                            value={`${play.lendRate.toLocaleString()}${unitLabel(
                              play.type,
                            )}/1,000円`}
                          />
                        </div>

                        {play.memo && (
                          <p className="mt-3 rounded-xl bg-zinc-900 p-3 text-sm text-zinc-300">
                            {play.memo}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>

                <Card>
                  <h3 className="text-xl font-black">受け渡し</h3>
                  {detailSession.transfers.length === 0 ? (
                    <p className="text-sm text-zinc-500">受け渡しなし</p>
                  ) : (
                    <div className="space-y-2">
                      {detailSession.transfers.map((transfer) => (
                        <div
                          key={transfer.id}
                          className="rounded-2xl bg-zinc-950 p-4"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-bold">
                              {transfer.from} → {transfer.to}
                            </p>
                            <span className="text-amber-300">
                              {transfer.units.toLocaleString()}
                              {unitLabel(transfer.type)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-zinc-500">
                            {typeLabel(transfer.type)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card>
                  <h3 className="text-xl font-black">交換内容</h3>
                  {detailSession.exchanges.length === 0 ? (
                    <p className="text-sm text-zinc-500">交換内容なし</p>
                  ) : (
                    <div className="space-y-3">
                      {detailSession.exchanges.map((exchange) => (
                        <div
                          key={exchange.id}
                          className="rounded-2xl bg-zinc-950 p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-black">
                                {typeLabel(exchange.type)}交換
                              </p>
                              <p className="mt-1 text-xs text-zinc-500">
                                {exchange.members.join("・")}
                              </p>
                            </div>
                            <p className="font-black text-amber-300">
                              {yen(exchange.yen)}
                            </p>
                          </div>
                          <p className="mt-3 text-sm text-zinc-300">
                            {exchange.units.toLocaleString()}
                            {unitLabel(exchange.type)}
                          </p>
                          {exchange.memo && (
                            <p className="mt-3 rounded-xl bg-zinc-900 p-3 text-sm text-zinc-300">
                              {exchange.memo}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                {detailSession.memo && (
                  <Card>
                    <h3 className="text-xl font-black">全体メモ</h3>
                    <p className="whitespace-pre-wrap text-sm text-zinc-300">
                      {detailSession.memo}
                    </p>
                  </Card>
                )}

                <div className="rounded-3xl border border-amber-500/40 bg-amber-400/10 p-5">
                  <h3 className="text-xl font-black text-amber-300">
                    精算結果
                  </h3>
                  <div className="mt-4 space-y-2">
                    <ResultRow
                      label="総投資"
                      value={yen(detailResult.totalInvestment)}
                    />
                    <ResultRow
                      label="交換金額"
                      value={yen(detailResult.totalExchangeYen)}
                    />
                    <ResultRow
                      label="全体収支"
                      value={signedYen(detailResult.totalProfit)}
                      positive={detailResult.totalProfit >= 0}
                    />
                    <ResultRow
                      label="1人あたりの収支"
                      value={signedYen(detailResult.equalProfit)}
                      positive={detailResult.equalProfit >= 0}
                    />
                    <ResultRow
                      label="端数"
                      value={yen(detailResult.remainder)}
                    />
                  </div>

                  <div className="mt-5 space-y-3 border-t border-amber-500/20 pt-5">
                    {detailResult.memberResults.map((result) => (
                      <div
                        key={result.member}
                        className="rounded-2xl bg-zinc-950/70 p-4"
                      >
                        <div className="flex items-center justify-between font-black">
                          <span>{result.member}</span>
                          <span>{yen(result.receipt)}</span>
                        </div>
                        <p className="mt-1 text-xs text-zinc-400">受け取り</p>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                          <Stat label="総投資" value={yen(result.investment)} />
                          <Stat
                            label="個人収支"
                            value={signedYen(result.personalProfit)}
                          />
                          <Stat
                            label="差枚"
                            value={units(result.netCoins, "slot")}
                          />
                          <Stat
                            label="差玉"
                            value={units(result.netBalls, "pachinko")}
                          />
                        </div>
                        <p className="mt-2 text-[10px] text-zinc-600">
                          個人収支は50枚＝1,000円・250玉＝1,000円で計算
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => editSession(detailSession)}
                  className="w-full rounded-2xl bg-amber-400 py-4 font-black text-black"
                >
                  この記録を編集
                </button>
              </>
            ) : (
              <EmptyState text="記録が見つかりません" />
            )}
          </section>
        )}

        {page === "ranking" && (
          <section className="space-y-5">
            <div>
              <h2 className="text-2xl font-black">ランキング</h2>
              <p className="mt-1 text-sm text-zinc-400">
                実質差枚・差玉でメンバーを比較します
              </p>
            </div>

            <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="grid grid-cols-2 gap-2 rounded-2xl bg-zinc-950 p-1">
                <button
                  type="button"
                  onClick={() => setAnalysisPeriod("month")}
                  className={`rounded-xl py-3 font-black ${
                    analysisPeriod === "month"
                      ? "bg-amber-400 text-black"
                      : "text-zinc-400"
                  }`}
                >
                  月間
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnalysisPeriod("year");
                    setAnalysisYear(analysisMonth.slice(0, 4));
                  }}
                  className={`rounded-xl py-3 font-black ${
                    analysisPeriod === "year"
                      ? "bg-amber-400 text-black"
                      : "text-zinc-400"
                  }`}
                >
                  年間
                </button>
              </div>

              <div className="mt-4 flex items-center justify-between">
                <button
                  type="button"
                  aria-label={analysisPeriod === "month" ? "前の月" : "前年"}
                  onClick={() => {
                    if (analysisPeriod === "month") {
                      setAnalysisMonth((current) => shiftMonth(current, -1));
                    } else {
                      setAnalysisYear((current) => String(Number(current) - 1));
                    }
                  }}
                  className="rounded-xl bg-zinc-800 px-4 py-2 text-xl font-black"
                >
                  ‹
                </button>
                <p className="text-lg font-black">{analysisPeriodLabel}</p>
                <button
                  type="button"
                  aria-label={analysisPeriod === "month" ? "次の月" : "翌年"}
                  onClick={() => {
                    if (analysisPeriod === "month") {
                      setAnalysisMonth((current) => shiftMonth(current, 1));
                    } else {
                      setAnalysisYear((current) => String(Number(current) + 1));
                    }
                  }}
                  className="rounded-xl bg-zinc-800 px-4 py-2 text-xl font-black"
                >
                  ›
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <Stat label="確定済み" value={`${analysisSessions.length}件`} />
                <Stat label="全体収支" value={signedYen(analysisProfit)} />
              </div>
            </div>

            {analysisSessions.length === 0 ? (
              <EmptyState
                text={`${analysisPeriodLabel}の確定済み記録はありません`}
              />
            ) : (
              <div className="space-y-4">
                {analysis.map((result, index) => (
                  <div
                    key={result.member}
                    className={`rounded-3xl border p-5 ${
                      index === 0
                        ? "border-amber-500/50 bg-amber-400/10"
                        : "border-zinc-800 bg-zinc-900"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-zinc-400">
                          {index === 0 ? "👑 1位" : `${index + 1}位`}
                        </p>
                        <h3 className="mt-1 text-xl font-black">
                          {result.member}
                        </h3>
                      </div>
                      <p className="text-right text-sm text-zinc-400">
                        累計投資
                        <br />
                        <span className="text-lg font-black text-white">
                          {yen(result.investment)}
                        </span>
                      </p>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <Stat
                        label="実質差枚"
                        value={units(result.netCoins, "slot")}
                      />
                      <Stat
                        label="実質差玉"
                        value={units(result.netBalls, "pachinko")}
                      />
                      <Stat
                        label="貸したメダル"
                        value={`${Math.round(result.sentCoins).toLocaleString()}枚`}
                      />
                      <Stat
                        label="借りたメダル"
                        value={`${Math.round(result.receivedCoins).toLocaleString()}枚`}
                      />
                      <Stat
                        label="貸した持ち玉"
                        value={`${Math.round(result.sentBalls).toLocaleString()}玉`}
                      />
                      <Stat
                        label="借りた持ち玉"
                        value={`${Math.round(result.receivedBalls).toLocaleString()}玉`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {page === "analysis" && (
          <section className="space-y-5">
            <div>
              <h2 className="text-2xl font-black">ホール別分析</h2>
              <p className="mt-1 text-sm text-zinc-400">
                確定済み記録からホールごとの成績を振り返れます
              </p>
            </div>

            <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="grid grid-cols-2 gap-2 rounded-2xl bg-zinc-950 p-1">
                <button
                  type="button"
                  onClick={() => setAnalysisPeriod("month")}
                  className={`rounded-xl py-3 font-black ${
                    analysisPeriod === "month"
                      ? "bg-amber-400 text-black"
                      : "text-zinc-400"
                  }`}
                >
                  月間
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnalysisPeriod("year");
                    setAnalysisYear(analysisMonth.slice(0, 4));
                  }}
                  className={`rounded-xl py-3 font-black ${
                    analysisPeriod === "year"
                      ? "bg-amber-400 text-black"
                      : "text-zinc-400"
                  }`}
                >
                  年間
                </button>
              </div>

              <div className="mt-4 flex items-center justify-between">
                <button
                  type="button"
                  aria-label={analysisPeriod === "month" ? "前の月" : "前年"}
                  onClick={() => {
                    if (analysisPeriod === "month") {
                      setAnalysisMonth((current) => shiftMonth(current, -1));
                    } else {
                      setAnalysisYear((current) => String(Number(current) - 1));
                    }
                  }}
                  className="rounded-xl bg-zinc-800 px-4 py-2 text-xl font-black"
                >
                  ‹
                </button>
                <p className="text-lg font-black">{analysisPeriodLabel}</p>
                <button
                  type="button"
                  aria-label={analysisPeriod === "month" ? "次の月" : "翌年"}
                  onClick={() => {
                    if (analysisPeriod === "month") {
                      setAnalysisMonth((current) => shiftMonth(current, 1));
                    } else {
                      setAnalysisYear((current) => String(Number(current) + 1));
                    }
                  }}
                  className="rounded-xl bg-zinc-800 px-4 py-2 text-xl font-black"
                >
                  ›
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <Stat label="確定済み" value={`${analysisSessions.length}件`} />
                <Stat label="全体収支" value={signedYen(analysisProfit)} />
                <Stat label="遊技ホール" value={`${hallAnalysis.length}店`} />
                <Stat
                  label="1回平均"
                  value={signedYen(
                    analysisSessions.length > 0
                      ? analysisProfit / analysisSessions.length
                      : 0,
                  )}
                />
              </div>
            </div>

            {hallAnalysis.length === 0 ? (
              <EmptyState
                text={`${analysisPeriodLabel}の確定済み記録はありません`}
              />
            ) : (
              <div className="space-y-4">
                {hallAnalysis.map((hall, index) => {
                  const averageProfit = hall.totalProfit / hall.visits;
                  const winRate = Math.round((hall.wins / hall.visits) * 100);

                  return (
                    <div
                      key={normalizeHallSearch(hall.name) || hall.name}
                      className={`rounded-3xl border p-5 ${
                        index === 0 && hall.totalProfit > 0
                          ? "border-emerald-500/40 bg-emerald-400/10"
                          : "border-zinc-800 bg-zinc-900"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-zinc-500">
                            収支順 {index + 1}位
                          </p>
                          <h3 className="mt-1 break-words text-xl font-black">
                            {hall.name}
                          </h3>
                          <p className="mt-1 text-sm text-zinc-400">
                            {hall.visits}回・{hall.wins}勝{hall.losses}敗
                            {hall.draws > 0 ? `${hall.draws}分` : ""}
                          </p>
                        </div>
                        <p
                          className={`shrink-0 text-lg font-black ${
                            hall.totalProfit >= 0
                              ? "text-emerald-400"
                              : "text-rose-400"
                          }`}
                        >
                          {signedYen(hall.totalProfit)}
                        </p>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <Stat label="勝率" value={`${winRate}%`} />
                        <Stat
                          label="1回平均"
                          value={signedYen(averageProfit)}
                        />
                        <Stat
                          label="総投資"
                          value={yen(hall.totalInvestment)}
                        />
                        <Stat
                          label="総交換金額"
                          value={yen(hall.totalExchange)}
                        />
                        <Stat
                          label="最高収支"
                          value={signedYen(hall.bestProfit)}
                        />
                        <Stat
                          label="最低収支"
                          value={signedYen(hall.worstProfit)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>

      <nav className="fixed inset-x-0 bottom-0 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto grid max-w-md grid-cols-5">
          <NavButton
            active={page === "home" || page === "drafts"}
            label="ホーム"
            icon="🏠"
            onClick={() => setPage("home")}
          />
          <NavButton
            active={page === "register"}
            label="登録"
            icon="＋"
            onClick={startNew}
          />
          <NavButton
            active={page === "history" || page === "detail"}
            label="履歴"
            icon="📖"
            onClick={() => setPage("history")}
          />
          <NavButton
            active={page === "ranking"}
            label="ランキング"
            icon="🏆"
            onClick={() => setPage("ranking")}
          />
          <NavButton
            active={page === "analysis"}
            label="分析"
            icon="📊"
            onClick={() => setPage("analysis")}
          />
        </div>
      </nav>
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4 rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
      {children}
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm text-zinc-400">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 outline-none focus:border-amber-400"
      />
    </label>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  suffix,
  showZero = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix: string;
  showZero?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min="0"
          inputMode="numeric"
          value={showZero || value !== 0 ? value : ""}
          placeholder="0"
          onChange={(event) => onChange(Number(event.target.value))}
          className="min-w-0 flex-1 rounded-xl border border-zinc-700 bg-zinc-950 p-3 outline-none focus:border-amber-400"
        />
        <span className="w-8 text-zinc-400">{suffix}</span>
      </div>
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-sm text-zinc-400">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-900 p-3 outline-none focus:border-amber-400"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ResultRow({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-zinc-400">{label}</span>
      <span
        className={`font-bold ${
          positive === undefined
            ? ""
            : positive
              ? "text-emerald-400"
              : "text-rose-400"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span
      className={`rounded-full px-2 py-1 text-xs font-bold ${
        status === "confirmed"
          ? "bg-emerald-400/10 text-emerald-300"
          : "bg-amber-400/10 text-amber-300"
      }`}
    >
      {status === "confirmed" ? "確定" : "未確定"}
    </span>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl bg-amber-400 px-3 py-3 text-sm font-black text-black"
    >
      {label}
    </button>
  );
}

function NavButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1 py-3 text-xs ${
        active ? "font-bold text-amber-400" : "text-zinc-500"
      }`}
    >
      <span className="text-lg">{icon}</span>
      {label}
    </button>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-zinc-700 p-8 text-center text-zinc-500">
      {text}
    </div>
  );
}

function EmptyMini({ text }: { text: string }) {
  return (
    <p className="mt-4 rounded-2xl bg-zinc-950 p-4 text-sm text-zinc-500">
      {text}
    </p>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-zinc-950 p-3">
      <p className="text-zinc-500">{label}</p>
      <p className="mt-1 font-bold">{value}</p>
    </div>
  );
}
