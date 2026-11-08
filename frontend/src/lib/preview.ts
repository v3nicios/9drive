export type PreviewKind = 'image' | 'video' | 'document' | 'office' | 'zip'

export type ZipVideoEntry = {
  index: number
  name: string
  path: string
  mimeType: string
  compressedSize: string
  uncompressedSize: string
  compressionMethod: number
}

const officeMimeTypes = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const googleDocumentMimeTypes = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
])

const archiveMimeTypes = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'multipart/x-zip',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/x-rar',
])

export function isZipFile(mimeType: string | undefined, fileName?: string): boolean {
  if (mimeType) {
    const lowerMime = mimeType.toLowerCase()
    if (archiveMimeTypes.has(lowerMime) || lowerMime.includes('zip') || lowerMime.includes('rar')) return true
  }
  if (fileName) {
    const lowerName = fileName.trim().toLowerCase()
    if (lowerName.endsWith('.zip') || lowerName.endsWith('.rar')) return true
  }
  return false
}

export function getPreviewKind(mimeType: string | undefined, fileName?: string): PreviewKind | null {
  if (isZipFile(mimeType, fileName)) return 'zip'
  if (!mimeType) return null
  if (mimeType.startsWith('image/') || mimeType === 'application/vnd.google-apps.drawing') return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'application/pdf' || googleDocumentMimeTypes.has(mimeType)) return 'document'
  if (officeMimeTypes.has(mimeType)) return 'office'
  return null
}

export function officeViewerUrl(fileUrl: string) {
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(fileUrl)}`
}

export function isSpreadsheetMimeType(mimeType: string | undefined) {
  return mimeType === 'application/vnd.google-apps.spreadsheet' || mimeType === 'application/vnd.ms-excel' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}
