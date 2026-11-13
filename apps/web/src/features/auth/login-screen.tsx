import { useEffect, useState } from 'react';
import { Button } from '../../shared/ui/button';
import { fetchDemoUsers, login, type SessionUser } from './lib/auth-api';
import './login-screen.css';

export interface LoginScreenProps {
  onSignedIn: (user: SessionUser) => void;
  /** Injected in tests; fetched from the BFF otherwise. */
  initialUsers?: SessionUser[];
}

export function LoginScreen({ onSignedIn, initialUsers }: LoginScreenProps) {
  const [users, setUsers] = useState<SessionUser[] | undefined>(initialUsers);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (initialUsers) return;
    fetchDemoUsers()
      .then(setUsers)
      .catch(() => setError(true));
  }, [initialUsers]);

  async function signIn(username: string) {
    setPending(username);
    setError(false);
    try {
      onSignedIn(await login(username));
    } catch {
      setError(true);
      setPending(null);
    }
  }

  return (
    <main className="page-center">
      <section className="login-card" aria-labelledby="login-title">
        <h1 id="login-title" className="login-card__title">
          Asistente bancario
        </h1>
        <p className="muted">Demo con datos ficticios. Elegí con qué cliente entrar.</p>
        <div className="login-card__users">
          {users?.map((user) => (
            <Button
              key={user.id}
              variant="secondary"
              block
              disabled={pending !== null}
              onClick={() => void signIn(user.id)}
            >
              {pending === user.id ? 'Ingresando…' : user.name}
            </Button>
          ))}
        </div>
        {error && (
          <p role="alert" className="login-card__error">
            No pudimos iniciar sesión. Probá de nuevo.
          </p>
        )}
      </section>
    </main>
  );
}
