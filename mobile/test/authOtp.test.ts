import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => {
  class ApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  return {
    ApiError,
    apiPostBackendOnly: vi.fn(),
    getApiErrorDetails: (error: any) => ({
      status: typeof error?.status === "number" ? error.status : undefined,
      message: typeof error?.message === "string" ? error.message : "",
    }),
  };
});

describe("friendlyOtpError", () => {
  it.each([
    "email_delivery_unconfigured",
    "email_delivery_unavailable",
    "email_otp_secret_missing",
  ])("maps %s to a friendly OTP delivery message", async (code) => {
    const { ApiError } = await import("../lib/api");
    const { friendlyOtpError } = await import("../lib/authOtp");
    const error = new ApiError(
      `POST /auth/email-otp/signup/request failed: 503 - ${JSON.stringify({
        detail: {
          code,
          message:
            "Email delivery is temporarily unavailable. Please try again later.",
        },
      })}`,
      503,
    );

    expect(friendlyOtpError(error)).toBe(
      "We couldn't send the OTP email right now. Please try again in a few minutes.",
    );
    expect(friendlyOtpError(error)).not.toContain("{");
  });

  it("maps legacy unstructured 503 responses to the same friendly message", async () => {
    const { ApiError } = await import("../lib/api");
    const { friendlyOtpError } = await import("../lib/authOtp");
    const error = new ApiError(
      "POST /auth/email-otp/signup/request failed: 503",
      503,
    );

    expect(friendlyOtpError(error)).toBe(
      "We couldn't send the OTP email right now. Please try again in a few minutes.",
    );
  });
});
