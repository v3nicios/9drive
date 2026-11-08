import { GetObjectCommand } from '@aws-sdk/client-s3'
import type { ConnectedAccount, File } from '@prisma/client'
import type { Response } from 'express'
import { createExtractorFromData } from 'node-unrar-js'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { createS3Client, getS3ConfigForAccount } from '../s3/s3.service.js'
import { normalizeHeaders } from './stream-google-file.js'

type FileWithAccount = File & { connectedAccount: ConnectedAccount }

export type ZipVideoEntry = {
  index: number
  name: string
  path: string
  mimeType: string
  compressedSize: string
  uncompressedSize: string
  compressionMethod: number
}

type InternalArchiveEntry = {
  index: number
  name: string
  path: string
  mimeType: string
  compressedSize: bigint
  uncompressedSize: bigint
  localHeaderOffset: bigint
  dataStartOffset?: bigint
  compressionMethod: number
  archiveFormat: 'zip' | 'rar'
}

const videoMimeByExtension: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
}

// Short-lived in-memory cache for extracted compressed RAR video buffers (avoids re-extracting on every HTTP Range request from <video>)
const extractedRarVideoCache = new Map<string, { data: Uint8Array; expiresAt: number }>()

function cleanExpiredRarCache() {
  const now = Date.now()
  for (const [key, entry] of extractedRarVideoCache.entries()) {
    if (entry.expiresAt <= now) extractedRarVideoCache.delete(key)
  }
}

function getVideoMimeType(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/')
  if (normalized.endsWith('/')) return null
  const baseName = normalized.split('/').pop() ?? ''
  if (!baseName || baseName.startsWith('._') || normalized.startsWith('__MACOSX/')) return null
  const dotIndex = baseName.lastIndexOf('.')
  if (dotIndex === -1) return null
  const ext = baseName.slice(dotIndex).toLowerCase()
  return videoMimeByExtension[ext] ?? null
}

function isRarFile(file: Pick<File, 'name' | 'mimeType'>): boolean {
  const lowerMime = (file.mimeType || '').toLowerCase()
  const lowerName = (file.name || '').trim().toLowerCase()
  return lowerMime.includes('rar') || lowerName.endsWith('.rar')
}

async function fetchRangeBuffer(file: FileWithAccount, start: bigint, end: bigint): Promise<Buffer> {
  const rangeHeader = `bytes=${start.toString()}-${end.toString()}`
  if (file.provider === 's3') {
    const config = await getS3ConfigForAccount(file.connectedAccountId)
    const client = createS3Client(config)
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId, Range: rangeHeader }))
    if (!response.Body) throw new Error('Empty S3 range response')
    const byteArray = await response.Body.transformToByteArray()
    return Buffer.from(byteArray)
  }

  const auth = await getAuthedGoogleClient(file.connectedAccount)
  const headers = normalizeHeaders(await auth.getRequestHeaders())
  const url = `https://www.googleapis.com/drive/v3/files/${file.providerFileId}?alt=media`
  const response = await fetch(url, {
    headers: {
      ...headers,
      Range: rangeHeader,
    },
  })
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText)
    throw new Error(message || `Failed to read archive range (${response.status})`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

async function openRangeStream(
  file: FileWithAccount,
  start: bigint,
  end: bigint,
  abortSignal: AbortSignal
): Promise<Readable> {
  const rangeHeader = `bytes=${start.toString()}-${end.toString()}`
  if (file.provider === 's3') {
    const config = await getS3ConfigForAccount(file.connectedAccountId)
    const client = createS3Client(config)
    const response = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId, Range: rangeHeader }),
      { abortSignal }
    )
    if (!response.Body) throw new Error('Empty S3 stream body')
    return response.Body as Readable
  }

  const auth = await getAuthedGoogleClient(file.connectedAccount)
  const headers = normalizeHeaders(await auth.getRequestHeaders())
  const url = `https://www.googleapis.com/drive/v3/files/${file.providerFileId}?alt=media`
  const response = await fetch(url, {
    headers: {
      ...headers,
      Range: rangeHeader,
    },
    signal: abortSignal,
  })
  if (!response.ok || !response.body) {
    const message = await response.text().catch(() => response.statusText)
    throw new Error(message || `Failed to stream archive range (${response.status})`)
  }
  return Readable.fromWeb(response.body as any)
}

