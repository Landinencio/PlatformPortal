"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";

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

    const toggleAccount = (accountId: string) => {
        if (selectedIds.includes(accountId)) {
            onChange(selectedIds.filter(id => id !== accountId));
        } else {
            onChange([...selectedIds, accountId]);
        }
    };

    const toggleAll = () => {
        if (selectedIds.length === accounts.length) {
            onChange([]);
        } else {
            onChange(accounts.map(a => a.id));
        }
    };

    const selectedAccounts = accounts.filter(a => selectedIds.includes(a.id));

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className="w-full justify-between h-auto min-h-[2.5rem] py-2"
                >
                    <div className="flex flex-wrap gap-1 flex-1">
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
                <Command>
                    <CommandInput placeholder="Search accounts..." />
                    <CommandList>
                        <CommandEmpty>No account found.</CommandEmpty>
                        <CommandGroup className="max-h-64 overflow-auto">
                            <CommandItem
                                onSelect={toggleAll}
                                className="font-semibold border-b"
                                value="Select All"
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
                                Select All ({accounts.length})
                            </CommandItem>
                            {accounts.map((account) => (
                                <CommandItem
                                    key={account.id}
                                    onSelect={() => toggleAccount(account.id)}
                                    value={`${account.name} ${account.id}`}
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
                                    <span>{account.name}</span>
                                    <span className="ml-auto text-xs text-muted-foreground">
                                        {account.id.slice(-6)}
                                    </span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
