// React Native entry of @rnrs/runtime: selects the platform backend when first loaded.
import {Platform} from 'react-native';
import {installJsiBackend} from './jsi-backend';
import {setMissingBackendMessage} from './runtime';

export * from './runtime';

if (Platform.OS === 'android' || Platform.OS === 'ios') {
  installJsiBackend(Platform.OS);
} else {
  setMissingBackendMessage(`@rnrs/runtime: ${Platform.OS} is not supported; backends exist for Android, iOS and browser Wasm only`);
}
