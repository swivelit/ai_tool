import { Ionicons } from "@expo/vector-icons";

export function getPasswordVisibilityProps(isVisible: boolean) {
  return {
    secureTextEntry: !isVisible,
    iconName: (isVisible ? "eye-off-outline" : "eye-outline") as keyof typeof Ionicons.glyphMap,
    accessibilityLabel: isVisible ? "Hide password" : "Show password",
    accessibilityHint: isVisible
      ? "Hides the password text."
      : "Shows the password text.",
  };
}
