import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  COMMISSION_PCT,
  DELIVERY_FEES,
  EXAMPLE_ORDERS,
  computeProfit,
  getDeliveryFee,
  resolveTier,
  setDriftLogSink,
  type DriftLogEntry,
  type Order,
} from "./delivery-fee";

describe("TDD: sintoma original (taxa R$ 0,00 com selo ouro)", () => {
  // Código antigo: fallback assumia "ouro", consultava a tabela com o código
  // cru ("3_gold"), não achava preço e devolvia taxa 0 — lucro inflado.
  it("tier_id '3_gold' resolve 'ouro' com taxa 11,20 e lucro líquido", () => {
    const result = computeProfit(
      { id: "bug", total: 80, cost: 27.92, commissionPct: COMMISSION_PCT },
      { tier_id: "3_gold" },
    );
    expect(result.tier, "selo precisa bater com o nível real").toBe("ouro");
    expect(result.deliveryFee, "taxa não pode ser 0 (bug original)").toBe(11.2);
    expect(result.profit, "lucro = total - custo - comissão - taxa").toBe(22.48);
  });

  it("nenhum pedido de exemplo fica com taxa 0 ou lucro sem descontos", () => {
    for (const order of EXAMPLE_ORDERS) {
      const result = computeProfit(order, order.tierInput);
      expect(result.deliveryFee, `pedido ${order.id}: taxa`).toBeGreaterThan(0);
      expect(result.profit, `pedido ${order.id}: lucro`).toBeLessThan(order.total - order.cost);
    }
  });
});

describe("pedidos de exemplo (P-1, P-2, P-3) — tabela executiva", () => {
  const EXPECTED = [
    { id: "P-1", tier: "ouro", fee: 11.2, before: 33.68, after: 22.48 },
    { id: "P-2", tier: "prata", fee: 7.5, before: 23.71, after: 16.21 },
    { id: "P-3", tier: "bronze", fee: 4.9, before: 12.36, after: 7.46 },
  ] as const;

  it("devolve taxa, lucro antes (taxa 0) e lucro depois exatos por pedido", () => {
    EXPECTED.forEach((exp, index) => {
      const order = EXAMPLE_ORDERS[index]!;
      const result = computeProfit(order, order.tierInput);
      expect(result.tier, order.id).toBe(exp.tier);
      expect(result.deliveryFee, `${order.id}: taxa`).toBe(exp.fee);
      expect(result.profit, `${order.id}: lucro depois`).toBe(exp.after);
      expect(
        result.profit + result.deliveryFee,
        `${order.id}: lucro antes (taxa R$ 0,00)`,
      ).toBeCloseTo(exp.before, 2);
    });
  });

  it("totais da tabela: taxa 23,60 | antes 69,75 | depois 46,15 | diferença −23,60", () => {
    const results = EXAMPLE_ORDERS.map((order) => computeProfit(order, order.tierInput));
    const feeTotal = results.reduce((sum, r) => sum + r.deliveryFee, 0);
    const beforeTotal = results.reduce((sum, r) => sum + r.profit + r.deliveryFee, 0);
    const afterTotal = results.reduce((sum, r) => sum + r.profit, 0);
    expect(feeTotal, "taxa de entrega total").toBeCloseTo(23.6, 2);
    expect(beforeTotal, "lucro antes total").toBeCloseTo(69.75, 2);
    expect(afterTotal, "lucro depois total").toBeCloseTo(46.15, 2);
    expect(afterTotal - beforeTotal, "diferença real").toBeCloseTo(-23.6, 2);
  });
});

describe("getDeliveryFee", () => {
  it("tabela oficial: ouro 11,20 | prata 7,50 | bronze 4,90", () => {
    expect(getDeliveryFee("ouro")).toBe(11.2);
    expect(getDeliveryFee("prata")).toBe(7.5);
    expect(getDeliveryFee("bronze")).toBe(4.9);
  });

  it("'sem_nivel' é estritamente 0 (nunca inventa taxa)", () => {
    expect(getDeliveryFee("sem_nivel")).toBe(0);
  });
});

