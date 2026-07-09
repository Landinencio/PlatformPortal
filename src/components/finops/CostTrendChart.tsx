"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";

interface CostTrendChartProps {
    currentPeriodCost: number;
    previousPeriodCost: number;
    currentPeriodLabel?: string;
    previousPeriodLabel?: string;
    description?: string;
}

export function CostTrendChart({
    currentPeriodCost,
    previousPeriodCost,
    currentPeriodLabel,
    previousPeriodLabel,
    description
}: CostTrendChartProps) {
    const { t } = useI18n();
    const resolvedCurrentLabel = currentPeriodLabel ?? t("costs.currentPeriod");
    const resolvedPreviousLabel = previousPeriodLabel ?? t("costs.previousPeriod");
    const resolvedDescription = description ?? t("costs.periodComparisonDesc");
    const data = [
        {
            period: resolvedPreviousLabel,
            cost: previousPeriodCost
        },
        {
            period: resolvedCurrentLabel,
            cost: currentPeriodCost
        }
    ];

    const CustomTooltip = ({ active, payload }: any) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-background border rounded-lg shadow-lg p-3">
                    <p className="font-semibold">{payload[0].payload.period}</p>
                    <p className="text-primary font-bold">
                        ${payload[0].value.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </p>
                </div>
            );
        }
        return null;
    };

    return (
        <Card className="border-none shadow-lg">
            <CardHeader>
                <CardTitle>{t("costs.periodComparison")}</CardTitle>
                <CardDescription>{resolvedDescription}</CardDescription>
            </CardHeader>
            <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={data} margin={{ top: 10, right: 30, left: 20, bottom: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="period" className="text-xs" />
                        <YAxis
                            tickFormatter={(value) => `$${Number(value).toLocaleString()}`}
                            className="text-xs"
                        />
                        <Tooltip content={<CustomTooltip />} />
                        <Bar dataKey="cost" fill="hsl(var(--primary))" radius={[8, 8, 0, 0]} name="Total Cost ($)" />
                    </BarChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}
