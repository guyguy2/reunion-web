import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api.ts'
import { useStore } from '../store.tsx'
import Tagger from './Tagger.tsx'

/** Destructive actions ask twice, inline, instead of using a browser dialog. */
function ConfirmButton({ label, confirmLabel, onConfirm, className = '' }: { label: string; confirmLabel: string; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false)
  return armed ? (
    <span className="inline-flex gap-1">
      <button className="btn btn-pink btn-sm" onClick={() => (setArmed(false), onConfirm())}>
        {confirmLabel}
      </button>
      <button className="btn btn-plain btn-sm" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  ) : (
    <button className={`btn btn-plain btn-sm ${className}`} onClick={() => setArmed(true)}>
      {label}
    </button>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="chunk space-y-4 p-5">
      <h2 className="font-display text-xl">{title}</h2>
      {children}
    </section>
  )
}

export default function Admin() {
  const { scenes, people, reload } = useStore()
  const [taggingId, setTaggingId] = useState<number | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [csv, setCsv] = useState('')
  const [newName, setNewName] = useState('')
  const [filter, setFilter] = useState('')
  const [wipePhrase, setWipePhrase] = useState('')
  const tagging = scenes.find((s) => s.id === taggingId)

  async function run(label: string, action: () => Promise<string | void>) {
    setBusy(label)
    setNotice('')
    try {
      const result = await action()
      await reload()
      setNotice(result || 'Done.')
    } catch (err) {
      setNotice(`Error: ${(err as Error).message}`)
    } finally {
      setBusy('')
    }
  }

  function uploadScene(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const body = new FormData(form)
    run('scene', async () => {
      await api('/api/admin/scenes', { body })
      form.reset()
      return 'Picture added. Open "Tag faces" to detect and name the faces.'
    })
  }

  if (tagging) return <Tagger scene={tagging} onClose={() => setTaggingId(null)} />

  const shown = people.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 pb-28 sm:p-8 sm:pb-28">
      <h1 className="heading">Principal's Office</h1>
      {notice && (
        <p role="status" className="rounded-lg border-[3px] border-ink bg-sun p-3 font-bold">
          {notice}
        </p>
      )}

      <Section title="Class pictures">
        <ul className="space-y-2">
          {scenes.map((scene) => (
            <li key={scene.id} className="flex flex-wrap items-center gap-2 rounded-lg border-[3px] border-ink p-2">
              <span className="min-w-0 flex-1 font-bold" dir="auto">
                {scene.title}
                <span className="ms-2 text-sm font-normal opacity-70">
                  {scene.width}x{scene.height}, {scene.tags.length} faces, {scene.tags.filter((t) => t.personId != null).length} named
                </span>
              </span>
              {scene.kind === 'group' && (
                <button className="btn btn-teal btn-sm" onClick={() => setTaggingId(scene.id)}>
                  Tag faces
                </button>
              )}
              <ConfirmButton label="Delete" confirmLabel="Really delete" onConfirm={() => run('delete', () => api(`/api/admin/scenes/${scene.id}`, { method: 'DELETE' }).then(() => {}))} />
            </li>
          ))}
          {scenes.length === 0 && <li>No pictures yet.</li>}
        </ul>
        <form onSubmit={uploadScene} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="scene-title">
              Title (shown on the tab)
            </label>
            <input id="scene-title" name="title" className="field" dir="auto" placeholder="1996 - Graduation" required maxLength={80} />
          </div>
          <div>
            <label className="label" htmlFor="scene-image">
              Image (max 40 MB)
            </label>
            <input id="scene-image" name="image" type="file" accept="image/*" className="field" required />
          </div>
          <button className="btn btn-pink" disabled={busy === 'scene'}>
            {busy === 'scene' ? 'Developing...' : 'Add picture'}
          </button>
        </form>
        <div className="flex flex-wrap items-center gap-3 border-t-[3px] border-ink pt-4">
          <button className="btn btn-sm" disabled={busy === 'wall'} onClick={() => run('wall', () => api('/api/admin/rebuild-wall', { method: 'POST' }).then(() => 'The Wall has been rebuilt.'))}>
            {busy === 'wall' ? 'Rebuilding...' : 'Rebuild The Wall'}
          </button>
          <p className="text-sm opacity-70">The Wall is a generated portrait grid of everyone with a profile. Rebuild it after names or photos change.</p>
        </div>
      </Section>

      <Section title={`People (${people.length})`}>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            run('person', async () => {
              await api('/api/admin/people', { json: { name: newName } })
              setNewName('')
            })
          }}
        >
          <input className="field" dir="auto" placeholder="Add a classmate by name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn shrink-0" disabled={newName.trim().length < 2}>
            Add
          </button>
        </form>

        <details>
          <summary className="cursor-pointer font-bold">Import a roster from CSV</summary>
          <div className="mt-3 space-y-2">
            <p className="text-sm">First row is the header. Columns: name (required), former_name, nickname, email, instagram, linkedin, city.</p>
            <textarea className="field pixel min-h-32 text-lg" dir="auto" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'name,former_name,city\n...'} />
            <button
              className="btn btn-sm"
              disabled={!csv.trim()}
              onClick={() =>
                run('csv', async () => {
                  const result = await api<{ added: number; skipped: string[] }>('/api/admin/import-csv', { body: csv })
                  setCsv('')
                  return `Added ${result.added}. ${result.skipped.length ? `Skipped: ${result.skipped.join('; ')}` : ''}`
                })
              }
            >
              Import
            </button>
          </div>
        </details>

        <input className="field" type="search" dir="auto" placeholder="Filter people" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ul className="max-h-96 divide-y-2 divide-ink/20 overflow-y-auto">
          {shown.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1" dir="auto">
                <span className="font-bold">{p.name}</span>
                <span className="ms-2 text-sm opacity-70">
                  {p.claimed ? 'claimed' : 'unclaimed'}
                  {p.email ? `, ${p.email}` : ''}
                </span>
              </span>
              <button
                className="btn btn-plain btn-sm"
                onClick={() => run('memoriam', () => api(`/api/admin/people/${p.id}`, { method: 'PATCH', json: { inMemoriam: !p.inMemoriam } }).then(() => {}))}
              >
                {p.inMemoriam ? 'Unmark in memoriam' : 'In memoriam'}
              </button>
              {p.claimed && (
                <ConfirmButton label="Reset claim" confirmLabel="Reset" onConfirm={() => run('reset', () => api(`/api/admin/people/${p.id}/reset-claim`, { method: 'POST' }).then(() => 'Claim reset. Their old edit link no longer works.'))} />
              )}
              <ConfirmButton label="Delete" confirmLabel="Really delete" className="text-pink" onConfirm={() => run('delete', () => api(`/api/admin/people/${p.id}`, { method: 'DELETE' }).then(() => {}))} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Danger zone">
        {people.length === 0 && scenes.length === 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-sm" disabled={busy === 'demo'} onClick={() => run('demo', () => api('/api/admin/demo', { method: 'POST' }).then(() => 'Demo data loaded.'))}>
              {busy === 'demo' ? 'Loading...' : 'Load demo data'}
            </button>
            <p className="text-sm opacity-70">Fake classmates and pictures, for trying the site out.</p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input className="field max-w-xs" placeholder='Type "DELETE EVERYTHING"' value={wipePhrase} onChange={(e) => setWipePhrase(e.target.value)} />
          <button
            className="btn btn-pink btn-sm"
            disabled={wipePhrase !== 'DELETE EVERYTHING'}
            onClick={() =>
              run('wipe', async () => {
                await api('/api/admin/wipe', { json: { confirm: wipePhrase } })
                setWipePhrase('')
                return 'Everything was removed.'
              })
            }
          >
            Wipe all people and pictures
          </button>
        </div>
      </Section>
    </div>
  )
}
