import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { publicConfig } from '../config/publicConfig'

const app = initializeApp(publicConfig.firebase)

export const auth = getAuth(app)
