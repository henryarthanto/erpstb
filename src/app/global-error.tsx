'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="id">
      <body>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          fontFamily: 'system-ui, sans-serif',
          backgroundColor: '#fff',
          color: '#333',
        }}>
          <h1 style={{ fontSize: '2rem', marginBottom: '1rem' }}>Terjadi Kesalahan</h1>
          <p style={{ marginBottom: '1.5rem', color: '#666' }}>
            Mohon coba lagi atau hubungi administrator.
          </p>
          <button
            onClick={reset}
            style={{
              padding: '0.5rem 1.5rem',
              backgroundColor: '#111',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '1rem',
            }}
          >
            Coba Lagi
          </button>
        </div>
      </body>
    </html>
  );
}
