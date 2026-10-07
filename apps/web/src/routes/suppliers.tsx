import { createFileRoute } from "@tanstack/react-router";
import { PartiesPage } from "@/components/PartiesPage";

export const Route = createFileRoute("/suppliers")({
  component: () => <PartiesPage defaultFilter="supplier" title="Suppliers" description="Manage your suppliers" />,
});