function readRar5Vint(buf: Buffer, offset: number): { value: bigint; nextPos: number } | null {
  let value = 0n
  let shift = 0n
  let pos = offset
  while (pos < buf.length && pos - offset < 10) {
    const byte = buf[pos]!
    value |= BigInt(byte & 0x7f) << shift
    pos++
    if ((byte & 0x80) === 0) {
      return { value, nextPos: pos }
    }
    shift += 7n
  }
  return null
}

async function readRarEntriesInternal(file: FileWithAccount): Promise<InternalArchiveEntry[]> {
  const fileSize = file.sizeBytes
  if (fileSize < 20n) return []

  const initialChunkSize = fileSize < 65536n ? fileSize : 65536n
  const headBuf = await fetchRangeBuffer(file, 0n, initialChunkSize - 1n)

  // Verify RAR signature: Rar!\x1a\x07\x00 (RAR 4.x) or Rar!\x1a\x07\x01\x00 (RAR 5.0)
  const isRarSig =
    headBuf.length >= 7 &&
    headBuf[0] === 0x52 &&
    headBuf[1] === 0x61 &&
    headBuf[2] === 0x72 &&
    headBuf[3] === 0x21 &&
    headBuf[4] === 0x1a &&
    headBuf[5] === 0x07

  if (!isRarSig) {
    throw new Error('Invalid or unsupported RAR archive signature.')
  }

  const isRar5 = headBuf.length >= 8 && headBuf[6] === 0x01 && headBuf[7] === 0x00
  const entries: InternalArchiveEntry[] = []
  let videoIndex = 0

  async function getSliceAt(absOffset: bigint, length: number): Promise<Buffer> {
    const endOffset = absOffset + BigInt(length) - 1n
    const clampedEnd = endOffset >= fileSize ? fileSize - 1n : endOffset
    if (clampedEnd < absOffset) return Buffer.alloc(0)
    if (clampedEnd < initialChunkSize) {
      return headBuf.subarray(Number(absOffset), Number(clampedEnd) + 1)
    }
    return fetchRangeBuffer(file, absOffset, clampedEnd)
  }

  let offset = isRar5 ? 8n : 7n
  let safetyCounter = 0

  while (offset + 7n < fileSize && safetyCounter++ < 500) {
    const chunk = await getSliceAt(offset, 1024)
    if (chunk.length < 7) break

    if (isRar5) {
      const sizeRes = readRar5Vint(chunk, 4)
      if (!sizeRes) break
      const headerSize = sizeRes.value
      const afterSizePos = sizeRes.nextPos
      if (headerSize <= 0n || headerSize > 1048576n) break

      let headerBuf = chunk
      if (afterSizePos + Number(headerSize) > chunk.length) {
        headerBuf = await getSliceAt(offset, afterSizePos + Number(headerSize))
      }

      const typeRes = readRar5Vint(headerBuf, afterSizePos)
      if (!typeRes) break
      const headerType = typeRes.value

      const flagsRes = readRar5Vint(headerBuf, typeRes.nextPos)
      if (!flagsRes) break
      const headerFlags = flagsRes.value

      let cur = flagsRes.nextPos
      if ((headerFlags & 0x0001n) !== 0n) {
        const extraRes = readRar5Vint(headerBuf, cur)
        if (!extraRes) break
        cur = extraRes.nextPos
      }

      let dataSize = 0n
      if ((headerFlags & 0x0002n) !== 0n) {
        const dataRes = readRar5Vint(headerBuf, cur)
        if (!dataRes) break
        dataSize = dataRes.value
        cur = dataRes.nextPos
      }

      const headerEndAbs = offset + BigInt(afterSizePos) + headerSize

      if (headerType === 5n) break // End of archive

      if (headerType === 2n) {
        const fileFlagsRes = readRar5Vint(headerBuf, cur)
        const unpSizeRes = fileFlagsRes ? readRar5Vint(headerBuf, fileFlagsRes.nextPos) : null
        const attrRes = unpSizeRes ? readRar5Vint(headerBuf, unpSizeRes.nextPos) : null
        if (fileFlagsRes && unpSizeRes && attrRes) {
          const fileFlags = fileFlagsRes.value
          const unpackedSize = unpSizeRes.value
          let fCur = attrRes.nextPos
          if ((fileFlags & 0x0002n) !== 0n) fCur += 4
          if ((fileFlags & 0x0004n) !== 0n) fCur += 4
          const compRes = readRar5Vint(headerBuf, fCur)
          const hostRes = compRes ? readRar5Vint(headerBuf, compRes.nextPos) : null
          const nameLenRes = hostRes ? readRar5Vint(headerBuf, hostRes.nextPos) : null
          if (compRes && nameLenRes) {
            const nameStart = nameLenRes.nextPos
            const nameEnd = nameStart + Number(nameLenRes.value)
            if (nameEnd <= headerBuf.length) {
              const filePath = headerBuf.subarray(nameStart, nameEnd).toString('utf8')
              const isDirectory = (fileFlags & 0x0001n) !== 0n
              const method = Number((compRes.value >> 7n) & 0x07n)
              const mimeType = getVideoMimeType(filePath)
              if (!isDirectory && mimeType && unpackedSize > 0n) {
                const normalizedPath = filePath.replace(/\\/g, '/')
                const baseName = normalizedPath.split('/').pop() ?? normalizedPath
                entries.push({
                  index: videoIndex++,
                  name: baseName,
                  path: normalizedPath,
                  mimeType,
                  compressedSize: dataSize,
                  uncompressedSize: unpackedSize,
                  localHeaderOffset: offset,
                  dataStartOffset: headerEndAbs,
                  compressionMethod: method,
                  archiveFormat: 'rar',
                })
              }
            }
          }
        }
      }

      offset = headerEndAbs + dataSize
    } else {
      // RAR 4.x block header
      const headType = chunk.readUInt8(2)
      const headFlags = chunk.readUInt16LE(3)
      const headSize = chunk.readUInt16LE(5)
      if (headSize < 7 || headType === 0x7b) break

      let headerBuf = chunk
      if (headSize > chunk.length) {
        headerBuf = await getSliceAt(offset, headSize)
      }

      let addSize = 0n
      if (headType === 0x74 && headerBuf.length >= 32) {
        const lowPackSize = BigInt(headerBuf.readUInt32LE(7))
        const lowUnpSize = BigInt(headerBuf.readUInt32LE(11))
        const method = headerBuf.readUInt8(25)
        const nameSize = headerBuf.readUInt16LE(26)
        let highPackSize = 0n
        let highUnpSize = 0n
        let nameOffset = 32
        if ((headFlags & 0x0100) !== 0 && headerBuf.length >= 40) {
          highPackSize = BigInt(headerBuf.readUInt32LE(32))
          highUnpSize = BigInt(headerBuf.readUInt32LE(36))
          nameOffset = 40
        }
        const packSize = (highPackSize << 32n) | lowPackSize
        const unpSize = (highUnpSize << 32n) | lowUnpSize
        addSize = packSize

        if (nameOffset + nameSize <= headerBuf.length) {
          const rawName = headerBuf.subarray(nameOffset, nameOffset + nameSize).toString('utf8')
          const cleanPath = rawName.split('\0')[0] ?? rawName
          const isDirectory = (headFlags & 0x00e0) === 0x00e0
          const mimeType = getVideoMimeType(cleanPath)
          if (!isDirectory && mimeType && unpSize > 0n) {
            const normalizedPath = cleanPath.replace(/\\/g, '/')
            const baseName = normalizedPath.split('/').pop() ?? normalizedPath
            entries.push({
              index: videoIndex++,
              name: baseName,
              path: normalizedPath,
              mimeType,
              compressedSize: packSize,
              uncompressedSize: unpSize,
              localHeaderOffset: offset,
              dataStartOffset: offset + BigInt(headSize),
              compressionMethod: method === 0x30 ? 0 : method,
              archiveFormat: 'rar',
            })
          }
        }
      } else if ((headFlags & 0x8000) !== 0 && headerBuf.length >= 11) {
        addSize = BigInt(headerBuf.readUInt32LE(7))
      }

      offset = offset + BigInt(headSize) + addSize
    }
  }

  return entries
}

