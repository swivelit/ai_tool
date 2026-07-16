import { validatePublicWebConfig } from './publicWebConfig'

const environment = import.meta.env.PROD ? 'production' : import.meta.env.MODE === 'test' ? 'test' : 'development'

export const publicConfig = validatePublicWebConfig(import.meta.env, environment)
