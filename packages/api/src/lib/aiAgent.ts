import { eq, and, ilike, or, sql, desc, isNull, inArray } from "drizzle-orm";
import {
  invoices,
  invoiceItems,
  parties,
  items,
  payments,
  businesses,
} from "@hisaabo/db";
import type { TenantDatabase } from "@hisaabo/db";
import { money, calcInvoiceTotals } from "@hisaabo/shared";
import { logger } from "./logger.js";
import type { Context } from "../context.js";
import type { AppAbility } from "./permissions.js";

export type AiContext = {
  user: NonNullable<Context["user"]>;
  tenantId: string;
  db: TenantDatabase;
  businessId: string;
  ability: AppAbility;
};

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

export interface ToolCallResult {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
}

export interface ChatResult {
  reply: string;
  toolCalls: ToolCallResult[];
}

interface ToolCall {
  type: string;
  function?: {
    name: string;
    arguments: string;
  };
}

interface OllamaMessage {
  role: string;
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OllamaResponse {
  message?: {
    role: string;
    content: string;
    tool_calls?: ToolCall[];
  };
  error?: string;
}

function parseToolArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

const SYSTEM_PROMPT = `You are an AI assistant for a business accounting application. You have access to tools that let you query and modify invoices, parties (customers/suppliers), items, payments, and financial data. Use tools when you need to look up specific information or create records. When a tool gives you data, use it to provide a precise, helpful answer. Only call tools when necessary — if you can answer from what you already know, just respond directly.

Guidelines:
- When creating invoices, always look up the party by name first. If they don't exist, create them.
- When creating invoices, look up items by name to get their selling price and tax rate.
- Numbers should be strings representing decimal values (e.g., "500.00").
- For Indian business context, use ₹ for currency and format dates as DD/MM/YYYY.
- Be concise in your responses — summarize what you did and the key numbers.`;

export class AiAgent {
  private ctx: AiContext;
  private model: string;
  private apiKey: string;
  private apiUrl: string;

  constructor(ctx: AiContext, opts?: { model?: string; apiUrl?: string; apiKey?: string }) {
    this.ctx = ctx;
    this.apiUrl = opts?.apiUrl || "https://api.groq.com/openai/v1/chat/completions";
    this.apiKey = opts?.apiKey || process.env.GROQ_API_KEY || ((): never => { throw new Error("No Groq API key configured. Set GROQ_API_KEY in .env"); })();
    this.model = opts?.model || process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  }

