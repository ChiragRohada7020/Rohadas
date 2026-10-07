import { createFileRoute } from "@tanstack/react-router";
import { PartiesPage } from "@/components/PartiesPage";

export const Route = createFileRoute("/customers")({
  component: () => <PartiesPage defaultFilter="customer" title="Customers" description="Manage your customers" />,
});
