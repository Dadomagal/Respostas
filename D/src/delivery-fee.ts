export type Tier = "ouro" | "prata" | "bronze" | "sem_nivel";

export type Order = {
  id: string;
  total: number;
  cost: number;
  commissionPct: number;
};

export type ProfitResult = {
  tier: Tier;
  deliveryFee: number;
  profit: number;
};

export const DELIVERY_FEES: Record<Exclude<Tier, "sem_nivel">, number> = {
  ouro: 11.2,
  prata: 7.5,
  bronze: 4.9,
};

export const COMMISSION_PCT = 0.23;

export type TierSource = "v1.tier" | "v2.tier_id" | "v3.merchant.tier_id";

export type DriftLogEntry = {
  event: "partner_tier_drift";
  source: TierSource;
  rawValue: string;
  resolvedTo: Tier;
  at: string;
};

type DriftSink = (entry: DriftLogEntry) => void;

const defaultDriftSink: DriftSink = (entry) => {
  console.warn(JSON.stringify(entry));
};

let driftSink: DriftSink = defaultDriftSink;

export function setDriftLogSink(sink: DriftSink | null): void {
  driftSink = sink ?? defaultDriftSink;
}

export const EXAMPLE_ORDERS: readonly (Order & { tierInput: unknown })[] = [
  { id: "P-1", total: 80.0, cost: 27.92, commissionPct: COMMISSION_PCT, tierInput: { tier_id: "3_gold" } },
  { id: "P-2", total: 70.0, cost: 30.19, commissionPct: COMMISSION_PCT, tierInput: { tier_id: "2_silver" } },
  { id: "P-3", total: 40.0, cost: 18.44, commissionPct: COMMISSION_PCT, tierInput: { tier_id: "1_bronze" } },
];

const TIER_BY_RAW: Record<string, Exclude<Tier, "sem_nivel">> = {
  ouro: "ouro",
  prata: "prata",
  bronze: "bronze",
  "1_bronze": "bronze",
  "2_silver": "prata",
  "3_gold": "ouro",
};

export function resolveTier(input: unknown): Tier {
  const raw = extractRawTier(input);
  if (raw === undefined) return "sem_nivel";

  const normalized = raw.value.trim().toLowerCase();
  const tier: Tier = TIER_BY_RAW[normalized] ?? "sem_nivel";

  if (tier === "sem_nivel") emitDriftLog(raw.source, raw.value);
  return tier;
}

type RawTier = { value: string; source: TierSource };

function extractRawTier(input: unknown): RawTier | undefined {
  if (!isRecord(input)) return undefined;

  const merchant = input["merchant"];
  const v1 = asString(input["tier"]);
  const v2 = asString(input["tier_id"]);
  const v3 = isRecord(merchant) ? asString(merchant["tier_id"]) : undefined;

  // `??` (e não `||`) de propósito: string vazia é payload corrompido e deve
  // vencer o fallback, caindo em "sem_nivel" — nunca pular para a próxima versão.
  const chosen = v1 ?? v2 ?? v3;
  if (chosen === undefined) return undefined;

  const source: TierSource =
    v1 !== undefined ? "v1.tier" : v2 !== undefined ? "v2.tier_id" : "v3.merchant.tier_id";
  return { value: chosen, source };
}

export function getDeliveryFee(tier: Tier): number {
  if (tier === "sem_nivel") return 0;
  return DELIVERY_FEES[tier] ?? 0;
}

export function computeProfit(order: Order, tierInput: unknown): ProfitResult {
  const tier = resolveTier(tierInput);
  const deliveryFee = getDeliveryFee(tier);
  const total = finiteOrZero(order.total);
  const cost = finiteOrZero(order.cost);
  const commission = total * sanitizeCommissionPct(order.commissionPct);
  return {
    tier,
    deliveryFee,
    profit: round2(total - cost - commission - deliveryFee),
  };
}

function emitDriftLog(source: TierSource, rawValue: string): void {
  driftSink({
    event: "partner_tier_drift",
    source,
    rawValue,
    resolvedTo: "sem_nivel",
    at: new Date().toISOString(),
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sanitizeCommissionPct(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
