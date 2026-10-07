import { useState, useEffect } from "react";
import { apiUrl } from "@/lib/api-url";
import { isDesktop } from "@/lib/isDesktop";

export function CommunicationsTab() {
  const [waOpen, setWaOpen] = useState(false);
  const [waStatus, setWaStatus] = useState<"idle" | "checking" | "connected" | "disconnected" | "qr" | "console">("idle");
  const [waKey, setWaKey] = useState(0);

  useEffect(() => {
    if (waOpen) {
      setWaStatus("checking");
      void checkWaStatus();
    }
  }, [waOpen]);

  useEffect(() => {
    if (waStatus === "qr") {
      const interval = setInterval(() => {
        void checkWaStatus();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [waStatus]);

  async function checkWaStatus() {
    setWaStatus("checking");
    try {
      const res = await fetch(apiUrl("/api/whatsapp/status"), {
        credentials: isDesktop() ? "omit" : "include",
      });
      if (!res.ok) {
        setWaStatus("disconnected");
        return;
      }
      const data = await res.json();
      if (data.connected) {
        setWaStatus("connected");
      } else if (data.qrAvailable) {
        setWaStatus("qr");
        setWaKey((k) => k + 1);
      } else if (data.mode === "console") {
        setWaStatus("console");
      } else {
        setWaStatus("disconnected");
      }
    } catch {
      setWaStatus("disconnected");
    }
  }

  async function handleReset() {
    setWaStatus("checking");
    try {
      const res = await fetch(apiUrl("/api/whatsapp/reset"), {
        method: "POST",
        credentials: isDesktop() ? "omit" : "include",
      });
      if (!res.ok) throw new Error("Reset failed");
    } catch (err: any) {
      console.error("[wa] reset failed:", err);
    }
    void checkWaStatus();
  }

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-text-primary">WhatsApp</h3>
            <p className="text-sm text-text-secondary mt-1 leading-relaxed">
              Send invoices directly to your party's WhatsApp from the invoice list or detail view.
              Scan a QR code to connect your business WhatsApp number.
            </p>
          </div>
          {waStatus === "connected" && (
            <button
              onClick={() => handleReset()}
              title="Disconnect WhatsApp and reset auth"
              className="text-xs px-2.5 py-1.5 rounded-lg font-medium text-red-600 hover:bg-red-600/[0.08] transition-colors"
            >
              Disconnect
            </button>
          )}
        </div>

        {waStatus === "connected" ? (
          <div className="mt-4 p-3 bg-emerald-50 dark:bg-emerald-950/40 rounded-lg border border-emerald-200 dark:border-emerald-800">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                WhatsApp Connected
              </span>
            </div>
          </div>
        ) : waStatus === "console" ? (
          <div className="mt-4">
            <p className="text-xs text-text-tertiary mb-2">
              WhatsApp is in dev console mode. Set <code className="bg-surface-2 px-1 py-0.5 rounded">WHATSAPP_ENABLED=true</code> and restart.
            </p>
          </div>
        ) : (
          <button
            onClick={() => setWaOpen(true)}
            className="mt-4 text-xs px-3 py-1.5 rounded-lg font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors"
          >
            Connect WhatsApp
          </button>
        )}
      </div>

      <div className="card p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-text-primary">Email</h3>
            <p className="text-sm text-text-secondary mt-1 leading-relaxed">
              Send invoice links and magic-login emails via Resend. Configure your provider in server environment variables.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between py-2">
            <span className="text-xs text-text-tertiary">Provider</span>
            <span className="text-xs font-medium text-text-primary">
            </span>
          </div>
          <div className="flex items-center justify-between py-2 border-t border-border-light">
            <span className="text-xs text-text-tertiary">From address</span>
            <span className="text-xs font-medium text-text-primary">noreply@hisaabo.com</span>
          </div>
          <div className="flex items-center justify-between py-2 border-t border-border-light">
            <span className="text-xs text-text-tertiary">Status</span>
            <span className="text-xs font-medium text-amber-600">Not configured</span>
          </div>
        </div>

        <div className="mt-3 p-3 bg-surface-2 rounded-lg">
          <p className="text-xs font-medium text-text-tertiary mb-2">Gmail SMTP setup:</p>
          <code className="text-xs block text-text-secondary mb-1">SMTP_HOST=smtp.gmail.com</code>
          <code className="text-xs block text-text-secondary mb-1">SMTP_PORT=587</code>
          <code className="text-xs block text-text-secondary mb-1">SMTP_SECURE=false</code>
          <code className="text-xs block text-text-secondary mb-1">SMTP_USER=your-gmail@gmail.com</code>
          <code className="text-xs block text-text-secondary mb-1">SMTP_PASS=app-password</code>
          <code className="text-xs block text-text-secondary">EMAIL_FROM=Your Business Name &lt;your-gmail@gmail.com&gt;</code>
        </div>
      </div>

      {waOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="w-96 max-h-[90vh] overflow-y-auto rounded-xl border border-border-light bg-surface-1 shadow-xl">
            <div className="p-4 border-b border-border-light flex items-center justify-between">
              <h3 className="text-sm font-medium text-text-tertiary uppercase tracking-wide">Connect WhatsApp</h3>
              <button
                onClick={() => setWaOpen(false)}
                className="p-1 rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-4">
              {waStatus === "checking" && (
                <div className="text-center py-4">
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-xs text-text-tertiary">Checking WhatsApp connection…</p>
                </div>
              )}

              {waStatus === "connected" && (
                <div className="text-center py-4">
                  <div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center mx-auto mb-3">
                    <svg className="w-5 h-5 text-emerald-600" fill="currentColor" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" fill="currentColor" />
                      <path d="M8.5 12.5l2.5 2.5 3-3" fill="white" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-text-primary">WhatsApp Connected</p>
                  <p className="text-xs text-text-tertiary mt-1">You can now send invoices via WhatsApp</p>
                  <button
                    onClick={() => setWaOpen(false)}
                    className="mt-4 text-xs px-3 py-1.5 rounded-lg font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors"
                  >
                    Close
                  </button>
                </div>
              )}

              {waStatus === "qr" && (
                <div className="text-center">
                  <p className="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-3">Scan QR Code</p>
                  <img
                    key={waKey}
                    src={`${apiUrl("/api/whatsapp/qr")}?_t=${Date.now()}`}
                    alt="WhatsApp QR code"
                    className="w-48 h-48 mx-auto rounded-lg border border-border-light bg-white"
                    onError={() => {
                      setTimeout(() => {
                        setWaStatus("checking");
                        void checkWaStatus();
                      }, 1000);
                    }}
                  />
                  <p className="text-xs text-text-tertiary mt-3">Open WhatsApp on your phone and scan the QR code</p>
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => {
                        setWaStatus("checking");
                        void checkWaStatus();
                      }}
                      className="flex-1 text-xs px-2.5 py-1.5 rounded-lg font-medium text-text-secondary hover:bg-surface-2 border border-border-light transition-colors"
                    >
                      Refresh QR
                    </button>
                    <button
                      onClick={() => {
                        setWaStatus("checking");
                        void handleReset();
                      }}
                      className="flex-1 text-xs px-2.5 py-1.5 rounded-lg font-medium text-text-secondary hover:bg-surface-2 border border-border-light transition-colors"
                    >
                      Reset QR
                    </button>
                  </div>
                </div>
              )}

              {waStatus === "disconnected" && (
                <div className="text-center py-4">
                  <p className="text-xs text-text-tertiary mb-3">Not connected to WhatsApp</p>
                  <button
                    onClick={() => {
                      setWaStatus("checking");
                      void checkWaStatus();
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors"
                  >
                    Try Connecting
                  </button>
                </div>
              )}

              {waStatus === "console" && (
                <div className="text-center py-4">
                  <p className="text-xs text-text-tertiary">WhatsApp is in dev console mode.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
