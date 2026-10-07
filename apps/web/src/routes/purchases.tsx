import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/purchases")({
  component: PurchasesPage,
});

function PurchasesPage() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/invoices", search: { type: "purchase" } });
  }, [navigate]);
  return null;
}
