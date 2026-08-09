export const MIN_PASSWORD_LENGTH = 8;

export function hasValidPasswordLength(value: string) {
  return value.length >= MIN_PASSWORD_LENGTH;
}