  private get tools() {
    return [
      {
        type: "function",
        function: {
          name: "dashboard_summary",
          description: "Get a financial overview of the business: total sales, purchases, expenses, receivables, payables, and recent invoices for the current financial year. Can optionally filter by date range.",
          parameters: {
            type: "object",
            properties: {
              fromDate: { type: "string", description: "Start date in ISO format (YYYY-MM-DD). Optional." },
              toDate: { type: "string", description: "End date in ISO format (YYYY-MM-DD). Optional." },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "invoice_list",
          description: "Search and list invoices. Filter by search term (invoice number or party name), status, type, or date range. Returns invoice number, party, type, amount, status, and balance.",
          parameters: {
            type: "object",
            properties: {
              search: { type: "string", description: "Search by invoice number or party name" },
              status: { type: "string", description: "Filter by status: draft, unfulfilled, sent, paid, partial, overdue, cancelled" },
              type: { type: "string", description: "Filter by type: sale or purchase" },
              partyName: { type: "string", description: "Filter by party name" },
              fromDate: { type: "string", description: "Start date in ISO format" },
              toDate: { type: "string", description: "End date in ISO format" },
              limit: { type: "number", description: "Maximum results to return (default 20, max 50)", default: 20 },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "invoice_get",
          description: "Get detailed information about a specific invoice, including all line items, party details, and balance. Provide the exact invoice number (e.g., INV-00001).",
          parameters: {
            type: "object",
            properties: {
              invoiceNumber: { type: "string", description: "The invoice number to look up (e.g., INV-00001)" },
            },
            required: ["invoiceNumber"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "invoice_create",
          description: "Create a new invoice. Provide the party name (will be looked up), invoice type (sale or purchase), and line items. Each line item needs an item name, quantity, and unit price. Tax percent defaults to 0.",
          parameters: {
            type: "object",
            properties: {
              partyName: { type: "string", description: "Name of the customer or supplier" },
              type: { type: "string", enum: ["sale", "purchase"], description: "Invoice type" },
              lineItems: {
                type: "array",
                description: "Line items for the invoice",
                items: {
                  type: "object",
                  properties: {
                    itemName: { type: "string", description: "Name of the item/product" },
                    quantity: { type: "string", description: "Quantity (e.g., '10' or '2.5')" },
                    unitPrice: { type: "string", description: "Unit price (e.g., '500.00')" },
                    taxPercent: { type: "string", description: "Tax percentage (default '0')", default: "0" },
                    discountPercent: { type: "string", description: "Discount percentage (default '0')", default: "0" },
                  },
                  required: ["itemName", "quantity", "unitPrice"],
                },
              },
              notes: { type: "string", description: "Optional notes for the invoice" },
              termsAndConditions: { type: "string", description: "Optional terms and conditions" },
            },
            required: ["partyName", "type", "lineItems"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "party_list",
          description: "Search for customers and suppliers by name or phone number. Returns party name, phone, type, and balance.",
          parameters: {
            type: "object",
            properties: {
              search: { type: "string", description: "Search term for party name or phone" },
              type: { type: "string", enum: ["customer", "supplier"], description: "Filter by party type" },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "party_create",
          description: "Create a new customer or supplier. Requires name and type. Other fields are optional.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Party name (required)" },
              type: { type: "string", enum: ["customer", "supplier"], description: "Party type (required)" },
              phone: { type: "string", description: "Phone number" },
              email: { type: "string", description: "Email address" },
              gstin: { type: "string", description: "GSTIN number" },
              billingAddress: { type: "string", description: "Billing address" },
              city: { type: "string", description: "City" },
              state: { type: "string", description: "State" },
              stateCode: { type: "string", description: "State code (e.g., '27' for Maharashtra)" },
            },
            required: ["name", "type"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "item_list",
          description: "Search for items/products by name or SKU. Returns item name, selling price, unit, tax rate, and stock quantity.",
          parameters: {
            type: "object",
            properties: {
              search: { type: "string", description: "Search term for item name or SKU" },
              category: { type: "string", description: "Filter by category" },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "item_create",
          description: "Create a new item/product. Requires a name. Optional: selling price, tax percentage, unit, category, description.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Item name (required)" },
              salePrice: { type: "string", description: "Selling price per unit" },
              purchasePrice: { type: "string", description: "Cost price per unit" },
              taxPercent: { type: "string", description: "Tax percentage (default '0')", default: "0" },
              unit: { type: "string", description: "Unit of measurement (default 'pcs')", default: "pcs" },
              category: { type: "string", description: "Item category" },
              description: { type: "string", description: "Item description" },
            },
            required: ["name"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "payment_create",
          description: "Record a payment received from or paid to a party. Provide the party name, amount, and payment mode. Optionally reference an invoice number.",
          parameters: {
            type: "object",
            properties: {
              partyName: { type: "string", description: "Name of the party (required)" },
              amount: { type: "string", description: "Payment amount (required)" },
              mode: {
                type: "string",
                enum: ["cash", "bank", "upi", "cheque", "other", "credit_card", "debit_card", "net_banking", "wallet"],
                description: "Payment mode (required)",
              },
              invoiceNumber: { type: "string", description: "Invoice number to apply payment to" },
              notes: { type: "string", description: "Optional notes" },
            },
            required: ["partyName", "amount", "mode"],
          },
        },
      },
    ];
  }

  async chat(userMessage: string, history: ChatMessage[]): Promise<ChatResult> {
    const messages: OllamaMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...this.buildOllamaMessages(history),
      { role: "user", content: userMessage },
    ];

    const allToolCalls: ToolCallResult[] = [];
    const maxIterations = 10;

    for (let i = 0; i < maxIterations; i++) {
      try {
        const response = await this.groqChat(messages);
        const msg = response.message;

        if (!msg) {
          return { reply: "I got an unexpected response from the AI model. Please try again.", toolCalls: allToolCalls };
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          messages.push({
            role: "assistant",
            content: msg.content || "",
            tool_calls: msg.tool_calls,
          });

          for (const call of msg.tool_calls) {
            const toolName = call.function?.name || "";
            const args = parseToolArgs(call.function?.arguments);
            const resultText = await this.executeTool(toolName, args);

            allToolCalls.push({
              name: toolName,
              arguments: args,
              result: resultText,
            });

            if (messages[i] !== undefined) {
              messages[messages.length] = {
                role: "tool",
                content: resultText,
                name: toolName,
              };
            }
          }
        } else {
          return { reply: msg.content || "", toolCalls: allToolCalls };
        }
        } catch (error: unknown) {
        logger.error({ err: error }, "AI agent chat error");
        return {
          reply: `I encountered an error: ${error instanceof Error ? error.message : String(error)}`,
          toolCalls: allToolCalls,
        };
      }
    }

    return { reply: "I hit the maximum number of tool calls — here's what I did so far.", toolCalls: allToolCalls };
  }

  private async groqChat(messages: OllamaMessage[]): Promise<OllamaResponse> {
    const groqTools = this.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));

    const body = {
      model: this.model,
      messages: messages.map((m) => {
        if (m.role === "tool") {
          return { role: "tool", content: m.content, tool_call_id: "call_0", name: m.name };
        }
        if (m.tool_calls) {
          return {
            role: "assistant",
            content: m.content || "",
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.function?.name || "call_0",
              type: "function" as const,
              function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" },
            })),
          };
        }
        return { role: m.role, content: m.content || "" };
      }),
      tools: groqTools,
      tool_choice: "auto",
      stream: false,
      max_tokens: 2048,
    };

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);

      try {
        const res = await fetch(this.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (res.status === 429 && attempt < maxRetries) {
          const retryAfter = res.headers.get("retry-after");
          const waitMs = retryAfter ? Math.min(parseFloat(retryAfter) * 1000, 10_000) : Math.min(attempt * 2000, 10_000);
          logger.warn({ attempt, waitMs }, "Groq rate limited, retrying");
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Groq API error: ${res.status} ${errText}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        const msg = choice?.message;

        if (!msg) {
          throw new Error("No message in Groq response");
        }

        return {
          message: {
            role: "assistant",
            content: msg.content || "",
            tool_calls: msg.tool_calls?.map((tc: { id: string; type: string; function: { name: string; arguments: string } }) => ({
              type: tc.type,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            })),
          },
        };
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    }

    throw new Error("Max retries exceeded for Groq API");
  }

  private buildOllamaMessages(history: ChatMessage[]): OllamaMessage[] {
    const msgs: OllamaMessage[] = [];
    for (const msg of history) {
      if (msg.role === "tool") {
        msgs.push({
          role: "tool",
          content: msg.content,
          name: msg.toolName,
        });
      } else if (msg.role === "assistant" && msg.toolName) {
        msgs.push({
          role: "assistant",
          content: msg.content,
        });
      } else {
        msgs.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }
    return msgs;
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      let result: unknown;
      switch (name) {
        case "dashboard_summary":
          result = await this.dashboardSummary(args);
          break;
        case "invoice_list":
          result = await this.invoiceList(args);
          break;
        case "invoice_get":
          result = await this.invoiceGet(args);
          break;
        case "invoice_create":
          result = await this.invoiceCreate(args);
          break;
        case "party_list":
          result = await this.partyList(args);
          break;
        case "party_create":
          result = await this.partyCreate(args);
          break;
        case "item_list":
          result = await this.itemList(args);
          break;
        case "item_create":
          result = await this.itemCreate(args);
          break;
        case "payment_create":
          result = await this.paymentCreate(args);
          break;
        default:
          return `Unknown tool: ${name}`;
      }
      return JSON.stringify(result);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return `Error: ${errMsg}`;
    }
  }

  private async dashboardSummary(args: Record<string, unknown>): Promise<unknown> {
    const { fromDate, toDate } = args;
    const dateConditions = [];
    if (fromDate) {
      dateConditions.push(sql`${invoices.invoiceDate} >= ${fromDate}::timestamp`);
    }
    if (toDate) {
      dateConditions.push(sql`${invoices.invoiceDate} <= ${toDate}::timestamp`);
    }

    const [salesRow, purchaseRow, expenseRow, receivableRow, payableRow] = await Promise.all([
      this.ctx.db
        .select({ total: sql<string>`coalesce(sum(${invoices.totalAmount}::numeric), 0)::text` })
        .from(invoices)
        .where(and(
          eq(invoices.businessId, this.ctx.businessId),
          eq(invoices.type, "sale"),
          eq(invoices.documentType, "invoice"),
          isNull(invoices.deletedAt),
          ...dateConditions,
        )),
      this.ctx.db
        .select({ total: sql<string>`coalesce(sum(${invoices.totalAmount}::numeric), 0)::text` })
        .from(invoices)
        .where(and(
          eq(invoices.businessId, this.ctx.businessId),
          eq(invoices.type, "purchase"),
          eq(invoices.documentType, "invoice"),
          isNull(invoices.deletedAt),
          ...dateConditions,
        )),
      this.ctx.db.execute(sql`SELECT coalesce(sum(amount::numeric), 0)::text as total FROM expenses WHERE business_id = ${this.ctx.businessId} AND (${dateConditions.length > 0 ? sql`1=1` : sql`1=1`})`),
      this.ctx.db
        .select({ total: sql<string>`coalesce(sum(${invoices.totalAmount}::numeric - ${invoices.amountPaid}::numeric), 0)::text` })
        .from(invoices)
        .where(and(
          eq(invoices.businessId, this.ctx.businessId),
          eq(invoices.type, "sale"),
          sql`${invoices.status} NOT IN ('paid', 'cancelled')`,
        )),
      this.ctx.db
        .select({ total: sql<string>`coalesce(sum(${invoices.totalAmount}::numeric - ${invoices.amountPaid}::numeric), 0)::text` })
        .from(invoices)
        .where(and(
          eq(invoices.businessId, this.ctx.businessId),
          eq(invoices.type, "purchase"),
          sql`${invoices.status} NOT IN ('paid', 'cancelled')`,
        )),
    ]);

    const [business] = await this.ctx.db
      .select({ name: businesses.name })
      .from(businesses)
      .where(eq(businesses.id, this.ctx.businessId))
      .limit(1);

    const recentInvoices = await this.ctx.db
      .select({
        invoiceNumber: invoices.invoiceNumber,
        partyName: parties.name,
        type: invoices.type,
        totalAmount: invoices.totalAmount,
        status: invoices.status,
        invoiceDate: invoices.invoiceDate,
      })
      .from(invoices)
      .innerJoin(parties, eq(parties.id, invoices.partyId))
      .where(and(
        eq(invoices.businessId, this.ctx.businessId),
        eq(invoices.documentType, "invoice"),
        isNull(invoices.deletedAt),
      ))
      .orderBy(desc(invoices.createdAt))
      .limit(5);

    return {
      businessName: business?.name ?? "Unknown Business",
      totalSales: salesRow[0]?.total ?? "0",
      totalPurchases: purchaseRow[0]?.total ?? "0",
      totalExpenses: expenseRow[0]?.total ?? "0",
      receivable: receivableRow[0]?.total ?? "0",
      payable: payableRow[0]?.total ?? "0",
      recentInvoices: recentInvoices.map((inv) => ({
        invoiceNumber: inv.invoiceNumber,
        partyName: inv.partyName,
        type: inv.type,
        totalAmount: inv.totalAmount,
        status: inv.status,
        invoiceDate: inv.invoiceDate?.toISOString().split("T")[0],
      })),
    };
  }

  private async invoiceList(args: Record<string, unknown>): Promise<unknown> {
    const { search, status, type, limit = 20 } = args;
    const conditions = [
      eq(invoices.businessId, this.ctx.businessId),
      eq(invoices.documentType, "invoice"),
      isNull(invoices.deletedAt),
    ];

    if (status) conditions.push(eq(invoices.status, String(status) as "draft" | "unfulfilled" | "sent" | "paid" | "partial" | "overdue" | "cancelled"));
    if (type) conditions.push(eq(invoices.type, String(type) as "sale" | "purchase"));
    if (search) {
      const term = `%${String(search)}%`;
      conditions.push(
        or(
          ilike(invoices.invoiceNumber, term),
          sql`EXISTS (SELECT 1 FROM ${parties} WHERE ${parties.id} = ${invoices.partyId} AND ${parties.name} ILIKE ${term})`,
        )!,
      );
    }

    const rows = await this.ctx.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        partyName: parties.name,
        type: invoices.type,
        status: invoices.status,
        invoiceDate: invoices.invoiceDate,
        totalAmount: invoices.totalAmount,
        amountPaid: invoices.amountPaid,
        balance: sql<string>`(${invoices.totalAmount}::numeric - ${invoices.amountPaid}::numeric)::text`,
      })
      .from(invoices)
      .innerJoin(parties, eq(parties.id, invoices.partyId))
      .where(and(...conditions))
      .orderBy(desc(invoices.invoiceDate))
      .limit(Math.min(Number(limit), 50));

    return rows.map((r) => ({
      ...r,
      invoiceDate: r.invoiceDate?.toISOString().split("T")[0],
    }));
  }

  private async invoiceGet(args: Record<string, unknown>): Promise<unknown> {
    const { invoiceNumber } = args;
    const [inv] = await this.ctx.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        partyName: parties.name,
        partyPhone: parties.phone,
        type: invoices.type,
        status: invoices.status,
        invoiceDate: invoices.invoiceDate,
        dueDate: invoices.dueDate,
        totalAmount: invoices.totalAmount,
        amountPaid: invoices.amountPaid,
        notes: invoices.notes,
        termsAndConditions: invoices.termsAndConditions,
      })
      .from(invoices)
      .innerJoin(parties, eq(parties.id, invoices.partyId))
      .where(and(
        eq(invoices.businessId, this.ctx.businessId),
        eq(invoices.invoiceNumber, String(invoiceNumber)),
      ))
      .limit(1);

    if (!inv) return { error: `No invoice found with number '${invoiceNumber}'` };

    const lineItems = await this.ctx.db
      .select({
        itemName: invoiceItems.itemName,
        description: invoiceItems.description,
        quantity: invoiceItems.quantity,
        unitPrice: invoiceItems.unitPrice,
        taxPercent: invoiceItems.taxPercent,
        taxAmount: invoiceItems.taxAmount,
        discountPercent: invoiceItems.discountPercent,
        totalAmount: invoiceItems.totalAmount,
      })
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, inv.id));

