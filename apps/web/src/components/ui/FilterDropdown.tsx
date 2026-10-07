import { useState, useRef, useEffect, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FilterDropdownProps {
  label: string;
  children: ReactNode;
  className?: string;
}

export function FilterDropdown({ label, children, className }: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className={cn("relative inline-flex", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs border border-border-light rounded-lg px-2.5 py-1.5 bg-surface-0 text-text-primary hover:bg-surface-1 transition-colors"
      >
        <svg className="w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c4.97 0 9 4.03 9 9s-4.03 9-9 9-9-4.03-9-9 4.03-9 9-9zM5 7h14M7 12h10M9 17h6" />
        </svg>
        {label}
        <svg className="w-3 h-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-1 z-50 min-w-[220px] rounded-lg border border-border-light bg-surface-0 shadow-dropdown animate-scale-in overflow-hidden"
        >
          <div className="p-3 space-y-3">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
