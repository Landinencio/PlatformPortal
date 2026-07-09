"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AccountSummary, AthenaFinOpsResponse } from "@/types/finops";
import { formatAwsServiceName } from "@/lib/finops-format";
import { useI18n } from "@/lib/i18n";

interface ExcelExportButtonProps {
    data: AthenaFinOpsResponse;
    accounts?: AccountSummary[];
    disabled?: boolean;
}

export function ExcelExportButton({ data, accounts, disabled }: ExcelExportButtonProps) {
    const [isExporting, setIsExporting] = useState(false);
    const { t } = useI18n();
    const scopedAccounts = accounts ?? data.accounts;
    const scopedServiceMap = new Map<string, number>();
    scopedAccounts.forEach((account) => {
        account.services.forEach((service) => {
            scopedServiceMap.set(service.name, (scopedServiceMap.get(service.name) || 0) + service.cost);
        });
    });
    const scopedTopServiceEntry = [...scopedServiceMap.entries()].sort((a, b) => b[1] - a[1])[0] || null;

    const exportToExcel = async () => {
        setIsExporting(true);

        try {
            // Import xlsx dynamically to reduce bundle size
            const XLSX = await import('xlsx');

            // Sheet 1: Summary
            const summaryData = [
                [t("costs.finopsReport")],
                [t("costs.generated"), new Date().toLocaleString()],
                [t("costs.period"), `${data.dateRange.start} to ${data.dateRange.end}`],
                [],
                [t("costs.totalCost"), `$${scopedAccounts.reduce((sum, account) => sum + account.totalCost, 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`],
                [t("costs.accountsAnalyzed"), scopedAccounts.length],
                [t("costs.topService"), scopedTopServiceEntry ? formatAwsServiceName(scopedTopServiceEntry[0]) : '-'],
                [t("costs.topServiceCost"), scopedTopServiceEntry ? `$${scopedTopServiceEntry[1].toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '-'],
                [t("costs.topServiceTrend"), `${data.summary.topService.trend.change >= 0 ? '+' : ''}${data.summary.topService.trend.percentage.toFixed(1)}%`],
                [],
                [t("costs.topCostIncreases")],
                ['Service', 'Change ($)', 'Change (%)'],
                ...data.topMovers.increases.map(m => [
                    formatAwsServiceName(m.service),
                    m.change.toFixed(2),
                    `${m.percentage.toFixed(1)}%`
                ]),
                [],
                [t("costs.topCostDecreases")],
                ['Service', 'Change ($)', 'Change (%)'],
                ...data.topMovers.decreases.map(m => [
                    formatAwsServiceName(m.service),
                    m.change.toFixed(2),
                    `${m.percentage.toFixed(1)}%`
                ])
            ];

            // Sheet 2: By Account
            const accountData = [
                ['Account ID', 'Account Name', 'Total Cost', 'Trend ($)', 'Trend (%)', 'Top Service', 'Top Service Cost'],
                ...scopedAccounts.map(acc => [
                    acc.accountId,
                    acc.accountName,
                    acc.totalCost.toFixed(2),
                    acc.trend.change.toFixed(2),
                    `${acc.trend.percentage.toFixed(1)}%`,
                    formatAwsServiceName(acc.topService.name),
                    acc.topService.cost.toFixed(2)
                ])
            ];

            // Sheet 3: All Services by Account
            const serviceData = [['Account ID', 'Account Name', 'Service', 'Cost', 'Trend ($)', 'Trend (%)']];
            scopedAccounts.forEach(acc => {
                acc.services.forEach(svc => {
                    serviceData.push([
                        acc.accountId,
                        acc.accountName,
                        formatAwsServiceName(svc.name),
                        svc.cost.toFixed(2),
                        svc.trend ? svc.trend.change.toFixed(2) : '0',
                        svc.trend ? `${svc.trend.percentage.toFixed(1)}%` : '0%'
                    ]);
                });
            });

            // Create workbook
            const wb = XLSX.utils.book_new();

            const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
            const wsAccount = XLSX.utils.aoa_to_sheet(accountData);
            const wsService = XLSX.utils.aoa_to_sheet(serviceData);

            // Set column widths
            wsSummary['!cols'] = [{ wch: 20 }, { wch: 30 }];
            wsAccount['!cols'] = [{ wch: 15 }, { wch: 25 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 30 }, { wch: 15 }];
            wsService['!cols'] = [{ wch: 15 }, { wch: 25 }, { wch: 40 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];

            XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');
            XLSX.utils.book_append_sheet(wb, wsAccount, 'By Account');
            XLSX.utils.book_append_sheet(wb, wsService, 'All Services');

            // Generate filename
            const filename = `FinOps_Report_${data.dateRange.start}_to_${data.dateRange.end}.xlsx`;

            // Download
            XLSX.writeFile(wb, filename);

        } catch (error) {
            console.error('Export failed:', error);
            alert(t("costs.exportFailed"));
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <Button
            onClick={exportToExcel}
            disabled={disabled || isExporting}
            variant="outline"
            size="sm"
            className="gap-2"
        >
            {isExporting ? (
                <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("costs.exporting")}
                </>
            ) : (
                <>
                    <Download className="h-4 w-4" />
                    {t("costs.exportExcel")}
                </>
            )}
        </Button>
    );
}