describe("mapeamento resolveTier (v1, v2, v3)", () => {
  it("v1: { tier: 'ouro' | 'prata' | 'bronze' }", () => {
    expect(resolveTier({ tier: "ouro" })).toBe("ouro");
    expect(resolveTier({ tier: "prata" })).toBe("prata");
    expect(resolveTier({ tier: "bronze" })).toBe("bronze");
  });

  it("v2: { tier_id: '3_gold' | '2_silver' | '1_bronze' }", () => {
    expect(resolveTier({ tier_id: "3_gold" })).toBe("ouro");
    expect(resolveTier({ tier_id: "2_silver" })).toBe("prata");
    expect(resolveTier({ tier_id: "1_bronze" })).toBe("bronze");
  });

  it("v3: { merchant: { tier_id: ... } }", () => {
    expect(resolveTier({ merchant: { tier_id: "3_gold" } })).toBe("ouro");
    expect(resolveTier({ merchant: { tier_id: "2_silver" } })).toBe("prata");
    expect(resolveTier({ merchant: { tier_id: "1_bronze" } })).toBe("bronze");
  });

  it("códigos novos também resolvem via v1", () => {
    expect(resolveTier({ tier: "3_gold" })).toBe("ouro");
    expect(resolveTier({ tier: "2_silver" })).toBe("prata");
    expect(resolveTier({ tier: "1_bronze" })).toBe("bronze");
  });

  it("normaliza caixa e espaços", () => {
    expect(resolveTier({ tier_id: " 3_GOLD " })).toBe("ouro");
    expect(resolveTier({ tier: " PRATA " })).toBe("prata");
  });

  it("precedência v1 > v2 > v3", () => {
    expect(resolveTier({ tier: "bronze", tier_id: "3_gold" })).toBe("bronze");
    expect(resolveTier({ tier_id: "prata", merchant: { tier_id: "3_gold" } })).toBe("prata");
  });

  it("string vazia em v1 NÃO cai para v2 (dado corrompido vira sem_nivel)", () => {
    expect(resolveTier({ tier: "", tier_id: "3_gold" })).toBe("sem_nivel");
  });

  it("nulo, ausente, inválido ou desconhecido → 'sem_nivel', NUNCA 'ouro'", () => {
    expect(resolveTier(null)).toBe("sem_nivel");
    expect(resolveTier(undefined)).toBe("sem_nivel");
    expect(resolveTier("ouro")).toBe("sem_nivel");
    expect(resolveTier(42)).toBe("sem_nivel");
    expect(resolveTier(NaN)).toBe("sem_nivel");
    expect(resolveTier({})).toBe("sem_nivel");
    expect(resolveTier({ tier: null })).toBe("sem_nivel");
    expect(resolveTier({ tier_id: 7 })).toBe("sem_nivel");
    expect(resolveTier({ merchant: {} })).toBe("sem_nivel");
    expect(resolveTier({ merchant: null })).toBe("sem_nivel");
    expect(resolveTier({ tier_id: "9_platinum" })).toBe("sem_nivel");
    expect(resolveTier({ merchant: { tier_id: "x_black" } })).toBe("sem_nivel");
  });

  it("sem_nivel implica taxa estritamente 0 e lucro = total − custo − comissão", () => {
    const result = computeProfit(
      { id: "o", total: 100, cost: 30, commissionPct: 0.2 },
      { tier_id: "9_platinum" },
    );
    expect(result).toEqual({ tier: "sem_nivel", deliveryFee: 0, profit: 50 });
  });
});

describe("comissão percentual (computeProfit)", () => {
  it("desconta total × commissionPct além de custo e taxa", () => {
    const result = computeProfit(
      { id: "c", total: 200, cost: 50, commissionPct: 0.15 },
      { tier: "ouro" },
    );
    expect(result.deliveryFee).toBe(11.2);
    expect(result.profit, "200 − 50 − (200 × 0.15) − 11.20").toBeCloseTo(108.8, 2);
  });

  it("commissionPct inválido (NaN, ±Infinity, fora de [0,1], tipo errado) vira 0 — nunca lucro inválido", () => {
    const invalid: readonly unknown[] = [NaN, Infinity, -Infinity, -0.5, 1.5, "0.23", null, undefined];
    for (const pct of invalid) {
      const order = { id: "c", total: 100, cost: 30, commissionPct: pct } as unknown as Order;
      const result = computeProfit(order, { tier: "bronze" });
      expect(Number.isFinite(result.profit), `commissionPct=${String(pct)}`).toBe(true);
      expect(result.profit, `commissionPct=${String(pct)} deve cair em 0`).toBeCloseTo(65.1, 2);
    }
  });

  it("total/cost não finitos são saneados para 0 (nunca NaN no lucro)", () => {
    const result = computeProfit(
      { id: "c", total: Number.NaN, cost: Number.POSITIVE_INFINITY, commissionPct: 0.23 },
      { tier_id: "3_gold" },
    );
    expect(result.profit).toBe(-11.2);
  });
});

