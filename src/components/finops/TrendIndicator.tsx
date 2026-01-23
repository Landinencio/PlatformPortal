"use client";

import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TrendData } from "@/types/finops";

interface TrendIndicatorProps {
    trend: TrendData;
    showValue?: boolean;
    size?: "sm" | "md" | "lg";
    className?: string;
}

export function TrendIndicator({
    trend,
    showValue = true,
    size = "md",
    className
}: TrendIndicatorProps) {
    const isIncrease = trend.change > 0;
    const isDecrease = trend.change < 0;
    const isNeutral = trend.change === 0;

    const sizeClasses = {
        sm: "text-xs",
        md: "text-sm",
        lg: "text-base"
    };

    const iconSizes = {
        sm: "w-3 h-3",
        md: "w-4 h-4",
        lg: "w-5 h-5"
    };

    return (
        <div
            className={cn(
                "inline-flex items-center gap-1 font-semibold",
                sizeClasses[size],
                isIncrease && "text-red-600 dark:text-red-400",
                isDecrease && "text-emerald-600 dark:text-emerald-400",
                isNeutral && "text-muted-foreground",
                className
            )}
        >
            {isIncrease && <TrendingUp className={iconSizes[size]} />}
            {isDecrease && <TrendingDown className={iconSizes[size]} />}
            {isNeutral && <Minus className={iconSizes[size]} />}

            {showValue && (
                <span>
                    {isIncrease && "+"}
                    {Math.abs(trend.percentage).toFixed(1)}%
                </span>
            )}
        </div>
    );
}
