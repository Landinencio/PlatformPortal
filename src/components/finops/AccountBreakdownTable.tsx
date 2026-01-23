"use client";

import { useState } from "react";
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

interface AccountBreakdownTableProps {
    accounts: AccountSummary[];
    className?: string;
}

export function AccountBreakdownTable({ accounts, className }: AccountBreakdownTableProps) {
    const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());

    const toggleAccount = (accountId: string) => {
        const newExpanded = new Set(expandedAccounts);
        if (newExpanded.has(accountId)) {
            newExpanded.delete(accountId);
        } else {
            newExpanded.add(accountId);
        }
        setExpandedAccounts(newExpanded);
    };

    const formatServiceName = (name: string) => {
        return name
            .replace("Amazon Elastic Compute Cloud - Compute", "EC2 - Compute")
            .replace("Amazon Elastic Compute Cloud", "EC2")
            .replace("Amazon Elastic Container Service for Kubernetes", "EKS")
            .replace("Amazon Simple Storage Service", "S3")
            .replace("Amazon Relational Database Service", "RDS")
            .replace("Amazon Virtual Private Cloud", "VPC")
            .replace("Amazon Elastic Load Balancing", "ELB")
            .replace("Amazon CloudWatch", "CloudWatch")
            .replace(/^Amazon /, "");
    };

    return (
        <div className={cn("rounded-lg border bg-card overflow-hidden", className)}>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-12"></TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead className="text-right">Total Cost</TableHead>
                        <TableHead className="text-right">Trend</TableHead>
                        <TableHead>Top Service</TableHead>
                        <TableHead className="text-right">Top Service Cost</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {accounts.map((account) => {
                        const isExpanded = expandedAccounts.has(account.accountId);

                        return (
                            <>
                                {/* Account Row */}
                                <TableRow
                                    key={account.accountId}
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
                                    <TableCell className="text-right font-bold">
                                        ${account.totalCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <TrendIndicator trend={account.trend} size="sm" />
                                    </TableCell>
                                    <TableCell>
                                        <div className="font-medium">
                                            {formatServiceName(account.topService.name)}
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                            {account.topService.percentage.toFixed(1)}% of account total
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-right font-semibold">
                                        ${account.topService.cost.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                    </TableCell>
                                </TableRow>

                                {/* Expanded Services */}
                                {isExpanded && (
                                    <TableRow key={`${account.accountId}-services`}>
                                        <TableCell colSpan={6} className="bg-muted/20 p-0">
                                            <div className="p-4 space-y-2">
                                                <div className="text-sm font-semibold text-muted-foreground mb-3">
                                                    Service Breakdown
                                                </div>
                                                <div className="grid gap-2">
                                                    {account.services.slice(0, 10).map((service, idx) => (
                                                        <div
                                                            key={service.name}
                                                            className="flex items-center justify-between p-3 bg-background rounded-lg border hover:border-primary/50 transition-colors"
                                                        >
                                                            <div className="flex items-center gap-3 flex-1">
                                                                <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">
                                                                    {idx + 1}
                                                                </div>
                                                                <div className="flex-1">
                                                                    <div className="font-medium text-sm">
                                                                        {formatServiceName(service.name)}
                                                                    </div>
                                                                    {service.percentage && (
                                                                        <div className="text-xs text-muted-foreground">
                                                                            {service.percentage.toFixed(1)}% of account
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
                                                    ))}
                                                    {account.services.length > 10 && (
                                                        <div className="text-center text-sm text-muted-foreground py-2">
                                                            +{account.services.length - 10} more services
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                )}
                            </>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}
