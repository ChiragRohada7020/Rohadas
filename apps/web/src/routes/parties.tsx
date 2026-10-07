import { createFileRoute } from "@tanstack/react-router";
import { PartiesPage } from "@/components/PartiesPage";

export const Route = createFileRoute("/parties")({
  component: () => <PartiesPage defaultFilter="all" title="Parties" description="Manage your customers and suppliers" />,
});
