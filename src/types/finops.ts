export interface TrendData {
  change: number;        // Absolute change in $
  percentage: number;    // Percentage change
}

export interface ServiceCost {
  name: string;
  cost: number;
  previousCost?: number;
  trend?: TrendData;
  percentage?: number;   // % of total
}

export interface AccountSummary {
  accountId: string;
  accountName: string;
  totalCost: number;
  previousCost?: number;
  trend: TrendData;
  topService: {
    name: string;
    cost: number;
    percentage: number;
  };
  services: ServiceCost[];
}

export interface TopMover {
  service: string;
  change: number;
  percentage: number;
  accountId?: string;
}

export interface SavingsPlanAccount {
  accountId: string;
  accountName: string;
  spCoveredCost: number;
  onDemandCost: number;
  savings: number;
  savingsPercentage: number;
  totalCost: number;
  coveragePercentage: number;
  lineItems: number;
  hasCoverage: boolean;
}

export interface SavingsPlansUtilizationSummary {
  start: string;
  endExclusive: string;
  utilizationPercentage: number;
  totalCommitment: number;
  usedCommitment: number;
  unusedCommitment: number;
  netSavings: number;
  onDemandCostEquivalent: number;
  amortizedRecurringCommitment: number;
  amortizedUpfrontCommitment: number;
  totalAmortizedCommitment: number;
}

export interface SavingsPlansCommitmentSummary {
  scope: "organization";
  asOfDate: string;
  inventoryAvailable: boolean;
  inventoryError?: string | null;
  activePlans: number | null;
  currency: string;
  hourlyCommitment: number | null;
  estimatedMonthlyCommitment: number | null;
  recurringPaymentAmount: number | null;
  upfrontPaymentAmount: number | null;
  nextExpirationDate: string | null;
  nextExpirationDays: number | null;
  planTypes: string[];
  paymentOptions: string[];
  utilizationAvailable: boolean;
  utilizationError?: string | null;
  utilization: SavingsPlansUtilizationSummary | null;
}

export interface SavingsPlansData {
  totalCoverage: number;
  totalSavings: number;
  selectedAccountCount: number;
  visibleAccountCount: number;
  coveredAccountCount: number;
  byAccount: SavingsPlanAccount[];
  commitment?: SavingsPlansCommitmentSummary | null;
}

export interface ResourceCostSummary {
  accountId: string;
  service: string;
  resourceId: string;
  cost: number;
  lineItems?: number;
}

export interface PeriodWindow {
  start: string;
  end: string;
  days?: number;
}

export interface PeriodComparison {
  mode: string;
  current: PeriodWindow;
  previous: PeriodWindow;
}

export interface MonthlyTrendAccountCost {
  accountId: string;
  accountName: string;
  cost: number;
}

export interface MonthlyTrendPoint {
  monthStart: string;
  label: string;
  totalCost: number;
  accounts: MonthlyTrendAccountCost[];
}

export interface AthenaFinOpsResponse {
  executionTime: number;
  dataScanned: string;
  dateRange: { start: string; end: string };
  comparison?: PeriodComparison;
  summary: {
    totalCost: number;
    previousTotalCost?: number;
    trend?: TrendData;
    accountCount: number;
    topService: {
      name: string;
      cost: number;
      trend: TrendData;
    };
  };
  accounts: AccountSummary[];
  topMovers: {
    increases: TopMover[];
    decreases: TopMover[];
  };
  monthlyTrend?: MonthlyTrendPoint[];
  resourceCosts?: ResourceCostSummary[];
  savingsPlans?: SavingsPlansData; // Optional - may not exist for old data
}

// Legacy types for backward compatibility with Cost Explorer
export type FinOpsResponse = {
  reportType: string;
  totalCurrency?: string;
  totalCost: number;
  services: Array<{ name: string; cost: number }>;
  breakdownByAccount?: Array<{
    name: string;
    id: string;
    total: number;
    topService: string;
  }>;
  accountName?: string;
  accountId?: string;
};

// ─── Executive-level types (CUR deep analysis) ─────────────────────────────

export interface NetCostBreakdown {
  grossCost: number;
  netCost: number;
  onDemandEquivalent: number;
  totalDiscount: number;
  bundledDiscount: number;
  creditsApplied: number;
  sppDiscount: number;
  realSavings: number;
  effectiveDiscountPct: number;
  netCostAvailable: boolean;
}

export interface PricingModelEntry {
  model: string;
  cost: number;
  onDemandEquivalent: number;
  resources: number;
}

export interface PricingModelBreakdown {
  breakdown: PricingModelEntry[];
  usageCost: number;
  onDemandCost: number;
  spCost: number;
  riCost: number;
  spotCost: number;
  commitmentCoverage: number;
  onDemandPct: number;
  orgCoverage?: {
    spCoveredCost: number;
    riCoveredCost: number;
    totalUsageCost: number;
    totalOnDemandEquivalent: number;
    coveragePct: number;
    onDemandExposedPct: number;
  };
}

export interface SpUtilizationDetail {
  type: string;
  paymentOption: string;
  region: string;
  effectiveCost: number;
  usedCommitment: number;
  recurringCommitment: number;
  onDemandEquivalent: number;
  planCount: number;
  accountsCovered: number;
}

export interface SavingsPlansDetailData {
  plans: SpUtilizationDetail[];
  totalEffectiveCost: number;
  totalOnDemandEquivalent: number;
  savingsAmount: number;
  savingsPct: number;
}

export interface DailyCostPoint {
  day: string;
  cost: number;
  netCost: number;
}

export interface CostAnomaly {
  day: string;
  cost: number;
  deviation: number;
}

export interface AnomalyData {
  threshold: number;
  mean: number;
  stddev: number;
  flaggedDays: CostAnomaly[];
}

export interface TopResource {
  accountId: string;
  accountName: string;
  service: string;
  resourceId: string;
  instanceType: string | null;
  region: string | null;
  usageType: string | null;
  cost: number;
  usageAmount: number;
  unit: string | null;
  onDemandCost: number;
}

export interface ExecutiveFinOpsData {
  netCost: NetCostBreakdown;
  pricingModel: PricingModelBreakdown;
  savingsPlansDetail: SavingsPlansDetailData;
  dailyCosts: DailyCostPoint[];
  anomalies: AnomalyData;
  topResources: TopResource[];
}

/** Extended response with executive data */
export interface AthenaFinOpsResponseV2 extends AthenaFinOpsResponse {
  executive?: ExecutiveFinOpsData;
}
