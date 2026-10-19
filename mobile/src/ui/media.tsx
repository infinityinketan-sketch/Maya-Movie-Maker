import { Directory, File, Paths } from 'expo-file-system';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect } from 'react';
import { Alert, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius } from './theme';

export function aspectOf(ratio: '16:9' | '9:16'): number {
  return ratio === '9:16' ? 9 / 16 : 16 / 9;
}

export function Player({ uri, ratio, autoPlay = false, style }: { uri: string; ratio: '16:9' | '9:16'; autoPlay?: boolean; style?: StyleProp<ViewStyle> }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    if (autoPlay) p.play();
  });
  useEffect(() => {
    player.replaceAsync(uri).catch(() => undefined);
  }, [uri, player]);
  return (
    <View
      style={[
        { width: '100%', aspectRatio: aspectOf(ratio), backgroundColor: '#000', borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
        ratio === '9:16' && { width: '70%', alignSelf: 'center' },
        style,
      ]}
    >
      <VideoView player={player} nativeControls contentFit="contain" fullscreenOptions={{ enable: true }} style={{ flex: 1 }} />
    </View>
  );
}

async function downloadToCache(url: string, name: string): Promise<File> {
  const dir = new Directory(Paths.cache, 'maya');
  if (!dir.exists) dir.create();
  const target = new File(dir, name);
  if (target.exists) target.delete();
  return File.downloadFileAsync(url, target);
}

export async function saveVideoToPhone(url: string, title: string): Promise<void> {
  const { status } = await requestPermissionsAsync(true, ['video']);
  if (status !== 'granted') {
    Alert.alert('Permission needed', 'Allow Maya to save videos so your film can go to your gallery.');
    return;
  }
  const file = await downloadToCache(url, `${safeName(title)}.mp4`);
  await Asset.create(file.uri);
  Alert.alert('Saved', 'Your film is in your gallery.');
}

export async function saveImageToPhone(url: string, title: string): Promise<void> {
  const { status } = await requestPermissionsAsync(true, ['photo']);
  if (status !== 'granted') {
    Alert.alert('Permission needed', 'Allow Maya to save pictures so the poster can go to your gallery.');
    return;
  }
  const ext = url.split('?')[0].split('.').pop() || 'png';
  const file = await downloadToCache(url, `${safeName(title)}.${ext}`);
  await Asset.create(file.uri);
  Alert.alert('Saved', 'The poster is in your gallery.');
}

export async function shareImage(url: string, title: string): Promise<void> {
  const ext = url.split('?')[0].split('.').pop() || 'png';
  const file = await downloadToCache(url, `${safeName(title)}.${ext}`);
  if (!(await Sharing.isAvailableAsync())) {
    Alert.alert('Sharing is not available on this phone');
    return;
  }
  await Sharing.shareAsync(file.uri, { mimeType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, dialogTitle: title });
}

export async function shareVideo(url: string, title: string): Promise<void> {
  const file = await downloadToCache(url, `${safeName(title)}.mp4`);
  if (!(await Sharing.isAvailableAsync())) {
    Alert.alert('Sharing is not available on this phone');
    return;
  }
  await Sharing.shareAsync(file.uri, { mimeType: 'video/mp4', dialogTitle: title });
}

function safeName(s: string): string {
  return (s || 'maya-film').replace(/[^a-z0-9\- ]/gi, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'maya-film';
}
