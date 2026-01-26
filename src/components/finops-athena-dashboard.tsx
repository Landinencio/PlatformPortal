"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, DollarSign, TrendingUp, TrendingDown, Building2, Calendar, Home, Database, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AccountMultiSelect } from "./finops/AccountMultiSelect";
import { TrendIndicator } from "./finops/TrendIndicator";
import { AccountBreakdownTable } from "./finops/AccountBreakdownTable";
import { ExcelExportButton } from "./finops/ExcelExportButton";
import { ServiceComparisonChart } from "./finops/ServiceComparisonChart";
import { CostTrendChart } from "./finops/CostTrendChart";
import { QuickFilters } from "./finops/QuickFilters";
import type { AthenaFinOpsResponse } from "@/types/finops";

// Account list
const ACCOUNTS = [
    { id: "933315498976", name: "EKS Dev / Default" },
    { id: "656056379995", name: "EKS UAT" },
    { id: "000339436598", name: "EKS Prod" },
    { id: "012966899965", name: "EKS Tooling" },
    { id: "850014722158", name: "Helios Dev" },
    { id: "863836597839", name: "Helios UAT" },
    { id: "484517523926", name: "Helios Prod" },
    { id: "343444108351", name: "Digital Ecommerce" },
    { id: "178558647998", name: "Digital Dev" },
    { id: "425981549652", name: "Digital UAT" },
    { id: "722677935098", name: "Digital Prod" },
    { id: "095812636847", name: "Ecommerce Tiendanimal" },
    { id: "496588051783", name: "IskayPet Ecommerce" },
    { id: "531709726950", name: "Retail Dev" },
    { id: "211125399788", name: "Retail UAT" },
    { id: "539960941758", name: "Retail Prod" },
    { id: "176692871045", name: "Animalis Dev" },
    { id: "006157029960", name: "Animalis Prod" },
    { id: "138724810358", name: "Clinicanimal" },
    { id: "590222455071", name: "Data Dev" },
    { id: "615170114703", name: "IskayPet Data" },
    { id: "307516957806", name: "Infra" },
    { id: "801185562308", name: "SAP" },
    { id: "194193179595", name: "Sistemas Tiendanimal" }
];

const getFirstOfMonth = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
};

const getToday = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

