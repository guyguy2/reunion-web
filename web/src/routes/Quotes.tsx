import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Quote } from '../api.ts'
import { useStore } from '../store.tsx'
import { LAYER, useEscape } from '../useEscape.ts'

// Each quote gets its own color and tilt, picked from its id so a card never changes color when new ones arrive.
const CARD_STYLES = [
  { card: 'bg-pink text-white', mark: 'text-sun', tilt: '-rotate-1' },
  { card: 'bg-sun text-ink', mark: 'text-pink', tilt: 'rotate-1' },
  { card: 'bg-grape text-white', mark: 'text-sky', tilt: 'rotate-[0.5deg]' },
  { card: 'bg-sky text-ink', mark: 'text-grape', tilt: '-rotate-[0.5deg]' },
  { card: 'bg-teal text-white', mark: 'text-sun', tilt: 'rotate-1' },
  { card: 'bg-tangerine text-ink', mark: 'text-white', tilt: '-rotate-1' },
]
const BUBBLE_COLORS = ['bg-white', 'bg-sun/40', 'bg-sky/40', 'bg-pink/25', 'bg-teal/30', 'bg-grape/25', 'bg-tangerine/40']

/** Inline "are you sure" so one misclick never deletes anything. */
function RemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false)
  return confirm ? (
    <span className="flex gap-1">
      <button className="btn btn-pink btn-sm" onClick={onRemove}>
        להסיר באמת
      </button>
      <button className="btn btn-plain btn-sm" onClick={() => setConfirm(false)}>
        ביטול
      </button>
    </span>
  ) : (
    <button className="btn btn-plain btn-sm text-pink" onClick={() => setConfirm(true)}>
      {label}
    </button>
  )
}

