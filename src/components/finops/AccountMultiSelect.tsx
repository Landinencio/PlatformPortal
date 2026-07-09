"use client";

import { useState } from "react";
import { ChevronsUpDown, Search, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

interface Account {
    id: string;
    name: string;
}

interface AccountMultiSelectProps {
    accounts: Account[];
    selectedIds: string[];
    onChange: (selectedIds: string[]) => void;
    placeholder?: string;
}

export function AccountMultiSelect({
    accounts,
    selectedIds,
    onChange,
    placeholder = "Select accounts..."
}: AccountMultiSelectProps) {
    const [open, setOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");

    const toggleAccount = (accountId: string) => {
        if (selectedIds.includes(accountId)) {
            onChange(selectedIds.filter(id => id !== accountId));
        } else {
            onChange([...selectedIds, accountId]);
        }
    };

    const toggleAll = () => {
        const visibleIds = filteredAccounts.map(a => a.id);
        if (selectedIds.length === visibleIds.length && visibleIds.every(id => selectedIds.includes(id))) {
            onChange([]);
        } else {
            onChange(visibleIds);
        }
    };

    const selectedAccounts = accounts.filter(a => selectedIds.includes(a.id));

    // Filter logic — also hide accounts where name is just the ID (unresolved)
    const filteredAccounts = accounts
      .filter(account => {
        // Skip accounts where name is just the numeric ID (unresolved from Organizations)
        const nameIsJustId = /^\d{6,}$/.test(account.name);
        if (nameIsJustId) return false;
        // Search filter
        if (!searchTerm) return true;
        return account.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          account.id.includes(searchTerm);
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className="w-full justify-between h-auto min-h-[2.5rem] py-2"
                >
                    <div className="flex flex-wrap gap-1 flex-1 text-left">
                        {selectedIds.length === 0 ? (
                            <span className="text-muted-foreground">{placeholder}</span>
                        ) : selectedIds.length === accounts.length ? (
                            <Badge variant="secondary" className="font-semibold">
                                All Accounts ({accounts.length})
                            </Badge>
                        ) : (
                            <>
                                {selectedAccounts.slice(0, 2).map(account => (
                                    <Badge key={account.id} variant="secondary">
                                        {account.name}
                                    </Badge>
                                ))}
                                {selectedIds.length > 2 && (
                                    <Badge variant="secondary">
                                        +{selectedIds.length - 2} more
                                    </Badge>
                                )}
                            </>
                        )}
                    </div>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[400px] p-0" align="start">
                <div className="flex flex-col max-h-[400px]">
                    {/* Search Input */}
                    <div className="flex items-center border-b px-3">
                        <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
                        <Input
                            placeholder="Search accounts..."
                            className="flex h-11 w-full rounded-md border-none bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>

                    {/* List */}
                    <div className="overflow-y-auto overflow-x-hidden p-1">
                        {filteredAccounts.length === 0 ? (
                            <div className="py-6 text-center text-sm text-muted-foreground">
                                No account found.
                            </div>
                        ) : (
                            <div className="space-y-1">
                                {/* Select All Action */}
                                <div
                                    className={cn(
                                        "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors",
                                        selectedIds.length === accounts.length && "bg-accent/50"
                                    )}
                                    onClick={toggleAll}
                                >
                                    <div
                                        className={cn(
                                            "mr-2 flex h-4 w-4 items-center justify-center rounded-sm border border-primary",
                                            selectedIds.length === accounts.length
                                                ? "bg-primary text-primary-foreground"
                                                : "opacity-50 [&_svg]:invisible"
                                        )}
                                    >
                                        <Check className="h-4 w-4" />
                                    </div>
                                    <span className="font-semibold">Select All ({filteredAccounts.length})</span>
                                </div>

                                {/* Items */}
                                {filteredAccounts.map((account) => (
                                    <div
                                        key={account.id}
                                        className={cn(
                                            "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors",
                                            selectedIds.includes(account.id) && "bg-accent/50"
                                        )}
                                        onClick={() => toggleAccount(account.id)}
                                    >
                                        <div
                                            className={cn(
                                                "mr-2 flex h-4 w-4 items-center justify-center rounded-sm border border-primary",
                                                selectedIds.includes(account.id)
                                                    ? "bg-primary text-primary-foreground"
                                                    : "opacity-50 [&_svg]:invisible"
                                            )}
                                        >
                                            <Check className="h-4 w-4" />
                                        </div>
                                        <span className="flex-1 truncate">{account.name}</span>
                                        <span className="ml-2 text-[10px] text-muted-foreground/60 font-mono">
                                            {account.id}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}
