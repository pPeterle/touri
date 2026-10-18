-- A routine can post its prompt into a group conversation; the group routes it like a user message.
-- No foreign key: upgrade tests pin the existing tables' keys, groups cannot be deleted today, and
-- the runtime refuses to run a routine whose group is missing.
ALTER TABLE routines ADD COLUMN group_id TEXT;
UPDATE schema_meta SET value = '24' WHERE key = 'schema_version';