export function FinOpsAthenaDashboard() {
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<AthenaFinOpsResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
    const [startDate, setStartDate] = useState<string>(getFirstOfMonth());
    const [endDate, setEndDate] = useState<string>(getToday());

    // New filter states
    const [searchTerm, setSearchTerm] = useState<string>("");
    const [filterMode, setFilterMode] = useState<'all' | 'increases' | 'decreases'>('all');
    const [chartView, setChartView] = useState<'service' | 'account'>('service');

    // AI analysis state
    const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
    const [aiLoading, setAiLoading] = useState(false);
    const [showAiAnalysis, setShowAiAnalysis] = useState(false);

    const fetchData = async () => {
        if (selectedAccountIds.length === 0) {
            setError("Please select at least one account.");
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            params.append("accountIds", selectedAccountIds.join(','));
            params.append("startDate", startDate);
            params.append("endDate", endDate);
            params.append("includeTrends", "true");

            const res = await fetch(`/api/finops/athena?${params.toString()}`);
            if (!res.ok) throw new Error("Failed to fetch Athena data");

            const jsonData: AthenaFinOpsResponse = await res.json();
            setData(jsonData);
        } catch (err) {
            setError("Error loading FinOps data from Athena.");
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const fetchAiAnalysis = async () => {
        if (!data) return;

        setAiLoading(true);
        try {
            const res = await fetch("/api/ai/analyze-costs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            });

            if (!res.ok) throw new Error("Failed to get AI analysis");

            const result = await res.json();
            setAiAnalysis(result.analysis);
            setShowAiAnalysis(true);
        } catch (err) {
            console.error("AI Analysis error:", err);
            setAiAnalysis("Error al obtener análisis de IA. Por favor intenta de nuevo.");
            setShowAiAnalysis(true);
        } finally {
            setAiLoading(false);
        }
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

    // Filter accounts based on search and filter mode
    const filteredAccounts = data?.accounts.filter(account => {
        // Search filter
        const matchesSearch = searchTerm === "" ||
            account.accountName.toLowerCase().includes(searchTerm.toLowerCase()) ||
            account.accountId.includes(searchTerm) ||
            account.services.some(svc => formatServiceName(svc.name).toLowerCase().includes(searchTerm.toLowerCase()));

        // Trend filter
        let matchesTrend = true;
        if (filterMode === 'increases') {
            matchesTrend = account.trend.change > 0;
        } else if (filterMode === 'decreases') {
            matchesTrend = account.trend.change < 0;
        }

        return matchesSearch && matchesTrend;
    }) || [];

    return (
        <div className="min-h-screen bg-slate-50/50 dark:bg-zinc-950/20 p-2 sm:p-6 space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b pb-6">
                <div>
                    <Link href="/" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary mb-2 transition-colors">
                        <Home className="w-4 h-4 mr-1.5" />
                        Back to Portal
                    </Link>
                    <h1 className="text-4xl font-extrabold tracking-tight bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 bg-clip-text text-transparent">
                        FinOps Analytics
                    </h1>
                    <p className="text-muted-foreground mt-1 text-lg flex items-center gap-2">
                        <Database className="w-4 h-4" />
                        Powered by AWS Athena & CUR
                    </p>
                </div>

                {data && (
                    <div className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 text-emerald-600 rounded-full border border-emerald-500/20 shadow-sm animate-in fade-in slide-in-from-right">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        <span className="text-sm font-semibold">
                            {data.dataScanned} scanned
                        </span>
                    </div>
                )}
            </div>

            {/* Control Panel */}
            <div className="sticky top-4 z-10 mx-auto max-w-6xl rounded-2xl border bg-background/80 shadow-lg backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 p-1">
                <div className="flex flex-col lg:flex-row gap-2 p-2">
                    {/* Date Range */}
                    <div className="flex flex-1 items-center gap-2 bg-muted/40 p-2 rounded-xl border border-transparent focus-within:border-primary/20 transition-all">
                        <div className="grid place-items-center w-8 h-8 rounded-lg bg-background shadow-sm text-muted-foreground">
                            <Calendar className="w-4 h-4" />
                        </div>
                        <div className="flex flex-1 items-center gap-2">
                            <div className="grid gap-0.5 flex-1">
                                <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">From</label>
                                <input
                                    type="date"
                                    className="bg-transparent border-none p-0 h-auto text-sm font-semibold focus:ring-0 w-full"
                                    value={startDate}
                                    max={endDate}
                                    onChange={(e) => setStartDate(e.target.value)}
                                />
                            </div>
                            <span className="text-muted-foreground/50">→</span>
                            <div className="grid gap-0.5 flex-1">
                                <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">To</label>
                                <input
                                    type="date"
                                    className="bg-transparent border-none p-0 h-auto text-sm font-semibold focus:ring-0 w-full"
                                    value={endDate}
                                    min={startDate}
                                    onChange={(e) => setEndDate(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Account Selector */}
                    <div className="flex-[2] flex items-center gap-2 bg-muted/40 p-2 rounded-xl border border-transparent focus-within:border-primary/20 transition-all">
                        <div className="grid place-items-center w-8 h-8 rounded-lg bg-background shadow-sm text-muted-foreground">
                            <Building2 className="w-4 h-4" />
                        </div>
                        <div className="grid gap-0.5 flex-1">
                            <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Accounts</label>
                            <AccountMultiSelect
                                accounts={ACCOUNTS}
                                selectedIds={selectedAccountIds}
                                onChange={setSelectedAccountIds}
                                placeholder="Select accounts to analyze..."
                            />
                        </div>
                    </div>

                    {/* Action Button */}
                    <Button
                        size="lg"
                        onClick={fetchData}
                        disabled={loading || selectedAccountIds.length === 0}
                        className="h-auto px-8 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-md transition-all hover:scale-[1.02] hover:shadow-lg"
                    >
                        {loading ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                        ) : (
                            <span className="flex items-center font-bold">
                                Analyze
                                <Database className="ml-2 h-4 w-4" />
                            </span>
                        )}
                    </Button>
                </div>
            </div>

            {/* Error State */}
            {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 flex items-center gap-3 text-red-600 animate-in slide-in-from-top-2">
                    <span className="font-medium">{error}</span>
                </div>
            )}

            {/* Empty State */}
            {!data && !loading && !error && (
                <div className="h-[400px] flex flex-col items-center justify-center text-center opacity-0 animate-in fade-in duration-700 delay-100 fill-mode-forwards">
                    <div className="w-24 h-24 mb-6 rounded-3xl bg-gradient-to-tr from-blue-100 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 flex items-center justify-center">
                        <DollarSign className="w-12 h-12 text-blue-500/50" />
                    </div>
                    <h3 className="text-2xl font-bold text-foreground">Ready to Analyze</h3>
                    <p className="text-muted-foreground w-full max-w-sm mt-2">
                        Select accounts and date range above to query AWS Cost and Usage Report via Athena.
                    </p>
                </div>
            )}

            {/* Data Display */}
            {data && (
                <div className="space-y-8 animate-in fade-in slide-in-from-bottom-8 duration-500">

                    {/* KPI Cards */}
                    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                        {/* Total Cost */}
                        <Card className="relative overflow-hidden border-none shadow-lg bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium opacity-90">Total Spend</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="text-3xl font-bold tracking-tight">
                                    ${data.summary.totalCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                </div>
                                <div className="mt-2 text-sm opacity-90">
                                    {selectedAccountIds.length} account{selectedAccountIds.length !== 1 ? 's' : ''}
                                </div>
                            </CardContent>
                        </Card>

                        {/* Top Service */}
                        <Card className="relative overflow-hidden border-none shadow-lg">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">Top Service</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold tracking-tight truncate">
                                    {formatServiceName(data.summary.topService.name)}
                                </div>
                                <div className="mt-2 flex items-center gap-2">
                                    <span className="text-sm font-semibold">
                                        ${data.summary.topService.cost.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                                    </span>
                                    <TrendIndicator trend={data.summary.topService.trend} size="sm" />
                                </div>
                            </CardContent>
                        </Card>

                        {/* Biggest Increase */}
                        <Card className="relative overflow-hidden border-none shadow-lg">
                            <CardHeader className="pb-2">
                                <div className="flex items-center gap-2">
                                    <TrendingUp className="w-4 h-4 text-red-500" />
                                    <CardTitle className="text-sm font-medium text-muted-foreground">Biggest Increase</CardTitle>
                                </div>
                            </CardHeader>
                            <CardContent>
                                {data.topMovers.increases[0] ? (
                                    <>
                                        <div className="text-xl font-bold tracking-tight truncate">
                                            {formatServiceName(data.topMovers.increases[0].service)}
                                        </div>
                                        <div className="mt-2 text-red-600 dark:text-red-400 font-semibold">
                                            +${Math.abs(data.topMovers.increases[0].change).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                                            <span className="text-sm ml-1">
                                                (+{data.topMovers.increases[0].percentage.toFixed(1)}%)
                                            </span>
                                        </div>
                                    </>
                                ) : (
                                    <div className="text-muted-foreground">No increases</div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Biggest Decrease */}
                        <Card className="relative overflow-hidden border-none shadow-lg">
                            <CardHeader className="pb-2">
                                <div className="flex items-center gap-2">
                                    <TrendingDown className="w-4 h-4 text-emerald-500" />
                                    <CardTitle className="text-sm font-medium text-muted-foreground">Biggest Decrease</CardTitle>
                                </div>
                            </CardHeader>
                            <CardContent>
                                {data.topMovers.decreases[0] ? (
                                    <>
                                        <div className="text-xl font-bold tracking-tight truncate">
                                            {formatServiceName(data.topMovers.decreases[0].service)}
                                        </div>
                                        <div className="mt-2 text-emerald-600 dark:text-emerald-400 font-semibold">
                                            -${Math.abs(data.topMovers.decreases[0].change).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                                            <span className="text-sm ml-1">
                                                ({data.topMovers.decreases[0].percentage.toFixed(1)}%)
                                            </span>
                                        </div>
                                    </>
                                ) : (
                                    <div className="text-muted-foreground">No decreases</div>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    {/* AI Analysis Section */}
                    <Card className="border-none shadow-lg bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-950/20 dark:to-blue-950/20">
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Sparkles className="h-5 w-5 text-purple-600" />
                                    <CardTitle>AI Cost Analysis</CardTitle>
                                </div>
                                {!showAiAnalysis && (
                                    <Button
                                        onClick={fetchAiAnalysis}
                                        disabled={aiLoading}
                                        className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
                                    >
                                        {aiLoading ? (
                                            <>
                                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                                Analyzing...
                                            </>
                                        ) : (
                                            <>
                                                <Sparkles className="h-4 w-4 mr-2" />
                                                Get AI Insights
                                            </>
                                        )}
                                    </Button>
                                )}
                            </div>
                            <CardDescription>
                                Análisis inteligente de tus costos AWS powered by DeepSeek
                            </CardDescription>
                        </CardHeader>
                        {showAiAnalysis && aiAnalysis && (
                            <CardContent>
                                <div className="prose prose-sm max-w-none bg-white dark:bg-zinc-900 dark:prose-invert rounded-lg p-4 border text-sm leading-relaxed">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                        {aiAnalysis}
                                    </ReactMarkdown>
                                    <div className="mt-4 pt-3 border-t text-xs text-muted-foreground flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <Sparkles className="h-3 w-3" />
                                            Generado por DeepSeek R1
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setShowAiAnalysis(false)}
                                        >
                                            Close
                                        </Button>
                                    </div>
                                </div>
                            </CardContent>
                        )}
                    </Card>

                    {/* Quick Filters */}
                    <QuickFilters
                        searchTerm={searchTerm}
                        onSearchChange={setSearchTerm}
                        filterMode={filterMode}
                        onFilterModeChange={setFilterMode}
                        chartView={chartView}
                        onChartViewChange={setChartView}
                    />

                    {/* Charts Grid */}
                    <div className="grid gap-6 lg:grid-cols-2">
                        {/* Cost Trend Chart */}
                        <CostTrendChart
                            currentPeriodData={[{ date: data.dateRange.start, cost: data.summary.totalCost }]}
                            previousPeriodData={[{ date: data.dateRange.start, cost: data.summary.totalCost - data.summary.topService.trend.change }]}
                        />

                        {/* Service/Account Comparison Chart */}
                        <ServiceComparisonChart
                            accounts={data.accounts}
                            viewMode={chartView}
                        />
                    </div>

                    {/* Account Breakdown */}
                    <Card className="border-none shadow-lg">
                        <CardHeader className="border-b bg-muted/20">
                            <div className="flex items-center justify-between">
                                <div>
                                    <CardTitle>Account Breakdown</CardTitle>
                                    <CardDescription>
                                        {filteredAccounts.length === data.accounts.length
                                            ? `Showing all ${data.accounts.length} accounts`
                                            : `Showing ${filteredAccounts.length} of ${data.accounts.length} accounts`}
                                    </CardDescription>
                                </div>
                                <ExcelExportButton data={data} />
                            </div>
                        </CardHeader>
                        <CardContent className="p-0">
                            <AccountBreakdownTable accounts={filteredAccounts} />
                        </CardContent>
                    </Card>

                </div>
            )
            }
        </div >
    );
}
