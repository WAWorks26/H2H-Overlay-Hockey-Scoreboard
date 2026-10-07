import { createClient } from '@supabase/supabase-js';

// Hardcoding the keys directly to bypass the .env issue
const supabaseUrl = 'https://bdjrjtspzleitnxrezgl.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkanJqdHNwemxlaXRueHJlemdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExNTM0MjcsImV4cCI6MjEwNjcyOTQyN30.KLY4CgWy0rRsj3TZ19UdfVKMXf5jylQa6zO90ZYYfnY';
export const supabase = createClient(supabaseUrl, supabaseAnonKey);