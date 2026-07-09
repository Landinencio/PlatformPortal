"use client";

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { MonthlyTrendPoint } from "@/types/finops";
import { useI18n } from "@/lib/i18n";

interface MonthlyCostTrendChartProps {
    points: MonthlyTrendPoint[];
}

const ACCOUNT_COLORS = [
    "#0f766e",
    "#2563eb",
    "#dc2626",
    "#7c3aed",
    "#d97706",
    "#059669",
    "#db2777",
    "#0891b2",
    "#4f46e5",
    "#9333ea",
];

const TOTAL_COLOR = "hsl(var(--primary))";
const TOTAL_KEY = "totalCost";

export function MonthlyCostTrendChart({ points }: MonthlyCostTrendChartProps) {
    const { t } = useI18n();
    const accountTotals = new Map<string, { accountId: string; accountName: string; totalCost: number }>();

    points.forEach((point) => {
        point.accounts.forEach((account) => {
            const existing = accountTotals.get(account.accountId) || {
                accountId: account.accountId,
                accountName: account.accountName,
                totalCost: 0,
            };
            existing.totalCost += account.cost;
            accountTotals.set(account.accountId, existing);
        });
    });

    const accountDefinitions = [...accountTotals.values()]
        .sort((left, right) => right.totalCost - left.totalCost)
        .map((account, index) => ({
            ...account,
            dataKey: `account_${account.accountId}`,
            color: ACCOUNT_COLORS[index % ACCOUNT_COLORS.length],
        }));

    const showAccountLines = accountDefinitions.length > 1;
    const chartData = points.map((point) => {
        const row: Record<string, string | number> = {
            label: point.label,
            totalCost: point.totalCost,
        };

        accountDefinitions.forEach((account) => {
            row[account.dataKey] = 0;
        });

        point.accounts.forEach((account) => {
            row[`account_${account.accountId}`] = account.cost;
        });

        return row;
    });

    const CustomTooltip = ({ active, payload }: any) => {
        if (!active || !payload?.length) return null;

        const label = payload[0]?.payload?.label;
        const visibleEntries = [...payload]
            .filter((entry) => Number(entry.value) > 0 || entry.dataKey === TOTAL_KEY)
            .sort((left, right) => {
                if (left.dataKey === TOTAL_KEY) return -1;
                if (right.dataKey === TOTAL_KEY) return 1;
                return Number(right.value) - Number(left.value);
            });

        return (
            <div className="rounded-lg border bg-background p-3 shadow-lg">
                <p className="font-semibold">{label}</p>
                <div className="mt-2 space-y-1.5">
                    {visibleEntries.map((entry: any) => (
                        <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-sm">
                            <div className="flex items-center gap-2">
                                <span
                                    className="inline-block h-2.5 w-2.5 rounded-full"
                                    style={{ backgroundColor: entry.color }}
                                />
                                <span className="text-muted-foreground">{entry.name}</span>
                            </div>
                            <span className="font-semibold">
                                ${Number(entry.value).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    return (
        <Card className="border-none shadow-lg">
            <CardHeader>
                <CardTitle>{t("costs.monthlyEvolution")}</CardTitle>
                <CardDescription>
                    {showAccountLines
                        ? t("costs.monthlyMultiDesc")
                        : t("costs.monthlySingleDesc")}
                </CardDescription>
            </CardHeader>
            <CardContent>
                {points.length === 0 ? (
                    <div className="flex h-[360px] items-center justify-center text-sm text-muted-foreground">
                        {t("costs.noMonthlyData")}
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height={360}>
                        <LineChart data={chartData} margin={{ top: 10, right: 24, left: 12, bottom: 10 }}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                            <XAxis dataKey="label" className="text-xs" />
                            <YAxis
                                tickFormatter={(value) => `$${Number(value).toLocaleString()}`}
                                className="text-xs"
                            />
                            <Tooltip content={<CustomTooltip />} />
                            <Legend />
                            <Line
                                type="monotone"
                                dataKey={TOTAL_KEY}
                                stroke={TOTAL_COLOR}
                                strokeWidth={3}
                                dot={false}
                                activeDot={{ r: 5 }}
                                name="Total"
                            />
                            {showAccountLines && accountDefinitions.map((account) => (
                                <Line
                                    key={account.dataKey}
                                    type="monotone"
                                    dataKey={account.dataKey}
                                    stroke={account.color}
                                    strokeWidth={2}
                                    dot={false}
                                    activeDot={{ r: 4 }}
                                    name={account.accountName}
                                />
                            ))}
                        </LineChart>
                    </ResponsiveContainer>
                )}
            </CardContent>
        </Card>
    );
}
