-- Server-owned rows get a new version on every update (inserts take it from the column default),
-- so a terminal can pull "everything with version > N" and never miss a change
CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger AS $$
BEGIN
  NEW.version := nextval('change_version_seq');
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER organizations_bump_version BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER stores_bump_version BEFORE UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER terminals_bump_version BEFORE UPDATE ON terminals FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER users_bump_version BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER categories_bump_version BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER products_bump_version BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER customers_bump_version BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
-- Changing which stores a user may work in changes what their terminals receive: bump the user
CREATE OR REPLACE FUNCTION touch_user_on_store_access() RETURNS trigger AS $$
BEGIN
  UPDATE users SET updated_at = now() WHERE id = COALESCE(NEW.user_id, OLD.user_id);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER user_stores_touch_user AFTER INSERT OR DELETE ON user_stores FOR EACH ROW EXECUTE FUNCTION touch_user_on_store_access();
--> statement-breakpoint
-- Records terminals create are append-only (a void is a new credit note, never an edit)
CREATE OR REPLACE FUNCTION forbid_record_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: records are never updated or deleted', TG_TABLE_NAME;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER shift_opens_append_only BEFORE UPDATE OR DELETE ON shift_opens FOR EACH ROW EXECUTE FUNCTION forbid_record_change();
--> statement-breakpoint
CREATE TRIGGER shift_closes_append_only BEFORE UPDATE OR DELETE ON shift_closes FOR EACH ROW EXECUTE FUNCTION forbid_record_change();
--> statement-breakpoint
CREATE TRIGGER transactions_append_only BEFORE UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION forbid_record_change();
--> statement-breakpoint
CREATE TRIGGER transaction_items_append_only BEFORE UPDATE OR DELETE ON transaction_items FOR EACH ROW EXECUTE FUNCTION forbid_record_change();
--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_record_change();
--> statement-breakpoint
CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE OR DELETE ON credit_ledger FOR EACH ROW EXECUTE FUNCTION forbid_record_change();
--> statement-breakpoint
CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION forbid_record_change();
--> statement-breakpoint
CREATE TRIGGER z_readings_append_only BEFORE UPDATE OR DELETE ON z_readings FOR EACH ROW EXECUTE FUNCTION forbid_record_change();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_record_change();