function findEocdOffset(buffer: Buffer): number {
  const minEocdSize = 22
  for (let i = buffer.length - minEocdSize; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(i + 20)
      if (i + minEocdSize + commentLength <= buffer.length) {
        return i
      }
    }
  }
  return -1
}

async function readZipEntriesInternal(file: FileWithAccount): Promise<InternalArchiveEntry[]> {
  const fileSize = file.sizeBytes
  if (fileSize < 22n) return []

  const maxTailSize = 65558n
  const tailStart = fileSize > maxTailSize ? fileSize - maxTailSize : 0n
  const tailBuffer = await fetchRangeBuffer(file, tailStart, fileSize - 1n)

  const eocdOffset = findEocdOffset(tailBuffer)
  if (eocdOffset === -1) {
    throw new Error('Invalid or unsupported ZIP archive (Central Directory not found).')
  }

  let cdSize = BigInt(tailBuffer.readUInt32LE(eocdOffset + 12))
  let cdOffset = BigInt(tailBuffer.readUInt32LE(eocdOffset + 16))

  if (eocdOffset >= 20 && tailBuffer.readUInt32LE(eocdOffset - 20) === 0x07064b50) {
    const zip64EocdOffset = tailBuffer.readBigUInt64LE(eocdOffset - 12)
    let zip64Buf: Buffer
    if (zip64EocdOffset >= tailStart && zip64EocdOffset + 56n <= fileSize) {
      const rel = Number(zip64EocdOffset - tailStart)
      zip64Buf = tailBuffer.subarray(rel, rel + 56)
    } else {
      zip64Buf = await fetchRangeBuffer(file, zip64EocdOffset, zip64EocdOffset + 55n)
    }
    if (zip64Buf.length >= 56 && zip64Buf.readUInt32LE(0) === 0x06064b50) {
      cdSize = zip64Buf.readBigUInt64LE(40)
      cdOffset = zip64Buf.readBigUInt64LE(48)
    }
  }

  if (cdSize === 0n) return []
  if (cdSize > 32n * 1024n * 1024n) {
    throw new Error('ZIP central directory is too large to inspect in memory.')
  }

  let cdBuffer: Buffer
  if (cdOffset >= tailStart && cdOffset + cdSize <= fileSize) {
    const relStart = Number(cdOffset - tailStart)
    cdBuffer = tailBuffer.subarray(relStart, relStart + Number(cdSize))
  } else {
    cdBuffer = await fetchRangeBuffer(file, cdOffset, cdOffset + cdSize - 1n)
  }

  const entries: InternalArchiveEntry[] = []
  let ptr = 0
  let videoIndex = 0

  while (ptr + 46 <= cdBuffer.length) {
    const signature = cdBuffer.readUInt32LE(ptr)
    if (signature !== 0x02014b50) break

    const generalPurposeBitFlag = cdBuffer.readUInt16LE(ptr + 8)
    const compressionMethod = cdBuffer.readUInt16LE(ptr + 10)
    const rawCompressedSize = cdBuffer.readUInt32LE(ptr + 20)
    const rawUncompressedSize = cdBuffer.readUInt32LE(ptr + 24)
    const fileNameLength = cdBuffer.readUInt16LE(ptr + 28)
    const extraFieldLength = cdBuffer.readUInt16LE(ptr + 30)
    const fileCommentLength = cdBuffer.readUInt16LE(ptr + 32)
    const rawLocalHeaderOffset = cdBuffer.readUInt32LE(ptr + 42)

    const nameStart = ptr + 46
    const extraStart = nameStart + fileNameLength
    const nextEntryPtr = extraStart + extraFieldLength + fileCommentLength
    if (nextEntryPtr > cdBuffer.length) break

    const filePath = cdBuffer.subarray(nameStart, extraStart).toString('utf8')

    let compressedSize = BigInt(rawCompressedSize)
    let uncompressedSize = BigInt(rawUncompressedSize)
    let localHeaderOffset = BigInt(rawLocalHeaderOffset)

    if (
      rawUncompressedSize === 0xffffffff ||
      rawCompressedSize === 0xffffffff ||
      rawLocalHeaderOffset === 0xffffffff
    ) {
      let extraPtr = extraStart
      const extraEnd = extraStart + extraFieldLength
      while (extraPtr + 4 <= extraEnd) {
        const headerId = cdBuffer.readUInt16LE(extraPtr)
        const dataSize = cdBuffer.readUInt16LE(extraPtr + 2)
        const dataStart = extraPtr + 4
        if (dataStart + dataSize > extraEnd) break
        if (headerId === 0x0001) {
          let fieldOffset = dataStart
          if (rawUncompressedSize === 0xffffffff && fieldOffset + 8 <= dataStart + dataSize) {
            uncompressedSize = cdBuffer.readBigUInt64LE(fieldOffset)
            fieldOffset += 8
          }
          if (rawCompressedSize === 0xffffffff && fieldOffset + 8 <= dataStart + dataSize) {
            compressedSize = cdBuffer.readBigUInt64LE(fieldOffset)
            fieldOffset += 8
          }
          if (rawLocalHeaderOffset === 0xffffffff && fieldOffset + 8 <= dataStart + dataSize) {
            localHeaderOffset = cdBuffer.readBigUInt64LE(fieldOffset)
            fieldOffset += 8
          }
          break
        }
        extraPtr = dataStart + dataSize
      }
    }

    const isEncrypted = (generalPurposeBitFlag & 0x0001) !== 0
    const isSupportedCompression = compressionMethod === 0 || compressionMethod === 8
    const mimeType = getVideoMimeType(filePath)

    if (!isEncrypted && isSupportedCompression && mimeType && uncompressedSize > 0n) {
      const normalizedPath = filePath.replace(/\\/g, '/')
      const baseName = normalizedPath.split('/').pop() ?? normalizedPath
      entries.push({
        index: videoIndex++,
        name: baseName,
        path: normalizedPath,
        mimeType,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        compressionMethod,
        archiveFormat: 'zip',
      })
    }

    ptr = nextEntryPtr
  }

  return entries
}

