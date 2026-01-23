"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AthenaFinOpsResponse } from "@/types/finops";

interface ExcelExportButtonProps {
    data: AthenaFinOpsResponse;
    disabled?: boolean;
}

export function ExcelExportButton({ data, disabled }: ExcelExportButtonProps) {
    const [isExporting, setIsExporting] = useState(false);

    const exportToExcel = async () => {
        setIsExporting(true);

        try {
            // Import xlsx dynamically to reduce bundle size
            const XLSX = await import('xlsx');

            // Sheet 1: Summary
            const summaryData = [
                ['FinOps Cost Report'],
                ['Generated:', new Date().toLocaleString()],
                ['Period:', `${data.dateRange.start} to ${data.dateRange.end}`],
                [],
                ['Total Cost', `$${data.summary.totalCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}`],
                ['Accounts Analyzed', data.summary.accountCount],
                ['Top Service', data.summary.topService.name],
                ['Top Service Cost', `$${data.summary.topService.cost.toLocaleString('en-US', { minimumFractionDigits: 2 })}`],
                ['Top Service Trend', `${data.summary.topService.trend.change >= 0 ? '+' : ''}${data.summary.topService.trend.percentage.toFixed(1)}%`],
                [],
                ['Top Cost Increases'],
                ['Service', 'Change ($)', 'Change (%)'],
                ...data.topMovers.increases.map(m => [
                    m.service,
                    m.change.toFixed(2),
                    `${m.percentage.toFixed(1)}%`
                ]),
                [],
                ['Top Cost Decreases'],
                ['Service', 'Change ($)', 'Change (%)'],
                ...data.topMovers.decreases.map(m => [
                    m.service,
                    m.change.toFixed(2),
                    `${m.percentage.toFixed(1)}%`
                ])
            ];

            // Sheet 2: By Account
            const accountData = [
                ['Account ID', 'Account Name', 'Total Cost', 'Trend ($)', 'Trend (%)', 'Top Service', 'Top Service Cost'],
                ...data.accounts.map(acc => [
                    acc.accountId,
                    acc.accountName,
                    acc.totalCost.toFixed(2),
                    acc.trend.change.toFixed(2),
                    `${acc.trend.percentage.toFixed(1)}%`,
                    acc.topService.name,
                    acc.topService.cost.toFixed(2)
                ])
            ];

            // Sheet 3: All Services by Account
            const serviceData = [['Account ID', 'Account Name', 'Service', 'Cost', 'Trend ($)', 'Trend (%)']];
            data.accounts.forEach(acc => {
                acc.services.forEach(svc => {
                    serviceData.push([
                        acc.accountId,
                        acc.accountName,
                        svc.name,
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
            alert('Failed to export Excel file. Please try again.');
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
                    Exporting...
                </>
            ) : (
                <>
                    <Download className="h-4 w-4" />
                    Export Excel
                </>
            )}
        </Button>
    );
}
