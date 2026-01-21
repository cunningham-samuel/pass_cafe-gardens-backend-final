// Existing code before autoMigrate()

autoMigrate() {
    // Existing code
    ALTER TABLE IF EXISTS bookings ALTER COLUMN coworker_id DROP NOT NULL;
    ALTER TABLE IF NOT EXISTS bookings ADD COLUMN IF NOT EXISTS coworker_email TEXT;
    // Existing code
}