async function readArchiveEntriesInternal(file: FileWithAccount): Promise<InternalArchiveEntry[]> {
  if (isRarFile(file)) {
    return readRarEntriesInternal(file)
  }
  return readZipEntriesInternal(file)
}

export async function listZipVideoEntries(file: FileWithAccount): Promise<ZipVideoEntry[]> {
  const internalEntries = await readArchiveEntriesInternal(file)
  return internalEntries.map((entry) => ({
    index: entry.index,
    name: entry.name,
    path: entry.path,
    mimeType: entry.mimeType,
    compressedSize: entry.compressedSize.toString(),
    uncompressedSize: entry.uncompressedSize.toString(),
    compressionMethod: entry.compressionMethod,
  }))
}

function parseHttpRange(rangeHeader: string | undefined, totalSize: bigint): { start: bigint; end: bigint; isPartial: boolean } | null {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return { start: 0n, end: totalSize - 1n, isPartial: false }
  }
  const spec = rangeHeader.slice('bytes='.length).split(',')[0]?.trim() ?? ''
  const [startStr, endStr] = spec.split('-')
  if (!startStr && !endStr) return null

  if (!startStr) {
    const suffixLength = BigInt(endStr)
    if (suffixLength <= 0n) return null
    const start = suffixLength >= totalSize ? 0n : totalSize - suffixLength
    return { start, end: totalSize - 1n, isPartial: true }
  }

  const start = BigInt(startStr)
  const end = endStr ? BigInt(endStr) : totalSize - 1n
  if (start < 0n || start >= totalSize || end < start) return null
  const clampedEnd = end >= totalSize ? totalSize - 1n : end
  return { start, end: clampedEnd, isPartial: true }
}

