import { cn } from "@/lib/utils";

interface SettingsTab {
  value: string;
  label: string;
  icon: React.ReactNode;
  /** Hidden for everyone except owner + superadmin (most restrictive). */
  ownerOnly?: boolean;
  /** Hidden for everyone except owner/admin (matches server `requireTenantAdmin`). */
  adminOnly?: boolean;
}

function BuildingIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function StoreIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
      <path d="M3 6h18" />
      <path d="M16 10a4 4 0 01-8 0" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function TruckIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M1 3h15v13H1z" /><path d="M16 8h4l3 3v5h-7V8z" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M12 0C5.385 0 0 5.15 0 11.7c0 2.56.92 4.94 2.462 6.803a.81.81 0 0 0 1.078.15l2.7-1.7a.81.81 0 0 1 1.078.15 8.43 8.43 0 0 0 12.34-2.77.81.81 0 0 0-.64-1.31L17.9 14.6a.81.81 0 0 1-.27-1.13 8.35 8.35 0 0 0-.94-6.48 8.36 8.36 0 0 0-6.48.94.81.81 0 0 1-1.13-.27l-1.7-2.7a.81.81 0 0 0-1.31-.64A11.93 11.93 0 0 0 0 11.7c0 3.37 1.5 6.45 3.96 8.54l.04.03c1.89 1.69 4.29 2.75 6.88 2.75 2.77 0 5.29-1.13 7.17-2.97.04-.04.08-.08.12-.12a8.38 8.38 0 0 0 2.3-5.81c0-.35.02-.7.02-1.05a.81.81 0 0 1 1.21-.72 10.5 10.5 0 0 1 2.33 1.85.81.81 0 0 1-1.05 1.2 8.36 8.36 0 0 1-1.66-1.28.81.81 0 0 1 0-1.13c.03-.04.07-.08.1-.13A11.94 11.94 0 0 0 24 11.7c0-6.55-5.38-11.7-12-11.7z" />
    </svg>
  );
}

function RegisterIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2" />
      <path d="M7 11h10M9 15h6" />
    </svg>
  );
}

const SETTINGS_TABS: SettingsTab[] = [
  { value: "business", label: "Business", icon: <BuildingIcon /> },
  { value: "documents", label: "Documents", icon: <DocumentIcon /> },
  { value: "shipping", label: "Shipping", icon: <TruckIcon /> },
  { value: "communications", label: "Communications", icon: <WhatsAppIcon /> },
  { value: "team", label: "Team", icon: <UsersIcon /> },
  { value: "targets", label: "Sales Targets", icon: <TargetIcon /> },
  { value: "data", label: "Data", icon: <DatabaseIcon /> },
  { value: "account", label: "Account", icon: <UserIcon /> },
  { value: "store", label: "Online Store", icon: <StoreIcon /> },
  { value: "pos", label: "Point-of-Sale", icon: <RegisterIcon />, adminOnly: true },
];

interface SettingsNavProps {
  value: string;
  onChange: (value: string) => void;
  role?: string | null;
}

export function SettingsNav({ value, onChange, role }: SettingsNavProps) {
  const isOwner = role === "owner" || role === "superadmin";
  // `admin` and `owner` both pass adminOnly. superadmin inherits admin privileges.
  const isAdmin = isOwner || role === "admin";
  const visibleTabs = SETTINGS_TABS.filter((tab) => {
    if (tab.ownerOnly && !isOwner) return false;
    if (tab.adminOnly && !isAdmin) return false;
    return true;
  });

  return (
    <>
      {/* Desktop: vertical sidebar — sticky */}
      <nav className="hidden md:block w-[220px] shrink-0 sticky top-0 self-start">
        <div className="space-y-0.5">
          {visibleTabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => onChange(tab.value)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left",
                tab.value === value
                  ? "bg-surface-2 text-text-primary font-medium"
                  : "text-text-secondary hover:bg-surface-1 hover:text-text-primary"
              )}
            >
              <span className="w-[18px] h-[18px] shrink-0">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Mobile: horizontal scrollable tabs — sticky */}
      <div className="md:hidden flex gap-1 overflow-x-auto pb-4 -mx-1 px-1 sticky top-0 z-10 bg-surface-1">
        {visibleTabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => onChange(tab.value)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors",
              tab.value === value
                ? "bg-brand-600/10 text-brand-700 dark:text-brand-400"
                : "text-text-tertiary hover:text-text-secondary hover:bg-surface-2"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </>
  );
}
