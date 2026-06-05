import {
  BackendProfileErrorDetails,
  UserProfile,
  classifyBackendProfileError,
  createProfileOnBackend,
  restoreProfileForFirebaseUid,
} from "./account";
import type { LanguageMode } from "./storage";

export type AuthenticatedProfileUser = {
  uid: string;
  email?: string | null;
  emailVerified?: boolean;
  photoURL?: string | null;
  displayName?: string | null;
  providerData?: Array<{ providerId?: string | null }>;
};

export type ProfileSyncResult =
  | { status: "ok"; profile: UserProfile }
  | { status: "not_found" }
  | {
      status: "offline";
      error: BackendProfileErrorDetails;
      cachedProfile?: UserProfile;
    }
  | {
      status: "auth_error";
      error: BackendProfileErrorDetails;
      cachedProfile?: UserProfile;
    }
  | {
      status: "backend_error";
      error: BackendProfileErrorDetails;
      cachedProfile?: UserProfile;
    };

export function detectAuthProvider(
  user: AuthenticatedProfileUser
): "password" | "email_otp" {
  return "password";
}

function normalizeEmail(email?: string | null) {
  const value = (email || "").trim().toLowerCase();
  return value || undefined;
}

export function buildFallbackName(user: AuthenticatedProfileUser) {
  const displayName = user.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  const email = user.email?.trim();
  if (email && email.includes("@")) {
    const localPart = email.split("@")[0]?.trim();
    if (localPart) {
      return localPart;
    }
  }

  return "User";
}

export function resolveSettingsLanguageAfterProfileRestore(input: {
  storedLanguageMode: LanguageMode;
  backendReplyLanguage?: "en" | "ta" | null;
  localSettingsChangedThisSession?: boolean;
}): LanguageMode {
  if (input.localSettingsChangedThisSession) {
    return input.storedLanguageMode;
  }

  return input.backendReplyLanguage === "en" || input.backendReplyLanguage === "ta"
    ? input.backendReplyLanguage
    : input.storedLanguageMode;
}

function resultFromCreateError(
  error: unknown,
  cachedProfile?: UserProfile
): Extract<ProfileSyncResult, { status: "offline" | "auth_error" | "backend_error" }> {
  const details = classifyBackendProfileError(
    error,
    { method: "POST", path: "/users" },
    "Backend profile sync failed"
  );

  return {
    status: details.kind,
    error: details,
    cachedProfile,
  };
}

export async function syncProfileForAuthenticatedUser(
  authUser: AuthenticatedProfileUser
): Promise<ProfileSyncResult> {
  const provider = detectAuthProvider(authUser);
  const restored = await restoreProfileForFirebaseUid(authUser.uid, authUser.email);

  if (restored.status === "not_found") {
    try {
      const createdProfile = await createProfileOnBackend({
        userId: undefined,
        firebaseUid: authUser.uid,
        firebaseEmailVerified: Boolean(authUser.emailVerified),
        email: authUser.email || "",
        avatarUrl: authUser.photoURL || undefined,
        authProvider: provider,
        name: buildFallbackName(authUser),
        place: "",
        assistantName: "Elli",
        timezone: "Asia/Kolkata",
        questionnaireCompleted: false,
      });

      return { status: "ok", profile: createdProfile };
    } catch (error) {
      return resultFromCreateError(error);
    }
  }

  if (restored.status !== "ok") {
    return restored;
  }

  const restoredProfile = restored.profile;
  const normalizedAuthEmail = normalizeEmail(authUser.email);
  const normalizedProfileEmail = normalizeEmail(restoredProfile.email);
  const fallbackName = buildFallbackName(authUser);

  const shouldSyncBackend =
    restoredProfile.firebaseUid !== authUser.uid ||
    normalizedProfileEmail !== normalizedAuthEmail ||
    !restoredProfile.name?.trim() ||
    restoredProfile.firebaseEmailVerified !== Boolean(authUser.emailVerified);

  if (!shouldSyncBackend) {
    return { status: "ok", profile: restoredProfile };
  }

  try {
    const upsertedProfile = await createProfileOnBackend({
      ...restoredProfile,
      userId: restoredProfile.userId,
      firebaseUid: authUser.uid,
      firebaseEmailVerified: Boolean(authUser.emailVerified),
      email: authUser.email || restoredProfile.email || "",
      avatarUrl: authUser.photoURL || restoredProfile.avatarUrl,
      authProvider: provider,
      name: restoredProfile.name || fallbackName,
      place: restoredProfile.place || "",
      assistantName: restoredProfile.assistantName || "Elli",
      timezone: restoredProfile.timezone || "Asia/Kolkata",
      questionnaireCompleted: restoredProfile.questionnaireCompleted ?? false,
      replyLanguage: restoredProfile.replyLanguage,
    });

    return { status: "ok", profile: upsertedProfile };
  } catch (error) {
    return resultFromCreateError(error, restoredProfile);
  }
}