async function extractCompressedRarEntryInMemory(file: FileWithAccount, entry: InternalArchiveEntry): Promise<Uint8Array> {
  cleanExpiredRarCache()
  const cacheKey = `${file.id}:${entry.index}`
  const cached = extractedRarVideoCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data
  }

  const maxInMemoryRarBytes = 300n * 1024n * 1024n // 300 MB safety guard for in-memory WASM extraction
  if (file.sizeBytes > maxInMemoryRarBytes) {
    throw new Error('This RAR archive uses solid/LZ compression and is larger than 300 MB. For large RAR video streaming, create the RAR with Store (no compression) or use ZIP.')
  }

  const archiveBuffer = await fetchRangeBuffer(file, 0n, file.sizeBytes - 1n)
  const arrayBuffer = archiveBuffer.buffer.slice(archiveBuffer.byteOffset, archiveBuffer.byteOffset + archiveBuffer.byteLength) as ArrayBuffer
  const extractor = await createExtractorFromData({ data: arrayBuffer })
  const extracted = extractor.extract({
    files: (header) => header.name.replace(/\\/g, '/') === entry.path,
  })

  for (const item of extracted.files) {
    if (item.extraction) {
      extractedRarVideoCache.set(cacheKey, {
        data: item.extraction,
        expiresAt: Date.now() + 5 * 60_000,
      })
      return item.extraction
    }
  }

  throw new Error('Failed to decompress video entry from RAR archive.')
}

