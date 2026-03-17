import React from 'react';
import { View, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { Brand } from '@/constants/theme';

export function GlassCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          borderRadius: 24,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: Brand.lineStrong,
          backgroundColor: Brand.glass,
          shadowColor: '#a56522',
          shadowOpacity: 0.12,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 10 },
          elevation: 10,
        },
        style,
      ]}
    >
      <BlurView intensity={18} tint="light" style={{ padding: 18 }}>
        <LinearGradient
          colors={[
            'rgba(255,255,255,0.64)',
            'rgba(255,229,180,0.28)',
            'rgba(215,154,89,0.10)',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        />
        {children}
      </BlurView>
    </View>
  );
}