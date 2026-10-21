import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { isConfigured } from '../lib/config';
import { SessionProvider, useSession } from '../lib/hooks';
import { colors, space, type } from '../ui/theme';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

function Navigator() {
  const { session, loading } = useSession();
  useEffect(() => {
    if (!loading) SplashScreen.hideAsync().catch(() => undefined);
  }, [loading]);
  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Protected guard={Boolean(session)}>
        <Stack.Screen name="index" options={{ title: 'Maya' }} />
        <Stack.Screen name="new" options={{ title: 'New film', presentation: 'modal' }} />
        <Stack.Screen name="project/[id]" options={{ title: '' }} />
        <Stack.Screen name="shot/[id]" options={{ title: 'Shot' }} />
        <Stack.Screen name="edit/[id]" options={{ title: 'Edit & mix' }} />
        <Stack.Screen name="wallet" options={{ title: 'Credits' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="orders" options={{ title: 'Shop-ad orders' }} />
        <Stack.Screen name="order/new" options={{ title: 'New order', presentation: 'modal' }} />
        <Stack.Screen name="order/[id]" options={{ title: 'Order' }} />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

function NotConfigured() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', padding: space(3) }}>
      <Text style={type.title}>Almost there</Text>
      <Text style={[type.body, { marginTop: space(1), color: colors.textMuted }]}>
        Add EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY and EXPO_PUBLIC_API_URL to mobile/.env, then restart the app. See SETUP.md.
      </Text>
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {isConfigured ? (
        <SessionProvider>
          <Navigator />
        </SessionProvider>
      ) : (
        <NotConfigured />
      )}
    </SafeAreaProvider>
  );
}
