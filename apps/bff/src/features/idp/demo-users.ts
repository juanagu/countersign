export interface DemoUser {
  id: string;
  name: string;
}

/** Synthetic customers; ids match the seed data. */
export const DEMO_USERS: readonly DemoUser[] = [
  { id: 'ana', name: 'Ana Gómez' },
  { id: 'juan', name: 'Juan Pérez' },
];

export function findDemoUser(id: string): DemoUser | undefined {
  return DEMO_USERS.find((user) => user.id === id);
}
