import { Alert, Linking, Text } from 'react-native';
import { api } from '../lib/api';
import { config } from '../lib/config';
import { useSession } from '../lib/hooks';
import { supabase } from '../lib/supabase';
import { Button, Card, Screen, SectionLabel, showError } from '../ui/kit';
import { colors, space, type } from '../ui/theme';

export default function Settings() {
  const { session } = useSession();

  function deleteAccount() {
    Alert.alert(
      'Delete your account?',
      'Your films, pictures, videos and unused credits are deleted for good. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete everything',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.deleteAccount();
              await supabase.auth.signOut();
            } catch (e) {
              showError(e);
            }
          },
        },
      ],
    );
  }

  return (
    <Screen>
      <SectionLabel>Account</SectionLabel>
      <Card>
        <Text style={type.small}>Signed in as</Text>
        <Text style={type.heading}>{session?.user.email}</Text>
      </Card>
      <Button title="Sign out" kind="secondary" style={{ marginTop: space(2) }} onPress={() => supabase.auth.signOut()} />

      <SectionLabel>About</SectionLabel>
      <Text style={type.small}>
        Maya uses AI models to write stories and generate pictures, video and music. Results can be imperfect — check every frame before you film it. Only create content you have the right to make; don&apos;t
        depict real people without their consent.
      </Text>
      {config.privacyUrl ? <Button title="Privacy policy" kind="ghost" onPress={() => Linking.openURL(config.privacyUrl)} /> : null}
      {config.termsUrl ? <Button title="Terms of use" kind="ghost" onPress={() => Linking.openURL(config.termsUrl)} /> : null}

      <SectionLabel>Danger zone</SectionLabel>
      <Button title="Delete my account" kind="danger" onPress={deleteAccount} />
      <Text style={[type.small, { marginTop: space(1), color: colors.textFaint }]}>Version 1.0.0</Text>
    </Screen>
  );
}
