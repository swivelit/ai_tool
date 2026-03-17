import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/Glass';
import { useAuth } from '@/components/AuthProvider';
import { Brand } from '@/constants/theme';

export default function SignupScreen() {
  const { signUpWithPassword, signInWithGoogle, googleConfigured, googleReady } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState('');

  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isCompact = width < 370 || height < 760;
  const horizontalPadding = isCompact ? 16 : 20;
  const topPadding = insets.top + (isCompact ? 12 : 18);
  const bottomPadding = Math.max(insets.bottom + 28, 30);
  const contentMaxWidth = Math.min(width - horizontalPadding * 2, 520);
  const inputHeight = isCompact ? 54 : 58;
  const buttonHeight = isCompact ? 54 : 58;

  async function handleSignup() {
    if (!name.trim() || !email.trim() || !password || !confirmPassword) {
      setErrorText('Please fill all fields.');
      return;
    }
    if (password.length < 6) {
      setErrorText('Password should be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorText('Passwords do not match.');
      return;
    }

    try {
      setBusy(true);
      setErrorText('');
      await signUpWithPassword(name.trim(), email.trim(), password);
    } catch (error: unknown) {
      setErrorText(error instanceof Error ? error.message : 'Sign up failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    try {
      setBusy(true);
      setErrorText('');
      await signInWithGoogle();
    } catch (error: unknown) {
      setErrorText(error instanceof Error ? error.message : 'Google sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.topGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.page}
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: horizontalPadding,
            paddingTop: topPadding,
            paddingBottom: bottomPadding,
            justifyContent: height > 780 ? 'center' : 'flex-start',
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={{ width: '100%', alignSelf: 'center', maxWidth: contentMaxWidth }}>
            <Pressable onPress={() => router.replace('/')} style={styles.backButton}>
              <Ionicons name="chevron-back" size={18} color={Brand.cocoa} />
              <Text style={styles.backButtonText}>Back</Text>
            </Pressable>

            <View style={styles.headerBlock}>
              <View style={styles.titlePill}>
                <Ionicons name="person-add-outline" size={14} color={Brand.bronze} />
                <Text style={styles.titlePillText}>Create your account</Text>
              </View>

              <Text
                style={[
                  styles.title,
                  { fontSize: isCompact ? 31 : 34, lineHeight: isCompact ? 37 : 40 },
                ]}
              >
                Start with style
              </Text>
              <Text style={styles.subtitle}>
                A cleaner first-run experience with warmer tones, stronger structure, and better
                visual hierarchy for production-level polish.
              </Text>
            </View>

            <GlassCard style={{ borderRadius: 28 }}>
              {errorText ? (
                <View style={styles.errorCard}>
                  <Ionicons name="alert-circle-outline" size={16} color="#fff4ef" />
                  <Text style={styles.errorText}>{errorText}</Text>
                </View>
              ) : null}

              <View style={{ marginTop: errorText ? 16 : 0 }}>
                <Text style={styles.label}>Name</Text>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="Hari"
                  placeholderTextColor="rgba(124, 99, 80, 0.55)"
                  style={[styles.input, { height: inputHeight }]}
                  editable={!busy}
                />
              </View>

              <View style={{ marginTop: 16 }}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  placeholder="you@example.com"
                  placeholderTextColor="rgba(124, 99, 80, 0.55)"
                  style={[styles.input, { height: inputHeight }]}
                  editable={!busy}
                />
              </View>

              <View style={{ marginTop: 16 }}>
                <Text style={styles.label}>Password</Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  placeholder="Minimum 6 characters"
                  placeholderTextColor="rgba(124, 99, 80, 0.55)"
                  style={[styles.input, { height: inputHeight }]}
                  editable={!busy}
                />
              </View>

              <View style={{ marginTop: 16 }}>
                <Text style={styles.label}>Confirm password</Text>
                <TextInput
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  secureTextEntry
                  placeholder="Re-enter password"
                  placeholderTextColor="rgba(124, 99, 80, 0.55)"
                  style={[styles.input, { height: inputHeight }]}
                  editable={!busy}
                />
              </View>

              <Pressable
                onPress={handleSignup}
                disabled={busy}
                style={({ pressed }) => [
                  styles.buttonShell,
                  pressed && styles.buttonPressed,
                  busy && styles.disabled,
                ]}
              >
                <LinearGradient
                  colors={Brand.gradients.button}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[styles.primaryButton, { minHeight: buttonHeight, marginTop: 22 }]}
                >
                  {busy ? (
                    <ActivityIndicator color={Brand.ink} />
                  ) : (
                    <>
                      <Text style={styles.primaryButtonText}>Create account</Text>
                      <Ionicons name="arrow-forward" size={18} color={Brand.ink} />
                    </>
                  )}
                </LinearGradient>
              </Pressable>

              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or continue with</Text>
                <View style={styles.dividerLine} />
              </View>

              <Pressable
                onPress={handleGoogle}
                disabled={busy || !googleReady || !googleConfigured}
                style={({ pressed }) => [
                  styles.googleButton,
                  pressed && styles.buttonPressed,
                  (busy || !googleReady || !googleConfigured) && styles.disabled,
                  { minHeight: buttonHeight },
                ]}
              >
                <Ionicons name="logo-google" size={18} color={Brand.ink} />
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </Pressable>

              {!googleConfigured ? (
                <Text style={styles.helperText}>
                  Add your EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID in your env file to enable Google
                  sign-in.
                </Text>
              ) : null}

              <View style={styles.footerRow}>
                <Text style={styles.footerCopy}>Already have an account?</Text>
                <Pressable onPress={() => router.replace('/auth/login')}>
                  <Text style={styles.footerLink}>Login</Text>
                </Pressable>
              </View>
            </GlassCard>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  topGlow: {
    position: 'absolute',
    top: -80,
    right: -20,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  bottomGlow: {
    position: 'absolute',
    bottom: -60,
    left: -30,
    width: 240,
    height: 240,
    borderRadius: 999,
    backgroundColor: 'rgba(255,229,180,0.35)',
  },
  backButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  backButtonText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: '800',
  },
  headerBlock: {
    marginTop: 18,
    marginBottom: 18,
  },
  titlePill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: 'rgba(255,255,255,0.62)',
  },
  titlePillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: '800',
  },
  title: {
    marginTop: 16,
    color: Brand.ink,
    fontWeight: '900',
  },
  subtitle: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 18,
    backgroundColor: Brand.danger,
  },
  errorText: {
    flex: 1,
    color: '#fff8f5',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
  },
  label: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 9,
  },
  input: {
    borderRadius: 18,
    paddingHorizontal: 16,
    color: Brand.ink,
    fontSize: 15,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },
  buttonShell: {
    borderRadius: 18,
    overflow: 'hidden',
  },
  buttonPressed: {
    opacity: 0.94,
  },
  disabled: {
    opacity: 0.6,
  },
  primaryButton: {
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    shadowColor: '#d4934f',
    shadowOpacity: 0.24,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  primaryButtonText: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 18,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Brand.line,
  },
  dividerText: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  googleButton: {
    marginTop: 18,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },
  googleButtonText: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  helperText: {
    marginTop: 12,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  footerRow: {
    marginTop: 20,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  footerCopy: {
    color: Brand.muted,
    fontSize: 13,
  },
  footerLink: {
    color: Brand.bronze,
    fontSize: 13,
    fontWeight: '900',
  },
});