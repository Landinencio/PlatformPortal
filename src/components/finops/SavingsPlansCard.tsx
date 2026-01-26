import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSign, PiggyBank } from "lucide-react";
import type { SavingsPlansData } from "@/types/finops";

interface SavingsPlansCardProps {
    data: SavingsPlansData;
}

export function SavingsPlansCard({ data }: SavingsPlansCardProps) {
    if (!data || !data.byAccount || data.byAccount.length === 0) {
        return null; // Hide if no SP data
    }

    const totalCoverage = data.totalCoverage || 0;
    const accountsWithSP = data.byAccount.filter(a => a.spCoveredCost > 0);

    if (accountsWithSP.length === 0) {
        return null;
    }

    return (
        <Card className="border-none shadow-lg">
            <CardHeader className="border-b bg-emerald-50/50 dark:bg-emerald-950/20">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <PiggyBank className="h-5 w-5 text-emerald-600" />
                        <CardTitle>Savings Plans Coverage</CardTitle>
                    </div>
                    <div className="text-right">
                        <div className="text-2xl font-bold text-emerald-600">
                            ${totalCoverage.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </div>
                        <div className="text-xs text-muted-foreground">Total SP Coverage</div>
                    </div>
                </div>
                <CardDescription>
                    AWS Savings Plans utilization across {accountsWithSP.length} account{accountsWithSP.length !== 1 ? 's' : ''}
                </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
                <div className="divide-y">
                    {accountsWithSP
                        .sort((a, b) => b.spCoveredCost - a.spCoveredCost)
                        .map((account) => (
                            <div key={account.accountId} className="p-4 hover:bg-muted/30 transition-colors">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex-1">
                                        <div className="font-medium text-sm">
                                            {account.accountName}
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                            {account.accountId}
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="font-semibold text-emerald-600">
                                            ${account.spCoveredCost.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                            {account.coveragePercentage.toFixed(1)}% coverage
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-emerald-500 transition-all duration-500"
                                            style={{ width: `${Math.min(account.coveragePercentage, 100)}%` }}
                                        />
                                    </div>
                                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                                        ${account.totalCost.toLocaleString('en-US', { maximumFractionDigits: 0 })} total
                                    </span>
                                </div>
                            </div>
                        ))}
                </div>
            </CardContent>
        </Card>
    );
}
