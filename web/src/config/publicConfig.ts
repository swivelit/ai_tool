import { validatePublicWebConfig } from './publicWebConfig'

const environment = import.meta.env.PROD ? 'production' : import.meta.env.MODE === 'test' ? 'test' : 'development'

export const publicConfig = validatePublicWebConfig(import.meta.env, environment)
export const frontendRelease = typeof __SWICO_FRONTEND_RELEASE__ === 'string'
  ? __SWICO_FRONTEND_RELEASE__ : 'dev'
