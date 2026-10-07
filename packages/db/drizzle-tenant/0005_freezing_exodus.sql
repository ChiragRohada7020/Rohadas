CREATE TABLE "inventory_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"count_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"variant_id" uuid,
	"expected_quantity" numeric(15, 3) NOT NULL,
	"counted_quantity" numeric(15, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"godown_id" uuid,
	"count_number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_by_user_id" uuid,
	"created_by_name" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lot_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_item_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"quantity" numeric(15, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "godown_transfers" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_count_id_inventory_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."inventory_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_variant_id_item_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."item_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_consumptions" ADD CONSTRAINT "lot_consumptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_consumptions" ADD CONSTRAINT "lot_consumptions_invoice_item_id_invoice_items_id_fk" FOREIGN KEY ("invoice_item_id") REFERENCES "public"."invoice_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_consumptions" ADD CONSTRAINT "lot_consumptions_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_count_lines_count_idx" ON "inventory_count_lines" USING btree ("count_id");--> statement-breakpoint
CREATE INDEX "inventory_count_lines_item_idx" ON "inventory_count_lines" USING btree ("business_id","item_id");--> statement-breakpoint
CREATE INDEX "inventory_counts_business_idx" ON "inventory_counts" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "inventory_counts_godown_idx" ON "inventory_counts" USING btree ("godown_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_counts_number_idx" ON "inventory_counts" USING btree ("business_id","count_number");--> statement-breakpoint
CREATE INDEX "lot_consumptions_business_idx" ON "lot_consumptions" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "lot_consumptions_line_idx" ON "lot_consumptions" USING btree ("invoice_item_id");--> statement-breakpoint
CREATE INDEX "lot_consumptions_lot_idx" ON "lot_consumptions" USING btree ("lot_id");