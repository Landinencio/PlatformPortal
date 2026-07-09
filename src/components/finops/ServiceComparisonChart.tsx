"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AccountSummary } from "@/types/finops";
import { formatAwsServiceName, truncateLabel } from "@/lib/finops-format";
import { useI18n } from "@/lib/i18n";

interface ServiceComparisonChartProps {
    accounts: AccountSummary[];
    serviceRows?: { name: string; cost: number; fullName: string }[];
    viewMode: 'service' | 'account';
}

export function ServiceComparisonChart({ accounts, serviceRows, viewMode }: ServiceComparisonChartProps) {
    const { t } = useI18n();
    const prepareData = () => {
        if (viewMode === 'account') {
            return accounts
                .slice(0, 10)
                .map(acc => ({
                    name: truncateLabel(acc.accountName, 24),
                    cost: parseFloat(acc.totalCost.toFixed(2)),
                    fullName: acc.accountName
                }));
        } else {
            if (serviceRows && serviceRows.length > 0) {
                return serviceRows
                    .slice(0, 10)
                    .map((row) => ({
                        name: truncateLabel(row.fullName, 24),
                        cost: parseFloat(row.cost.toFixed(2)),
                        fullName: row.fullName,
                    }));
            }

            const serviceMap: { [key: string]: number } = {};
            accounts.forEach(acc => {
                acc.services.forEach(svc => {
                    if (!serviceMap[svc.name]) {
                        serviceMap[svc.name] = 0;
                    }
                    serviceMap[svc.name] += svc.cost;
                });
            });

            return Object.entries(serviceMap)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([name, cost]) => ({
                    name: truncateLabel(formatAwsServiceName(name), 24),
                    cost: parseFloat(cost.toFixed(2)),
                    fullName: formatAwsServiceName(name)
                }));
        }
    };

    const data = prepareData();

    const CustomTooltip = ({ active, payload }: any) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-background border rounded-lg shadow-lg p-3">
                    <p className="font-semibold">{payload[0].payload.fullName}</p>
                    <p className="text-primary font-bold">
                        ${payload[0].value.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </p>
                </div>
            );
        }
        return null;
    };

    const title = viewMode === 'service' ? t("costs.top10services") : t("costs.top10accounts");
    const description = viewMode === 'service'
        ? t("costs.top10servicesDesc")
        : t("costs.top10accountsDesc");

    return (
        <Card className="border-none shadow-lg">
            <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent>
                {data.length === 0 ? (
                    <div className="flex h-[400px] items-center justify-center text-sm text-muted-foreground">
                        {t("costs.noDataInScope")}
                    </div>
                ) : (
                <ResponsiveContainer width="100%" height={400}>
                    <BarChart data={data} layout="vertical" margin={{ top: 10, right: 24, left: 12, bottom: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis
                            type="number"
                            tickFormatter={(value) => `$${Number(value).toLocaleString()}`}
                            className="text-xs"
                        />
                        <YAxis
                            type="category"
                            dataKey="name"
                            width={180}
                            className="text-xs"
                        />
                        <Tooltip content={<CustomTooltip />} />
                        <Bar
                            dataKey="cost"
                            fill="hsl(var(--primary))"
                            radius={[0, 8, 8, 0]}
                            name="Cost ($)"
                        />
                    </BarChart>
                </ResponsiveContainer>
                )}
            </CardContent>
        </Card>
    );
}