    return {
      invoiceNumber: inv.invoiceNumber,
      partyName: inv.partyName,
      partyPhone: inv.partyPhone,
      type: inv.type,
      status: inv.status,
      invoiceDate: inv.invoiceDate?.toISOString().split("T")[0],
      dueDate: inv.dueDate?.toISOString().split("T")[0] ?? null,
      totalAmount: inv.totalAmount,
      amountPaid: inv.amountPaid,
      balance: money.sub(inv.totalAmount, inv.amountPaid),
      notes: inv.notes,
      termsAndConditions: inv.termsAndConditions,
      lineItems: lineItems.map((li) => ({
        itemName: li.itemName,
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        taxPercent: li.taxPercent,
        taxAmount: li.taxAmount,
        totalAmount: li.totalAmount,
      })),
    };
  }

  private async invoiceCreate(args: Record<string, unknown>): Promise<unknown> {
    const { partyName, type: invType, lineItems, notes } = args;
    const partyNameStr = String(partyName ?? "");
    const invTypeStr = String(invType ?? "sale") as "sale" | "purchase";
    const lineItemsArr = Array.isArray(lineItems) ? lineItems : [];
    const notesStr = typeof notes === "string" ? notes : undefined;

    try {
      const result = await this.ctx.db.transaction(async (tx) => {
        let [party] = await tx
          .select({ id: parties.id, name: parties.name })
          .from(parties)
          .where(and(
            eq(parties.businessId, this.ctx.businessId),
            eq(parties.type, invTypeStr === "sale" ? "customer" : "supplier"),
            ilike(parties.name, `%${partyNameStr}%`),
          ))
          .limit(1);

        if (!party) {
          const now = new Date();
          const [created] = await tx
            .insert(parties)
            .values({
              id: crypto.randomUUID(),
              businessId: this.ctx.businessId,
              type: invTypeStr === "sale" ? "customer" : "supplier",
              name: partyNameStr,
              openingBalance: "0",
              updatedAt: now,
            })
            .returning();
          party = { id: created.id, name: created.name };
        }

        const processedItems = lineItemsArr.map((li: Record<string, unknown>, idx: number) => {
          const itemName = String(li.itemName ?? "Unknown Item");
          const quantity = String(li.quantity ?? "1");
          const unitPrice = String(li.unitPrice ?? "0");
          const taxPercent = String(li.taxPercent ?? "0");
          const discountPercent = String(li.discountPercent ?? "0");

          let _itemId: string | null = null;
          void _itemId;
          const itemMatch = lineItemsArr[idx].itemId as string | undefined;
          if (itemMatch) {
            _itemId = itemMatch;
          }

          const calcResult = calcInvoiceTotals({
            lineItems: [{ quantity, unitPrice, taxPercent, discountPercent }],
            charges: [],
            invoiceDiscount: "0",
            invoiceDiscountType: "amount" as const,
            roundOff: "0",
          });

          return {
            itemId: li.itemId ? String(li.itemId) : null,
            itemName,
            description: li.description ? String(li.description) : null,
            quantity,
            unitPrice,
            taxPercent,
            taxAmount: "0",
            discountPercent,
            totalAmount: calcResult.total,
            sortOrder: idx,
            selectedUnit: li.selectedUnit ? String(li.selectedUnit) : null,
            conversionFactor: "1",
            variantId: li.variantId ? String(li.variantId) : null,
          };
        });

        const totals = calcInvoiceTotals({
          lineItems: processedItems.map((li: Record<string, unknown>) => ({
            quantity: String(li.quantity),
            unitPrice: String(li.unitPrice),
            taxPercent: String(li.taxPercent ?? "0"),
            discountPercent: String(li.discountPercent ?? "0"),
          })),
          charges: [],
          invoiceDiscount: "0",
          invoiceDiscountType: "amount" as const,
          roundOff: "0",
        });

        const [bizForNumber] = await tx
          .select({ prefix: businesses.invoicePrefix, nextNum: businesses.nextInvoiceNumber })
          .from(businesses)
          .where(eq(businesses.id, this.ctx.businessId))
          .for("update");

        const prefix = bizForNumber?.prefix ?? "INV";
        const nextNum = bizForNumber?.nextNum ?? 1;
        const invoiceNumber = `${prefix}-${String(nextNum).padStart(5, "0")}`;

        await tx
          .update(businesses)
          .set({ nextInvoiceNumber: nextNum + 1 })
          .where(eq(businesses.id, this.ctx.businessId));

        const [invoiceRow] = await tx
          .insert(invoices)
          .values({
            businessId: this.ctx.businessId,
            partyId: party.id,
            type: invTypeStr,
            documentType: "invoice",
            invoiceNumber,
            invoiceDate: new Date(),
            dueDate: null,
            subtotal: totals.subtotal,
            taxAmount: totals.taxTotal,
            discountAmount: "0",
            charges: null,
            additionalCharges: "0",
            roundOff: "0",
            totalAmount: totals.total,
            amountPaid: "0",
            status: "draft",
            notes: notesStr ?? '',
            termsAndConditions: '',
            referenceDocumentId: null,
            deliveryMethod: "self_pickup",
            isReverseCharge: false,
            source: null,
            createdByUserId: this.ctx.user.id,
            createdByName: this.ctx.user.name ?? this.ctx.user.email,
            updatedAt: new Date(),
          })
          .returning();

        if (processedItems.length > 0) {
          await tx
            .insert(invoiceItems)
            .values(
              processedItems.map((li: Record<string, unknown>, idx: number) => ({
                ...li,
                invoiceId: invoiceRow.id,
                sortOrder: idx,
              })) as any,
            );
        }

        for (const li of processedItems as Array<Record<string, unknown>>) {
          if (li.itemId) {
            const cf = String(li.conversionFactor ?? "1");
            await tx
              .update(items)
              .set({
                stockQuantity: invTypeStr === "sale"
                  ? sql`${items.stockQuantity}::numeric - (${li.quantity}::numeric * ${cf}::numeric)`
                  : sql`${items.stockQuantity}::numeric + (${li.quantity}::numeric * ${cf}::numeric)`,
                updatedAt: new Date(),
              })
              .where(eq(items.id, String(li.itemId)));
          }
        }

        return { invoiceNumber, partyName: party.name, totalAmount: totals.total, status: "draft" };
      });

      return {
        success: true,
        invoiceNumber: result.invoiceNumber,
        partyName: result.partyName,
        totalAmount: result.totalAmount,
        status: result.status,
      };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, "invoice_create failed in AI agent");
      return { success: false, error: errMsg };
    }
  }

  private async partyList(args: Record<string, unknown>): Promise<unknown> {
    const { search, type: partyType } = args;
    const conditions = [eq(parties.businessId, this.ctx.businessId)];

    if (partyType) {
      conditions.push(eq(parties.type, String(partyType) as "customer" | "supplier"));
    }
    if (search) {
      const term = `%${String(search)}%`;
      conditions.push(or(ilike(parties.name, term), ilike(parties.phone, term))!);
    }

    const rows = await this.ctx.db
      .select({
        id: parties.id,
        name: parties.name,
        phone: parties.phone,
        type: parties.type,
        email: parties.email,
        city: parties.city,
        openingBalance: parties.openingBalance,
      })
      .from(parties)
      .where(and(...conditions))
      .orderBy(desc(parties.createdAt))
      .limit(30);

    const balanceSq = this.ctx.db
      .select({
        partyId: invoices.partyId,
        balance: sql<string>`COALESCE(SUM(${invoices.totalAmount}::numeric - ${invoices.amountPaid}::numeric), 0)`,
      })
      .from(invoices)
      .where(and(
        eq(invoices.businessId, this.ctx.businessId),
        sql`${invoices.documentType} = 'invoice'`,
        sql`${invoices.status} NOT IN ('paid', 'cancelled')`,
      ))
      .groupBy(invoices.partyId)
      .as("balance_sq");

    const partyBalances = await this.ctx.db
      .select({
        partyId: parties.id,
        balance: sql<string>`(COALESCE(${parties.openingBalance}::numeric, 0) + COALESCE(${balanceSq.balance}, 0))::text`,
      })
      .from(parties)
      .leftJoin(balanceSq, eq(balanceSq.partyId, parties.id))
      .where(inArray(parties.id, rows.map((r) => r.id)));

    const balanceMap = new Map(partyBalances.map((r) => [r.partyId, r.balance]));

    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      phone: p.phone,
      type: p.type,
      email: p.email,
      city: p.city,
      balance: balanceMap.get(p.id) ?? "0",
    }));
  }

  private async partyCreate(args: Record<string, unknown>): Promise<unknown> {
    const { name, type: partyType, phone, email, gstin, billingAddress, city, state, stateCode } = args;
    const nameStr = String(name ?? "");
    const typeStr = String(partyType ?? "customer") as "customer" | "supplier";

    const now = new Date();
    const [result] = await this.ctx.db
      .insert(parties)
      .values({
        id: crypto.randomUUID(),
        businessId: this.ctx.businessId,
        type: typeStr,
        name: nameStr,
        phone: phone ? String(phone) : null,
        email: email ? String(email) : null,
        gstin: gstin ? String(gstin) : null,
        billingAddress: billingAddress ? String(billingAddress) : null,
        city: city ? String(city) : null,
        state: state ? String(state) : null,
        stateCode: stateCode ? String(stateCode) : null,
        openingBalance: "0",
        updatedAt: now,
      })
      .returning();

    return {
      success: true,
      partyId: result.id,
      name: result.name,
      type: result.type,
    };
  }

  private async itemList(args: Record<string, unknown>): Promise<unknown> {
    const { search, category } = args;
    const conditions = [
      eq(items.businessId, this.ctx.businessId),
      isNull(items.deletedAt),
    ];

    if (search) {
      const term = `%${String(search)}%`;
      conditions.push(ilike(items.name, term));
    }
    if (category) {
      conditions.push(eq(items.category, String(category)));
    }

    const rows = await this.ctx.db
      .select({
        id: items.id,
        name: items.name,
        sku: items.sku,
        salePrice: items.salePrice,
        unit: items.unit,
        taxPercent: items.taxPercent,
        stockQuantity: items.stockQuantity,
        category: items.category,
      })
      .from(items)
      .where(and(...conditions))
      .orderBy(desc(items.updatedAt))
      .limit(30);

    return rows.map((i) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      salePrice: i.salePrice,
      unit: i.unit ?? "pcs",
      taxPercent: i.taxPercent ?? "0",
      stockQuantity: i.stockQuantity ?? "0",
      category: i.category,
    }));
  }

  private async itemCreate(args: Record<string, unknown>): Promise<unknown> {
    const { name, salePrice, purchasePrice, taxPercent, unit, category, description } = args;
    const nameStr = String(name ?? "");

    const now = new Date();
    const [result] = await this.ctx.db
      .insert(items)
      .values({
        businessId: this.ctx.businessId,
        name: nameStr,
        salePrice: salePrice ? String(salePrice) : null,
        purchasePrice: purchasePrice ? String(purchasePrice) : null,
        taxPercent: taxPercent ? String(taxPercent) : "0",
        unit: (unit ? String(unit) : "pcs") as "pcs" | "kg" | "g" | "l" | "ml" | "m" | "cm" | "ft" | "in" | "box" | "dozen" | "pair" | "set" | "pkt" | "bun" | "pouch" | "jar" | "btl" | "bag" | "ton" | "pack" | "pet" | "person",
        category: category ? String(category) : null,
        description: description ? String(description) : null,
        stockQuantity: "0",
        itemType: "product",
        itemMode: "simple",
        taxInclusive: false,
        trackingMode: "none",
        updatedAt: now,
      })
      .returning();

    return {
      success: true,
      itemId: result.id,
      name: result.name,
      salePrice: result.salePrice,
      unit: result.unit,
    };
  }

  private async paymentCreate(args: Record<string, unknown>): Promise<unknown> {
    const { partyName, amount, mode, invoiceNumber, notes } = args;
    const partyNameStr = String(partyName ?? "");
    const amountStr = String(amount ?? "0");
    const modeStr = String(mode ?? "cash");

    const result = await this.ctx.db.transaction(async (tx) => {
      const [party] = await tx
        .select({ id: parties.id, name: parties.name })
        .from(parties)
        .where(and(
          eq(parties.businessId, this.ctx.businessId),
          ilike(parties.name, `%${partyNameStr}%`),
        ))
        .limit(1);

      if (!party) {
        throw new Error(`No party found matching '${partyNameStr}'`);
      }

      const [biz] = await tx
        .select({ prefix: businesses.invoicePrefix, nextNum: businesses.nextInvoiceNumber })
        .from(businesses)
        .where(eq(businesses.id, this.ctx.businessId))
        .for("update");

      const prefix = biz?.prefix ?? "PYT";
      const nextNum = biz?.nextNum ?? 1;
      const paymentNumber = `${prefix}-${String(nextNum).padStart(5, "0")}`;

      await tx
        .insert(payments)
        .values({
          businessId: this.ctx.businessId,
          partyId: party.id,
          amount: amountStr,
          discount: "0",
          mode: modeStr as "cash" | "bank" | "upi" | "cheque" | "other" | "credit_card" | "debit_card" | "net_banking" | "wallet",
          paymentDate: new Date(),
          referenceNumber: null,
          notes: notes ? String(notes) : null,
          bankAccountId: null,
          invoiceId: null,
        })
        .returning();

      await tx
        .update(businesses)
        .set({ nextInvoiceNumber: nextNum + 1 })
        .where(eq(businesses.id, this.ctx.businessId));

      if (invoiceNumber) {
        const [inv] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(and(
            eq(invoices.businessId, this.ctx.businessId),
            eq(invoices.invoiceNumber, String(invoiceNumber)),
          ))
          .limit(1);

        if (inv) {
          await tx
            .update(invoices)
            .set({
              amountPaid: sql`${invoices.amountPaid}::numeric + ${amountStr}::numeric`,
              updatedAt: new Date(),
            })
            .where(eq(invoices.id, inv.id));
        }
      }

      return {
        success: true,
        paymentNumber,
        partyName: party.name,
        amount: amountStr,
        mode: modeStr,
      };
    });

    return result;
  }

  async ocrExtract(imageBase64: string): Promise<unknown> {
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      const imageData = imageBase64.startsWith("data:")
        ? imageBase64
        : `data:image/png;base64,${imageBase64}`;

      const {
        data: { text },
      } = await worker.recognize(imageData);

      await worker.terminate();

      const extractedText = text.trim();
      if (!extractedText) {
        return { text: "", structured: null, error: "No text found in the image" };
      }

      const structured = await this.parseInvoiceFromOCR(extractedText);

      return { text: extractedText, structured };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, "OCR extraction failed");
      return { text: "", structured: null, error: errMsg };
    }
  }

  private async parseInvoiceFromOCR(extractedText: string): Promise<unknown> {
    const prompt = `You are an invoice data extraction assistant. Extract the following fields from the OCR text below. Return ONLY valid JSON (no markdown, no code block, no explanation):

{
  "partyName": "string",
  "invoiceNumber": "string or null",
  "invoiceDate": "string or null",
  "dueDate": "string or null",
  "items": [{"itemName": "string", "quantity": "string", "unitPrice": "string", "taxPercent": "string"}],
  "subtotal": "string or null",
  "taxAmount": "string or null",
  "totalAmount": "string or null"
}

OCR Text:
${extractedText}`;

     try {
      const body = {
        model: this.model,
        messages: [
          { role: "system", content: "You extract structured data from invoice OCR text. Return only valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        stream: false,
        max_tokens: 2048,
      };

      for (let attempt = 1; attempt <= 3; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (res.status === 429 && attempt < 3) {
          const retryAfter = res.headers.get("retry-after");
          const waitMs = retryAfter ? Math.min(parseFloat(retryAfter) * 1000, 10_000) : Math.min(attempt * 2000, 10_000);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          return { error: `Groq API error: ${res.status} ${errText}` };
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || "";

        try {
          return JSON.parse(content);
        } catch {
          return { error: "Failed to parse LLM output as JSON", rawText: content };
        }
      }

      return { error: "Max retries exceeded for Groq API" };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return { error: `Failed to parse invoice data: ${errMsg}` };
    }
  }
}
