/** Shown instead of the site when its first load failed: why, and a button to try again. */
export default function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="chunk space-y-3 p-6" role="alert">
        <h1 className="heading">האתר לא נטען</h1>
        <p>{message}</p>
        <button className="btn btn-pink" onClick={onRetry}>
          נסו שוב
        </button>
      </div>
    </div>
  )
}