export async function streamZipVideoEntry(
  file: FileWithAccount,
  entryIndex: number,
  rangeHeader: string | undefined,
  res: Response
) {
  const entries = await readArchiveEntriesInternal(file)
  if (entries.length === 0) {
    return res.status(404).json({ code: 'ARCHIVE_NO_VIDEOS', message: 'No playable video files found inside this archive.' })
  }

  const entry = entries.find((e) => e.index === entryIndex) ?? entries[0]!

  const parsedRange = parseHttpRange(rangeHeader, entry.uncompressedSize)
  if (!parsedRange) {
    res.setHeader('Content-Range', `bytes */${entry.uncompressedSize.toString()}`)
    return res.status(416).end()
  }

  const { start, end, isPartial } = parsedRange
  const contentLength = end - start + 1n

  const abortController = new AbortController()
  res.on('close', () => abortController.abort())

  // Handle RAR archives
  if (entry.archiveFormat === 'rar') {
    try {
      if (entry.compressionMethod === 0 && entry.dataStartOffset !== undefined) {
        // Stored RAR entry: stream exact byte range directly from Google Drive / S3
        res.status(isPartial ? 206 : 200)
        res.setHeader('Content-Type', entry.mimeType)
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Content-Length', contentLength.toString())
        res.setHeader('Content-Disposition', `inline; filename="${entry.name.replaceAll('"', '')}"`)
        if (isPartial) {
          res.setHeader('Content-Range', `bytes ${start.toString()}-${end.toString()}/${entry.uncompressedSize.toString()}`)
        }
        const sourceStream = await openRangeStream(file, entry.dataStartOffset + start, entry.dataStartOffset + end, abortController.signal)
        await pipeline(sourceStream, res)
        return
      }

      // Compressed RAR entry: decompress in memory with WASM UnRAR and serve requested byte range
      const extractedData = await extractCompressedRarEntryInMemory(file, entry)
      const slice = extractedData.subarray(Number(start), Number(end) + 1)

      res.status(isPartial ? 206 : 200)
      res.setHeader('Content-Type', entry.mimeType)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Length', slice.byteLength.toString())
      res.setHeader('Content-Disposition', `inline; filename="${entry.name.replaceAll('"', '')}"`)
      if (isPartial) {
        res.setHeader('Content-Range', `bytes ${start.toString()}-${end.toString()}/${extractedData.byteLength.toString()}`)
      }
      res.end(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength))
      return
    } catch (error: any) {
      if (abortController.signal.aborted || res.writableEnded) return
      if (!res.headersSent) {
        return res.status(500).json({ code: 'RAR_VIDEO_STREAM_FAILED', message: error?.message || 'Failed to stream video from RAR.' })
      }
      res.end()
      return
    }
  }

  // Handle ZIP archives
  const localHeader = await fetchRangeBuffer(file, entry.localHeaderOffset, entry.localHeaderOffset + 29n)
  if (localHeader.length < 30 || localHeader.readUInt32LE(0) !== 0x04034b50) {
    return res.status(400).json({ code: 'ZIP_INVALID_LOCAL_HEADER', message: 'Invalid ZIP local file header.' })
  }

  const localFileNameLen = BigInt(localHeader.readUInt16LE(26))
  const localExtraLen = BigInt(localHeader.readUInt16LE(28))
  const dataStart = entry.localHeaderOffset + 30n + localFileNameLen + localExtraLen
  const dataEnd = dataStart + entry.compressedSize - 1n

  res.status(isPartial ? 206 : 200)
  res.setHeader('Content-Type', entry.mimeType)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Length', contentLength.toString())
  res.setHeader('Content-Disposition', `inline; filename="${entry.name.replaceAll('"', '')}"`)
  if (isPartial) {
    res.setHeader('Content-Range', `bytes ${start.toString()}-${end.toString()}/${entry.uncompressedSize.toString()}`)
  }

  try {
    if (entry.compressionMethod === 0) {
      const sourceStream = await openRangeStream(file, dataStart + start, dataStart + end, abortController.signal)
      await pipeline(sourceStream, res)
      return
    }

    const compressedStream = await openRangeStream(file, dataStart, dataEnd, abortController.signal)
    const inflate = createInflateRaw()
    let offset = 0n

    const rangeSlicer = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const chunkLen = BigInt(chunk.length)
        const chunkStart = offset
        const chunkEnd = offset + chunkLen - 1n
        offset += chunkLen

        if (chunkEnd < start) {
          callback()
          return
        }

        const sliceStart = start > chunkStart ? Number(start - chunkStart) : 0
        const sliceEndExclusive = end < chunkEnd ? Number(end - chunkStart) + 1 : chunk.length

        if (sliceStart < sliceEndExclusive) {
          this.push(chunk.subarray(sliceStart, sliceEndExclusive))
        }

        if (chunkEnd >= end) {
          this.push(null)
          abortController.abort()
        }
        callback()
      },
    })

    await pipeline(compressedStream, inflate, rangeSlicer, res)
  } catch (error: any) {
    if (abortController.signal.aborted || res.writableEnded) return
    if (!res.headersSent) {
      res.status(500).json({ code: 'ZIP_VIDEO_STREAM_FAILED', message: error?.message || 'Failed to stream video from ZIP.' })
    } else {
      res.end()
    }
  }
}
