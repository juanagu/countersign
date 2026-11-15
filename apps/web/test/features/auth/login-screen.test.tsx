import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoginScreen } from '../../../src/features/auth/login-screen';

describe('LoginScreen', () => {
  it('offers one button per demo user', () => {
    const html = renderToString(
      <LoginScreen
        onSignedIn={() => undefined}
        initialUsers={[
          { id: 'ana', name: 'Ana Gómez' },
          { id: 'juan', name: 'Juan Pérez' },
        ]}
      />,
    );
    expect(html).toContain('Ana Gómez');
    expect(html).toContain('Juan Pérez');
  });

  it('offers a retry when the demo users could not be loaded', () => {
    const html = renderToString(<LoginScreen onSignedIn={() => undefined} initialLoadFailed />);
    expect(html).toContain('No pudimos cargar los usuarios de prueba.');
    expect(html).toContain('Reintentar');
    expect(html).not.toContain('No pudimos iniciar sesión');
  });
});
