import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/sales")({
  component: SalesPage,
});

function SalesPage() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/invoices", search: { type: "sale" } });
  }, [navigate]);
  return null;
}
