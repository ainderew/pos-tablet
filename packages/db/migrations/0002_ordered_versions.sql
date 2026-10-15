-- Versions must become visible in order: a tablet pulls "everything with version > N", so a change
-- that took version 41 must never commit after one with version 42 was read (it would be skipped).
-- Every versioned write takes one transaction-scoped advisory lock before taking its version; the
-- lock is held until commit, so versions are assigned and committed in the same order. Back-office
-- writes are low volume, so serializing them costs nothing noticeable.
CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7250420);
  NEW.version := nextval('change_version_seq');
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER organizations_version_on_insert BEFORE INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER stores_version_on_insert BEFORE INSERT ON stores FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER terminals_version_on_insert BEFORE INSERT ON terminals FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER users_version_on_insert BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER categories_version_on_insert BEFORE INSERT ON categories FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER products_version_on_insert BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER customers_version_on_insert BEFORE INSERT ON customers FOR EACH ROW EXECUTE FUNCTION bump_version();
