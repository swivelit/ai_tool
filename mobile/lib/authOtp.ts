import { ApiError, apiPostBackendOnly, getApiErrorDetails } from "./api";

export type OtpResponse = {
  ok: boolean;
  message?: string;
  cooldown_seconds?: number;
};

export type SignupCompleteResponse = {
  ok: boolean;
  user?: unknown;
};

function parseBackendDetail(error: unknown): any {
  const message =
    typeof (error as any)?.message === "string" ? (error as any).message : "";
  const jsonStart = message.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(message.slice(jsonStart));
    return parsed?.detail ?? parsed;
  } catch {
    return null;
  }
}

function friendlyOtpError(error: unknown) {
  const detail = parseBackendDetail(error);
  const details = getApiErrorDetails(error);
  const status = details.status;
  const code = typeof detail?.code === "string" ? detail.code : "";
  const backendMessage =
    typeof detail?.message === "string"
      ? detail.message
      : typeof detail === "string"
        ? detail
        : "";

  switch (code) {
    case "invalid_email":
      return "Please enter a valid email address.";
    case "invalid_otp_format":
      return "Enter the 6-digit code from your email.";
    case "otp_incorrect":
      return "The code you entered is incorrect.";
    case "otp_invalid_or_expired":
      return "This code is invalid or expired. Request a new code.";
    case "otp_too_many_attempts":
      return "Too many incorrect attempts. Request a new code.";
    case "otp_cooldown":
      return backendMessage || "Please wait before requesting another code.";
  }

  if (status === 409 || /already registered/i.test(backendMessage)) {
    return "This email is already registered. Please log in or reset your password.";
  }

  if (status === 429) {
    return backendMessage || "Please wait before requesting another code.";
  }

  if (status === 503) {
    return "Email delivery is temporarily unavailable. Please try again later.";
  }

  if (backendMessage && !/[{}[\]]/.test(backendMessage)) {
    return backendMessage;
  }

  return details.message && !(error instanceof ApiError)
    ? details.message
    : "Something went wrong. Please try again.";
}

async function postOtp<T>(path: string, body: Record<string, unknown>) {
  try {
    return await apiPostBackendOnly<T>(path, body, { auth: false });
  } catch (error) {
    throw new Error(friendlyOtpError(error));
  }
}

export function requestSignupOtp(email: string, name?: string) {
  return postOtp<OtpResponse>("/auth/email-otp/signup/request", {
    email,
    name: name || "",
  });
}

export function completeSignupWithOtp(
  name: string,
  email: string,
  password: string,
  otp: string
) {
  return postOtp<SignupCompleteResponse>("/auth/email-otp/signup/complete", {
    name,
    email,
    password,
    otp,
  });
}

export function requestPasswordResetOtp(email: string) {
  return postOtp<OtpResponse>("/auth/email-otp/password-reset/request", {
    email,
  });
}

export function confirmPasswordResetOtp(
  email: string,
  otp: string,
  newPassword: string
) {
  return postOtp<OtpResponse>("/auth/email-otp/password-reset/confirm", {
    email,
    otp,
    new_password: newPassword,
  });
}
