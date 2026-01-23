"use client";

import { Search, Filter, TrendingUp, TrendingDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface QuickFiltersProps {
    searchTerm: string;
    onSearchChange: (term: string) => void;
    filterMode: 'all' | 'increases' | 'decreases';
    onFilterModeChange: (mode: 'all' | 'increases' | 'decreases') => void;
    chartView: 'service' | 'account';
    onChartViewChange: (view: 'service' | 'account') => void;
}

export function QuickFilters({
    searchTerm,
    onSearchChange,
    filterMode,
    onFilterModeChange,
    chartView,
    onChartViewChange
}: QuickFiltersProps) {

    return (
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between p-4 bg-muted/30 rounded-xl border">

            {/* Search */}
            <div className="relative flex-1 min-w-[200px] max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                    type="text"
                    placeholder="Search accounts or services..."
                    value={searchTerm}
                    onChange={(e) => onSearchChange(e.target.value)}
                    className="pl-10 bg-background"
                />
            </div>

            {/* Quick Filters */}
            <div className="flex flex-wrap gap-2">
                <div className="flex items-center gap-2">
                    <Filter className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs font-semibold text-muted-foreground uppercase">Filter:</span>
                </div>

                <Button
                    size="sm"
                    variant={filterMode === 'all' ? 'default' : 'outline'}
                    onClick={() => onFilterModeChange('all')}
                    className="h-8"
                >
                    All
                </Button>

                <Button
                    size="sm"
                    variant={filterMode === 'increases' ? 'default' : 'outline'}
                    onClick={() => onFilterModeChange('increases')}
                    className="h-8 gap-1"
                >
                    <TrendingUp className="h-3 w-3" />
                    Increases
                </Button>

                <Button
                    size="sm"
                    variant={filterMode === 'decreases' ? 'default' : 'outline'}
                    onClick={() => onFilterModeChange('decreases')}
                    className="h-8 gap-1"
                >
                    <TrendingDown className="h-3 w-3" />
                    Decreases
                </Button>
            </div>

            {/* Chart View Toggle */}
            <div className="flex items-center gap-2 bg-background rounded-lg p-1 border">
                <Button
                    size="sm"
                    variant={chartView === 'service' ? 'default' : 'ghost'}
                    onClick={() => onChartViewChange('service')}
                    className="h-7 px-3"
                >
                    By Service
                </Button>
                <Button
                    size="sm"
                    variant={chartView === 'account' ? 'default' : 'ghost'}
                    onClick={() => onChartViewChange('account')}
                    className="h-7 px-3"
                >
                    By Account
                </Button>
            </div>
        </div>
    );
}
