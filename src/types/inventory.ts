export type ResourceMetadataValue = string | number | boolean | null | undefined;
export type TerraformStatus = "managed" | "not-managed" | "unknown";

export interface ResourceDetail {
  id: string;
  name: string;
  type: string;
  state: string;
  terraform: boolean;
  terraformStatus?: TerraformStatus;
  estimatedMonthlyCost?: number | null;
  tags?: Record<string, string>;
  metadata?: Record<string, ResourceMetadataValue>;
}

export interface InventoryResource {
  account_id: string;
  account_name: string;
  service: string;
  resource_type: string;
  region: string;
  usage_amount: number;
  unit: string;
}

export interface InventoryAccountSummary {
  accountId: string;
  accountName: string;
  totalResources: number;
  services: {
    name: string;
    serviceFamily?: string;
    resourceType?: string;
    resourceCount: number;
    estimatedMonthlyCost?: number | null;
    details: ResourceDetail[];
  }[];
}

export interface InventoryResponse {
  dateRange: { start: string; end: string };
  totalResources: number;
  accounts: InventoryAccountSummary[];
  byService: {
    service: string;
    serviceFamily?: string;
    resourceType?: string;
    resourceCount: number;
    estimatedMonthlyCost?: number | null;
    regions: string[];
    details: ResourceDetail[];
  }[];
  byRegion: {
    region: string;
    resourceCount: number;
  }[];
  resources: InventoryResource[];
}
