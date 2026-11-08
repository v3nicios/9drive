import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Download, ExternalLink, FileArchive, FileText, ImageIcon, Play, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { API_URL, apiFetch, formatBytes, formatDate } from '@/lib/api'
import { createPlyr, ensurePlyr } from '@/lib/plyr'
import { getPreviewKind, isSpreadsheetMimeType, officeViewerUrl, type ZipVideoEntry } from '@/lib/preview'

type PublicFile = { name: string; mimeType: string; sizeBytes: string; createdAt: string }

function fileIcon(file: PublicFile, kind: ReturnType<typeof getPreviewKind>) {
  if (kind === 'image') return <ImageIcon className="h-5 w-5" />
  if (kind === 'video') return <Play className="h-5 w-5" />
  if (isSpreadsheetMimeType(file.mimeType)) return <Table2 className="h-5 w-5" />
  if (kind === 'document') return <FileText className="h-5 w-5" />
  if (kind === 'office') return <FileText className="h-5 w-5" />
  return <FileArchive className="h-5 w-5" />
}

function UnsupportedPreview({ file, downloadUrl }: { file: PublicFile; downloadUrl: string }) {
  return (
    <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-6 text-center text-slate-300">
      <div className="flex h-20 w-20 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-100 shadow-2xl shadow-black/30">
        <FileArchive className="h-9 w-9" />
      </div>
      <h2 className="mt-6 text-xl font-bold text-white">Preview not available</h2>
      <p className="mt-2 max-w-md text-sm text-slate-400">{file.name} cannot be previewed in browser. Download file to open it locally.</p>
      <a href={downloadUrl} download className="mt-6">
        <Button><Download className="h-4 w-4" />Download</Button>
      </a>
    </div>
  )
}

