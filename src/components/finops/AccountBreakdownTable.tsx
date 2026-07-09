"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { TrendIndicator } from "./TrendIndicator";
import type { AccountSummary } from "@/types/finops";
import { formatAwsServiceName } from "@/lib/finops-format";
import { useI18n } from "@/lib/i18n";

interface AccountBreakdownTableProps {
    accounts: AccountSummary[];
    resourceCosts?: Array<{ accountId: string; service: string; resourceId: string; cost: number; lineItems?: number }>;
    className?: string;
}

export function AccountBreakdownTable({ accounts, resourceCosts = [], className }: AccountBreakdownTableProps) {
    const { t } = useI18n();
    const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
    const [expandedServices, setExpandedServices] = useState<Set<string>>(new Set());
    const [resourceVisibleLimits, setResourceVisibleLimits] = useState<Map<string, number>>(new Map());
    const totalVisibleCost = accounts.reduce((sum, account) => sum + account.totalCost, 0);

    const toggleAccount = (accountId: string) => {
        const newExpanded = new Set(expandedAccounts);
        if (newExpanded.has(accountId)) {
            newExpanded.delete(accountId);
        } else {
            newExpanded.add(accountId);
        }
        setExpandedAccounts(newExpanded);
    };

    const toggleService = (key: string) => {
        const newExpanded = new Set(expandedServices);
        if (newExpanded.has(key)) {
            newExpanded.delete(key);
        } else {
            newExpanded.add(key);
        }
        setExpandedServices(newExpanded);
    };

    const getServiceResources = (accountId: string, serviceName: string) => {
        return resourceCosts
            .filter((r) => r.accountId === accountId && r.service === serviceName)
            .sort((a, b) => b.cost - a.cost);
    };

    return (
        <div className={cn("rounded-lg border bg-card overflow-hidden", className)}>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-12"></TableHead>
                        <TableHead>{t("costs.accountCol")}</TableHead>
                        <TableHead className="text-right font-semibold">{t("costs.realCostCol")}</TableHead>
                        <TableHead className="text-right text-muted-foreground">
                            <div className="flex items-center justify-end gap-1">
                                <span className="text-xs">{t("costs.netPaymentCol")}</span>
                            </div>
                        </TableHead>
                        <TableHead className="text-right">{t("costs.trendCol")}</TableHead>
                        <TableHead>{t("costs.topServiceCol")}</TableHead>
                        <TableHead className="text-right">{t("costs.topServiceCostCol")}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {accounts.length === 0 && (
                        <TableRow>
                            <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                                {t("costs.noAccountsMatch")}
                            </TableCell>
                        </TableRow>
                    )}
                    {accounts.map((account) => {
                        const isExpanded = expandedAccounts.has(account.accountId);
                        const APPROX_MONTHLY_DISCOUNT = 9000;
                        const accountShare = totalVisibleCost > 0 ? account.totalCost / totalVisibleCost : 0;
                        const approxAccountDiscount = APPROX_MONTHLY_DISCOUNT * accountShare;
                        const realCost = account.totalCost;
                        const approxNetPayment = Math.max(0, realCost - approxAccountDiscount);

                        return (
                            <Fragment key={account.accountId}>
                                {/* Account Row */}
                                <TableRow
                                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                                    onClick={() => toggleAccount(account.accountId)}
                                >
                                    <TableCell>
                                        <button className="p-1 hover:bg-muted rounded transition-colors">
                                            {isExpanded ? (
                                                <ChevronDown className="h-4 w-4" />
                                            ) : (
                                                <ChevronRight className="h-4 w-4" />
                                            )}
                                        </button>
                                    </TableCell>
                                    <TableCell>
                                        <div>
                                            <div className="font-semibold">{account.accountName}</div>
                                            <div className="text-xs text-muted-foreground font-mono">
                                                {account.accountId}
                                            </div>
                                        </div>
                                    </TableCell>
                                    {/* Real AWS Cost - PRIMARY */}
                                    <TableCell className="text-right">
                                        <div className="font-bold text-base">
                                            ${realCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                        </div>
                                    </TableCell>
                                    {/* Approximate Net Payment - SECONDARY */}
                                    <TableCell className="text-right">
                                        <div className="text-sm text-muted-foreground">
                                            ~${approxNetPayment.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <TrendIndicator trend={account.trend} size="sm" />
                                    </TableCell>
                                    <TableCell>
                                        <div className="font-medium">
                                            {account.topService.name === "None"
                                                ? t("costs.noCostCurrent")
                                                : formatAwsServiceName(account.topService.name)}
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                            {account.topService.percentage.toFixed(1)}% {t("costs.ofAccountTotal")}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-right font-semibold">
                                        ${account.topService.cost.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                    </TableCell>
                                </TableRow>

                                {/* Expanded Services */}
                                {isExpanded && (
                                    <TableRow key={`${account.accountId}-services`}>
                                        <TableCell colSpan={7} className="bg-muted/20 p-0">
                                            <div className="p-4 space-y-2">
                                                <div className="text-sm font-semibold text-muted-foreground mb-3">
                                                    {t("costs.serviceBreakdown")}
                                                </div>
                                                <div className="grid gap-2">
                                                    {account.services.slice(0, 10).map((service, idx) => {
                                                        const serviceKey = `${account.accountId}::${service.name}`;
                                                        const isServiceExpanded = expandedServices.has(serviceKey);
                                                        const serviceResources = isServiceExpanded ? getServiceResources(account.accountId, service.name) : [];
                                                        const visibleLimit = resourceVisibleLimits.get(serviceKey) || 50;

                                                        return (
                                                        <div key={service.name}>
                                                        <div
                                                            className="flex items-center justify-between p-3 bg-background rounded-lg border hover:border-primary/50 transition-colors cursor-pointer"
                                                            onClick={() => toggleService(serviceKey)}
                                                        >
                                                            <div className="flex items-center gap-3 flex-1">
                                                                <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">
                                                                    {idx + 1}
                                                                </div>
                                                                <div className="flex-1">
                                                                        <div className="font-medium text-sm flex items-center gap-1">
                                                                        {formatAwsServiceName(service.name)}
                                                                        {resourceCosts.length > 0 && (
                                                                            <span className="text-[10px] text-muted-foreground/60">
                                                                                {isServiceExpanded ? "▲" : "▼"}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    {service.percentage && (
                                                                        <div className="text-xs text-muted-foreground">
                                                                            {service.percentage.toFixed(1)}% {t("costs.ofAccount")}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-4">
                                                                {service.trend && (
                                                                    <TrendIndicator trend={service.trend} size="sm" />
                                                                )}
                                                                <div className="text-right">
                                                                    <div className="font-bold">
                                                                        ${service.cost.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        {isServiceExpanded && serviceResources.length > 0 && (
                                                            <div className="ml-11 mt-1 mb-2 space-y-1">
                                                                {serviceResources.slice(0, visibleLimit).map((resource) => (
                                                                    <div key={resource.resourceId} className="flex items-center justify-between px-3 py-2 bg-muted/30 rounded-md text-xs">
                                                                        <div className="min-w-0 flex-1 truncate text-muted-foreground" title={resource.resourceId}>
                                                                            {resource.resourceId.length > 60 ? `...${resource.resourceId.slice(-55)}` : resource.resourceId}
                                                                        </div>
                                                                        <div className="font-semibold text-foreground ml-3 shrink-0">
                                                                            ${resource.cost.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                                {serviceResources.length > visibleLimit && (
                                                                    <button
                                                                        className="w-full text-center text-xs text-primary hover:text-primary/80 py-2 hover:bg-muted/20 rounded-md transition-colors"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            setResourceVisibleLimits((prev) => {
                                                                                const next = new Map(prev);
                                                                                next.set(serviceKey, visibleLimit + 50);
                                                                                return next;
                                                                            });
                                                                        }}
                                                                    >
                                                                        {t("costs.load50More")} ({serviceResources.length - visibleLimit} {t("costs.remaining")})
                                                                    </button>
                                                                )}
                                                            </div>
                                                        )}
                                                        {isServiceExpanded && serviceResources.length === 0 && (
                                                            <div className="ml-11 mt-1 mb-2 px-3 py-2 bg-muted/20 rounded-md text-[10px] text-muted-foreground">
                                                                {t("costs.noResourceBreakdown")}
                                                            </div>
                                                        )}
                                                        </div>
                                                        );
                                                    })}
                                                    {account.services.length > 10 && (
                                                        <div className="text-center text-sm text-muted-foreground py-2">
                                                            +{account.services.length - 10} {t("costs.moreServices")}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                )}
                            </Fragment>
                        );
                    })}
                </TableBody>
            </Table>
        </div >
    );
}
