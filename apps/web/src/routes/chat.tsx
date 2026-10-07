import React, { useState, useRef, useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { trpc } from "@/lib/trpc";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/chat")({
  component: ChatPage,
});

interface ChatUIMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

function ChatPage() {
  const [messages, setMessages] = useState<ChatUIMessage[]>([]);
  const [input, setInput] = useState("");
  const [showOcr, setShowOcr] = useState(false);
  const [ocrFile, setOcrFile] = useState<File | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const chatMutation = trpc.ai.chat.useMutation({
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply },
      ]);
    },
    onError: (err) => toast.error("Chat error", err.message),
  });

  const ocrMutation = trpc.ai.ocr.useMutation({
    onSuccess: (data) => {
      const result = data as { text: string; structured: unknown } | null;
      const structured = result?.structured as Record<string, unknown> | null;
      if (structured && !structured.error) {
        const items = structured.items as Array<Record<string, unknown>> | undefined;
        const summary = `OCR extracted: ${structured.partyName || "party"}, ${structured.invoiceNumber || "no invoice #"}, ${items?.length ?? 0} items, total: ${structured.totalAmount || "N/A"}`;
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: summary },
        ]);
      } else {
        toast.error("OCR issue", String(structured?.error || "No structured data returned"));
      }
      setShowOcr(false);
      setOcrFile(null);
    },
    onError: (err) => toast.error("OCR error", err.message),
  });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = () => {
    if (!input.trim() || chatMutation.isPending) return;

    const userMessage: ChatUIMessage = { role: "user", content: input };
    setMessages((prev) => [...prev, userMessage]);

    chatMutation.mutate({
      message: input,
      history: messages,
    });

    setInput("");
  };

  const handleOcrUpload = () => {
    if (!ocrFile) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const imageData = e.target?.result as string;
      ocrMutation.mutate({ imageData });
    };
    reader.readAsDataURL(ocrFile);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] max-w-4xl mx-auto p-4">
      <div className="flex-1 overflow-y-auto space-y-4 pb-4">
        {messages.length === 0 ? (
          <div className="text-center text-text-tertiary py-12">
            <p className="text-lg mb-2">Chat with your business data</p>
            <p className="text-sm">
              Ask me about invoices, parties, items, payments, or upload an invoice image.
            </p>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div
              key={idx}
              className={cn(
                "max-w-[80%] rounded-lg p-3",
                msg.role === "user"
                  ? "ml-auto bg-primary-100 text-text-primary"
                  : "mr-auto bg-surface-2 text-text-primary",
              )}
            >
              {msg.toolName && (
                <span className="text-xs text-text-tertiary block mb-1">
                  Tool: {msg.toolName}
                </span>
              )}
              <div className="whitespace-pre-wrap text-sm">{msg.content}</div>
            </div>
          ))
        )}
        {(chatMutation.isPending || ocrMutation.isPending) && (
          <div className="ml-auto mr-auto text-center text-text-tertiary py-4">
            <div className="inline-block w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-border pt-4">
        {showOcr ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setOcrFile(e.target.files?.[0] ?? null)}
                className="text-sm"
              />
              <button
                className="btn-primary btn-sm"
                onClick={handleOcrUpload}
                disabled={!ocrFile || ocrMutation.isPending}
              >
                Process
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setShowOcr(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              className="btn-secondary btn-sm"
              onClick={() => setShowOcr(true)}
              disabled={chatMutation.isPending}
            >
              OCR Invoice
            </button>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask about invoices, parties, payments..."
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-surface-1 text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-500"
              disabled={chatMutation.isPending}
            />
            <button
              className="btn-primary btn-sm"
              onClick={handleSend}
              disabled={!input.trim() || chatMutation.isPending}
            >
              Send
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
