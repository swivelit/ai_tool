import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/Glass';
import { useAuth } from '@/components/AuthProvider';
import { Brand } from '@/constants/theme';

const FEATURES = [
  {
    icon: 'sparkles-outline' as const,
    title: 'Persona-aware assistance',
    copy: 'Tailored replies and scheduling flows shaped around each user.',
  },
  {
    icon: 'shield-checkmark-outline' as const,
    title: 'Secure session flow',
    copy: 'Clean auth handoff with Firebase-backed access and persistent login.',
  },
  {
    icon: 'calendar-clear-outline' as const,
    title: 'Daily planning built in',
    copy: 'Designed for reminders, routines, and fast actions without clutter.',
  },
];

const METRICS = ['Premium warm UI', 'Fast onboarding', 'Production-ready feel'];

export default function LandingScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isCompact = width < 370 || height < 760;
  const isVeryCompact = width < 345 || height < 700;
  const horizontalPadding = isCompact ? 16 : 20;
  const topPadding = insets.top + (isCompact ? 12 : 18);
  const bottomPadding = Math.max(insets.bottom + 28, 30);
  const maxContentWidth = Math.min(width - horizontalPadding * 2, 560);
  const cardRadius = isCompact ? 24 : 28;
  const primaryHeight = isCompact ? 54 : 58;

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.topGlow} />
        <View style={styles.middleGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <ScrollView
        style={styles.page}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: horizontalPadding,
          paddingTop: topPadding,
          paddingBottom: bottomPadding,
          justifyContent: height > 780 ? 'center' : 'flex-start',
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ width: '100%', alignSelf: 'center', maxWidth: maxContentWidth }}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <View style={styles.brandPill}>
                <Ionicons name="sparkles" size={14} color={Brand.bronze} />
                <Text style={styles.brandPillText}>J AI · Personal companion</Text>
              </View>

              <Text
                style={[
                  styles.headline,
                  {
                    fontSize: isVeryCompact ? 34 : isCompact ? 38 : 42,
                    lineHeight: isVeryCompact ? 40 : isCompact ? 45 : 49,
                    marginTop: 18,
                  },
                ]}
              >
                A polished AI experience that feels calm, premium, and ready for real users.
              </Text>

              <Text
                style={[
                  styles.subhead,
                  {
                    marginTop: 12,
                    fontSize: isCompact ? 14 : 15,
                    lineHeight: isCompact ? 22 : 24,
                  },
                ]}
              >
                Built for onboarding, reminders, routines, and everyday conversations with a
                warmer, more trustworthy visual identity centered on{' '}
                <Text style={styles.inlineAccent}>#ffe5b4</Text>.
              </Text>
            </View>

            <View style={styles.logoBadge}>
              <LinearGradient
                colors={Brand.gradients.hero}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.logoBadgeInner}
              >
                <Ionicons name="sparkles" size={isCompact ? 20 : 22} color={Brand.ink} />
              </LinearGradient>
            </View>
          </View>

          <View style={[styles.metricRow, { marginTop: isCompact ? 18 : 22 }]}>
            {METRICS.map((metric) => (
              <View key={metric} style={styles.metricChip}>
                <Text style={styles.metricText}>{metric}</Text>
              </View>
            ))}
          </View>

          <GlassCard
            style={{
              marginTop: isCompact ? 20 : 24,
              borderRadius: cardRadius,
            }}
          >
            <View style={styles.heroCardTopRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text
                  style={{
                    color: Brand.ink,
                    fontSize: isVeryCompact ? 24 : isCompact ? 28 : 30,
                    lineHeight: isVeryCompact ? 30 : isCompact ? 34 : 36,
                    fontWeight: '900',
                  }}
                >
                  Sign in beautifully.
                </Text>
                <Text
                  style={{
                    color: Brand.muted,
                    marginTop: 8,
                    fontSize: isCompact ? 14 : 15,
                    lineHeight: isCompact ? 21 : 23,
                  }}
                >
                  Cleaner onboarding, stronger hierarchy, better spacing, and a more premium first
                  impression from the very first screen.
                </Text>
              </View>

              <View style={styles.heroMiniCard}>
                <Ionicons name="checkmark-circle" size={18} color={Brand.success} />
                <Text style={styles.heroMiniCardText}>Ready</Text>
              </View>
            </View>

            <View style={{ marginTop: isCompact ? 18 : 20, gap: 12 }}>
              {FEATURES.map((feature) => (
                <View key={feature.title} style={styles.featureRow}>
                  <View style={styles.featureIconWrap}>
                    <Ionicons name={feature.icon} size={18} color={Brand.bronze} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.featureTitle}>{feature.title}</Text>
                    <Text style={styles.featureCopy}>{feature.copy}</Text>
                  </View>
                </View>
              ))}
            </View>

            <Pressable
              onPress={() => router.push(user ? '/(tabs)' : '/auth/login')}
              style={({ pressed }) => [
                styles.buttonShell,
                pressed && styles.buttonPressed,
                { marginTop: 24 },
              ]}
            >
              <LinearGradient
                colors={Brand.gradients.button}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[styles.primaryButton, { minHeight: primaryHeight }]}
              >
                <Text style={styles.primaryButtonText}>
                  {user ? 'Continue to app' : 'Login'}
                </Text>
                <Ionicons name="arrow-forward" size={18} color={Brand.ink} />
              </LinearGradient>
            </Pressable>

            {!user ? (
              <Pressable
                onPress={() => router.push('/auth/signup')}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && styles.buttonPressed,
                  { minHeight: primaryHeight, marginTop: 12 },
                ]}
              >
                <Text style={styles.secondaryButtonText}>Create account</Text>
              </Pressable>
            ) : null}

            <Text style={styles.footerNote}>
              Designed to feel softer and more premium while keeping the flow clear and highly
              usable on smaller phones too.
            </Text>
          </GlassCard>
        </View>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  topGlow: {
    position: 'absolute',
    top: -90,
    right: -40,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
  middleGlow: {
    position: 'absolute',
    top: 230,
    left: -80,
    width: 200,
    height: 200,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 229, 180, 0.42)',
  },
  bottomGlow: {
    position: 'absolute',
    bottom: -80,
    right: 18,
    width: 260,
    height: 260,
    borderRadius: 999,
    backgroundColor: 'rgba(215, 154, 89, 0.16)',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  brandPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: 'rgba(255,255,255,0.64)',
  },
  brandPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  headline: {
    color: Brand.ink,
    fontWeight: '900',
  },
  subhead: {
    color: Brand.muted,
    fontWeight: '500',
  },
  inlineAccent: {
    color: Brand.bronze,
    fontWeight: '800',
  },
  logoBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    padding: 1,
    backgroundColor: 'rgba(255,255,255,0.68)',
    borderWidth: 1,
    borderColor: Brand.line,
    shadowColor: '#d8a35f',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  logoBadgeInner: {
    flex: 1,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metricRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metricChip: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: Brand.line,
  },
  metricText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: '700',
  },
  heroCardTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  heroMiniCard: {
    minWidth: 76,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.74)',
    borderWidth: 1,
    borderColor: Brand.line,
  },
  heroMiniCardText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: '800',
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 14,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderWidth: 1,
    borderColor: Brand.line,
  },
  featureIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,229,180,0.65)',
  },
  featureTitle: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  featureCopy: {
    color: Brand.muted,
    marginTop: 4,
    fontSize: 13,
    lineHeight: 19,
  },
  buttonShell: {
    borderRadius: 18,
    overflow: 'hidden',
  },
  buttonPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.995 }],
  },
  primaryButton: {
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    shadowColor: '#d4934f',
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  primaryButtonText: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  secondaryButton: {
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },
  secondaryButtonText: {
    color: Brand.cocoa,
    fontSize: 15,
    fontWeight: '900',
  },
  footerNote: {
    marginTop: 16,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});