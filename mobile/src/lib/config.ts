// Values come from mobile/.env (see .env.example). EXPO_PUBLIC_* values are bundled into the app,
// so only public keys belong here — never the Supabase service role key or any AI API key.
export const config = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  apiUrl: (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, ''),
  privacyUrl: process.env.EXPO_PUBLIC_PRIVACY_URL ?? '',
  termsUrl: process.env.EXPO_PUBLIC_TERMS_URL ?? '',
};

export const isConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey && config.apiUrl);