describe("drift log (tier desconhecido do parceiro)", () => {
  const captured: DriftLogEntry[] = [];

  afterEach(() => {
    setDriftLogSink(null);
    captured.length = 0;
  });

  it("emite registro estruturado quando chega tier desconhecido", () => {
    setDriftLogSink((entry) => captured.push(entry));

    resolveTier({ tier_id: "9_platinum" });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.event).toBe("partner_tier_drift");
    expect(captured[0]?.source).toBe("v2.tier_id");
    expect(captured[0]?.rawValue).toBe("9_platinum");
    expect(captured[0]?.resolvedTo).toBe("sem_nivel");
    expect(typeof captured[0]?.at).toBe("string");
  });

  it("registra a origem correta (v1, v2 ou v3) do valor desconhecido", () => {
    setDriftLogSink((entry) => captured.push(entry));

    resolveTier({ tier: "4_platinum" });
    resolveTier({ merchant: { tier_id: "y_black" } });

    expect(captured).toHaveLength(2);
    expect(captured[0]?.source).toBe("v1.tier");
    expect(captured[0]?.rawValue).toBe("4_platinum");
    expect(captured[1]?.source).toBe("v3.merchant.tier_id");
    expect(captured[1]?.rawValue).toBe("y_black");
  });

  it("tiers conhecidos e payloads sem nível não geram drift", () => {
    setDriftLogSink((entry) => captured.push(entry));

    resolveTier({ tier: "ouro" });
    resolveTier({ tier_id: "2_silver" });
    resolveTier({ merchant: { tier_id: "1_bronze" } });
    resolveTier(null);
    resolveTier({});

    expect(captured).toHaveLength(0);
  });
});

