export const MEMBERS = [
  "すぎさん",
  "こうちさん",
  "こんちゃみ",
] as const;

export type MemberName = (typeof MEMBERS)[number];

export type SessionStatus = "draft" | "confirmed";

export type PlayType = "slot" | "pachinko";

export type UnitType = "coins" | "balls";

/**
 * 1人分の遊技内容
 *
 * 1台ごとに追加できるため、
 * 同じホールでスロットとパチンコの両方を遊技できます。
 */
export type PlayEntry = {
  id: string;
  type: PlayType;
  member: MemberName;
  machine: string;
  investment: number;

  /**
   * スロットなら枚数、パチンコなら玉数。
   */
  finalUnits: number;

  /**
   * 1,000円あたりの貸出枚数・貸玉数。
   * 例：
   * 46枚貸し → 46
   * 250玉貸し → 250
   */
  lendRate: number;

  memo: string;
};

/**
 * メダル・持ち玉の受け渡し。
 */
export type Transfer = {
  id: string;
  from: MemberName;
  to: MemberName;
  type: PlayType;
  units: number;
};

/**
 * 景品交換の明細。
 *
 * 全員まとめて交換した場合も、
 * 個人別・一部メンバーで交換した場合も登録できます。
 */
export type ExchangeEntry = {
  id: string;

  /**
   * この交換に含まれるメンバー。
   */
  members: MemberName[];

  type: PlayType;
  units: number;
  yen: number;
  memo: string;
};

/**
 * 1つのホールでのノリ打ち記録。
 *
 * 同じ日・同じホールでも、
 * 別の記録として何件でも保存できます。
 */
export type NoriuchiSession = {
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

export type SettlementResult = {
  member: MemberName;

  /**
   * その人が実際に投資した総額。
   */
  investment: number;

  /**
   * 最終的にその人が受け取る金額。
   */
  receipt: number;

  /**
   * 投資額との差額。
   */
  balance: number;

  /**
   * スロットの実質差枚。
   */
  netCoins: number;

  /**
   * パチンコの実質差玉。
   */
  netBalls: number;

  sentCoins: number;
  receivedCoins: number;
  sentBalls: number;
  receivedBalls: number;
};

export type SessionCalculation = {
  totalInvestment: number;
  totalExchangeYen: number;
  totalProfit: number;

  /**
   * 100円単位など、3人で均等に分けきらない金額。
   */
  remainder: number;

  memberResults: SettlementResult[];
};