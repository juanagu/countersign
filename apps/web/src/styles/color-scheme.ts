// CopilotKit's stylesheet switches to dark only under a `.dark` class, while our tokens follow the OS
// setting; mirroring the OS setting onto <html> keeps the chat and our cards on the same theme.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyColorScheme(): void {
  document.documentElement.classList.toggle('dark', darkQuery.matches);
}

export function syncColorScheme(): void {
  applyColorScheme();
  darkQuery.addEventListener('change', applyColorScheme);
}
