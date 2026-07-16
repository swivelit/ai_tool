import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8000')
vi.stubEnv('VITE_FIREBASE_API_KEY', 'unit-test-public-key')
vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'localhost')
vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'unit-test-project')
vi.stubEnv('VITE_FIREBASE_APP_ID', '1:1234567890:web:unit-test')
vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', '1234567890')

if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => undefined
if (!window.matchMedia) window.matchMedia = (() => ({ matches:false, media:'', onchange:null, addListener:() => undefined, removeListener:() => undefined, addEventListener:() => undefined, removeEventListener:() => undefined, dispatchEvent:() => false })) as typeof window.matchMedia
