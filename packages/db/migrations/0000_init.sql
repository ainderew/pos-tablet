CREATE SEQUENCE "public"."change_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"terminal_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" bigint DEFAULT nextval('change_version_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"terminal_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"business_name" text,
	"business_address" text,
	"business_tin" text,
	"receipt_header_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"receipt_footer_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"time_zone" text DEFAULT 'Asia/Manila' NOT NULL,
	"stock_policy" text DEFAULT 'enforce' NOT NULL,
	"offline_credit_mode" text DEFAULT 'A' NOT NULL,
	"offline_credit_cap" numeric(14, 2),
	"version" bigint DEFAULT nextval('change_version_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stores_stock_policy_check" CHECK ("stores"."stock_policy" in ('enforce', 'warn')),
	CONSTRAINT "stores_offline_credit_mode_check" CHECK ("stores"."offline_credit_mode" in ('A', 'B', 'C'))
);
--> statement-breakpoint
CREATE TABLE "terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'tablet' NOT NULL,
	"ptu_number" text,
	"serial_number" text,
	"min" text,
	"last_seen_at" timestamp with time zone,
	"app_version" text,
	"revoked_at" timestamp with time zone,
	"version" bigint DEFAULT nextval('change_version_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "terminals_kind_check" CHECK ("terminals"."kind" in ('tablet', 'desktop'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "user_stores" (
	"user_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	CONSTRAINT "user_stores_user_id_store_id_pk" PRIMARY KEY("user_id","store_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"role" text NOT NULL,
	"email" text,
	"password_hash" text,
	"pin_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" bigint DEFAULT nextval('change_version_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('OWNER', 'ADMIN', 'MANAGER', 'CASHIER'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" bigint DEFAULT nextval('change_version_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"phone_number" text,
	"email" text,
	"address" text,
	"credit_limit" numeric(14, 2) DEFAULT 0 NOT NULL,
	"credit_status" text DEFAULT 'ACTIVE' NOT NULL,
	"version" bigint DEFAULT nextval('change_version_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "customers_credit_status_check" CHECK ("customers"."credit_status" in ('ACTIVE', 'BLOCKED', 'OVERDUE'))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"category_id" uuid,
	"name" text NOT NULL,
	"barcode" text,
	"selling_price" numeric(14, 2) NOT NULL,
	"cost_price" numeric(14, 2) NOT NULL,
	"unit_type" text NOT NULL,
	"tax_category" text DEFAULT 'VATABLE' NOT NULL,
	"supplier_type" text DEFAULT 'WHOLESALER' NOT NULL,
	"wholesale_price" numeric(14, 2),
	"wholesale_threshold" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 0 NOT NULL,
	"notify_low_stock" boolean DEFAULT false NOT NULL,
	"is_promo" boolean DEFAULT false NOT NULL,
	"promo_price" numeric(14, 2),
	"version" bigint DEFAULT nextval('change_version_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "products_unit_type_check" CHECK ("products"."unit_type" in ('QUANTITY', 'WEIGHT')),
	CONSTRAINT "products_tax_category_check" CHECK ("products"."tax_category" in ('VATABLE', 'VAT_EXEMPT', 'ZERO_RATED')),
	CONSTRAINT "products_prices_check" CHECK ("products"."selling_price" >= 0 and "products"."cost_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_seq" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"user_id" uuid,
	"shift_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audit_image_id" uuid
);
--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_seq" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" in ('CASH_IN', 'CASH_OUT', 'SAFE_DROP')),
	CONSTRAINT "cash_movements_amount_check" CHECK ("cash_movements"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid,
	"device_seq" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid NOT NULL,
	"transaction_id" uuid,
	"shift_id" uuid,
	"entry_type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"running_balance" numeric(14, 2) NOT NULL,
	"notes" text,
	"payment_method" text,
	"reference_number" text,
	CONSTRAINT "credit_ledger_entry_type_check" CHECK ("credit_ledger"."entry_type" in ('CHARGE', 'PAYMENT', 'ADJUSTMENT')),
	CONSTRAINT "credit_ledger_amount_check" CHECK ("credit_ledger"."amount" >= 0),
	CONSTRAINT "credit_ledger_origin_check" CHECK (("credit_ledger"."terminal_id" is null) = ("credit_ledger"."device_seq" is null))
);
--> statement-breakpoint
CREATE TABLE "shift_closes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_seq" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"user_id" uuid,
	"theoretical_cash" numeric(14, 2) NOT NULL,
	"actual_cash" numeric(14, 2) NOT NULL,
	"cash_variance" numeric(14, 2) NOT NULL,
	"theoretical_gcash" numeric(14, 2) NOT NULL,
	"actual_gcash" numeric(14, 2) NOT NULL,
	"gcash_variance" numeric(14, 2) NOT NULL,
	"theoretical_maya" numeric(14, 2) NOT NULL,
	"actual_maya" numeric(14, 2) NOT NULL,
	"maya_variance" numeric(14, 2) NOT NULL,
	"theoretical_card" numeric(14, 2) NOT NULL,
	"actual_card" numeric(14, 2) NOT NULL,
	"card_variance" numeric(14, 2) NOT NULL,
	"variance" numeric(14, 2) NOT NULL,
	"snapshot_z_counter" integer NOT NULL,
	"snapshot_accumulated_total" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_opens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_seq" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"opening_fund" numeric(14, 2) NOT NULL,
	"snapshot_z_counter" integer NOT NULL,
	"snapshot_accumulated_total" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid,
	"device_seq" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_delta" numeric(14, 3) NOT NULL,
	"reason" text NOT NULL,
	"ref_id" uuid,
	"note" text,
	CONSTRAINT "stock_movements_reason_check" CHECK ("stock_movements"."reason" in ('SALE', 'VOID', 'RESTOCK', 'ADJUSTMENT')),
	CONSTRAINT "stock_movements_origin_check" CHECK (("stock_movements"."terminal_id" is null) = ("stock_movements"."device_seq" is null))
);
--> statement-breakpoint
CREATE TABLE "transaction_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_seq" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"unit_type" text NOT NULL,
	"quantity_sold" numeric(14, 3) NOT NULL,
	"price_at_sale" numeric(14, 2) NOT NULL,
	"cost_at_sale" numeric(14, 2) NOT NULL,
	"tax_category" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_seq" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"cashier_id" uuid,
	"invoice_number" text NOT NULL,
	"transaction_type" text NOT NULL,
	"status" text NOT NULL,
	"original_transaction_id" uuid,
	"void_reason" text,
	"authorized_by" uuid,
	"gross_sales" numeric(14, 2) NOT NULL,
	"vatable_sales" numeric(14, 2) NOT NULL,
	"vat_amount" numeric(14, 2) NOT NULL,
	"vat_exempt_sales" numeric(14, 2) NOT NULL,
	"zero_rated_sales" numeric(14, 2) NOT NULL,
	"total_discount" numeric(14, 2) NOT NULL,
	"net_sales" numeric(14, 2) NOT NULL,
	"pax_count" integer NOT NULL,
	"senior_count" integer NOT NULL,
	"sc_pwd_id" text,
	"sc_pwd_name" text,
	"payment_method" text NOT NULL,
	"amount_tendered" numeric(14, 2),
	"change_amount" numeric(14, 2) NOT NULL,
	"reference_number" text,
	CONSTRAINT "transactions_type_check" CHECK ("transactions"."transaction_type" in ('SALE', 'VOID_REFUND')),
	CONSTRAINT "transactions_status_check" CHECK ("transactions"."status" in ('PAID', 'REFUND')),
	CONSTRAINT "transactions_payment_method_check" CHECK ("transactions"."payment_method" in ('CASH', 'GCASH', 'MAYA', 'CARD', 'STORE_CREDIT'))
);
--> statement-breakpoint
CREATE TABLE "z_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_seq" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"user_id" uuid,
	"z_counter" integer NOT NULL,
	"sales_count" integer NOT NULL,
	"void_count" integer NOT NULL,
	"sales_total" numeric(14, 2) NOT NULL,
	"void_total" numeric(14, 2) NOT NULL,
	"net_total" numeric(14, 2) NOT NULL,
	"total_vat" numeric(14, 2) NOT NULL,
	"cash_sales_total" numeric(14, 2) NOT NULL,
	"opening_funds_total" numeric(14, 2) NOT NULL,
	"cash_in_total" numeric(14, 2) NOT NULL,
	"cash_out_total" numeric(14, 2) NOT NULL,
	"safe_drop_total" numeric(14, 2) NOT NULL,
	"theoretical_cash" numeric(14, 2) NOT NULL,
	"beginning_invoice" text,
	"ending_invoice" text,
	"beginning_credit_note" text,
	"ending_credit_note" text,
	"beginning_grand_total" numeric(14, 2) NOT NULL,
	"accumulated_grand_total" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stores" ADD CONSTRAINT "user_stores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stores" ADD CONSTRAINT "user_stores_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_shift_id_shift_opens_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shift_opens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shift_id_shift_opens_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shift_opens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_shift_id_shift_opens_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shift_opens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closes" ADD CONSTRAINT "shift_closes_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closes" ADD CONSTRAINT "shift_closes_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closes" ADD CONSTRAINT "shift_closes_shift_id_shift_opens_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shift_opens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closes" ADD CONSTRAINT "shift_closes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_opens" ADD CONSTRAINT "shift_opens_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_opens" ADD CONSTRAINT "shift_opens_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_opens" ADD CONSTRAINT "shift_opens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_shift_id_shift_opens_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shift_opens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_cashier_id_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "z_readings" ADD CONSTRAINT "z_readings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "z_readings" ADD CONSTRAINT "z_readings_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "z_readings" ADD CONSTRAINT "z_readings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_hash_idx" ON "device_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "device_tokens_terminal_idx" ON "device_tokens" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "pairing_codes_terminal_idx" ON "pairing_codes" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "stores_org_idx" ON "stores" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "terminals_store_idx" ON "terminals" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree (lower("email")) WHERE "users"."email" is not null and "users"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_name_idx" ON "categories" USING btree ("org_id",lower("name")) WHERE "categories"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "customers_store_idx" ON "customers" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "products_org_idx" ON "products" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_barcode_idx" ON "products" USING btree ("org_id","barcode") WHERE "products"."barcode" is not null and "products"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_seq_idx" ON "audit_logs" USING btree ("terminal_id","device_seq");--> statement-breakpoint
CREATE INDEX "audit_logs_store_time_idx" ON "audit_logs" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_movements_seq_idx" ON "cash_movements" USING btree ("terminal_id","device_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_seq_idx" ON "credit_ledger" USING btree ("terminal_id","device_seq") WHERE "credit_ledger"."terminal_id" is not null;--> statement-breakpoint
CREATE INDEX "credit_ledger_customer_idx" ON "credit_ledger" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_closes_seq_idx" ON "shift_closes" USING btree ("terminal_id","device_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_closes_shift_idx" ON "shift_closes" USING btree ("shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_opens_seq_idx" ON "shift_opens" USING btree ("terminal_id","device_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_seq_idx" ON "stock_movements" USING btree ("terminal_id","device_seq") WHERE "stock_movements"."terminal_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_movements_product_idx" ON "stock_movements" USING btree ("store_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_items_seq_idx" ON "transaction_items" USING btree ("terminal_id","device_seq");--> statement-breakpoint
CREATE INDEX "transaction_items_tx_idx" ON "transaction_items" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_seq_idx" ON "transactions" USING btree ("terminal_id","device_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_number_idx" ON "transactions" USING btree ("terminal_id","invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_voids_idx" ON "transactions" USING btree ("original_transaction_id") WHERE "transactions"."original_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "transactions_store_time_idx" ON "transactions" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_shift_idx" ON "transactions" USING btree ("shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "z_readings_seq_idx" ON "z_readings" USING btree ("terminal_id","device_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "z_readings_counter_idx" ON "z_readings" USING btree ("terminal_id","z_counter");