export function PublicFilePage({ embed = false }: { embed?: boolean }) {
  const { token } = useParams()
  const [file, setFile] = useState<PublicFile | null>(null)
  const [failed, setFailed] = useState(false)
  const [zipEntries, setZipEntries] = useState<ZipVideoEntry[]>([])
  const [selectedZipIndex, setSelectedZipIndex] = useState(0)
  const [zipLoading, setZipLoading] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const previewUrl = `${API_URL}/public/files/${token}/preview`
  const downloadUrl = `${API_URL}/public/files/${token}/download`
  const kind = getPreviewKind(file?.mimeType, file?.name)
  const selectedZipVideo = zipEntries.find((entry) => entry.index === selectedZipIndex) ?? zipEntries[0]

  useEffect(() => {
    setFailed(false)
    setZipEntries([])
    setSelectedZipIndex(0)
    apiFetch<{ file: PublicFile }>(`/public/files/${token}`, { skipAuth: true })
      .then(async (data) => {
        setFile(data.file)
        if (getPreviewKind(data.file.mimeType, data.file.name) === 'zip') {
          setZipLoading(true)
          try {
            const zipData = await apiFetch<{ entries: ZipVideoEntry[] }>(`/public/files/${token}/zip-entries`, { skipAuth: true })
            setZipEntries(zipData.entries ?? [])
            setSelectedZipIndex(zipData.entries?.[0]?.index ?? 0)
          } catch {
            setZipEntries([])
          } finally {
            setZipLoading(false)
          }
        }
      })
      .catch(() => {
        setFile(null)
        setFailed(true)
      })
  }, [token])

  useEffect(() => {
    document.title = file ? `${file.name} | 9Drive` : 'Shared file | 9Drive'
    return () => {
      document.title = '9Drive'
    }
  }, [file])

  useEffect(() => {
    const isVideoReady = kind === 'video' || (kind === 'zip' && zipEntries.length > 0 && !zipLoading)
    if (!isVideoReady || !videoRef.current) return undefined
    let disposed = false
    let player: { destroy: () => void } | null = null

    ensurePlyr().then(() => {
      if (disposed || !videoRef.current) return
      player = createPlyr(videoRef.current)
    }).catch(() => undefined)

    return () => {
      disposed = true
      player?.destroy()
    }
  }, [kind, previewUrl, zipEntries.length, selectedZipIndex, zipLoading])

  if (failed) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0f1117] p-6 text-white">
        <div className="max-w-md rounded-3xl border border-white/10 bg-white/[0.04] p-8 text-center shadow-2xl shadow-black/30">
          <FileArchive className="mx-auto h-12 w-12 text-slate-400" />
          <h1 className="mt-5 text-2xl font-extrabold">Shared file not found</h1>
          <p className="mt-2 text-sm text-slate-400">Link may be expired, disabled, or deleted.</p>
        </div>
      </main>
    )
  }

  if (!file) {
    return <main className="flex min-h-screen items-center justify-center bg-[#0f1117] text-sm font-semibold text-slate-400">Loading shared file...</main>
  }

  const preview = (
    <div className="flex h-full w-full items-center justify-center">
      {kind === 'image' ? <img src={previewUrl} alt={file.name} className="max-h-full max-w-full object-contain shadow-2xl shadow-black/30" /> : null}
      {kind === 'video' ? <div className="shared-video-shell"><video ref={videoRef} controls playsInline preload="metadata"><source src={previewUrl} type={file.mimeType} /></video></div> : null}
      {kind === 'zip' ? (
        zipLoading ? (
          <div className="text-sm font-semibold text-slate-400">Inspecting ZIP video stream...</div>
        ) : zipEntries.length > 0 && selectedZipVideo ? (
          <div className="flex h-full w-full flex-col">
            <div className="z-10 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#17191f]/90 px-4 py-2 text-xs text-slate-300">
              <span className="truncate font-semibold">
                Streaming from Archive: <b className="text-white">{selectedZipVideo.name}</b> ({formatBytes(selectedZipVideo.uncompressedSize)})
              </span>
              {zipEntries.length > 1 ? (
                <select
                  className="h-8 rounded-lg border border-white/15 bg-[#0f1117] px-2.5 text-xs font-semibold text-white"
                  value={selectedZipVideo.index}
                  onChange={(e) => setSelectedZipIndex(Number(e.target.value))}
                >
                  {zipEntries.map((entry) => (
                    <option key={entry.index} value={entry.index}>
                      {entry.path} ({formatBytes(entry.uncompressedSize)})
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <div className="flex flex-1 items-center justify-center overflow-hidden">
              <div className="shared-video-shell">
                <video key={`${token}-${selectedZipVideo.index}`} ref={videoRef} controls playsInline preload="metadata">
                  <source src={`${API_URL}/public/files/${token}/zip-stream?index=${selectedZipVideo.index}`} type={selectedZipVideo.mimeType} />
                </video>
              </div>
            </div>
          </div>
        ) : (
          <UnsupportedPreview file={file} downloadUrl={downloadUrl} />
        )
      ) : null}
      {kind === 'document' ? <iframe src={previewUrl} title={file.name} className="h-full w-full border-0 bg-white" /> : null}
      {kind === 'office' ? <iframe src={officeViewerUrl(previewUrl)} title={file.name} className="h-full w-full border-0 bg-white" /> : null}
      {!kind ? <UnsupportedPreview file={file} downloadUrl={downloadUrl} /> : null}
    </div>
  )

  if (embed) {
    return <main className="h-screen overflow-hidden bg-black text-white">{preview}</main>
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#101218] text-white">
      <header className="fixed inset-x-0 top-0 z-30 flex h-16 items-center justify-between border-b border-white/10 bg-[#17191f]/95 px-4 shadow-lg shadow-black/20 backdrop-blur sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-slate-100">
            {fileIcon(file, kind)}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold text-white sm:text-base">{file.name}</h1>
            <p className="truncate text-xs text-slate-400">{formatBytes(file.sizeBytes)} • Uploaded {formatDate(file.createdAt)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a href={`/public/files/${token}/embed`} target="_blank" rel="noreferrer" className="hidden sm:block">
            <Button variant="ghost" className="text-slate-100 hover:bg-white/10"><ExternalLink className="h-4 w-4" />Embed</Button>
          </a>
          <a href={downloadUrl} download>
            <Button variant="outline" className="border-white/10 bg-white/10 text-white hover:bg-white/15"><Download className="h-4 w-4" />Download</Button>
          </a>
        </div>
      </header>

      <section className="flex h-screen items-center justify-center px-3 pb-6 pt-20 sm:px-6">
        <div className="relative h-full w-full overflow-hidden rounded-2xl border border-white/10 bg-[#0b0d12] shadow-2xl shadow-black/40">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-white/[0.06] to-transparent" />
          {preview}
        </div>
      </section>
    </main>
  )
}
