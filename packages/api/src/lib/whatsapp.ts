/**
 * WhatsApp service abstraction using @whiskeysockets/baileys.
 *
 * Dev: prints to console (no WhatsApp credentials configured)
 * Prod: connects to WhatsApp Web via Baileys, manages QR codes and sessions
 *
 * The Baileys connection runs in-process within the API server — no separate
 * Docker container or external service required. When the WhatsApp
 * service starts (or re-connects), it emits a QR code that can be served
 * via the /api/whatsapp/qr HTTP endpoint for scanning from the web UI.
 *
 * Env vars:
 *   WHATSAPP_ENABLED     — set to "true" to enable WhatsApp features
 *   WHATSAPP_AUTH_DIR    — directory for saving Baileys auth state (default: ./whatsapp-auth)
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  type WAVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────────

interface WhatsAppSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

interface WhatsAppStatus {
  connected: boolean;
  phone?: string;
  state?: string;
  qrAvailable: boolean;
  mode: "console" | "baileys";
}

interface WhatsAppService {
  getStatus(): Promise<WhatsAppStatus>;
  getQRCode(): Promise<Buffer | null>;
  reset(): Promise<void>;
  sendInvoicePDF(
    to: string,
    pdfBuffer: Buffer,
    options: {
      invoiceNumber: string;
      message?: string;
    },
  ): Promise<WhatsAppSendResult>;
  sendText(to: string, text: string): Promise<WhatsAppSendResult>;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Normalize a phone number for the WhatsApp API.
 * The Evolution API / Baileys expects JIDs in the format: `919999999999@s.whatsapp.net`
 */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  // Already has country code (11+ digits, does not start with 0)
  if (digits.length >= 11 && !digits.startsWith("0")) {
    return digits;
  }

  // Remove leading 0 from local-format numbers
  const local = digits.startsWith("0") ? digits.slice(1) : digits;

  // If 10 digits (Indian local format), prepend 91
  if (local.length === 10) {
    return "91" + local;
  }

  // Starts with 00 (international prefix) — strip it
  if (digits.startsWith("00")) {
    return digits.slice(2);
  }

  return digits;
}

// ── Console fallback (development / WhatsApp not configured) ────────────

class ConsoleWhatsAppService implements WhatsAppService {
  async getStatus(): Promise<WhatsAppStatus> {
    if (process.env.NODE_ENV === "production") {
      console.error("[whatsapp] FATAL: WhatsApp not configured for production. Set WHATSAPP_ENABLED=true.");
      throw new Error("WhatsApp service not configured");
    }
    console.log("[whatsapp] Console mode — not connected to WhatsApp");
    return { connected: false, state: "disconnected", qrAvailable: false, mode: "console" };
  }

  async getQRCode(): Promise<Buffer | null> {
    if (process.env.NODE_ENV === "production") {
      throw new Error("WhatsApp service not configured");
    }
    return null;
  }

  async reset(): Promise<void> {
    console.log("[whatsapp] Reset requested in console mode — no-op");
  }

  async sendInvoicePDF(
    to: string,
    pdfBuffer: Buffer,
    options: { invoiceNumber: string; message?: string },
  ): Promise<WhatsAppSendResult> {
    if (process.env.NODE_ENV === "production") {
      console.error("[whatsapp] FATAL: WhatsApp not configured for production. Set WHATSAPP_ENABLED=true.");
      throw new Error("WhatsApp service not configured");
    }
    const display = normalizePhone(to);
    console.log("");
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║  WhatsApp (console mode)                      ║");
    console.log("╠══════════════════════════════════════════════════════════╣");
    console.log(`║  To:        ${display.padEnd(40)}║`);
    console.log(`║  Invoice:   ${options.invoiceNumber.padEnd(40)}║`);
    const msg = options.message ?? "Invoice attached";
    console.log(`║  Message:   ${msg.substring(0, 40).padEnd(40)}║`);
    console.log(`║  PDF size:  ${pdfBuffer.length.toString().padEnd(38)}bytes  ║`);
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log("");
    return { success: true, messageId: "console-mock-id" };
  }

  async sendText(to: string, text: string): Promise<WhatsAppSendResult> {
    if (process.env.NODE_ENV === "production") {
      throw new Error("WhatsApp service not configured");
    }
    console.log(`[whatsapp] Console: would send to ${to}: ${text}`);
    return { success: true, messageId: "console-mock-id" };
  }
}

// ── Baileys implementation ───────────────────────────────────────────────

