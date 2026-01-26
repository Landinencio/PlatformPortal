export interface TrendData {
  change: number;        // Absolute change in $
  percentage: number;    // Percentage change
}

export interface ServiceCost {
  name: string;
  cost: number;
  trend?: TrendData;
  percentage?: number;   // % of total
}

export interface AccountSummary {
  accountId: string;
  accountName: string;
  totalCost: number;
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
}

export interface SavingsPlansData {
  totalCoverage: number;
  totalSavings: number;
  byAccount: SavingsPlanAccount[];
  commitment?: any; // Optional commitment data
}

export interface AthenaFinOpsResponse {
  executionTime: number;
  dataScanned: string;
  dateRange: { start: string; end: string };
  summary: {
    totalCost: number;
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
