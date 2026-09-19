import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { filterOptions, isFiltering, NO_FILTERS, type Filters } from '../yearbook.ts'
import type { Scene } from '../api.ts'

/** The filters live in the address, so a slice of the yearbook can be shared and survives opening a profile. */
export function useFilters(): [Filters, (next: Partial<Filters>) => void] {
  const [params, setParams] = useSearchParams()
  const year = Number(params.get('year'))
  const gender = params.get('g')
  const filters: Filters = {
    query: params.get('q') ?? '',
    year: year || null,
    classLabel: params.get('class'),
    gender: gender === 'm' || gender === 'f' ? gender : null,
    sort: params.get('sort') === 'class' ? 'class' : 'name',
  }
  const set = (next: Partial<Filters>) => {
    const f = { ...filters, ...next }
    const out = new URLSearchParams(params)
    const put = (key: string, value: string | null) => (value ? out.set(key, value) : out.delete(key))
    put('q', f.query)
    put('year', f.year == null ? null : String(f.year))
    put('class', f.classLabel)
    put('g', f.gender)
    put('sort', f.sort === 'class' ? 'class' : null)
    setParams(out, { replace: true })
  }
  return [filters, set]
}

const GENDERS = [
  [null, 'כולם'],
  ['f', 'בנות'],
  ['m', 'בנים'],
] as const

/** A menu dressed as a chip. It lights up while it is narrowing the list. Native, so phones get their own picker. */
function Chip({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`h-9 min-w-0 cursor-pointer rounded-full border-[3px] border-ink ps-3 pe-6 text-sm font-bold ${value ? 'bg-sun' : 'bg-white'}`}
    >
      {children}
    </select>
  )
}

/** Search and slice: by name, by the year of the class photo, by class, and boys or girls. */
export default function FriendFilters({ scenes, filters, onChange, total, shown, genders }: { scenes: Scene[]; filters: Filters; onChange: (next: Partial<Filters>) => void; total: number; shown: number; /** False until someone has been marked as a boy or a girl. */ genders: boolean }) {
  const options = filterOptions(scenes)
  const years = filters.year == null ? options : options.filter((o) => o.year === filters.year)
  const hasClasses = options.some((o) => o.classes.length > 0)

  return (
    <div className="space-y-2" role="search">
      <input
        className="field shadow-chunk"
        type="search"
        dir="auto"
        enterKeyHint="search"
        placeholder={`חיפוש חברים לפי שם (${total})`}
        value={filters.query}
        onChange={(e) => onChange({ query: e.target.value })}
        aria-label="חיפוש בוגרים לפי שם"
      />
      {/* Wraps instead of scrolling sideways: on a phone a filter that is off screen is a filter nobody finds. */}
      <div className="flex flex-wrap items-center gap-2">
        {options.length > 1 && (
          <Chip
            label="שנה"
            value={filters.year == null ? '' : String(filters.year)}
            onChange={(v) => {
              const year = v ? Number(v) : null
              const keepsClass = filters.classLabel && options.find((o) => o.year === year)?.classes.includes(filters.classLabel)
              onChange({ year, classLabel: keepsClass ? filters.classLabel : null })
            }}
          >
            <option value="">כל השנים</option>
            {options.map((o) => (
              <option key={o.year} value={o.year}>
                {o.year}
              </option>
            ))}
          </Chip>
        )}
        {hasClasses && (
          <Chip
            label="כיתה"
            value={filters.classLabel ?? ''}
            onChange={(v) => onChange({ classLabel: v || null, year: v ? (options.find((o) => o.classes.includes(v))?.year ?? filters.year) : filters.year })}
          >
            <option value="">כל הכיתות</option>
            {years.map((o) => (
              <optgroup key={o.year} label={String(o.year)}>
                {o.classes.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </optgroup>
            ))}
          </Chip>
        )}
        {genders && (
          <div className="flex h-9 shrink-0 overflow-hidden rounded-full border-[3px] border-ink bg-white text-sm font-bold" role="group" aria-label="בנים או בנות">
            {GENDERS.map(([value, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={filters.gender === value}
                onClick={() => onChange({ gender: value })}
                className={`cursor-pointer px-3 ${filters.gender === value ? (value ? 'bg-sun' : 'bg-ink text-white') : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {hasClasses && (
          <Chip label="מיון" value={filters.sort === 'class' ? 'class' : ''} onChange={(v) => onChange({ sort: v === 'class' ? 'class' : 'name' })}>
            <option value="">מיון: שם</option>
            <option value="class">מיון: כיתה</option>
          </Chip>
        )}
      </div>
      {isFiltering(filters) && (
        <p className="flex items-center gap-3 text-sm" role="status">
          <span className="font-bold">
            {shown} מתוך {total}
          </span>
          <button type="button" className="cursor-pointer font-bold underline decoration-2 underline-offset-2" onClick={() => onChange({ ...NO_FILTERS, sort: filters.sort })}>
            ניקוי הסינון
          </button>
        </p>
      )}
    </div>
  )
}
