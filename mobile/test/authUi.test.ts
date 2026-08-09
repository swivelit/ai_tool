import { describe, expect, it } from "vitest";

import { getPasswordVisibilityProps } from "@/lib/authUi";
import { hasValidPasswordLength, MIN_PASSWORD_LENGTH } from "@/lib/authValidation";

describe("getPasswordVisibilityProps", () => {
  it("returns hidden-password state when the field is masked", () => {
    expect(getPasswordVisibilityProps(false)).toEqual({
      secureTextEntry: true,
      iconName: "eye-outline",
      accessibilityLabel: "Show password",
      accessibilityHint: "Shows the password text.",
    });
  });

  it("returns visible-password state when the field is revealed", () => {
    expect(getPasswordVisibilityProps(true)).toEqual({
      secureTextEntry: false,
      iconName: "eye-off-outline",
      accessibilityLabel: "Hide password",
      accessibilityHint: "Hides the password text.",
    });
  });
});

describe("password validation", () => {
  it("matches the website minimum of eight characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(hasValidPasswordLength("1234567")).toBe(false);
    expect(hasValidPasswordLength("12345678")).toBe(true);
  });
});
