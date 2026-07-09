"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, CheckCheck, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import Link from "next/link";

interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  created_at: string;
  metadata: Record<string, unknown>;
}

export function NotificationBell({ collapsed }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { t } = useI18n();

  // Poll unread count every 30s
  useEffect(() => {
    const fetchCount = async () => {
      try {
        const res = await fetch("/api/notifications/count");
        if (res.ok) {
          const data = await res.json();
          setUnreadCount(data.count);
        }
      } catch {}
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30_000);
    return () => clearInterval(interval);
  }, []);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications?limit=20");
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
      }
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  const handleOpen = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropUp(rect.top > window.innerHeight / 2);
    }
    setOpen(!open);
    if (!open) fetchNotifications();
  };

  const markAsRead = async (ids: number[]) => {
    await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    setNotifications((prev) => prev.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)));
    setUnreadCount((prev) => Math.max(0, prev - ids.length));
  };

  const markAllRead = async () => {
    await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
  };

  const typeIcon = (type: string) => {
    switch (type) {
      case "approval_request": return "🔐";
      case "approval_result": return "✅";
      case "system": return "⚙️";
      default: return "ℹ️";
    }
  };

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t("notifications.justNow");
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleOpen}
        className={cn(
          "relative flex items-center justify-center rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
          open && "bg-accent text-foreground"
        )}
        aria-label={t("notifications.title")}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Dropdown */}
          <div className={cn(
            "absolute z-50 w-80 max-h-[480px] overflow-hidden rounded-xl border border-border bg-card shadow-xl",
            dropUp ? "bottom-full mb-2 left-0" : "top-full mt-2 right-0"
          )}>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-semibold text-foreground">{t("notifications.title")}</span>
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <CheckCheck className="h-3 w-3" />
                  {t("notifications.markAllRead")}
                </button>
              )}
            </div>

            {/* List */}
            <div className="overflow-y-auto max-h-[400px]">
              {loading && notifications.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">{t("common.loading")}</div>
              ) : notifications.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">{t("notifications.empty")}</div>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    className={cn(
                      "flex gap-3 px-4 py-3 border-b border-border/50 last:border-0 transition-colors",
                      !n.read && "bg-primary/5"
                    )}
                  >
                    <span className="text-lg shrink-0 mt-0.5">{typeIcon(n.type)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <span className={cn("text-sm leading-tight", !n.read ? "font-semibold text-foreground" : "text-muted-foreground")}>
                          {n.title}
                        </span>
                        <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(n.created_at)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>
                      <div className="flex items-center gap-2 mt-1.5">
                        {n.link && (
                          <Link
                            href={n.link}
                            onClick={() => { if (!n.read) markAsRead([n.id]); setOpen(false); }}
                            className="text-[11px] text-primary hover:underline flex items-center gap-0.5"
                          >
                            <ExternalLink className="h-3 w-3" /> {t("notifications.view")}
                          </Link>
                        )}
                        {!n.read && (
                          <button
                            onClick={() => markAsRead([n.id])}
                            className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                          >
                            <Check className="h-3 w-3" /> {t("notifications.markRead")}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