function AddComment({ quoteId, onAdded }: { quoteId: number; onAdded: () => Promise<unknown> }) {
  const { me } = useStore()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ message: '', addedBy: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const start = () => {
    setForm((f) => ({ ...f, addedBy: f.addedBy || me?.name || '' }))
    setError('')
    setOpen(true)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api(`/api/quotes/${quoteId}/comments`, { json: form })
      await onAdded()
      setForm((f) => ({ ...f, message: '' }))
      setOpen(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button className="btn btn-plain btn-sm" onClick={start}>
        + תגובה
      </button>
    )
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        className="field"
        dir="auto"
        rows={2}
        maxLength={1000}
        autoFocus
        required
        aria-label="התגובה שלכם"
        placeholder="גם אצלנו הוא היה אומר את זה..."
        value={form.message}
        onChange={(e) => setForm({ ...form, message: e.target.value })}
      />
      <input
        className="field"
        dir="auto"
        maxLength={60}
        aria-label="השם שלכם (לא חובה)"
        placeholder="השם שלכם (לא חובה)"
        value={form.addedBy}
        onChange={(e) => setForm({ ...form, addedBy: e.target.value })}
      />
      {error && <p className="font-bold text-pink">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-pink btn-sm" disabled={saving || !form.message.trim()}>
          {saving ? 'שולחים...' : 'פרסום תגובה'}
        </button>
        <button type="button" className="btn btn-plain btn-sm" onClick={() => setOpen(false)}>
          ביטול
        </button>
      </div>
    </form>
  )
}

function QuoteCard({ quote, onChanged, onRemove, onRemoveComment }: {
  quote: Quote
  onChanged: () => Promise<unknown>
  onRemove?: () => void
  onRemoveComment?: (id: number) => void
}) {
  const style = CARD_STYLES[quote.id % CARD_STYLES.length]
  return (
    <article className={`chunk overflow-hidden shadow-chunk-lg transition-transform hover:rotate-0 ${style.tilt}`}>
      <div className={`relative space-y-2 p-5 pt-10 ${style.card}`}>
        <span aria-hidden className={`font-display absolute start-3 -top-2 text-8xl leading-none drop-shadow-[3px_3px_0_var(--color-ink)] ${style.mark}`}>
          ״
        </span>
        <blockquote className="marker text-2xl leading-snug whitespace-pre-line sm:text-3xl" dir="auto">
          {quote.text}
        </blockquote>
        {quote.saidBy && (
          <p className="inline-block rounded-md border-2 border-ink bg-white px-2 py-0.5 font-bold text-ink shadow-chunk" dir="auto">
            {quote.saidBy}
          </p>
        )}
        {quote.context && (
          <p className="text-sm" dir="auto">
            {quote.context}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {quote.addedBy && <span dir="auto">הוסיף/ה: {quote.addedBy}</span>}
          {onRemove && <RemoveButton label="הסרה" onRemove={onRemove} />}
        </div>
      </div>
      <div className="space-y-3 border-t-[3px] border-ink bg-paper p-4">
        {quote.comments.length > 0 && (
          <ul className="space-y-2">
            {quote.comments.map((c, i) => (
              <li key={c.id} className={`rounded-2xl rounded-ss-sm border-2 border-ink px-3 py-2 ${BUBBLE_COLORS[i % BUBBLE_COLORS.length]}`}>
                <p className="whitespace-pre-line" dir="auto">
                  {c.message}
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs opacity-80">
                  <span dir="auto">{c.addedBy ?? 'בלי שם'}</span>
                  {onRemoveComment && <RemoveButton label="הסרת התגובה" onRemove={() => onRemoveComment(c.id)} />}
                </div>
              </li>
            ))}
          </ul>
        )}
        <AddComment quoteId={quote.id} onAdded={onChanged} />
      </div>
    </article>
  )
}

function AddQuote({ onAdded }: { onAdded: () => Promise<unknown> }) {
  const { me } = useStore()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ text: '', saidBy: '', context: '', addedBy: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEscape(open && (() => setOpen(false)), LAYER.drawer)

  const start = () => {
    setForm((f) => ({ ...f, addedBy: f.addedBy || me?.name || '' }))
    setError('')
    setOpen(true)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api<Quote>('/api/quotes', { json: form })
      await onAdded()
      setForm((f) => ({ ...f, text: '', saidBy: '', context: '' }))
      setOpen(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button className="btn btn-teal" onClick={start}>
        + הוספת ציטוט
      </button>
    )
  }
  return (
    <form onSubmit={submit} className="chunk max-w-xl space-y-3 p-4">
      <div>
        <label className="label" htmlFor="quote-text">
          מה אמרו?
        </label>
        <textarea
          id="quote-text"
          className="field"
          dir="auto"
          rows={3}
          maxLength={500}
          autoFocus
          required
          value={form.text}
          onChange={(e) => setForm({ ...form, text: e.target.value })}
        />
      </div>
      <div>
        <label className="label" htmlFor="quote-said-by">
          מי אמר/ה? (לא חובה)
        </label>
        <input
          id="quote-said-by"
          className="field"
          dir="auto"
          maxLength={80}
          placeholder="המורה, המחנכת, חבר מהכיתה..."
          value={form.saidBy}
          onChange={(e) => setForm({ ...form, saidBy: e.target.value })}
        />
      </div>
      <div>
        <label className="label" htmlFor="quote-context">
          מתי ואיפה? (לא חובה)
        </label>
        <input
          id="quote-context"
          className="field"
          dir="auto"
          maxLength={300}
          placeholder="למשל: כל בוקר בשיעור ראשון"
          value={form.context}
          onChange={(e) => setForm({ ...form, context: e.target.value })}
        />
      </div>
      <div>
        <label className="label" htmlFor="quote-by">
          מי מוסיף/ה? (לא חובה)
        </label>
        <input id="quote-by" className="field" dir="auto" maxLength={60} value={form.addedBy} onChange={(e) => setForm({ ...form, addedBy: e.target.value })} />
      </div>
      {error && <p className="font-bold text-pink">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-pink flex-1" disabled={saving || !form.text.trim()}>
          {saving ? 'מוסיפים...' : 'הוספה לקיר'}
        </button>
        <button type="button" className="btn btn-plain" onClick={() => setOpen(false)}>
          ביטול
        </button>
      </div>
    </form>
  )
}

export default function Quotes() {
  const { role } = useStore()
  const [quotes, setQuotes] = useState<Quote[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => api<Quote[]>('/api/quotes').then(setQuotes), [])
  useEffect(() => {
    load().catch((err) => setError((err as Error).message))
  }, [load])

  const remove = async (path: string) => {
    try {
      await api(path, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const isAdmin = role === 'admin'
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <h1 className="heading">מי אמר את זה?</h1>
      <p className="max-w-2xl text-lg">המשפטים שהמורים והחברים אמרו שוב ושוב. כתבו את מה שאתם זוכרים, והגיבו על מה שאחרים כתבו.</p>
      <AddQuote onAdded={load} />
      {error && <p className="font-bold text-pink">{error}</p>}
      {quotes?.length === 0 ? (
        <div className="sticky-note max-w-md text-lg">הקיר עדיין ריק. איזה משפט אתם עוד שומעים בראש?</div>
      ) : (
        <div className="grid items-start gap-6 sm:grid-cols-2">
          {quotes?.map((q) => (
            <QuoteCard
              key={q.id}
              quote={q}
              onChanged={load}
              onRemove={isAdmin ? () => remove(`/api/admin/quotes/${q.id}`) : undefined}
              onRemoveComment={isAdmin ? (id) => remove(`/api/admin/quote-comments/${id}`) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
