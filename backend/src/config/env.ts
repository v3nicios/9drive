import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_PORT: z.coerce.number().default(Number(process.env.PORT) || 4000),
  FRONTEND_URL: z.string().url().transform((url) => url.replace(/\/+$/, '')),
  JWT_ACCESS_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5 * 1024 * 1024 * 1024),
  RECAPTCHA_SECRET_KEY: z.string().optional(),
  ALLOW_REGISTRATION: z.string().optional().transform((v) => v !== 'false'),
})

export const env = envSchema.parse(process.env)
