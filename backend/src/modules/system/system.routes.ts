import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

export const systemRouter = Router()

async function isWorkspaceOwner(userId: string) {
  const firstUser = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  return !firstUser || firstUser.id === userId
}

systemRouter.post('/update', requireAuth, (_req, res) => {
  return res.status(403).json({
    code: 'SYSTEM_UPDATE_DISABLED',
    message: 'Remote shell updates are disabled for security. Deploy updates via Render or Git.',
  })
})

systemRouter.get('/update-log', requireAuth, (_req, res) => {
  return res.json({
    log: 'Updates are managed via Render / Git deployment pipeline.',
  })
})

systemRouter.get('/google-config', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    if (!(await isWorkspaceOwner(req.user!.id))) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        message: 'Only the workspace owner can view global OAuth configuration.',
      })
    }

    const config = await prisma.providerConfig.findFirst({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' }
    })

    const defaultRedirect = `${req.protocol}://${req.get('host')}/connected-accounts/google/callback`

    if (!config) {
      return res.json({
        exists: false,
        defaultRedirectUri: defaultRedirect
      })
    }

    let clientId = ''
    try {
      clientId = decryptText(config.clientIdEncrypted)
    } catch {
      clientId = ''
    }

    return res.json({
      exists: true,
      clientId,
      redirectUri: config.redirectUri,
      hasSecret: !!config.clientSecretEncrypted,
      defaultRedirectUri: defaultRedirect
    })
  } catch (error) {
    return next(error)
  }
})

systemRouter.post('/google-config', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    if (!(await isWorkspaceOwner(req.user!.id))) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        message: 'Only the workspace owner can update global OAuth configuration.',
      })
    }

    const { clientId, clientSecret, redirectUri } = req.body

    if (!clientId) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'Client ID is required.' })
    }

    const defaultRedirect = `${req.protocol}://${req.get('host')}/connected-accounts/google/callback`
    const finalRedirectUri = redirectUri || defaultRedirect

    const scopes = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]

    // Disable old global active config
    await prisma.providerConfig.updateMany({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      data: { status: 'disabled' }
    })

    // Retrieve the old config to see if we need to reuse the secret if it was not provided in the request
    let finalSecret = clientSecret
    if (!finalSecret) {
      const oldConfig = await prisma.providerConfig.findFirst({
        where: { userId: null, provider: 'google_drive', status: 'disabled' },
        orderBy: { createdAt: 'desc' }
      })
      if (oldConfig) {
        try {
          finalSecret = decryptText(oldConfig.clientSecretEncrypted)
        } catch {
          // ignore
        }
      }
    }

    if (!finalSecret) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'Client Secret is required for first-time setup.' })
    }

    const config = await prisma.providerConfig.create({
      data: {
        userId: null,
        provider: 'google_drive',
        clientIdEncrypted: encryptText(clientId),
        clientSecretEncrypted: encryptText(finalSecret),
        redirectUri: finalRedirectUri,
        scopes,
        status: 'active'
      }
    })

    return res.status(201).json({
      status: 'success',
      message: 'Global Google OAuth configuration updated successfully.',
      id: config.id
    })
  } catch (error) {
    return next(error)
  }
})

systemRouter.get('/backup', requireAuth, (_req, res) => {
  return res.status(400).json({
    code: 'BACKUP_MANAGED_EXTERNALLY',
    message: 'Database backups are managed directly in Supabase / PostgreSQL.',
  })
})

systemRouter.post('/restore', requireAuth, (_req, res) => {
  return res.status(403).json({
    code: 'RESTORE_DISABLED',
    message: 'File-based database restore is disabled for security. Use Supabase / PostgreSQL backups.',
  })
})
