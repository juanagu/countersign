import { useEffect, useState } from 'react';
import { fetchSession, logout, type SessionUser } from './features/auth/lib/auth-api';
import { LoginScreen } from './features/auth/login-screen';
import { ChatScreen } from './features/chat/chat-screen';

type SessionState = { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; user: SessionUser };

export function App({ initialState }: { initialState?: SessionState }) {
  const [session, setSession] = useState<SessionState>(initialState ?? { status: 'loading' });

  useEffect(() => {
    if (initialState) return;
    fetchSession()
      .then((user) => setSession(user ? { status: 'signed-in', user } : { status: 'signed-out' }))
      .catch(() => setSession({ status: 'signed-out' }));
  }, [initialState]);

  async function signOut() {
    await logout();
    setSession({ status: 'signed-out' });
  }

  // An expired session shows up as a failed runtime call; only a confirmed 401 signs the user out.
  function recheckSession() {
    fetchSession()
      .then((user) => {
        if (!user) setSession({ status: 'signed-out' });
      })
      .catch(() => undefined);
  }

  if (session.status === 'loading') {
    return (
      <main className="page-center muted" aria-busy="true">
        Cargando…
      </main>
    );
  }
  if (session.status === 'signed-out') {
    return <LoginScreen onSignedIn={(user) => setSession({ status: 'signed-in', user })} />;
  }
  return (
    <ChatScreen key={session.user.id} user={session.user} onSignOut={signOut} onRuntimeRequestFailed={recheckSession} />
  );
}
