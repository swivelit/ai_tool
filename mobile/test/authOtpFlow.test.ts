import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mobileRoot = path.resolve(__dirname, "..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(mobileRoot, relativePath), "utf8");
}

describe("email OTP auth flow source contract", () => {
  it("AuthProvider exposes OTP helpers and has no Google Sign-In imports", () => {
    const source = read("components/AuthProvider.tsx");

    expect(source).toContain("requestSignupOtp");
    expect(source).toContain("completeSignupWithOtp");
    expect(source).toContain("requestPasswordResetOtp");
    expect(source).toContain("confirmPasswordResetOtp");
    expect(source).not.toContain("@react-native-google-signin/google-signin");
    expect(source).not.toContain("GoogleAuthProvider");
    expect(source).not.toContain("signInWithGoogle");
    expect(source).not.toContain("googleReady");
  });

  it("login has forgot-password link and no Google button", () => {
    const source = read("app/auth/login.tsx");

    expect(source).toContain("login-email-input");
    expect(source).toContain("login-password-input");
    expect(source).toContain("login-submit-button");
    expect(source).toContain("forgot-password-link");
    expect(source).toContain("/auth/forgot-password");
    expect(source).not.toContain("Continue with Google");
    expect(source).not.toContain("logo-google");
  });

  it("signup uses OTP controls and no Google button", () => {
    const source = read("app/auth/signup.tsx");

    expect(source).toContain("signup-send-otp-button");
    expect(source).toContain("signup-otp-input");
    expect(source).toContain("signup-complete-button");
    expect(source).toContain("signup-resend-otp-button");
    expect(source).toContain("Send OTP");
    expect(source).toContain("Verify and create account");
    expect(source).not.toContain("Continue with Google");
    expect(source).not.toContain("logo-google");
  });

  it("signup error banner stays visible without oversized solid danger styling", () => {
    const source = read("app/auth/signup.tsx");
    const errorCardBlock = source.match(/errorCard:\s*\{[\s\S]*?\n  \},/)?.[0] || "";

    expect(errorCardBlock).toContain("paddingVertical: 10");
    expect(errorCardBlock).toContain("borderRadius: 12");
    expect(errorCardBlock).toContain("borderWidth: 1");
    expect(errorCardBlock).not.toContain("backgroundColor: Brand.danger");
  });

  it("forgot-password screen exposes expected controls", () => {
    const source = read("app/auth/forgot-password.tsx");

    [
      "forgot-password-email-input",
      "forgot-password-send-otp-button",
      "forgot-password-otp-input",
      "forgot-password-new-password-input",
      "forgot-password-confirm-password-input",
      "forgot-password-confirm-button",
    ].forEach((testID) => {
      expect(source).toContain(testID);
    });
  });

  it("app config and packages do not include Google Sign-In OAuth/native setup", () => {
    const appConfig = read("app.config.ts");
    const packageJson = JSON.parse(read("package.json"));
    const packageLock = read("package-lock.json");

    expect(appConfig).not.toContain("@react-native-google-signin/google-signin");
    expect(appConfig).not.toContain("googleWebClientId");
    expect(appConfig).not.toContain("googleAndroidClientId");
    expect(appConfig).not.toContain("googleIosClientId");
    expect(packageJson.dependencies).not.toHaveProperty(
      "@react-native-google-signin/google-signin",
    );
    expect(packageLock).not.toContain("@react-native-google-signin/google-signin");
  });

  it("profile and account screens no longer show Google linked status", () => {
    const combined = [
      read("app/onboarding/profile.tsx"),
      read("app/(tabs)/routine.tsx"),
      read("lib/profileSync.ts"),
    ].join("\n");

    expect(combined).not.toContain("Google linked");
    expect(combined).not.toContain("Google not linked");
    expect(combined).not.toContain("Google sign-in");
    expect(combined).toContain("Email verified");
    expect(combined).toContain("Email sign-in");
  });
});
