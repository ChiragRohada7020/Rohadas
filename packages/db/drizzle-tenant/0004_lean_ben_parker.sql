CREATE TYPE "public"."item_tracking_mode" AS ENUM('none', 'batch', 'serial', 'expiry');--> statement-breakpoint
CREATE TABLE "godown_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"variant_id" uuid,
	"lot_id" uuid,
	"from_godown_id" uuid,
	"to_godown_id" uuid,
	"quantity" numeric(15, 3) NOT NULL,
	"transfer_date" timestamp with time zone DEFAULT now() NOT NULL,
	"reference_number" text,
	"notes" text,
	"created_by_user_id" uuid,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "godowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"address" text,
	"city" text,
	"state" text,
	"state_code" text,
	"pincode" text,
	"phone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"variant_id" uuid,
	"godown_id" uuid,
	"batch_no" text,
	"serial_no" text,
	"manufacturing_date" timestamp with time zone,
	"expiry_date" timestamp with time zone,
	"quantity" numeric(15, 3) DEFAULT '0' NOT NULL,
	"quantity_received" numeric(15, 3) DEFAULT '0' NOT NULL,
	"quantity_sold" numeric(15, 3) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(15, 2),
	"status" text DEFAULT 'active' NOT NULL,
	"received_date" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "lot_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "godown_id" uuid;--> statement-breakpoint
ALTER TABLE "item_variants" ADD COLUMN "tracking_mode" "item_tracking_mode" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "tracking_mode" "item_tracking_mode" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "godown_transfers" ADD CONSTRAINT "godown_transfers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godown_transfers" ADD CONSTRAINT "godown_transfers_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godown_transfers" ADD CONSTRAINT "godown_transfers_variant_id_item_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."item_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godown_transfers" ADD CONSTRAINT "godown_transfers_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godown_transfers" ADD CONSTRAINT "godown_transfers_from_godown_id_godowns_id_fk" FOREIGN KEY ("from_godown_id") REFERENCES "public"."godowns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godown_transfers" ADD CONSTRAINT "godown_transfers_to_godown_id_godowns_id_fk" FOREIGN KEY ("to_godown_id") REFERENCES "public"."godowns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "godowns" ADD CONSTRAINT "godowns_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_variant_id_item_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."item_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "godown_transfers_business_idx" ON "godown_transfers" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "godown_transfers_item_idx" ON "godown_transfers" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "godown_transfers_date_idx" ON "godown_transfers" USING btree ("business_id","transfer_date");--> statement-breakpoint
CREATE INDEX "godowns_business_idx" ON "godowns" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "godowns_name_idx" ON "godowns" USING btree ("business_id","name");--> statement-breakpoint
CREATE INDEX "godowns_primary_idx" ON "godowns" USING btree ("business_id","is_primary");--> statement-breakpoint
CREATE INDEX "godowns_active_idx" ON "godowns" USING btree ("business_id","name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "stock_lots_business_idx" ON "stock_lots" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "stock_lots_item_idx" ON "stock_lots" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "stock_lots_variant_idx" ON "stock_lots" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_lots_godown_idx" ON "stock_lots" USING btree ("godown_id");--> statement-breakpoint
CREATE INDEX "stock_lots_fefo_idx" ON "stock_lots" USING btree ("item_id","godown_id","expiry_date");--> statement-breakpoint
CREATE INDEX "stock_lots_batch_idx" ON "stock_lots" USING btree ("item_id","batch_no");--> statement-breakpoint
CREATE INDEX "stock_lots_serial_idx" ON "stock_lots" USING btree ("serial_no");--> statement-breakpoint
CREATE INDEX "stock_lots_expiry_idx" ON "stock_lots" USING btree ("business_id","expiry_date");--> statement-breakpoint
CREATE INDEX "stock_lots_active_idx" ON "stock_lots" USING btree ("business_id","item_id") WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_godown_id_godowns_id_fk" FOREIGN KEY ("godown_id") REFERENCES "public"."godowns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_items_lot_idx" ON "invoice_items" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "invoice_items_godown_idx" ON "invoice_items" USING btree ("godown_id");