describe("fuzzing determinístico (PRNG mulberry32, seed 123)", () => {
  const SEED = 123;
  const FUZZ_ORDER: Order = { id: "fuzz", total: 100, cost: 30, commissionPct: 0.2 };
  const VALID_FUZZ_PROFIT = 50; // 100 − 30 − (100 × 0.2) − 0

  const GARBAGE_POOL: readonly unknown[] = [
    "", "   ", "gold", "GOLD", "prata2", "4_platinum", "1_bronze!",
    0, 1, -3.5, 42, NaN, Infinity, true, false,
    null, undefined,
    [], ["ouro"], [1, 2],
    {}, { tier: null }, { tier: 123 }, { tier: "" }, { tier: "3_goldx" }, { tier: NaN },
    { tier_id: null }, { tier_id: 7 }, { tier_id: "" }, { tier_id: {} }, { tier_id: "x_black" },
    { merchant: null }, { merchant: "x" }, { merchant: {} },
    { merchant: { tier_id: null } }, { merchant: { tier_id: 9 } }, { merchant: { tier_id: "y_silver?" } },
    { tier: "gold", tier_id: 5, merchant: 3 },
    { tier: "", tier_id: "3_gold" },
    new Date(0),
    () => "ouro",
  ];

  const RANDOM_KEYS = ["tier", "tier_id", "merchant", "outro"] as const;

  const RANDOM_VALUES: readonly unknown[] = [
    "", "  ", "gold", "GOLD", "9_platinum", null, undefined, 3, -1.5, NaN, Infinity, true,
    {}, [1], { tier_id: "x_y" }, { tier_id: null },
  ];

  const ORDER_VALUE_POOL: readonly unknown[] = [
    100, 27.92, 0, -50, -0.01, NaN, Infinity, -Infinity, "80", "", null, undefined, true, [100], { total: 1 },
  ];

  const KNOWN_TIER_INPUTS: readonly unknown[] = [
    { tier: "ouro" }, { tier: "prata" }, { tier: "bronze" },
    { tier_id: "3_gold" }, { tier_id: "2_silver" }, { tier_id: "1_bronze" },
    { merchant: { tier_id: "2_silver" } }, { tier_id: "9_platinum" }, null, "ouro", 42,
  ];

  function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick<T>(items: readonly T[], rng: () => number): T {
    return items[Math.floor(rng() * items.length)]!;
  }

  function buildFuzzData(rng: () => number): {
    tierInputs: unknown[];
    mixed: { order: unknown; tierInput: unknown }[];
  } {
    const tierInputs: unknown[] = [...GARBAGE_POOL];
    for (let i = 0; i < 300; i++) {
      if (rng() < 0.4) {
        tierInputs.push(pick(RANDOM_VALUES, rng));
        continue;
      }
      const obj: Record<string, unknown> = {};
      const count = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < count; k++) {
        obj[pick(RANDOM_KEYS, rng)] = pick(RANDOM_VALUES, rng);
      }
      tierInputs.push(obj);
    }

    const mixed: { order: unknown; tierInput: unknown }[] = [];
    for (let i = 0; i < 60; i++) {
      const order: Record<string, unknown> = { id: `fuzz-${i}` };
      for (const field of ["total", "cost", "commissionPct"] as const) {
        if (rng() < 0.85) order[field] = pick(ORDER_VALUE_POOL, rng);
      }
      mixed.push({ order, tierInput: pick(KNOWN_TIER_INPUTS, rng) });
    }
    return { tierInputs, mixed };
  }

  function mustCompute(order: Order, tierInput: unknown, label: string) {
    try {
      return computeProfit(order, tierInput);
    } catch (error) {
      throw new Error(`${label} lançou exceção: ${String(error)}`);
    }
  }

  function safeJson(value: unknown): string {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }

  beforeEach(() => setDriftLogSink(() => {}));
  afterEach(() => setDriftLogSink(null));

  it("roda 341 cenários de tierInput sem lançar exceção: tudo vira sem_nivel com taxa 0 e lucro válido", () => {
    const { tierInputs } = buildFuzzData(mulberry32(SEED));
    expect(tierInputs.length, `seed=${SEED}`).toBeGreaterThanOrEqual(300);

    tierInputs.forEach((input, index) => {
      const label = `seed=${SEED}, cenário #${index}, input=${safeJson(input)}`;
      const result = mustCompute(FUZZ_ORDER, input, label);
      expect(result.tier, label).toBe("sem_nivel");
      expect(result.deliveryFee, label).toBe(0);
      expect(Number.isFinite(result.profit), label).toBe(true);
      expect(result.profit, label).toBe(VALID_FUZZ_PROFIT);
    });
  });

  it("60 pedidos malformados (NaN, ±Infinity, negativos, strings, lixo) nunca lançam nem produzem número inválido", () => {
    const { mixed } = buildFuzzData(mulberry32(SEED));

    mixed.forEach((scenario, index) => {
      const label = `seed=${SEED}, pedido #${index}, order=${safeJson(scenario.order)}, tierInput=${safeJson(scenario.tierInput)}`;
      const result = mustCompute(scenario.order as Order, scenario.tierInput, label);

      if (result.tier === "sem_nivel") {
        expect(result.deliveryFee, label).toBe(0);
      } else {
        expect(result.deliveryFee, label).toBe(DELIVERY_FEES[result.tier]);
      }
      expect(Number.isFinite(result.deliveryFee), label).toBe(true);
      expect(Number.isFinite(result.profit), label).toBe(true);
    });
  });

  it("é determinístico: a mesma seed gera exatamente os mesmos cenários", () => {
    const first = buildFuzzData(mulberry32(SEED));
    const second = buildFuzzData(mulberry32(SEED));
    expect(first.tierInputs.map(safeJson), `seed=${SEED}`).toEqual(second.tierInputs.map(safeJson));
    expect(first.mixed.map(safeJson), `seed=${SEED}`).toEqual(second.mixed.map(safeJson));
  });
});
