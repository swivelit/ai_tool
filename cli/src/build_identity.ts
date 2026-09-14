export type BuildIdentity = {
  revision: string
  dirty: boolean | 'unknown'
}

// The release build overwrites the ignored dist copy with repository evidence.
// Source-only TypeScript builds remain explicit rather than guessing clean state.
export const BUILD_IDENTITY: BuildIdentity = Object.freeze({ revision: 'unknown', dirty: 'unknown' })
