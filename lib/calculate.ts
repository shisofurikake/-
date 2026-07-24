import {
  MEMBERS,
  MemberName,
  NoriuchiSession,
  PlayType,
  SessionCalculation,
} from "../types";

function getPurchasedUnits(
  investment: number,
  lendRate: number,
) {
  if (investment <= 0 || lendRate <= 0) {
    return 0;
  }

  return (investment / 1000) * lendRate;
}

function getMemberInvestment(
  session: NoriuchiSession,
  member: MemberName,
) {
  return session.plays
    .filter((play) => play.member === member)
    .reduce((sum, play) => sum + play.investment, 0);
}

function getMemberFinalUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  return session.plays
    .filter(
      (play) =>
        play.member === member &&
        play.type === type,
    )
    .reduce((sum, play) => sum + play.finalUnits, 0);
}

function getMemberPurchasedUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  return session.plays
    .filter(
      (play) =>
        play.member === member &&
        play.type === type,
    )
    .reduce(
      (sum, play) =>
        sum +
        getPurchasedUnits(
          play.investment,
          play.lendRate,
        ),
      0,
    );
}

function getSentUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  return session.transfers
    .filter(
      (transfer) =>
        transfer.from === member &&
        transfer.type === type,
    )
    .reduce(
      (sum, transfer) => sum + transfer.units,
      0,
    );
}

function getReceivedUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  return session.transfers
    .filter(
      (transfer) =>
        transfer.to === member &&
        transfer.type === type,
    )
    .reduce(
      (sum, transfer) => sum + transfer.units,
      0,
    );
}

function calculateNetUnits(
  session: NoriuchiSession,
  member: MemberName,
  type: PlayType,
) {
  const finalUnits = getMemberFinalUnits(
    session,
    member,
    type,
  );

  const sentUnits = getSentUnits(
    session,
    member,
    type,
  );

  const receivedUnits = getReceivedUnits(
    session,
    member,
    type,
  );

  const purchasedUnits = getMemberPurchasedUnits(
    session,
    member,
    type,
  );

  return (
    finalUnits +
    sentUnits -
    receivedUnits -
    purchasedUnits
  );
}

export function calculateSession(
  session: NoriuchiSession,
): SessionCalculation {
  const totalInvestment = MEMBERS.reduce(
    (sum, member) =>
      sum + getMemberInvestment(session, member),
    0,
  );

  const totalExchangeYen = session.exchanges.reduce(
    (sum, exchange) => sum + exchange.yen,
    0,
  );

  const totalProfit =
    totalExchangeYen - totalInvestment;

  const distributableYen =
    Math.floor(totalExchangeYen / 100) * 100;

  const remainder =
    totalExchangeYen - distributableYen;

  const baseReceipt =
    Math.floor(
      distributableYen / MEMBERS.length / 100,
    ) * 100;

  const memberResults = MEMBERS.map((member) => {
    const investment = getMemberInvestment(
      session,
      member,
    );

    const receipt = baseReceipt;

    return {
      member,
      investment,
      receipt,
      balance: receipt - investment,
      netCoins: calculateNetUnits(
        session,
        member,
        "slot",
      ),
      netBalls: calculateNetUnits(
        session,
        member,
        "pachinko",
      ),
      sentCoins: getSentUnits(
        session,
        member,
        "slot",
      ),
      receivedCoins: getReceivedUnits(
        session,
        member,
        "slot",
      ),
      sentBalls: getSentUnits(
        session,
        member,
        "pachinko",
      ),
      receivedBalls: getReceivedUnits(
        session,
        member,
        "pachinko",
      ),
    };
  });

  const distributedTotal =
    memberResults.reduce(
      (sum, result) => sum + result.receipt,
      0,
    );

  return {
    totalInvestment,
    totalExchangeYen,
    totalProfit,
    remainder:
      totalExchangeYen - distributedTotal,
    memberResults,
  };
}

export function getSessionMvp(
  session: NoriuchiSession,
) {
  const result = calculateSession(session);

  return [...result.memberResults].sort(
    (a, b) =>
      b.netCoins +
      b.netBalls -
      (a.netCoins + a.netBalls),
  )[0];
}