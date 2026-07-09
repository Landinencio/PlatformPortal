"use client";

import * as React from "react";
import { X, Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface MultiSelectOption {
  value: string;
  label: string;
  group?: string;
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  maxDisplay?: number;
}

export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyMessage = "No results found",
  className,
  maxDisplay = 3,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const filtered = React.useMemo(() => {
    if (!search.trim()) return options;
    const lower = search.toLowerCase();
    return options.filter(
      (opt) => opt.label.toLowerCase().includes(lower) || opt.value.toLowerCase().includes(lower)
    );
  }, [options, search]);

  const toggleOption = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
    // Don't close the popover when toggling options
  };

  const selectAll = () => {
    // "All" means no filter, so we clear the selection
    onChange([]);
  };
  
  const selectNone = () => {
    onChange([]);
  };

  const handleDone = () => {
    setOpen(false);
    setSearch(""); // Clear search when closing
  };

  const displayText = React.useMemo(() => {
    if (selected.length === 0) return placeholder;
    if (selected.length <= maxDisplay) {
      return selected
        .map((v) => options.find((o) => o.value === v)?.label || v)
        .join(", ");
    }
    return `${selected.length} selected`;
  }, [selected, options, placeholder, maxDisplay]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span className="min-w-0 flex-1 truncate text-left">{displayText}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[300px] p-0" align="start">
        {/* Search */}
        <div className="flex items-center border-b px-3 py-2">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {search && (
            <button onClick={() => setSearch("")} className="ml-2 opacity-50 hover:opacity-100">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Quick actions */}
        <div className="flex gap-1 border-b px-2 py-1.5">
          <button
            onClick={selectAll}
            className="text-xs px-2 py-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            All
          </button>
          <button
            onClick={selectNone}
            className="text-xs px-2 py-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            None
          </button>
          <span className="ml-auto text-xs text-muted-foreground py-1">
            {selected.length}/{options.length}
          </span>
        </div>

        {/* Options list */}
        <div className="max-h-[200px] overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>
          ) : (
            filtered.map((option) => (
              <button
                key={option.value}
                onClick={() => toggleOption(option.value)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted",
                  selected.includes(option.value) && "bg-primary/10"
                )}
              >
                <div
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded border",
                    selected.includes(option.value)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/30"
                  )}
                >
                  {selected.includes(option.value) && <Check className="h-3 w-3" />}
                </div>
                <span className="truncate">{option.label}</span>
              </button>
            ))
          )}
        </div>

        {/* Selected chips */}
        {selected.length > 0 && selected.length <= 5 && (
          <div className="flex flex-wrap gap-1 border-t p-2">
            {selected.map((value) => {
              const opt = options.find((o) => o.value === value);
              return (
                <span
                  key={value}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs"
                >
                  {opt?.label || value}
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleOption(value); }}
                    className="hover:text-danger"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* Done button */}
        <div className="border-t p-2">
          <Button
            onClick={handleDone}
            className="w-full"
            size="sm"
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
