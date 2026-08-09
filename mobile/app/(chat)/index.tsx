/**
 * Production signed-in surface.
 *
 * This route deliberately uses the canonical /api/web contracts through
 * SwicoChatScreen. Legacy local/orb code remains outside the production
 * navigation tree for historical tests and development experiments only.
 */
export { default } from "@/components/swico/SwicoChatScreen";