class BaileysWhatsAppService implements WhatsAppService {
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private qrCodeData: string | null = null;
  private connectionState: string = "disconnected";
  private connectedPhone: string | undefined;
  private initialized = false;
  private authDir: string;
  private qrTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.authDir = process.env.WHATSAPP_AUTH_DIR || join(process.cwd(), "whatsapp-auth");
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (!existsSync(this.authDir)) {
      await mkdir(this.authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    try {
      const { version: waVersion } = await fetchLatestBaileysVersion();
      console.log("[whatsapp] Using WA Web version:", waVersion);

      this.socket = makeWASocket({
        version: waVersion as WAVersion,
        auth: state,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: true,
      });

      this.socket.ev.on("creds.update", () => {
        void saveCreds();
      });

      this.socket.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
          this.qrCodeData = qr;
          this.connectionState = "connecting";
          console.log("[whatsapp] QR code received — scan with WhatsApp app");

          if (this.qrTimer) clearTimeout(this.qrTimer);
          this.qrTimer = setTimeout(() => {
            this.qrCodeData = null;
            console.log("[whatsapp] QR code expired");
          }, 20000);
        }

        if (connection === "open") {
          this.connectionState = "open";
          this.qrCodeData = null;
          this.connectedPhone = this.socket?.user?.id?.split(":")[0];
          console.log("[whatsapp] Connected as:", this.connectedPhone);
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
        }

        if (connection === "close") {
          const err = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
          const code = err?.output?.statusCode || 0;
          const errMsg = lastDisconnect?.error?.message || "Unknown";
          console.log(`[whatsapp] Connection closed (code ${code}): ${errMsg}`);
          this.connectionState = "close";

          if (code === DisconnectReason.loggedOut) {
            // Session logged out — need to re-scan QR
            this.connectionState = "connecting";
            this.qrCodeData = null;
            this.connectedPhone = undefined;
            try {
              await rm(this.authDir, { recursive: true, force: true });
            } catch {
              // ignore cleanup errors
            }
            console.log("[whatsapp] Session logged out — clearing auth state, please re-scan QR code");
          } else {
            // Auto-reconnect on other disconnects
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
              console.log("[whatsapp] Attempting to reconnect...");
              void this.reconnect();
            }, 5000);
          }
        }
      });
    } catch (err) {
      console.error("[whatsapp] Failed to initialize:", err);
      this.initialized = false;
    }
  }

  private async reconnect(): Promise<void> {
    this.socket = null;
    this.initialized = false;
    await this.init();
  }

  async reset(): Promise<void> {
    console.log("[whatsapp] Resetting auth state — clearing saved credentials");
    this.connectionState = "close";
    this.qrCodeData = null;
    this.connectedPhone = undefined;
    if (this.socket) {
      try {
        this.socket.end(new Error("Reset requested"));
      } catch {
        // ignore
      }
      this.socket = null;
    }
    if (this.qrTimer) {
      clearTimeout(this.qrTimer);
      this.qrTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await rm(this.authDir, { recursive: true, force: true });
      await mkdir(this.authDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
    this.initialized = false;
    await this.init();
  }

  async getStatus(): Promise<WhatsAppStatus> {
    if (!this.initialized) {
      await this.init();
    }
    return {
      connected: this.connectionState === "open",
      phone: this.connectedPhone,
      state: this.connectionState,
      qrAvailable: !!this.qrCodeData,
      mode: "baileys",
    };
  }

  async getQRCode(): Promise<Buffer | null> {
    if (!this.qrCodeData) {
      return null;
    }
    try {
      const png = await QRCode.toBuffer(this.qrCodeData, {
        width: 400,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
      return png;
    } catch (err) {
      console.error("[whatsapp] Failed to generate QR code image:", err);
      return null;
    }
  }

  async sendInvoicePDF(
    to: string,
    pdfBuffer: Buffer,
    options: { invoiceNumber: string; message?: string },
  ): Promise<WhatsAppSendResult> {
    if (!this.socket) {
      return { success: false, error: "WhatsApp not connected" };
    }

    const jid = `${normalizePhone(to)}@s.whatsapp.net`;
    const message = options.message ?? `Hello! Here is your invoice ${options.invoiceNumber} from Hisaabo.`;
    const fileName = `${options.invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;

    try {
      const res = await this.socket.sendMessage(jid, {
        document: {
          url: `data:application/pdf;base64,${pdfBuffer.toString("base64")}`,
        },
        mimetype: "application/pdf",
        fileName,
        caption: message,
      });

      return {
        success: true,
        messageId: res?.key?.id ?? undefined,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error("[whatsapp] Failed to send invoice PDF:", errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  async sendText(to: string, text: string): Promise<WhatsAppSendResult> {
    if (!this.socket) {
      return { success: false, error: "WhatsApp not connected" };
    }

    const jid = `${normalizePhone(to)}@s.whatsapp.net`;

    try {
      const res = await this.socket.sendMessage(jid, { text });
      return {
        success: true,
        messageId: res?.key?.id ?? undefined,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error("[whatsapp] Failed to send text:", errorMsg);
      return { success: false, error: errorMsg };
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────

function createWhatsAppService(): WhatsAppService {
  const enabled = process.env.WHATSAPP_ENABLED === "true";

  if (enabled) {
    console.log("[whatsapp] Baileys WhatsApp service enabled");
    return new BaileysWhatsAppService();
  }

  console.log("[whatsapp] WHATSAPP_ENABLED not set — messages will print to console");
  return new ConsoleWhatsAppService();
}

export const whatsAppService = createWhatsAppService();

export type {
  WhatsAppService,
  WhatsAppStatus,
  WhatsAppSendResult,
};
