import { useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { config } from '../lib/config';
import { supabase } from '../lib/supabase';
import { Button, Field, showError } from '../ui/kit';
import { colors, space, type } from '../ui/theme';

export default function Login() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const validEmail = /^\S+@\S+\.\S+$/.test(email.trim());

  async function sendCode() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) return showError(error);
    setSent(true);
  }

  async function verify() {
    setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'email' });
    setBusy(false);
    if (error) showError(new Error('That code did not work. Check it, or ask for a new one.'));
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', padding: space(3) }}>
        <Text style={[type.label, { color: colors.accent }]}>Maya · All in 1 movie maker</Text>
        <Text style={[type.display, { marginTop: space(1) }]}>Your story.{'\n'}On screen.</Text>
        <Text style={[type.body, { color: colors.textMuted, marginTop: space(1.5), marginBottom: space(4) }]}>
          Type an idea. Maya writes the script, casts the characters, draws the storyboard and films every shot.
        </Text>

        {!sent ? (
          <View>
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
            />
            <Button title="Send login code" onPress={sendCode} loading={busy} disabled={!validEmail} />
          </View>
        ) : (
          <View>
            <Text style={[type.small, { marginBottom: space(2) }]}>We sent a code to {email.trim()}. It may take a minute — check spam too.</Text>
            <Field
              label="Code"
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 8))}
              placeholder="123456"
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              autoFocus
            />
            <Button title="Sign in" onPress={verify} loading={busy} disabled={code.length < 6} />
            <Button title="Use a different email" kind="ghost" onPress={() => { setSent(false); setCode(''); }} style={{ marginTop: space(1) }} />
          </View>
        )}

        {config.termsUrl || config.privacyUrl ? (
          <Text style={[type.small, { textAlign: 'center', marginTop: space(4), color: colors.textFaint }]}>
            By continuing you agree to the{' '}
            <Text style={{ color: colors.textMuted, textDecorationLine: 'underline' }} onPress={() => config.termsUrl && Linking.openURL(config.termsUrl)}>
              Terms
            </Text>{' '}
            and{' '}
            <Text style={{ color: colors.textMuted, textDecorationLine: 'underline' }} onPress={() => config.privacyUrl && Linking.openURL(config.privacyUrl)}>
              Privacy Policy
            </Text>
            .
          </Text>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
