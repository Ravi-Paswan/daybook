// Cloud sync connection (Supabase). Both values are public by design: the publishable key only lets a
// browser talk to the project, and Row Level Security (supabase/schema.sql) limits every signed-in user
// to their own rows. Never put a service_role / secret key here.
// Leave SYNC_URL empty to build Daybook without accounts (on-device only).

export const SYNC_URL = 'https://rvqjurcnzvdqfqtqphrf.supabase.co';
export const SYNC_KEY = 'sb_publishable_kQoGWiYpgQtpijaKn7OYKg_gId2bPT2';
